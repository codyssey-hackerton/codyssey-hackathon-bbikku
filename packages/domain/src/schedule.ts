import { validateTimeRange } from "./time.ts";
import type { TimeRange, TimeRangeError } from "./time.ts";

export type EventVersion = string | number;

export interface TimedEvent extends TimeRange {
  id: string;
  userId: string;
}

export interface ScheduledEvent extends TimedEvent {
  version: EventVersion;
  isFixed: boolean;
  status: "planned" | "completed";
}

export interface ScheduleProposal {
  userId: string;
  targetId: string;
  targetVersion: EventVersion;
  range: TimeRange;
}

export type ConflictResult<T extends TimedEvent> =
  | { valid: true; conflicts: T[] }
  | { valid: false; reason: "invalid-user" }
  | { valid: false; reason: "invalid-range"; detail: TimeRangeError }
  | { valid: false; reason: "invalid-event"; index: number; detail?: TimeRangeError };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validVersion(version: unknown): version is EventVersion {
  return nonEmpty(version) || (typeof version === "number" && Number.isSafeInteger(version) && version >= 0);
}

/** Intervals are half-open: an event ending when another starts is not a conflict. */
export function findConflicts<T extends TimedEvent>(
  userId: string,
  range: TimeRange,
  events: readonly T[],
  excludeEventId?: string,
): ConflictResult<T> {
  if (!nonEmpty(userId)) return { valid: false, reason: "invalid-user" };
  const proposed = validateTimeRange(range);
  if (!proposed.valid) return { valid: false, reason: "invalid-range", detail: proposed.reason };

  const conflicts: T[] = [];
  for (const [index, event] of events.entries()) {
    // An unidentified owner cannot safely be assumed to belong to someone else.
    if (!event || !nonEmpty(event.userId)) return { valid: false, reason: "invalid-event", index };
    if (event.userId !== userId) continue;
    if (!nonEmpty(event.id)) return { valid: false, reason: "invalid-event", index };
    if (event.id === excludeEventId) continue;
    const current = validateTimeRange(event);
    if (!current.valid) return { valid: false, reason: "invalid-event", index, detail: current.reason };
    if (proposed.startMs < current.endMs && current.startMs < proposed.endMs) conflicts.push(event);
  }
  return { valid: true, conflicts };
}

export type ProposalValidation =
  | { valid: true }
  | { valid: false; reason: "invalid-proposal" | "target-not-found" | "ambiguous-target" | "invalid-target" | "stale-proposal" | "protected-event" }
  | { valid: false; reason: "invalid-range"; detail: TimeRangeError }
  | { valid: false; reason: "invalid-event"; index: number; detail?: TimeRangeError }
  | { valid: false; reason: "conflict"; conflicts: ScheduledEvent[] };

/**
 * Validates only: it does not approve or apply the change. Call with freshly
 * loaded state; storage must enforce version checks atomically when applying.
 */
export function validateScheduleProposal(
  proposal: ScheduleProposal,
  events: readonly ScheduledEvent[],
): ProposalValidation {
  if (!proposal || !nonEmpty(proposal.userId) || !nonEmpty(proposal.targetId) || !validVersion(proposal.targetVersion)) {
    return { valid: false, reason: "invalid-proposal" };
  }
  const targets = events.filter((event) => event?.userId === proposal.userId && event?.id === proposal.targetId);
  if (targets.length === 0) return { valid: false, reason: "target-not-found" };
  if (targets.length > 1) return { valid: false, reason: "ambiguous-target" };
  const target = targets[0];
  if (
    !validVersion(target.version) || typeof target.isFixed !== "boolean" ||
    (target.status !== "planned" && target.status !== "completed") || !validateTimeRange(target).valid
  ) return { valid: false, reason: "invalid-target" };
  if (target.version !== proposal.targetVersion) return { valid: false, reason: "stale-proposal" };
  if (target.isFixed || target.status === "completed") return { valid: false, reason: "protected-event" };

  const check = findConflicts(proposal.userId, proposal.range, events, proposal.targetId);
  if (!check.valid) {
    if (check.reason === "invalid-user") return { valid: false, reason: "invalid-proposal" };
    return check;
  }
  if (check.conflicts.length) return { valid: false, reason: "conflict", conflicts: check.conflicts };
  return { valid: true };
}
