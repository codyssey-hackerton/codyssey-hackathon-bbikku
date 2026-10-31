import assert from "node:assert/strict";
import test from "node:test";
import { calculatePreparationTimes, parseOffsetDateTime, validateTimeRange } from "../src/time.ts";

test("PRD example derives departure and two personalized preparation times", () => {
  const input = { appointmentStart: "2026-10-31T15:00:00+09:00", travelMinutes: 30, bufferMinutes: 10 };
  const short = calculatePreparationTimes({ ...input, preparationMinutes: 15 });
  const long = calculatePreparationTimes({ ...input, preparationMinutes: 45 });
  assert.equal(short.status, "ready");
  assert.equal(long.status, "ready");
  if (short.status !== "ready" || long.status !== "ready") return;
  assert.equal(short.departureTime, "2026-10-31T05:20:00.000Z"); // 14:20 +09:00
  assert.equal(short.preparationStart, "2026-10-31T05:05:00.000Z"); // 14:05 +09:00
  assert.equal(long.preparationStart, "2026-10-31T04:35:00.000Z"); // 13:35 +09:00
  assert.equal(short.inputs.travelMinutes, 30);
});

test("missing durations are reported instead of guessed; zero is a value", () => {
  assert.deepEqual(
    calculatePreparationTimes({ appointmentStart: "2026-10-31T15:00+09:00", preparationMinutes: 15, bufferMinutes: 0 }),
    { status: "missing", fields: ["travelMinutes"] },
  );
  assert.deepEqual(calculatePreparationTimes({}), {
    status: "missing", fields: ["appointmentStart", "preparationMinutes", "travelMinutes", "bufferMinutes"],
  });
  const zero = calculatePreparationTimes({ appointmentStart: "2026-10-31T15:00Z", preparationMinutes: 0, travelMinutes: 0, bufferMinutes: 0 });
  assert.equal(zero.status, "ready");
  if (zero.status === "ready") assert.equal(zero.preparationStart, "2026-10-31T15:00:00.000Z");
});

test("invalid durations and out-of-range calculations do not produce times", () => {
  const base = { appointmentStart: "2026-10-31T15:00Z", preparationMinutes: 10, travelMinutes: 30, bufferMinutes: 10 };
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.00001]) {
    assert.deepEqual(calculatePreparationTimes({ ...base, travelMinutes: value }), {
      status: "invalid", fields: ["travelMinutes"], reason: "invalid-value",
    });
  }
  assert.equal(calculatePreparationTimes({ ...base, appointmentStart: "0000-01-01T00:00Z" }).status, "invalid");
});

test("fractional minutes are exact to a millisecond and can cross midnight", () => {
  const result = calculatePreparationTimes({
    appointmentStart: "1970-01-01T00:00:00.000Z", preparationMinutes: 0.25, travelMinutes: 0.1, bufferMinutes: 0.2,
  });
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.departureTime, "1969-12-31T23:59:42.000Z");
    assert.equal(result.preparationStart, "1969-12-31T23:59:27.000Z");
  }
});

test("timestamp validation requires an explicit offset and real calendar date", () => {
  const invalid = [
    "2026-10-31T15:00", "2026-10-31", "2026-02-29T15:00Z", "2024-02-30T15:00Z",
    "2026-04-31T15:00Z", "2026-13-01T15:00Z", "2026-01-01T24:00Z", "2026-01-01T12:60Z",
    "2026-01-01T12:00:60Z", "2026-01-01T12:00+24:00", "2026-01-01T12:00+09:60",
    "2026-01-01T12:00:00.0001Z", "2026-01-01 12:00Z",
  ];
  for (const value of invalid) assert.equal(parseOffsetDateTime(value), null, value);
  assert.notEqual(parseOffsetDateTime("2024-02-29T15:00:00.125+09:00"), null);
  assert.equal(parseOffsetDateTime("2026-10-31T15:00+09:00"), parseOffsetDateTime("2026-10-31T06:00Z"));
});

test("range must be ordered by instant, even across different offsets", () => {
  assert.deepEqual(validateTimeRange({ start: "2026-10-31T15:00+09:00", end: "2026-10-31T06:00Z" }), {
    valid: false, reason: "start-not-before-end",
  });
  assert.deepEqual(validateTimeRange({ start: "2026-10-31T15:00", end: "2026-10-31T16:00+09:00" }), {
    valid: false, reason: "invalid-start",
  });
  assert.deepEqual(validateTimeRange({ start: "2026-10-31T15:00+09:00", end: "2026-10-31T14:00+09:00" }), {
    valid: false, reason: "start-not-before-end",
  });
  assert.equal(validateTimeRange({ start: "2026-10-31T15:00+09:00", end: "2026-10-31T07:00Z" }).valid, true);
});
