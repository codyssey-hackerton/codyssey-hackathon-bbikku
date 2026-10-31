import assert from "node:assert/strict";
import test from "node:test";
import { assessChanges, calculateTiming, hasCurrentSnapshotRevisions, parseOffsetDateTime, validateChanges } from "@pikku/domain";
import type { Change, ChangeValidationContext, ContextSnapshot, ScheduleFields, ScheduleItem } from "@pikku/domain";

const fields = (overrides: Partial<ScheduleFields> = {}): ScheduleFields => ({
  kind: "event", title: "Meeting", timeSlot: { startsAt: "2026-10-31T15:00+09:00", endsAt: "2026-10-31T16:00+09:00", timezone: "Asia/Seoul" },
  durationMinutes: null, deadline: null, flexibility: "flexible", involvement: "personal", completion: "pending", ...overrides,
});
const item = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({ id: "meeting", revision: 2, sourceRefs: [], ...fields(), ...overrides });
const snapshot = (items: ScheduleItem[] = [item()]): ContextSnapshot => ({
  now: "2026-10-31T10:00+09:00", timezone: "Asia/Seoul", scheduleRevision: 5, contextRevision: 7,
  items, facts: [], missingFields: [],
});
const update = (target: ScheduleItem, after: ScheduleFields, changeId = "change-1"): Change => ({
  changeId, operation: "update", targetId: target.id, expectedRevision: target.revision, after,
});
const moved = (target: ScheduleItem, startsAt = "2026-10-31T17:00+09:00", endsAt = "2026-10-31T18:00+09:00"): ScheduleFields => ({
  ...target, timeSlot: { startsAt, endsAt, timezone: "Asia/Seoul" },
});
const request = (changes: Change[], overrides: Partial<ChangeValidationContext> = {}): ChangeValidationContext => ({
  authenticatedUserId: "alice", snapshotUserId: "alice", snapshot: snapshot(), changeSet: { changes },
  purpose: "ai_proposal", checkedAt: "2026-10-31T10:00+09:00", ...overrides,
});

test("public package entry exposes old functions and the v1 timing adapter", () => {
  assert.equal(typeof parseOffsetDateTime, "function");
  assert.deepEqual(calculateTiming({ appointmentStart: "2026-10-31T15:00+09:00", preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 }), {
    ready: true, departureAt: "2026-10-31T05:20:00.000Z", preparationStartAt: "2026-10-31T05:05:00.000Z",
  });
  const missing = calculateTiming({ appointmentStart: "2026-10-31T15:00+09:00", preparationMinutes: 15, bufferMinutes: 10 });
  assert.equal(missing.ready, false);
  if (!missing.ready) assert.deepEqual(missing.missingFields, ["travelMinutes"]);
  const invalid = calculateTiming({ appointmentStart: "2026-10-31T15:00+09:00", preparationMinutes: 15, travelMinutes: -1, bufferMinutes: 10 });
  assert.equal(invalid.ready, false);
  if (!invalid.ready) assert.deepEqual(invalid.missingFields, []);
  const precise = calculateTiming({ appointmentStart: "2026-10-31T15:00:00.0001234000+09:00", preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 });
  assert.deepEqual(precise, { ready: true, departureAt: "2026-10-31T05:20:00.0001234Z", preparationStartAt: "2026-10-31T05:05:00.0001234Z" });
  const missingAndInvalid = calculateTiming({ appointmentStart: "2026-10-31T15:00+09:00", travelMinutes: -1, bufferMinutes: 10 });
  if (!missingAndInvalid.ready) assert.deepEqual(missingAndInvalid.missingFields, ["preparationMinutes"]);
});

test("requires event time and task duration, but allows an unplaced task", () => {
  const newItem = (after: ScheduleFields): Change => ({ changeId: "new", operation: "create", after });
  const eventMissingTime = validateChanges(request([newItem(fields({ timeSlot: null }))]));
  assert.equal(eventMissingTime.valid, false);
  assert.ok(eventMissingTime.missingFields.includes("changes[0].after.timeSlot"));
  const taskMissingDuration = validateChanges(request([newItem(fields({ kind: "task", timeSlot: null, durationMinutes: null }))]));
  assert.ok(taskMissingDuration.missingFields.includes("changes[0].after.durationMinutes"));
  const taskZeroDuration = validateChanges(request([newItem(fields({ kind: "task", timeSlot: null, durationMinutes: 0 }))]));
  assert.ok(taskZeroDuration.conflicts.some((conflict) => conflict.reason.includes("durationMinutes")));
  const unplacedTask = validateChanges(request([newItem(fields({ kind: "task", timeSlot: null, durationMinutes: 30 }))]));
  assert.equal(unplacedTask.valid, true);
});

