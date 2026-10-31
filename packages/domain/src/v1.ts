import { calculatePreparationTimes, parseOffsetDateTime } from "./time.ts";
import type {
  CalculateTimingInput, CalculateTimingOutput, Change, ChangeSet, ContextSnapshot,
  CoordinationTarget, Proposal, ProposalMode, ScheduleFields, ScheduleItem, ValidationResult,
} from "./contracts.ts";

/** A caller must inject both identifiers from authenticated, server-owned state. */
export interface ChangeValidationContext {
  authenticatedUserId: string;
  snapshotUserId: string;
  snapshot: ContextSnapshot;
  changeSet: ChangeSet;
  purpose: "ai_proposal" | "user_command";
  checkedAt: string;
  coordinationTarget?: CoordinationTarget | null;
}

export interface ChangeAssessment {
  validation: ValidationResult;
  mode: ProposalMode | null;
  coordinationTarget: CoordinationTarget | null;
}

type Instant = { milliseconds: number; remainder: string };
type Interval = { start: Instant; end: Instant };
type ParsedFields = { fields: ScheduleFields; interval: Interval | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRevision(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Compare arbitrary sub-millisecond ISO precision without silently truncating it. */
function parseInstant(value: unknown): Instant | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const seconds = match[2] === undefined ? "" : `:${match[2]}`;
  const fraction = match[3] === undefined ? "" : `.${match[3].slice(0, 3)}`;
  const milliseconds = parseOffsetDateTime(`${match[1]}${seconds}${fraction}${match[4]}`);
  if (milliseconds === null) return null;
  return { milliseconds, remainder: (match[3] ?? "").slice(3).replace(/0+$/, "") };
}

function compareInstant(a: Instant, b: Instant): number {
  if (a.milliseconds !== b.milliseconds) return a.milliseconds < b.milliseconds ? -1 : 1;
  const length = Math.max(a.remainder.length, b.remainder.length);
  for (let i = 0; i < length; i++) {
    const difference = (a.remainder.charCodeAt(i) || 48) - (b.remainder.charCodeAt(i) || 48);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// Keep the decimal value supplied in minutes; Number arithmetic on timestamps
// would otherwise round away sub-millisecond differences at modern dates.
function taskFitsInterval(interval: Interval, minutes: number): boolean {
  const [coefficient, exponent = "0"] = minutes.toString().split("e");
  const [whole, fractional = ""] = coefficient.split(".");
  const milliseconds = BigInt(whole + fractional) * 60_000n;
  const shift = Number(exponent) - fractional.length;
  let wholeMilliseconds: bigint;
  let fractionalMilliseconds = "";
  if (shift >= 0) {
    wholeMilliseconds = milliseconds * 10n ** BigInt(shift);
  } else {
    const places = -shift;
    const digits = milliseconds.toString().padStart(places + 1, "0");
    wholeMilliseconds = BigInt(digits.slice(0, -places));
    fractionalMilliseconds = digits.slice(-places).replace(/0+$/, "");
  }

  const length = Math.max(interval.start.remainder.length, fractionalMilliseconds.length);
  const sum: string[] = new Array(length);
  let carry = 0;
  for (let index = length - 1; index >= 0; index--) {
    const a = (interval.start.remainder.charCodeAt(index) || 48) - 48;
    const b = (fractionalMilliseconds.charCodeAt(index) || 48) - 48;
    const digit = a + b + carry;
    sum[index] = String(digit % 10);
    carry = Math.floor(digit / 10);
  }
  const minimumEndMs = BigInt(interval.start.milliseconds) + wholeMilliseconds + BigInt(carry);
  const actualEndMs = BigInt(interval.end.milliseconds);
  if (actualEndMs !== minimumEndMs) return actualEndMs > minimumEndMs;
  return compareInstant(
    { milliseconds: 0, remainder: interval.end.remainder },
    { milliseconds: 0, remainder: sum.join("").replace(/0+$/, "") },
  ) >= 0;
}

function isTimezone(value: unknown): value is string {
  if (!isId(value) || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validSourceRefs(value: unknown): boolean {
  return Array.isArray(value) && value.every((ref) => {
    if (!isRecord(ref)) return false;
    const required = ["provider", "accountRef", "calendarId", "externalEventId", "lastSyncedAt"];
    return required.every((key) => typeof ref[key] === "string") &&
      parseInstant(ref.lastSyncedAt) !== null &&
      (ref.occurrenceKey === undefined || typeof ref.occurrenceKey === "string") &&
      (ref.sourceVersion === undefined || typeof ref.sourceVersion === "string");
  });
}

function parseFields(
  value: unknown, path: string, targetIds: string[], result: ValidationResult, enforceTaskDuration = true,
): ParsedFields | null {
  if (!isRecord(value)) {
    if (value == null) result.missingFields.push(path);
    else result.conflicts.push({ targetIds, reason: `invalid_field:${path}` });
    return null;
  }

  const previousCount = result.conflicts.length + result.missingFields.length;
  const missing = (field: string) => result.missingFields.push(`${path}.${field}`);
  const invalid = (field: string) => result.conflicts.push({ targetIds, reason: `invalid_field:${path}.${field}` });
  for (const field of ["kind", "title", "timeSlot", "durationMinutes", "deadline", "flexibility", "involvement", "completion"]) {
    if (!(field in value) || value[field] === undefined) missing(field);
  }
  if (value.kind !== undefined && value.kind !== "event" && value.kind !== "task") invalid("kind");
  if (value.title !== undefined && typeof value.title !== "string") invalid("title");
  if (value.flexibility !== undefined && value.flexibility !== "fixed" && value.flexibility !== "flexible") invalid("flexibility");
  if (value.involvement !== undefined && value.involvement !== "personal" && value.involvement !== "shared") invalid("involvement");
  if (value.completion !== undefined && !["pending", "completed", "incomplete", "unknown"].includes(value.completion as string)) invalid("completion");
  if (value.category != null && value.category !== "personal" && value.category !== "work") invalid("category");
  if (value.attendance != null && !["attended", "absent", "unknown"].includes(value.attendance as string)) invalid("attendance");
  if (value.kind === "task" && value.attendance != null) invalid("attendance");

  let interval: Interval | null = null;
  if (value.timeSlot === null && value.kind === "event") {
    missing("timeSlot");
  } else if (value.timeSlot !== undefined && value.timeSlot !== null) {
    if (!isRecord(value.timeSlot)) invalid("timeSlot");
    else {
      const start = parseInstant(value.timeSlot.startsAt);
      const end = parseInstant(value.timeSlot.endsAt);
      if (!start) invalid("timeSlot.startsAt");
      if (!end) invalid("timeSlot.endsAt");
      if (!isTimezone(value.timeSlot.timezone)) invalid("timeSlot.timezone");
      if (start && end) {
        if (compareInstant(start, end) >= 0) invalid("timeSlot");
        else interval = { start, end };
      }
    }
  }

  if (value.durationMinutes === null && value.kind === "task") missing("durationMinutes");
  else if (value.durationMinutes !== undefined && value.durationMinutes !== null &&
    (typeof value.durationMinutes !== "number" || !Number.isFinite(value.durationMinutes) ||
      value.durationMinutes < 0 || (value.kind === "task" && value.durationMinutes === 0))) invalid("durationMinutes");
  if (enforceTaskDuration && value.kind === "task" && interval && typeof value.durationMinutes === "number" &&
    Number.isFinite(value.durationMinutes) && value.durationMinutes > 0 && !taskFitsInterval(interval, value.durationMinutes)) {
    result.conflicts.push({ targetIds, reason: `insufficient_task_duration:${path}.timeSlot` });
  }

  if (value.deadline !== undefined && value.deadline !== null) {
    const deadline = parseInstant(value.deadline);
    if (!deadline) invalid("deadline");
    else if (interval && compareInstant(interval.end, deadline) > 0) {
      result.conflicts.push({ targetIds, reason: `deadline_exceeded:${path}.deadline` });
    }
  }

  if (result.conflicts.length + result.missingFields.length !== previousCount) return null;
  return { fields: value as unknown as ScheduleFields, interval };
}

function sameInterval(a: Interval | null, b: Interval | null): boolean {
  return a === null || b === null ? a === b : compareInstant(a.start, b.start) === 0 && compareInstant(a.end, b.end) === 0;
}

function sameFields(before: ScheduleFields, beforeInterval: Interval | null, after: ParsedFields): boolean {
  const a = before.deadline === null ? null : parseInstant(before.deadline);
  const b = after.fields.deadline === null ? null : parseInstant(after.fields.deadline);
  const sameDeadline = a === null || b === null ? a === b : compareInstant(a, b) === 0;
  return before.kind === after.fields.kind && before.title === after.fields.title &&
    sameInterval(beforeInterval, after.interval) && before.timeSlot?.timezone === after.fields.timeSlot?.timezone &&
    before.durationMinutes === after.fields.durationMinutes && sameDeadline && before.flexibility === after.fields.flexibility &&
    before.involvement === after.fields.involvement && before.completion === after.fields.completion &&
    (before.category ?? null) === (after.fields.category === undefined ? before.category ?? null : after.fields.category) &&
    (before.attendance ?? null) === (after.fields.attendance === undefined ? before.attendance ?? null : after.fields.attendance);
}

function coordinationChange(before: ScheduleItem, beforeInterval: Interval | null, change: Change, after: ParsedFields | null): boolean {
  if (before.kind !== "event" || before.involvement !== "shared") return false;
  if (change.operation === "delete") return true;
  if (change.operation !== "update" || !after) return false;
  return after.fields.kind !== "event" || after.fields.involvement !== "shared" || !sameInterval(beforeInterval, after.interval);
}

// A coordination alternative changes only the time of the appointment, or cancels it.
function coordinationAlternativeKeepsOtherFields(before: ScheduleItem, change: Change, after: ParsedFields | null): boolean {
  if (change.operation === "delete") return true;
  if (change.operation !== "update" || !after) return false;
  const next = after.fields;
  return next.kind === before.kind && next.title === before.title && next.durationMinutes === before.durationMinutes &&
    next.deadline === before.deadline && next.flexibility === before.flexibility &&
    next.involvement === before.involvement && next.completion === before.completion &&
    (next.category === undefined || (next.category ?? null) === (before.category ?? null)) &&
    (next.attendance === undefined || (next.attendance ?? null) === (before.attendance ?? null));
}

// Explicit relationships only: the server must never infer a link from a task title.
function validateTimingConstraints(
  changeSet: ChangeSet, current: Map<string, { item: ScheduleItem; interval: Interval | null }>,
  changedTargets: Set<string>, validation: ValidationResult,
): void {
  const constraints: unknown = changeSet.timingConstraints;
  if (constraints === undefined) return;
  if (!Array.isArray(constraints) || constraints.length > 100) {
    validation.conflicts.push({ targetIds: [], reason: "invalid_timing_constraints" });
    return;
  }
  const used = new Set<string>();
  const windows: Interval[] = [];
  for (const [index, entry] of constraints.entries()) {
    const path = `timingConstraints[${index}]`;
    const fail = (reason: string) => validation.conflicts.push({ targetIds: [], reason: `${reason}:${path}` });
    if (!isRecord(entry) || !isRecord(entry.appointment) || !isRecord(entry.segments)) { fail("invalid_timing_constraint"); continue; }
    const { appointment } = entry;
    let event: ScheduleFields | undefined;
    if (appointment.kind === "existing" && isId(appointment.id) && isRevision(appointment.expectedRevision, 1)) {
      const target = current.get(appointment.id);
      if (!target || target.item.revision !== appointment.expectedRevision || changedTargets.has(appointment.id)) {
        fail("stale_timing_appointment"); continue;
      }
      event = target.item;
    } else if (appointment.kind === "change" && isId(appointment.changeId)) {
      const target = changeSet.changes.find(change => change.changeId === appointment.changeId);
      if (target && target.operation !== "delete") event = target.after;
    }
    if (!event || event.kind !== "event" || !event.timeSlot || event.completion === "completed") {
      fail("invalid_timing_appointment"); continue;
    }
    if (compareInstant(parseInstant(event.timeSlot.startsAt)!, parseInstant(validation.checkedAt)!) < 0) {
      fail("past_timing_appointment"); continue;
    }
    const names = ["preparationMinutes", "travelMinutes", "bufferMinutes"] as const;
    const missing = names.filter(name => entry[name] == null);
    if (missing.length) { validation.missingFields.push(...missing.map(name => `${path}.${name}`)); continue; }
    if (names.some(name => typeof entry[name] !== "number" || !Number.isFinite(entry[name]) || (entry[name] as number) < 0 || !Number.isSafeInteger((entry[name] as number) * 60_000))) {
      fail("invalid_timing_minutes"); continue;
    }
    const preparationMinutes = entry.preparationMinutes as number, travelMinutes = entry.travelMinutes as number, bufferMinutes = entry.bufferMinutes as number;
    const timing = calculateTiming({ appointmentStart: event.timeSlot.startsAt, preparationMinutes, travelMinutes, bufferMinutes });
    const arrival = calculateTiming({ appointmentStart: event.timeSlot.startsAt, preparationMinutes: 0, travelMinutes: 0, bufferMinutes });
    if (!timing.ready || !arrival.ready) { fail("invalid_timing_calculation"); continue; }
    const expected = [
      { id: entry.segments.preparation, minutes: preparationMinutes, start: timing.preparationStartAt, end: timing.departureAt },
      { id: entry.segments.travel, minutes: travelMinutes, start: timing.departureAt, end: arrival.departureAt },
      { id: entry.segments.buffer, minutes: bufferMinutes, start: arrival.departureAt, end: event.timeSlot.startsAt },
    ];
    if (expected.some(part => part.minutes === 0 ? part.id !== null : !isId(part.id))) {
      fail("invalid_timing_segments"); continue;
    }
    const segments = expected.filter(part => part.minutes > 0);
    const ids = segments.map(part => part.id as string);
    if (new Set(ids).size !== ids.length || ids.some(id => used.has(id))) { fail("invalid_timing_segments"); continue; }
    let valid = true;
    for (const part of segments) {
      const id = part.id as string;
      const segment = changeSet.changes.find(change => change.changeId === id);
      if (!segment || segment.operation === "delete" || segment.after.kind !== "task" || segment.after.involvement !== "personal" ||
          segment.after.completion === "completed" || !segment.after.timeSlot) { valid = false; break; }
      const start = parseInstant(segment.after.timeSlot.startsAt), end = parseInstant(segment.after.timeSlot.endsAt);
      if (!start || !end || compareInstant(start, parseInstant(part.start)!) !== 0 ||
          compareInstant(end, parseInstant(part.end)!) !== 0 || segment.after.durationMinutes !== part.minutes) { valid = false; break; }
    }
    if (!valid) { fail("invalid_timing_segments"); continue; }
    const window: Interval = { start: parseInstant(timing.preparationStartAt)!, end: parseInstant(event.timeSlot.startsAt)! };
    if (compareInstant(window.start, window.end) < 0 && windows.some(other => compareInstant(window.start, other.end) < 0 && compareInstant(other.start, window.end) < 0)) {
      fail("overlapping_timing_constraints"); continue;
    }
    ids.forEach(id => used.add(id));
    if (compareInstant(window.start, window.end) < 0) windows.push(window);
  }
}

/**
 * This is a pure check, not authentication, approval, application or a lock.
 * The caller supplies a server-fetched snapshot and must revalidate atomically
 * against current schedule/context revisions when applying any accepted plan.
 */
export function assessChanges(input: ChangeValidationContext): ChangeAssessment {
  if (!input || !isId(input.authenticatedUserId) || input.authenticatedUserId !== input.snapshotUserId) {
    throw new Error("Authenticated user and snapshot scope do not match");
  }
  const snapshot = input.snapshot;
  const checkedAt = parseInstant(input.checkedAt);
  if (!snapshot || !isRevision(snapshot.scheduleRevision, 0) || !isRevision(snapshot.contextRevision, 0) ||
    !checkedAt || !parseInstant(snapshot.now) || !isTimezone(snapshot.timezone) ||
    !Array.isArray(snapshot.items) || !Array.isArray(snapshot.facts) || !Array.isArray(snapshot.missingFields) ||
    !snapshot.missingFields.every(isId) || !["ai_proposal", "user_command"].includes(input.purpose)) {
    throw new Error("Invalid server validation context");
  }
  const validation: ValidationResult = {
    valid: false, conflicts: [], missingFields: [...snapshot.missingFields], protectedTargets: [],
    checkedScheduleRevision: snapshot.scheduleRevision, checkedContextRevision: snapshot.contextRevision, checkedAt: input.checkedAt,
  };
  const invalidAssessment = (): ChangeAssessment => ({ validation, mode: null, coordinationTarget: null });
  const current = new Map<string, { item: ScheduleItem; interval: Interval | null }>();
  for (const [index, item] of snapshot.items.entries()) {
    if (!isRecord(item) || !isId(item.id) || !isRevision(item.revision, 1) || !validSourceRefs(item.sourceRefs) || current.has(item.id)) {
      validation.conflicts.push({ targetIds: [], reason: `invalid_snapshot:items[${index}]` });
      continue;
    }
    // A legacy short slot may be the very item the user is trying to repair.
    const parsed = parseFields(item, `snapshot.items[${index}]`, [item.id], validation, false);
    if (parsed) current.set(item.id, { item: item as unknown as ScheduleItem, interval: parsed.interval });
  }
  if (validation.conflicts.length || validation.missingFields.length) return invalidAssessment();

  if (!isRecord(input.changeSet) || !Array.isArray(input.changeSet.changes)) {
    validation.conflicts.push({ targetIds: [], reason: "invalid_change_set" });
    return invalidAssessment();
  }
  if (input.changeSet.changes.length === 0) {
    validation.conflicts.push({ targetIds: [], reason: "empty_change_set" });
    return invalidAssessment();
  }

  const selected = input.coordinationTarget;
  if (selected != null) {
    const target = isRecord(selected) && isId(selected.id) ? current.get(selected.id) : undefined;
    if (!target || !isRevision(selected.expectedRevision, 1) || target.item.kind !== "event" || target.item.involvement !== "shared") {
      validation.conflicts.push({ targetIds: [], reason: "invalid_coordination_target" });
    } else if (target.item.revision !== selected.expectedRevision) {
      validation.conflicts.push({ targetIds: [target.item.id], reason: "stale_coordination_target" });
    } else if (target.item.completion === "completed") {
      validation.protectedTargets.push(target.item.id);
    }
  }
  if (validation.conflicts.length || validation.protectedTargets.length) return invalidAssessment();

  type FinalInterval = { itemId: string | null; changeId: string | null; interval: Interval };
  const changedTargets = new Set<string>();
  const changeIds = new Set<string>();
  const afterIntervals: FinalInterval[] = [];
  const coordinationTargets = new Map<string, CoordinationTarget>();
  let effectiveChange = false;

  for (const [index, value] of input.changeSet.changes.entries()) {
    const path = `changes[${index}]`;
    if (!isRecord(value) || !isId(value.changeId) || !["create", "update", "delete"].includes(value.operation as string)) {
      validation.conflicts.push({ targetIds: [], reason: `invalid_change:${path}` });
      continue;
    }
    if (changeIds.has(value.changeId)) {
      validation.conflicts.push({ targetIds: [], reason: `duplicate_change_id:${value.changeId}` });
      continue;
    }
    changeIds.add(value.changeId);
    if (input.purpose === "ai_proposal" && selected && (value.operation === "create" || value.targetId !== selected.id)) {
      validation.conflicts.push({ targetIds: [], reason: `outside_coordination_scope:${path}` });
      continue;
    }
    const change = value as unknown as Change;
    if (change.operation === "create" || change.operation === "delete") effectiveChange = true;
    const targetIds = change.operation === "create" ? [] : isId(change.targetId) ? [change.targetId] : [];
    const after = change.operation === "delete" ? null : parseFields(change.after, `${path}.after`, targetIds, validation);
    let placementChanged = change.operation === "create";
    if (change.operation !== "create") {
      if (!isId(change.targetId) || !isRevision(change.expectedRevision, 1)) {
        validation.conflicts.push({ targetIds: [], reason: `invalid_target:${path}` });
        continue;
      }
      if (changedTargets.has(change.targetId)) {
        validation.conflicts.push({ targetIds: [change.targetId], reason: "duplicate_target" });
        continue;
      }
      changedTargets.add(change.targetId);
      const target = current.get(change.targetId);
      if (!target) {
        validation.conflicts.push({ targetIds: [change.targetId], reason: "target_not_found" });
        continue;
      }
      if (target.item.revision !== change.expectedRevision) {
        validation.conflicts.push({ targetIds: [change.targetId], reason: "stale_target" });
        continue;
      }
      if (change.operation === "update" && after) {
        if (after.fields.kind === "task" && after.fields.attendance === undefined && target.item.attendance != null) {
          validation.conflicts.push({ targetIds: [target.item.id], reason: `invalid_field:${path}.after.attendance` });
        }
        placementChanged = !sameInterval(target.interval, after.interval) ||
          target.item.timeSlot?.timezone !== after.fields.timeSlot?.timezone;
        if (!sameFields(target.item, target.interval, after)) effectiveChange = true;
      }
      if (target.item.kind === "task" && target.item.involvement === "shared" &&
        (change.operation === "delete" || (change.operation === "update" && after &&
          (after.fields.involvement !== "shared" || placementChanged)))) {
        validation.conflicts.push({ targetIds: [target.item.id], reason: "shared_task_change_unsupported" });
      }
      const requiresCoordination = coordinationChange(target.item, target.interval, change, after);
      if (requiresCoordination) coordinationTargets.set(target.item.id, { id: target.item.id, expectedRevision: target.item.revision });
      const keepsOtherFields = coordinationAlternativeKeepsOtherFields(target.item, change, after);
      if (input.purpose === "ai_proposal" && requiresCoordination && !keepsOtherFields) {
        validation.conflicts.push({ targetIds: [target.item.id], reason: "coordination_fields_changed" });
      }
      const selectedFixedAlternative = input.purpose === "ai_proposal" && selected?.id === target.item.id &&
        selected.expectedRevision === target.item.revision && requiresCoordination && keepsOtherFields;
      if (input.purpose === "ai_proposal" && (target.item.completion === "completed" || (target.item.flexibility === "fixed" && !selectedFixedAlternative))) {
        validation.protectedTargets.push(target.item.id);
      }
    }
    if (input.purpose === "ai_proposal" && placementChanged && after?.interval && compareInstant(after.interval.start, checkedAt) < 0) {
      validation.conflicts.push({ targetIds, reason: "past_placement" });
    }
    if (after?.interval) afterIntervals.push({ itemId: change.operation === "create" ? null : change.targetId, changeId: change.changeId, interval: after.interval });
  }

  if (coordinationTargets.size > 1) {
    validation.conflicts.push({ targetIds: [...coordinationTargets.keys()], reason: "multiple_coordination_targets" });
  }
  if (input.purpose === "ai_proposal" && selected && !coordinationTargets.has(selected.id)) {
    validation.conflicts.push({ targetIds: [selected.id], reason: "coordination_target_unchanged" });
  }
  if (validation.conflicts.length || validation.missingFields.length || validation.protectedTargets.length) return invalidAssessment();
  validateTimingConstraints(input.changeSet, current, changedTargets, validation);
  if (validation.conflicts.length || validation.missingFields.length) return invalidAssessment();
  if (input.purpose === "ai_proposal" && !effectiveChange) {
    validation.conflicts.push({ targetIds: [...changedTargets], reason: "no_effective_change" });
    return invalidAssessment();
  }

  const remaining: FinalInterval[] = [...current.values()]
    .filter(({ item, interval }) => !changedTargets.has(item.id) && interval !== null)
    .map(({ item, interval }) => ({ itemId: item.id, changeId: null, interval: interval! }));
  const finalIntervals = [...remaining, ...afterIntervals];
  for (let i = 0; i < finalIntervals.length; i++) {
    for (let j = i + 1; j < finalIntervals.length; j++) {
      const a = finalIntervals[i];
      const b = finalIntervals[j];
      if (!a.changeId && !b.changeId) continue;
      if (compareInstant(a.interval.start, b.interval.end) < 0 && compareInstant(b.interval.start, a.interval.end) < 0) {
        const ids = [a.itemId, b.itemId].filter((id): id is string => id !== null);
        const changeRefs = [a.changeId, b.changeId].filter((id): id is string => id !== null).join(",");
        validation.conflicts.push({ targetIds: ids, reason: `overlap:${changeRefs}` });
      }
    }
  }
  const coordinationTarget = coordinationTargets.values().next().value ?? null;
  const mode: ProposalMode = coordinationTarget ? "coordination" : "personal";
  if (input.purpose === "user_command" && coordinationTarget) {
    validation.conflicts.push({ targetIds: [coordinationTarget.id], reason: "contact_required" });
  }
  validation.valid = validation.conflicts.length === 0 && validation.missingFields.length === 0 && validation.protectedTargets.length === 0;
  return { validation, mode, coordinationTarget };
}

/** The v1 validate_changes Tool output, without the separate coordination assessment. */
export function validateChanges(input: ChangeValidationContext): ValidationResult {
  return assessChanges(input).validation;
}

/** Checks both proposal base revisions only; authorization and atomic application are separate. */
export function hasCurrentSnapshotRevisions(
  proposal: Pick<Proposal, "baseScheduleRevision" | "baseContextRevision">,
  snapshot: Pick<ContextSnapshot, "scheduleRevision" | "contextRevision">,
): boolean {
  return !!proposal && !!snapshot &&
    isRevision(proposal.baseScheduleRevision, 0) && isRevision(proposal.baseContextRevision, 0) &&
    isRevision(snapshot.scheduleRevision, 0) && isRevision(snapshot.contextRevision, 0) &&
    proposal.baseScheduleRevision === snapshot.scheduleRevision && proposal.baseContextRevision === snapshot.contextRevision;
}

/** Adapts the existing pure timing function to the v1 calculate_timing output. */
export function calculateTiming(input: Partial<CalculateTimingInput>): CalculateTimingOutput {
  const safeInput = input ?? {};
  const originalInstant = parseInstant(safeInput.appointmentStart);
  const excessPrecision = typeof safeInput.appointmentStart === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d+(Z|[+-]\d{2}:\d{2})$/.exec(safeInput.appointmentStart)
    : null;
  const appointmentStart = excessPrecision ? `${excessPrecision[1]}${excessPrecision[2]}` : safeInput.appointmentStart;
  const result = calculatePreparationTimes({ ...safeInput, appointmentStart });
  if (result.status === "ready") {
    const appendPrecision = (value: string) => value.replace(/Z$/, `${originalInstant?.remainder ?? ""}Z`);
    return { ready: true, departureAt: appendPrecision(result.departureTime), preparationStartAt: appendPrecision(result.preparationStart) };
  }
  if (result.status === "missing") return { ready: false, missingFields: result.fields, message: "Required timing information is missing." };
  const required: (keyof CalculateTimingInput)[] = ["appointmentStart", "preparationMinutes", "travelMinutes", "bufferMinutes"];
  return { ready: false, missingFields: required.filter((field) => safeInput[field] == null), message: `Invalid timing information: ${result.fields.join(", ")}.` };
}
