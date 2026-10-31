import assert from "node:assert/strict";
import test from "node:test";
import { assessChanges, validateChanges } from "@pikku/domain";
import type { Change, ChangeValidationContext, ContextSnapshot, ScheduleFields, ScheduleItem, TimeSlot } from "@pikku/domain";

const slot = (startsAt: string, endsAt: string, timezone = "UTC"): TimeSlot => ({ startsAt, endsAt, timezone });
const task = (overrides: Partial<ScheduleFields> = {}): ScheduleFields => ({
  kind: "task", title: "task", timeSlot: null, durationMinutes: 30, deadline: null,
  flexibility: "flexible", involvement: "personal", completion: "pending", ...overrides,
});
const event = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id: "event-1", revision: 1, sourceRefs: [], kind: "event", title: "meeting",
  timeSlot: slot("2026-11-01T07:00Z", "2026-11-01T08:00Z"), durationMinutes: null, deadline: null,
  flexibility: "flexible", involvement: "personal", completion: "pending", ...overrides,
});
const snapshot = (items: ScheduleItem[] = []): ContextSnapshot => ({
  now: "2026-10-31T10:00Z", timezone: "UTC", scheduleRevision: 1, contextRevision: 1,
  items, facts: [], missingFields: [],
});
const request = (changes: Change[], overrides: Partial<ChangeValidationContext> = {}): ChangeValidationContext => ({
  authenticatedUserId: "user-a", snapshotUserId: "user-a", snapshot: snapshot(), changeSet: { changes },
  purpose: "ai_proposal", checkedAt: "2026-10-31T10:00Z", ...overrides,
});
const create = (after: ScheduleFields, changeId = "create-1"): Change => ({ changeId, operation: "create", after });

test("an empty change set is not a valid proposal or direct command", () => {
  for (const purpose of ["ai_proposal", "user_command"] as const) {
    const input = request([], { purpose, snapshot: snapshot([event({ flexibility: "fixed" })]) });
    const before = structuredClone(input);
    const validation = validateChanges(input);
    assert.equal(validation.valid, false);
    assert.ok(validation.conflicts.some(({ reason }) => reason === "empty_change_set"));
    assert.deepEqual(input, before);
  }
});