test("validates explicit offsets, valid IANA zones and ordered ranges", () => {
  const original = item();
  const invalidSlots = [
    { startsAt: "2026-10-31T17:00", endsAt: "2026-10-31T18:00+09:00", timezone: "Asia/Seoul" },
    { startsAt: "2026-02-30T17:00+09:00", endsAt: "2026-10-31T18:00+09:00", timezone: "Asia/Seoul" },
    { startsAt: "2026-10-31T17:00+09:00", endsAt: "2026-10-31T17:00+09:00", timezone: "Asia/Seoul" },
    { startsAt: "2026-10-31T17:00+09:00", endsAt: "2026-10-31T18:00+09:00", timezone: "+09:00" },
    { startsAt: "2026-10-31T17:00+09:00", endsAt: "2026-10-31T18:00+09:00", timezone: "Mars/Olympus" },
  ];
  for (const timeSlot of invalidSlots) {
    const result = validateChanges(request([update(original, { ...original, timeSlot })]));
    assert.equal(result.valid, false, JSON.stringify(timeSlot));
  }
});

test("deadline is inclusive and compares exact sub-millisecond instants", () => {
  const base = item();
  const sameInstant = { startsAt: "2026-10-31T17:00+09:00", endsAt: "2026-10-31T18:00:00.0000008+09:00", timezone: "Asia/Seoul" };
  const atDeadline = validateChanges(request([update(base, { ...base, timeSlot: sameInstant, deadline: "2026-10-31T09:00:00.0000008Z" })]));
  assert.equal(atDeadline.valid, true);
  const beyondDeadline = validateChanges(request([update(base, { ...base, timeSlot: sameInstant, deadline: "2026-10-31T09:00:00.0000007Z" })]));
  assert.ok(beyondDeadline.conflicts.some((conflict) => conflict.reason.startsWith("deadline_exceeded:")));
});

test("overlap uses half-open intervals and keeps sub-millisecond precision", () => {
  const existing = item({ timeSlot: { startsAt: "2026-10-31T06:00:00.0000003Z", endsAt: "2026-10-31T06:00:00.0000006Z", timezone: "UTC" } });
  const candidate = (startsAt: string): Change => ({ changeId: "new", operation: "create", after: fields({
    timeSlot: { startsAt, endsAt: "2026-10-31T06:00:00.0000010Z", timezone: "UTC" },
  }) });
  assert.equal(validateChanges(request([candidate("2026-10-31T06:00:00.0000006Z")], { snapshot: snapshot([existing]) })).valid, true);
  const overlapping = validateChanges(request([candidate("2026-10-31T06:00:00.0000005Z")], { snapshot: snapshot([existing]) }));
  assert.equal(overlapping.valid, false);
  assert.deepEqual(overlapping.conflicts[0].targetIds, ["meeting"]);
  assert.match(overlapping.conflicts[0].reason, /^overlap:/);
});

test("evaluates the final atomic change set without conflicting with old target slots", () => {
  const existing = item();
  const create: Change = { changeId: "new", operation: "create", after: fields() };
  const context = request([update(existing, moved(existing)), create]);
  assert.equal(validateChanges(context).valid, true);
  const duplicate = validateChanges(request([update(existing, moved(existing), "a"), { changeId: "b", operation: "delete", targetId: existing.id, expectedRevision: existing.revision }]));
  assert.ok(duplicate.conflicts.some((conflict) => conflict.reason === "duplicate_target"));
  const overlappingCreates = validateChanges(request([create, { ...create, changeId: "new-2" }], { snapshot: snapshot([]) }));
  assert.ok(overlappingCreates.conflicts.some((conflict) => conflict.reason === "overlap:new,new-2"));
});

test("stale or missing targets fail and user scope must be server supplied", () => {
  const existing = item();
  const change = update(existing, moved(existing));
  assert.equal(change.operation, "update");
  if (change.operation !== "update") return;
  assert.ok(validateChanges(request([{ ...change, expectedRevision: 1 }])).conflicts.some((conflict) => conflict.reason === "stale_target"));
  assert.ok(validateChanges(request([{ ...change, targetId: "other" }])).conflicts.some((conflict) => conflict.reason === "target_not_found"));
  assert.throws(() => validateChanges(request([change], { snapshotUserId: "bob" })), /scope do not match/);
  const validation = validateChanges(request([change]));
  assert.equal(validation.checkedScheduleRevision, 5);
  assert.equal(validation.checkedContextRevision, 7);
});

