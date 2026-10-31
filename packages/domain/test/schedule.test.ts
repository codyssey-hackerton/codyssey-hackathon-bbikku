import assert from "node:assert/strict";
import test from "node:test";
import { findConflicts, validateScheduleProposal } from "../src/schedule.ts";
import type { ScheduleProposal, ScheduledEvent } from "../src/schedule.ts";

const event = (overrides: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: "study", userId: "user-a", version: 3, isFixed: false, status: "planned",
  start: "2026-10-31T10:00+09:00", end: "2026-10-31T11:00+09:00", ...overrides,
});
const proposal = (overrides: Partial<ScheduleProposal> = {}): ScheduleProposal => ({
  userId: "user-a", targetId: "study", targetVersion: 3,
  range: { start: "2026-10-31T14:00+09:00", end: "2026-10-31T15:00+09:00" }, ...overrides,
});

test("conflicts use half-open interval boundaries and compare absolute instants", () => {
  const current = event({ id: "meeting", start: "2026-10-31T15:00+09:00", end: "2026-10-31T16:00+09:00" });
  const before = findConflicts("user-a", { start: "2026-10-31T05:00Z", end: "2026-10-31T06:00Z" }, [current]);
  assert.deepEqual(before, { valid: true, conflicts: [] });
  const after = findConflicts("user-a", { start: "2026-10-31T07:00Z", end: "2026-10-31T08:00Z" }, [current]);
  assert.deepEqual(after, { valid: true, conflicts: [] });
  const overlap = findConflicts("user-a", { start: "2026-10-31T05:59:59.999Z", end: "2026-10-31T06:30Z" }, [current]);
  assert.deepEqual(overlap, { valid: true, conflicts: [current] });
});

test("conflicts are scoped by user and optionally exclude the target", () => {
  const own = event();
  const foreign = event({ userId: "user-b" });
  assert.deepEqual(findConflicts("user-a", own, [own, foreign]), { valid: true, conflicts: [own] });
  assert.deepEqual(findConflicts("user-a", own, [own, foreign], "study"), { valid: true, conflicts: [] });
});

test("invalid ranges and unknown owner data fail closed", () => {
  const own = event();
  assert.deepEqual(findConflicts("user-a", { start: "no offset", end: own.end }, [own]), {
    valid: false, reason: "invalid-range", detail: "invalid-start",
  });
  assert.deepEqual(findConflicts("user-a", own, [event({ id: "other", end: "invalid" })]), {
    valid: false, reason: "invalid-event", index: 0, detail: "invalid-end",
  });
  assert.deepEqual(findConflicts("user-a", own, [event({ userId: "" })]), {
    valid: false, reason: "invalid-event", index: 0,
  });
});

test("only current target versions are accepted; target identity includes owner", () => {
  assert.deepEqual(validateScheduleProposal(proposal(), [event()]), { valid: true });
  assert.deepEqual(validateScheduleProposal(proposal({ targetVersion: 2 }), [event()]), { valid: false, reason: "stale-proposal" });
  assert.deepEqual(validateScheduleProposal(proposal(), [event({ version: "3" })]), { valid: false, reason: "stale-proposal" });
  assert.deepEqual(validateScheduleProposal(proposal(), [event({ userId: "user-b" })]), { valid: false, reason: "target-not-found" });
  assert.deepEqual(validateScheduleProposal(proposal(), [event(), event()]), { valid: false, reason: "ambiguous-target" });
});

test("fixed and completed events cannot be changed by a proposal", () => {
  assert.deepEqual(validateScheduleProposal(proposal(), [event({ isFixed: true })]), { valid: false, reason: "protected-event" });
  assert.deepEqual(validateScheduleProposal(proposal(), [event({ status: "completed" })]), { valid: false, reason: "protected-event" });
});

test("proposal detects other-event conflicts and does not mutate input", () => {
  const meeting = event({ id: "meeting", isFixed: true, start: "2026-10-31T14:30+09:00", end: "2026-10-31T16:00+09:00" });
  const events = [event(), meeting];
  const original = structuredClone(events);
  assert.deepEqual(validateScheduleProposal(proposal(), events), { valid: false, reason: "conflict", conflicts: [meeting] });
  assert.deepEqual(events, original);
});

test("invalid target state and invalid other events cannot pass validation", () => {
  assert.deepEqual(validateScheduleProposal(proposal(), [event({ version: Number.NaN })]), { valid: false, reason: "invalid-target" });
  assert.deepEqual(validateScheduleProposal(proposal(), [event(), event({ id: "bad", start: "unknown" })]), {
    valid: false, reason: "invalid-event", index: 1, detail: "invalid-start",
  });
  assert.deepEqual(validateScheduleProposal(proposal({ range: { start: "2026-10-31T15:00+09:00", end: "2026-10-31T15:00+09:00" } }), [event()]), {
    valid: false, reason: "invalid-range", detail: "start-not-before-end",
  });
});
