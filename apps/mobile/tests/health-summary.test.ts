import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealthAdapter } from '../src/health/native-adapter';
import { healthDayWindows, summarizeHealth } from '../src/health/summary';
import type { HealthReadResult } from '../src/health/types';

const now = '2030-01-08T12:00:00.000Z';
const selection = { steps: true, workouts: true };
const input = { now, timezone: 'UTC', selection };
const base = (): HealthReadResult => ({ source: 'health_connect', lastSyncedAt: now, timezone: 'UTC', selection,
  status: 'ok', truncated: false, workoutsAvailability: 'available', stepsByDay: [], workouts: [] });
const workout = (id: string, startAt: string, endAt: string) => ({ source: 'health_connect' as const, id, startAt, endAt, kind: null });

test('day windows follow local midnight, include today only through now, and handle DST', () => {
  const seoul = healthDayWindows({ now: '2030-01-08T12:00:00Z', timezone: 'Asia/Seoul' });
  assert.equal(seoul.length, 7); assert.deepEqual(seoul[0], { date: '2030-01-02', startAt: '2030-01-01T15:00:00.000Z', endAt: '2030-01-02T15:00:00.000Z' });
  assert.equal(seoul[6]!.date, '2030-01-08'); assert.equal(seoul[6]!.endAt, now);
  const fall = healthDayWindows({ now: '2026-11-02T18:00:00Z', timezone: 'America/New_York' });
  const repeated = fall.find(day => day.date === '2026-11-01')!;
  assert.equal(Date.parse(repeated.endAt) - Date.parse(repeated.startAt), 25 * 3_600_000);
  const spring = healthDayWindows({ now: '2026-03-09T18:00:00Z', timezone: 'America/New_York' });
  const shortened = spring.find(day => day.date === '2026-03-08')!;
  assert.equal(Date.parse(shortened.endAt) - Date.parse(shortened.startAt), 23 * 3_600_000);
});

test('missing steps are null while a confirmed zero remains zero', () => {
  const result = base(); result.stepsByDay = [{ date: '2030-01-07', steps: 0 }, { date: '2030-01-08', steps: 321 }];
  const summary = summarizeHealth(result, input);
  assert.equal(summary.days[0]!.steps, null); assert.equal(summary.days[5]!.steps, 0); assert.equal(summary.days[6]!.steps, 321);
  assert.deepEqual(summary.signals.find(signal => signal.kind === 'days_with_steps'), { kind: 'days_with_steps', value: 1, sampleDays: 2,
    source: 'health_connect', calculatedAt: now, expiresAt: '2030-01-08T12:05:00.000Z' });
});

test('deduplicates source IDs and unions overlapping workouts across midnight', () => {
  const result = base();
  const a = workout('a', '2030-01-07T23:30:00Z', '2030-01-08T01:00:00Z');
  const b = workout('b', '2030-01-08T00:30:00Z', '2030-01-08T02:00:00Z');
  result.workouts = [a, a, b];
  const summary = summarizeHealth(result, input);
  assert.equal(summary.workouts.length, 2); assert.equal(summary.days[5]!.exerciseMinutes, 30); assert.equal(summary.days[6]!.exerciseMinutes, 120);
  assert.equal(summary.signals.find(signal => signal.kind === 'exercise_sessions')!.value, 2);
});

test('supports higher-precision Health Connect timestamps at millisecond resolution', () => {
  const result = base(); result.workouts = [workout('precise', '2030-01-08T01:00:00.123456789Z', '2030-01-08T01:30:00.123456789Z')];
  const summary = summarizeHealth(result, input);
  assert.equal(summary.status, 'ok'); assert.equal(summary.days[6]!.exerciseMinutes, 30);
});