test("proposal freshness checks both snapshot revisions even when content is unchanged", () => {
  const proposal = { baseScheduleRevision: 5, baseContextRevision: 7 };
  const current = snapshot();
  assert.equal(hasCurrentSnapshotRevisions(proposal, current), true);
  assert.equal(hasCurrentSnapshotRevisions(proposal, { ...current, scheduleRevision: 6 }), false);
  assert.equal(hasCurrentSnapshotRevisions(proposal, { ...current, contextRevision: 8 }), false);
  assert.equal(hasCurrentSnapshotRevisions({ ...proposal, baseScheduleRevision: -1 }, { ...current, scheduleRevision: -1 }), false);
});

test("AI cannot change fixed or completed items without the narrow fixed coordination exception", () => {
  for (const existing of [item({ flexibility: "fixed" }), item({ completion: "completed" })]) {
    const result = validateChanges(request([update(existing, moved(existing))], { snapshot: snapshot([existing]) }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.protectedTargets, ["meeting"]);
  }
});

test("selected fixed shared event permits only its current, review-only coordination alternative", () => {
  const shared = item({ flexibility: "fixed", involvement: "shared" });
  const selected = { id: shared.id, expectedRevision: shared.revision };
  const context = request([update(shared, moved(shared))], { snapshot: snapshot([shared]), coordinationTarget: selected });
  const assessment = assessChanges(context);
  assert.equal(assessment.validation.valid, true);
  assert.equal(assessment.mode, "coordination");
  assert.deepEqual(assessment.coordinationTarget, selected);
  assert.equal(validateChanges({ ...context, coordinationTarget: undefined }).valid, false);
  assert.ok(validateChanges({ ...context, coordinationTarget: { ...selected, expectedRevision: 1 } }).conflicts.some((conflict) => conflict.reason === "stale_coordination_target"));
  const completed = { ...shared, completion: "completed" } as ScheduleItem;
  assert.deepEqual(validateChanges({ ...context, snapshot: snapshot([completed]) }).protectedTargets, ["meeting"]);
  const editOtherFields = update(shared, { ...moved(shared), title: "Different title" });
  assert.deepEqual(validateChanges({ ...context, changeSet: { changes: [editOtherFields] } }).protectedTargets, ["meeting"]);
  const unrelated: Change = { changeId: "new", operation: "create", after: fields({ timeSlot: null, kind: "task", durationMinutes: 30 }) };
  assert.ok(validateChanges({ ...context, changeSet: { changes: [update(shared, moved(shared)), unrelated] } }).conflicts.some((conflict) => conflict.reason.startsWith("outside_coordination_scope:")));
});

test("shared creation and metadata-only edits are personal, but direct time changes and shared-to-personal require contact", () => {
  const shared = item({ involvement: "shared" });
  const create: Change = { changeId: "new", operation: "create", after: fields({ involvement: "shared", timeSlot: { startsAt: "2026-10-31T18:00+09:00", endsAt: "2026-10-31T19:00+09:00", timezone: "Asia/Seoul" } }) };
  assert.equal(assessChanges(request([create])).mode, "personal");
  const context = { snapshot: snapshot([shared]), purpose: "user_command" as const };
  const metadata = assessChanges(request([update(shared, { ...shared, title: "Revised" })], context));
  assert.equal(metadata.validation.valid, true);
  assert.equal(metadata.mode, "personal");
  for (const after of [moved(shared), { ...shared, involvement: "personal" as const }]) {
    const result = assessChanges(request([update(shared, after)], context));
    assert.equal(result.mode, "coordination");
    assert.equal(result.validation.valid, false);
    assert.ok(result.validation.conflicts.some((conflict) => conflict.reason === "contact_required"));
  }
});

test("multiple shared appointment coordination targets cannot form one v1 proposal", () => {
  const a = item({ id: "a", involvement: "shared" });
  const b = item({ id: "b", involvement: "shared", timeSlot: { startsAt: "2026-10-31T12:00+09:00", endsAt: "2026-10-31T13:00+09:00", timezone: "Asia/Seoul" } });
  const context = request([update(a, moved(a), "a-change"), update(b, moved(b, "2026-10-31T19:00+09:00", "2026-10-31T20:00+09:00"), "b-change")], { snapshot: snapshot([a, b]) });
  assert.ok(validateChanges(context).conflicts.some((conflict) => conflict.reason === "multiple_coordination_targets"));
});

test("malformed snapshot or missing context cannot produce a valid result", () => {
  const duplicate = snapshot([item(), item()]);
  assert.equal(validateChanges(request([], { snapshot: duplicate })).valid, false);
  const missing = snapshot([]);
  missing.missingFields = ["travelMinutes"];
  const result = validateChanges(request([], { snapshot: missing }));
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFields, ["travelMinutes"]);
});