test("one incomplete task can move after a fixed event only within its deadline", () => {
  const fields = task({ completion: "incomplete", deadline: "2026-11-01T08:30Z",
    timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T05:30Z") });
  const unfinished: ScheduleItem = { ...fields, id: "study", revision: 2, sourceRefs: [] };
  const school = event({ id: "school", flexibility: "fixed" });
  const completed: ScheduleItem = { ...task({ completion: "completed",
    timeSlot: slot("2026-10-31T08:00Z", "2026-10-31T08:30Z") }), id: "done", revision: 1, sourceRefs: [] };
  const move = (timeSlot: TimeSlot): Change => ({ changeId: "move", operation: "update",
    targetId: unfinished.id, expectedRevision: unfinished.revision, after: { ...fields, timeSlot } });
  const input = request([move(slot("2026-11-01T08:00Z", "2026-11-01T08:30Z"))], {
    snapshot: snapshot([unfinished, school, completed]),
  });
  const before = structuredClone(input);
  const result = assessChanges(input);
  assert.equal(result.validation.valid, true);
  assert.equal(result.mode, "personal");
  assert.deepEqual(input, before);

  const missing = assessChanges({ ...input, snapshot: { ...input.snapshot, missingFields: ["taskValidity"] } });
  assert.equal(missing.validation.valid, false);
  assert.deepEqual(missing.validation.missingFields, ["taskValidity"]);
  const late = assessChanges({ ...input, changeSet: { changes: [move(slot("2026-11-01T08:00Z", "2026-11-01T08:30:00.000001Z"))] } });
  assert.equal(late.validation.valid, false);
  assert.ok(late.validation.conflicts.some(({ reason }) => reason.startsWith("deadline_exceeded:")));
  const overlap = assessChanges({ ...input, changeSet: { changes: [move(slot("2026-11-01T07:30Z", "2026-11-01T08:00Z"))] } });
  assert.equal(overlap.validation.valid, false);
  assert.ok(overlap.validation.conflicts.some(({ reason, targetIds }) => reason.startsWith("overlap:") && targetIds.includes(school.id)));
  assert.deepEqual(input, before);
});

test("AI cannot move or delete a completed or fixed task", () => {
  for (const overrides of [{ completion: "completed" as const }, { flexibility: "fixed" as const }]) {
    const fields = task({ ...overrides, timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T05:30Z") });
    const existing: ScheduleItem = { ...fields, id: "protected-task", revision: 1, sourceRefs: [] };
    const changes: Change[] = [
      { changeId: "move", operation: "update", targetId: existing.id, expectedRevision: 1,
        after: { ...fields, timeSlot: slot("2026-11-01T06:00Z", "2026-11-01T06:30Z") } },
      { changeId: "delete", operation: "delete", targetId: existing.id, expectedRevision: 1 },
    ];
    for (const change of changes) {
      const input = request([change], { snapshot: snapshot([existing]) });
      const before = structuredClone(input);
      const validation = validateChanges(input);
      assert.equal(validation.valid, false);
      assert.deepEqual(validation.protectedTargets, [existing.id]);
      assert.deepEqual(input, before);
    }
  }
});

test("a placed task must have at least its duration; an unplaced task remains valid", () => {
  const makeTask = (end: string) => create(task({ timeSlot: slot("2026-11-01T05:00:00Z", end), durationMinutes: 30 }));
  assert.equal(validateChanges(request([makeTask("2026-11-01T05:30:00Z")])).valid, true);
  assert.equal(validateChanges(request([makeTask("2026-11-01T05:45:00Z")])).valid, true);
  const short = validateChanges(request([makeTask("2026-11-01T05:29:59.999999Z")]));
  assert.equal(short.valid, false);
  assert.ok(short.conflicts.some(({ reason }) => reason.startsWith("insufficient_task_duration:")));
  assert.equal(validateChanges(request([create(task())])).valid, true);
});

test("a user can repair a previously stored task whose slot was too short", () => {
  const previous: ScheduleItem = {
    ...task({ timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T05:10Z"), durationMinutes: 30 }),
    id: "task-1", revision: 1, sourceRefs: [],
  };
  const correction: Change = {
    changeId: "fix", operation: "update", targetId: previous.id, expectedRevision: 1,
    after: { ...previous, timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T05:30Z") },
  };
  assert.equal(validateChanges(request([correction], { snapshot: snapshot([previous]), purpose: "user_command" })).valid, true);
  const stillInvalid = { ...correction, after: { ...previous, title: "renamed" } } as Change;
  assert.equal(validateChanges(request([stillInvalid], { snapshot: snapshot([previous]), purpose: "user_command" })).valid, false);
});

test("task duration comparisons preserve fractional-minute and sub-millisecond precision", () => {
  const start = "2026-11-01T05:00:00.0009999Z";
  const makeTask = (end: string) => create(task({ timeSlot: slot(start, end), durationMinutes: 1e-7 }));
  assert.equal(validateChanges(request([makeTask("2026-11-01T05:00:00.0010059Z")])).valid, true);
  assert.equal(validateChanges(request([makeTask("2026-11-01T05:00:00.0010058Z")])).valid, false);
  assert.equal(validateChanges(request([create(task({ timeSlot: slot(start, "2026-11-01T05:01:00Z"), durationMinutes: 1e100 }))])).valid, false);
});

test("task elapsed time uses instants across both daylight-saving transitions", () => {
  const fall = task({ timeSlot: slot("2026-11-01T01:30-04:00", "2026-11-01T01:15-05:00", "America/New_York"), durationMinutes: 45 });
  assert.equal(validateChanges(request([create(fall)])).valid, true);
  assert.equal(validateChanges(request([create({ ...fall, durationMinutes: 46 })])).valid, false);
  const spring = task({ timeSlot: slot("2027-03-14T01:30-05:00", "2027-03-14T03:15-04:00", "America/New_York"), durationMinutes: 45 });
  assert.equal(validateChanges(request([create(spring)])).valid, true);
  assert.equal(validateChanges(request([create({ ...spring, durationMinutes: 60 })])).valid, false);
});

test("runtime input types, duplicated change IDs, and ambiguous targets fail closed", () => {
  const invalidDuration = create({ ...task(), durationMinutes: "30" } as unknown as ScheduleFields);
  assert.equal(validateChanges(request([invalidDuration])).valid, false);
  const invalidOperation = { changeId: "bad", operation: "replace", after: task() } as unknown as Change;
  assert.equal(validateChanges(request([invalidOperation])).valid, false);
  const duplicateChangeIds = validateChanges(request([create(task(), "same"), create(task(), "same")]));
  assert.ok(duplicateChangeIds.conflicts.some(({ reason }) => reason.startsWith("duplicate_change_id:")));
  const existing = event({ involvement: "shared" });
  const updates: Change[] = [
    { changeId: "a", operation: "update", targetId: existing.id, expectedRevision: 1, after: { ...existing, involvement: "personal" } },
    { changeId: "b", operation: "delete", targetId: existing.id, expectedRevision: 1 },
  ];
  const ambiguous = validateChanges(request(updates, { snapshot: snapshot([existing]), purpose: "user_command" }));
  assert.equal(ambiguous.valid, false);
  assert.ok(ambiguous.conflicts.some(({ reason }) => reason === "duplicate_target"));
});

test("direct shared deletion needs contact; AI cannot delete an unselected fixed or completed event", () => {
  const shared = event({ involvement: "shared" });
  const deletion: Change = { changeId: "delete", operation: "delete", targetId: shared.id, expectedRevision: 1 };
  const direct = assessChanges(request([deletion], { snapshot: snapshot([shared]), purpose: "user_command" }));
  assert.equal(direct.validation.valid, false);
  assert.ok(direct.validation.conflicts.some(({ reason }) => reason === "contact_required"));
  for (const protectedItem of [event({ flexibility: "fixed" }), event({ completion: "completed" })]) {
    const validation = validateChanges(request([deletion], { snapshot: snapshot([protectedItem]) }));
    assert.deepEqual(validation.protectedTargets, [protectedItem.id]);
  }
});

test("a coordination proposal cannot silently change other fields of a flexible shared event", () => {
  const shared = event({ involvement: "shared" });
  const changed: Change = {
    changeId: "alter", operation: "update", targetId: shared.id, expectedRevision: shared.revision,
    after: { ...shared, timeSlot: slot("2026-11-01T09:00Z", "2026-11-01T10:00Z"), completion: "completed" },
  };
  for (const coordinationTarget of [undefined, { id: shared.id, expectedRevision: shared.revision }]) {
    const result = validateChanges(request([changed], { snapshot: snapshot([shared]), coordinationTarget }));
    assert.equal(result.valid, false);
    assert.ok(result.conflicts.some(({ reason }) => reason === "coordination_fields_changed"));
  }
  const titleOnly: Change = { changeId: "title", operation: "update", targetId: shared.id, expectedRevision: 1, after: { ...shared, title: "new title" } };
  assert.equal(validateChanges(request([titleOnly], { snapshot: snapshot([shared]), purpose: "user_command" })).valid, true);
});

test("a user command can record an explicit historical appointment", () => {
  const past = event({ timeSlot: slot("2026-10-30T08:00Z", "2026-10-30T09:00Z") });
  const result = validateChanges(request([create(past)], { purpose: "user_command" }));
  assert.equal(result.valid, true);
});

test("AI creation rejects starts before checkedAt, including sub-millisecond differences", () => {
  const checkedAt = "2026-10-31T10:00:00.000001Z";
  const at = (start: string) => create(event({ timeSlot: slot(start, "2026-10-31T11:00Z") }));
  const earlier = at("2026-10-31T10:00:00.0000009Z");
  const result = validateChanges(request([earlier], { checkedAt }));
  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some(({ reason }) => reason === "past_placement"));
  assert.equal(validateChanges(request([earlier], { checkedAt, purpose: "user_command" })).valid, true);
  assert.equal(validateChanges(request([at(checkedAt)], { checkedAt })).valid, true);
});

test("AI revalidation uses checkedAt and rejects moving an item into the past", () => {
  const existing = event();
  const update: Change = {
    changeId: "move", operation: "update", targetId: existing.id, expectedRevision: existing.revision,
    after: { ...existing, timeSlot: slot("2026-10-31T10:01Z", "2026-10-31T11:01Z") },
  };
  const base = request([update], { snapshot: snapshot([existing]) });
  assert.equal(validateChanges(base).valid, true);
  const later = validateChanges({ ...base, checkedAt: "2026-10-31T10:02Z" });
  assert.equal(later.valid, false);
  assert.ok(later.conflicts.some(({ reason }) => reason === "past_placement"));
  assert.equal(validateChanges({ ...base, checkedAt: "2026-10-31T10:02Z", purpose: "user_command" }).valid, true);
});

test("AI may update metadata for past or ongoing items without changing their time slot", () => {
  for (const existing of [
    event({ timeSlot: slot("2026-10-31T08:00Z", "2026-10-31T09:00Z") }),
    event({ timeSlot: slot("2026-10-31T09:30Z", "2026-10-31T10:30Z") }),
  ]) {
    const unchanged: Change = { changeId: "title", operation: "update", targetId: existing.id, expectedRevision: 1, after: { ...existing, title: "new" } };
    assert.equal(validateChanges(request([unchanged], { snapshot: snapshot([existing]) })).valid, true);
  }
  const ongoing = event({ timeSlot: slot("2026-10-31T09:30Z", "2026-10-31T10:30Z") });
  const zoneChanged: Change = {
    changeId: "zone", operation: "update", targetId: ongoing.id, expectedRevision: 1,
    after: { ...ongoing, timeSlot: slot("2026-10-31T09:30Z", "2026-10-31T10:30Z", "Asia/Seoul") },
  };
  assert.ok(validateChanges(request([zoneChanged], { snapshot: snapshot([ongoing]) })).conflicts.some(({ reason }) => reason === "past_placement"));
});

test("shared tasks cannot be made personal, rescheduled, unplaced, or deleted by either actor", () => {
  const shared: ScheduleItem = { ...task({ involvement: "shared", timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T06:00Z") }), id: "shared-task", revision: 1, sourceRefs: [] };
  const afters = [
    { ...shared, involvement: "personal" as const },
    { ...shared, timeSlot: slot("2026-11-01T06:00Z", "2026-11-01T07:00Z") },
    { ...shared, timeSlot: null },
  ];
  const changes: Change[] = afters.map((after, index) => ({ changeId: `u${index}`, operation: "update", targetId: shared.id, expectedRevision: 1, after }));
  changes.push({ changeId: "delete", operation: "delete", targetId: shared.id, expectedRevision: 1 });
  for (const purpose of ["ai_proposal", "user_command"] as const) {
    for (const change of changes) {
      const result = validateChanges(request([change], { snapshot: snapshot([shared]), purpose }));
      assert.equal(result.valid, false);
      assert.ok(result.conflicts.some(({ reason }) => reason === "shared_task_change_unsupported"));
    }
    const title: Change = { changeId: "title", operation: "update", targetId: shared.id, expectedRevision: 1, after: { ...shared, title: "new" } };
    assert.equal(validateChanges(request([title], { snapshot: snapshot([shared]), purpose })).valid, true);
  }
});

test("assigning a previously unplaced shared task is a prohibited time change", () => {
  const shared: ScheduleItem = { ...task({ involvement: "shared" }), id: "shared-task", revision: 1, sourceRefs: [] };
  const change: Change = {
    changeId: "assign", operation: "update", targetId: shared.id, expectedRevision: 1,
    after: { ...shared, timeSlot: slot("2026-11-01T05:00Z", "2026-11-01T06:00Z") },
  };
  for (const purpose of ["ai_proposal", "user_command"] as const) {
    assert.ok(validateChanges(request([change], { snapshot: snapshot([shared]), purpose })).conflicts.some(({ reason }) => reason === "shared_task_change_unsupported"));
  }
});
