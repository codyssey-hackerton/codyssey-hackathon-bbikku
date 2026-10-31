import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthDayWindows } from '../src/health/summary.ts';
import { createHealthAdapter } from '../src/health/native-adapter.ios.ts';

const input = { now: '2030-01-10T12:00:00.000Z', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
const windows = healthDayWindows(input);
let calls: string[] = [];
let granted = true;
let stats: unknown[] = [];
let failSteps = false;
let samples: unknown[] = [];
let requestTypes: string[] = [];
let statsOptions: unknown;
let workoutOptions: unknown;
let authWait: Promise<void> | undefined;
const fake = {
  isHealthDataAvailable() { calls.push('available'); return true; },
  async requestAuthorization(value: { toRead: string[] }) { calls.push('authorize'); requestTypes = value.toRead; await authWait; return granted; },
  async queryStatisticsCollectionForQuantity(_id: string, _stats: string[], _anchor: Date, _interval: unknown, options: unknown) {
    calls.push('steps'); statsOptions = options; if (failSteps) throw new Error('synthetic read failure'); return stats;
  },
  async queryWorkoutSamples(options: unknown) { calls.push('workouts'); workoutOptions = options; return samples; },
  WorkoutActivityType: { 37: 'running' },
};
const createAdapter = () => createHealthAdapter(async () => fake as unknown as typeof import('@kingstinct/react-native-healthkit'));
function reset() { calls = []; granted = true; stats = []; failSteps = false; samples = []; requestTypes = []; statsOptions = undefined; workoutOptions = undefined; authWait = undefined; }
function workout(overrides: Record<string, unknown> = {}) {
  return { uuid: 'workout-1', sourceRevision: { source: { bundleIdentifier: 'synthetic.app' } },
    startDate: new Date('2030-01-09T09:00:00Z'), endDate: new Date('2030-01-09T09:30:00Z'),
    duration: { unit: 's', quantity: 1800 }, workoutActivityType: 37, dispose() { calls.push('dispose'); }, ...overrides };
}

test('disabled selection does not import or call a native data API', async () => {
  reset(); const adapter = await createAdapter(); const selection = { steps: false, workouts: false };
  assert.deepEqual(await adapter.connect(selection), { steps: 'not_selected', workouts: 'not_selected' });
  const result = await adapter.read({ ...input, selection });
  assert.deepEqual(calls, []); assert.equal(result.timezone, input.timezone); assert.equal(result.stepsByDay.length, 7);
  assert.ok(result.stepsByDay.every(day => day.steps === null)); assert.equal(result.workoutsAvailability, 'not_selected');
});

test('steps require an explicit request and use native daily statistics with empty versus zero preserved', async () => {
  reset(); const adapter = await createAdapter(); const selection = { steps: true, workouts: false };
  await assert.rejects(adapter.read({ ...input, selection }), /HEALTH_UNAVAILABLE/); assert.deepEqual(calls, []);
  assert.deepEqual(await adapter.connect(selection), { steps: 'unknown', workouts: 'not_selected' });
  assert.deepEqual(requestTypes, ['HKQuantityTypeIdentifierStepCount']);
  stats = [{ startDate: new Date(windows[0]!.startAt), endDate: new Date(windows[0]!.endAt), sumQuantity: { unit: 'count', quantity: 0 } },
    { startDate: new Date(windows[1]!.startAt), endDate: new Date(windows[1]!.endAt) }];
  const result = await adapter.read({ ...input, selection });
  assert.deepEqual(result.stepsByDay.map(row => row.steps), [0, null, null, null, null, null, null]);
  assert.equal(result.status, 'partial'); assert.equal(result.workoutsAvailability, 'not_selected');
  assert.equal(calls.includes('workouts'), false);
  const options = statsOptions as { filter: { date: { endDate: Date; strictEndDate: boolean } }; unit: string };
  assert.equal(options.unit, 'count'); assert.equal(options.filter.date.endDate.toISOString(), input.now); assert.equal(options.filter.date.strictEndDate, true);
});

test('workouts only requests the selected type, deduplicates and releases native proxies', async () => {
  reset(); const adapter = await createAdapter(); const selection = { steps: false, workouts: true };
  await adapter.connect(selection); assert.deepEqual(requestTypes, ['HKWorkoutTypeIdentifier']);
  samples = [workout(), workout()];
  const result = await adapter.read({ ...input, selection });
  assert.equal(calls.includes('steps'), false); assert.equal(calls.filter(call => call === 'dispose').length, 2);
  assert.deepEqual(result.workouts, [{ source: 'apple_health', id: 'workout-1', startAt: '2030-01-09T09:00:00.000Z', endAt: '2030-01-09T09:30:00.000Z', kind: 'running' }]);
  assert.equal(result.workoutsAvailability, 'available');
  const options = workoutOptions as { limit: number; filter: { date: { endDate: Date; strictEndDate: boolean } } };
  assert.equal(options.limit, 501); assert.equal(options.filter.date.endDate.toISOString(), input.now); assert.equal(options.filter.date.strictEndDate, true);
});

test('absence remains ambiguous and invalid workouts fail closed', async () => {
  reset(); const adapter = await createAdapter(); const selection = { steps: false, workouts: true }; await adapter.connect(selection);
  const empty = await adapter.read({ ...input, selection }); assert.equal(empty.status, 'no_data_or_access'); assert.equal(empty.workoutsAvailability, 'no_data_or_access');
  samples = [workout({ endDate: new Date('2030-01-09T08:59:00Z') })];
  await assert.rejects(adapter.read({ ...input, selection }), /HEALTH_UNAVAILABLE/); assert.equal(calls.includes('dispose'), true);
  samples = [workout(), workout({ sourceRevision: { source: { bundleIdentifier: 'other.app' } } })];
  await assert.rejects(adapter.read({ ...input, selection }), /HEALTH_UNAVAILABLE/);
});

test('a paused workout uses the recorded start and end even when active duration is shorter', async () => {
  reset(); const adapter = createAdapter(); const selection = { steps: false, workouts: true }; await adapter.connect(selection);
  samples = [workout({ duration: { unit: 's', quantity: 900 } })];
  const result = await adapter.read({ ...input, selection });
  assert.equal(result.workoutsAvailability, 'available');
  assert.equal(result.workouts[0]?.startAt, '2030-01-09T09:00:00.000Z');
  assert.equal(result.workouts[0]?.endAt, '2030-01-09T09:30:00.000Z');
});

test('unrequested types, failed permission flow, and timezone mismatch do not read data', async () => {
  reset(); const adapter = await createAdapter(); granted = false;
  assert.deepEqual(await adapter.connect({ steps: true, workouts: false }), { steps: 'unknown', workouts: 'not_selected' });
  await assert.rejects(adapter.read({ ...input, selection: { steps: true, workouts: false } }), /HEALTH_UNAVAILABLE/);
  assert.equal(calls.includes('steps'), false);
  granted = true; await adapter.connect({ steps: false, workouts: true });
  await assert.rejects(adapter.read({ ...input, selection: { steps: true, workouts: true } }), /HEALTH_UNAVAILABLE/);
  await adapter.connect({ steps: true, workouts: false });
  const timezone = input.timezone === 'UTC' ? 'Asia/Seoul' : 'UTC';
  const mismatch = await adapter.read({ ...input, timezone, selection: { steps: true, workouts: false } });
  assert.equal(mismatch.status, 'no_data_or_access');
  assert.equal(calls.includes('steps'), false);
});

test('a missing native module is contained and selection changes invalidate outstanding authorization', async () => {
  reset(); const missing = createHealthAdapter(async () => { throw new Error('native absent'); });
  assert.deepEqual(await missing.availability(), { status: 'unavailable', source: 'apple_health', reason: 'needs_dev_build' });
  assert.deepEqual(await missing.connect({ steps: true, workouts: false }), { steps: 'unavailable', workouts: 'not_selected' });
  const adapter = createAdapter(); let resume!: () => void;
  authWait = new Promise<void>(resolve => { resume = resolve; });
  const old = adapter.connect({ steps: true, workouts: false });
  while (!calls.includes('authorize')) await new Promise<void>(resolve => setImmediate(resolve));
  await adapter.connect({ steps: false, workouts: false }); resume(); await old;
  await assert.rejects(adapter.read({ ...input, selection: { steps: true, workouts: false } }), /HEALTH_UNAVAILABLE/);
  authWait = undefined; await adapter.connect({ steps: true, workouts: true });
  await assert.rejects(adapter.read({ ...input, selection: { steps: true, workouts: false } }), /HEALTH_UNAVAILABLE/);

  reset(); let loaded!: (value: typeof fake) => void;
  const moduleLoad = new Promise<typeof fake>(resolve => { loaded = resolve; });
  const delayed = createHealthAdapter(async () => await moduleLoad as unknown as typeof import('@kingstinct/react-native-healthkit'));
  const pending = delayed.connect({ steps: true, workouts: false });
  await delayed.connect({ steps: false, workouts: false }); loaded(fake); await pending;
  assert.equal(calls.includes('authorize'), false);
});

test('caps workouts and rejects invalid daily statistics without presenting false values', async () => {
  reset(); const adapter = createAdapter(); const selection = { steps: true, workouts: true }; await adapter.connect(selection);
  stats = [{ startDate: new Date(windows[0]!.startAt), endDate: new Date(windows[0]!.endAt), sumQuantity: { unit: 'count', quantity: -1 } }];
  const invalid = await adapter.read({ ...input, selection });
  assert.ok(invalid.stepsByDay.every(day => day.steps === null));
  stats = [];
  samples = Array.from({ length: 501 }, (_, index) => workout({ uuid: `workout-${index}` }));
  const result = await adapter.read({ ...input, selection });
  assert.equal(result.workouts.length, 500); assert.equal(result.truncated, true); assert.equal(result.status, 'partial');
  assert.equal(result.workoutsAvailability, 'no_data_or_access');
  assert.equal(calls.filter(call => call === 'dispose').length, 501);
});

test('complete workouts remain available when step data is incomplete', async () => {
  reset(); const adapter = createAdapter(); const selection = { steps: true, workouts: true };
  await adapter.connect(selection); samples = [workout()];
  const result = await adapter.read({ ...input, selection });
  assert.equal(result.status, 'partial'); assert.equal(result.workoutsAvailability, 'available');
  stats = [{ startDate: new Date(windows[0]!.startAt), endDate: new Date(windows[0]!.endAt), sumQuantity: { unit: 'count', quantity: -1 } }];
  const invalidSteps = await adapter.read({ ...input, selection });
  assert.equal(invalidSteps.status, 'partial'); assert.equal(invalidSteps.workoutsAvailability, 'available');
  assert.ok(invalidSteps.stepsByDay.every(day => day.steps === null));
  failSteps = true;
  const failedSteps = await adapter.read({ ...input, selection });
  assert.equal(failedSteps.status, 'partial'); assert.equal(failedSteps.workoutsAvailability, 'available');
  assert.ok(failedSteps.stepsByDay.every(day => day.steps === null));
});