test('unknown or truncated workouts never become zero or signals', () => {
  for (const change of [
    { workoutsAvailability: 'no_data_or_access' as const }, { truncated: true },
  ]) {
    const result = { ...base(), ...change };
    const summary = summarizeHealth(result, input);
    assert.ok(summary.days.every(day => day.exerciseMinutes === null));
    assert.ok(!summary.signals.some(signal => signal.kind === 'exercise_sessions'));
  }
  const result = base(); result.workouts = [workout('a', '2030-01-07T12:00:00Z', '2030-01-07T13:00:00Z'),
    workout('a', '2030-01-07T12:00:00Z', '2030-01-07T14:00:00Z')];
  const conflict = summarizeHealth(result, input); assert.equal(conflict.status, 'partial');
  assert.ok(conflict.days.every(day => day.exerciseMinutes === null)); assert.deepEqual(conflict.workouts, []);
});

test('partial step access does not hide complete workout duration', () => {
  const result = base(); result.status = 'partial'; result.stepsByDay = [{ date: '2030-01-08', steps: null }];
  result.workouts = [workout('a', '2030-01-08T09:00:00Z', '2030-01-08T10:00:00Z')];
  const summary = summarizeHealth(result, input);
  assert.equal(summary.days[6]!.steps, null); assert.equal(summary.days[6]!.exerciseMinutes, 60);
  assert.equal(summary.status, 'partial'); assert.deepEqual(summary.signals, []);
});

test('unselected data is not surfaced and a changed selection or timezone rejects old results', () => {
  const result = base(); result.selection = { steps: true, workouts: false }; result.workoutsAvailability = 'not_selected';
  result.workouts = [workout('a', '2030-01-07T12:00:00Z', '2030-01-07T13:00:00Z')];
  const summary = summarizeHealth(result, { ...input, selection: result.selection });
  assert.deepEqual(summary.workouts, []); assert.ok(summary.days.every(day => day.exerciseMinutes === null));
  assert.throws(() => summarizeHealth(result, input), /HEALTH_CONTEXT_CHANGED/);
  assert.throws(() => summarizeHealth(result, { ...input, timezone: 'Asia/Seoul', selection: result.selection }), /HEALTH_CONTEXT_CHANGED/);
  result.selection = { steps: false, workouts: true }; result.workoutsAvailability = 'available';
  result.stepsByDay = [{ date: '2030-01-08', steps: 1234 }];
  const workoutsOnly = summarizeHealth(result, { ...input, selection: result.selection });
  assert.ok(workoutsOnly.days.every(day => day.steps === null));
  assert.ok(!workoutsOnly.signals.some(signal => signal.kind === 'days_with_steps'));
});

test('contradictory step values do not become an observed count', () => {
  const result = base(); result.stepsByDay = [{ date: '2030-01-08', steps: 1 }, { date: '2030-01-08', steps: 2 }];
  const summary = summarizeHealth(result, input);
  assert.equal(summary.status, 'partial'); assert.equal(summary.days[6]!.steps, null); assert.deepEqual(summary.signals, []);
});

test('signals expire five minutes after synchronization, including exactly at expiry', () => {
  const result = base(); result.stepsByDay = [{ date: '2030-01-08', steps: 100 }];
  const fresh = summarizeHealth(result, { ...input, now: '2030-01-08T12:04:59Z' }); assert.equal(fresh.stale, false); assert.ok(fresh.signals.length);
  const expired = summarizeHealth(result, { ...input, now: '2030-01-08T12:05:00Z' }); assert.equal(expired.stale, true); assert.deepEqual(expired.signals, []);
  const future = summarizeHealth(result, { ...input, now: '2030-01-08T11:59:59Z' }); assert.equal(future.stale, true); assert.deepEqual(future.signals, []);
  result.lastSyncedAt = '2030-01-08T12:00:02Z';
  const asynchronous = summarizeHealth(result, { ...input, calculatedAt: '2030-01-08T12:00:03Z' });
  assert.equal(asynchronous.stale, false); assert.equal(asynchronous.signals[0]!.calculatedAt, '2030-01-08T12:00:03.000Z');
});

test('unsupported fallback makes no health data available', async () => {
  const adapter = createHealthAdapter(); assert.deepEqual(await adapter.availability(), { status: 'unsupported', source: null, reason: 'unsupported' });
  assert.deepEqual(await adapter.connect({ steps: true, workouts: false }), { steps: 'unsupported', workouts: 'not_selected' });
  await assert.rejects(adapter.read({ ...input })); await adapter.openSettings();
});
