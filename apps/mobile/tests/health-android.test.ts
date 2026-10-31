import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealthAdapter } from '../src/health/native-adapter.android.ts';
import type { HealthSelection } from '../src/health/types.ts';

type Bridge = ReturnType<NonNullable<Parameters<typeof createHealthAdapter>[0]>>;
const selected: HealthSelection = { steps: true, workouts: true };
const now = '2026-11-01T12:00:00.000Z';
const input = { now, timezone: 'Asia/Seoul', selection: selected };
const perms = [{ accessType: 'read', recordType: 'Steps' }, { accessType: 'read', recordType: 'ExerciseSession' }];
function bridge(overrides: Partial<Bridge> = {}): Bridge {
  return { apiLevel: 34, async getSdkStatus() { return 3; }, async initialize() { return true; },
    async requestPermission() { return perms; }, async getGrantedPermissions() { return perms; },
    async aggregateRecord() { return { COUNT_TOTAL: 50, dataOrigins: ['synthetic'] }; },
    async readRecords() { return { records: [] }; }, openHealthConnectSettings() {}, ...overrides };
}

test('availability distinguishes no native build, SDK provider update and unsupported OS', async () => {
  assert.deepEqual(await createHealthAdapter(() => { throw new Error('no module'); }).availability(),
    { status: 'unavailable', source: 'health_connect', reason: 'needs_dev_build' });
  assert.equal((await createHealthAdapter(() => bridge({ async getSdkStatus() { throw new Error("The package doesn't seem to be linked"); } })).availability()).reason, 'needs_dev_build');
  assert.equal((await createHealthAdapter(() => bridge({ async getSdkStatus() { return 2; } })).availability()).reason, 'provider_missing_or_update_required');
  assert.equal((await createHealthAdapter(() => bridge({ apiLevel: 27 })).availability()).status, 'unsupported');
  assert.equal((await createHealthAdapter(() => bridge({ async getSdkStatus() { throw new Error('private error'); } })).availability()).reason, 'error');
  assert.equal((await createHealthAdapter(() => bridge()).availability()).status, 'available');
});

test('no selections cause no native loading and connect asks only for selected read access', async () => {
  let loads = 0; const adapter = createHealthAdapter(() => { loads++; return bridge(); });
  const none = { steps: false, workouts: false };
  assert.deepEqual(await adapter.connect(none), { steps: 'not_selected', workouts: 'not_selected' });
  const noData = await adapter.read({ ...input, selection: none });
  assert.equal(loads, 0); assert.equal(noData.status, 'no_data_or_access');
  assert.equal(noData.workoutsAvailability, 'not_selected'); assert.ok(noData.stepsByDay.every(day => day.steps === null));
  const requests: unknown[] = [];
  const partial = createHealthAdapter(() => bridge({ async requestPermission(value) { requests.push(value); return []; } }));
  assert.deepEqual(await partial.connect({ steps: true, workouts: false }), { steps: 'denied', workouts: 'not_selected' });
  assert.deepEqual(requests, [[{ accessType: 'read', recordType: 'Steps' }]]);
  assert.deepEqual(await partial.connect({ steps: false, workouts: true }), { steps: 'not_selected', workouts: 'denied' });
  assert.deepEqual(requests[1], [{ accessType: 'read', recordType: 'ExerciseSession' }]);
});

test('selected permissions use native aggregate for timezone windows; absent origins do not become zero', async () => {
  const ranges: Array<{ startTime: string; endTime: string }> = []; let workouts = 0;
  const adapter = createHealthAdapter(() => bridge({
    async getGrantedPermissions() { return [perms[0]]; },
    async aggregateRecord({ timeRangeFilter }) { ranges.push(timeRangeFilter); return ranges.length === 1
      ? { COUNT_TOTAL: 0, dataOrigins: [] } : ranges.length === 2 ? { COUNT_TOTAL: 0, dataOrigins: ['synthetic'] } : { COUNT_TOTAL: 100, dataOrigins: ['synthetic'] }; },
    async readRecords() { workouts++; throw new Error('should not run'); },
  }));
  const result = await adapter.read(input);
  assert.equal(ranges.length, 7); assert.equal(ranges[0]!.startTime, '2026-10-25T15:00:00.000Z');
  assert.equal(ranges.at(-1)!.endTime, now); assert.equal(result.timezone, input.timezone);
  assert.deepEqual(result.stepsByDay.slice(0, 3).map(day => day.steps), [null, 0, 100]);
  assert.equal(workouts, 0); assert.equal(result.status, 'partial');
  assert.equal(result.workoutsAvailability, 'no_data_or_access');
});

test('partial, empty and sanitized error cases do not fabricate values or call unselected reads', async () => {
  let stepsCalls = 0, workoutCalls = 0;
  const adapter = createHealthAdapter(() => bridge({
    async aggregateRecord() { stepsCalls++; throw new Error('private health'); },
    async readRecords() { workoutCalls++; return { records: [] }; },
  }));
  const result = await adapter.read({ ...input, selection: { steps: false, workouts: true } });
  assert.equal(stepsCalls, 0); assert.equal(workoutCalls, 1); assert.equal(result.status, 'ok');
  assert.equal(result.workoutsAvailability, 'available'); assert.deepEqual(result.workouts, []);
  const partial = await adapter.read(input);
  assert.equal(partial.status, 'partial'); assert.ok(partial.stepsByDay.every(day => day.steps === null));
  assert.equal(partial.workoutsAvailability, 'available');
  assert.ok(!JSON.stringify(partial).includes('private health'));
  const denied = createHealthAdapter(() => bridge({ async getGrantedPermissions() { return []; },
    async aggregateRecord() { throw new Error('unexpected'); }, async readRecords() { throw new Error('unexpected'); } }));
  assert.equal((await denied.read(input)).status, 'no_data_or_access');
  const error = createHealthAdapter(() => bridge({ async getGrantedPermissions() { throw new Error('secret'); } }));
  await assert.rejects(() => error.read(input), { message: 'HEALTH_READ_FAILED' });
});

test('exercise sessions are bounded, deduplicated, interval-filtered and capped with truncation', async () => {
  let pages = 0; const calls: Array<{ pageSize: number; pageToken?: string }> = [];
  const adapter = createHealthAdapter(() => bridge({ async getGrantedPermissions() { return [perms[1]]; },
    async readRecords(_type, options) {
      calls.push(options); pages++;
      const records = Array.from({ length: 100 }, (_, i) => ({ metadata: { id: `${pages}-${i}` },
        startTime: '2026-10-26T00:00:00.000Z', endTime: '2026-10-26T01:00:00.000Z', exerciseType: 79, title: 'private not returned' }));
      return { records, pageToken: `page-${pages}` };
    },
  }));
  const result = await adapter.read({ ...input, selection: { steps: false, workouts: true } });
  assert.equal(pages, 5); assert.equal(result.workouts.length, 500); assert.equal(result.truncated, true);
  assert.equal(result.workoutsAvailability, 'available'); assert.ok(calls.every(call => call.pageSize === 100));
  assert.ok(!JSON.stringify(result).includes('private not returned'));
});

test('repeated workout IDs with conflicting data and page tokens are marked partial', async () => {
  let pages = 0;
  const adapter = createHealthAdapter(() => bridge({ async getGrantedPermissions() { return [perms[1]]; },
    async readRecords() { pages++; return { records: [{ metadata: { id: 'same' }, startTime: '2026-10-26T00:00:00.000Z',
      endTime: pages === 1 ? '2026-10-26T01:00:00.000Z' : '2026-10-26T02:00:00.000Z', exerciseType: 1 }], pageToken: 'repeat' }; },
  }));
  const result = await adapter.read({ ...input, selection: { steps: false, workouts: true } });
  assert.equal(pages, 2); assert.equal(result.status, 'partial'); assert.equal(result.truncated, true); assert.deepEqual(result.workouts, []);
  assert.equal(result.workoutsAvailability, 'no_data_or_access');
});

test('invalid or conflicting workouts cannot be reported as complete after the last page', async () => {
  const workout = { metadata: { id: 'same' }, startTime: '2026-10-26T00:00:00.000Z', endTime: '2026-10-26T01:00:00.000Z', exerciseType: 1 };
  for (const invalid of [null, { ...workout, endTime: '2026-10-26T02:00:00.000Z' }]) {
    const adapter = createHealthAdapter(() => bridge({ async getGrantedPermissions() { return [perms[1]]; },
      async readRecords() { return { records: [workout, invalid] }; } }));
    const result = await adapter.read({ ...input, selection: { steps: false, workouts: true } });
    assert.equal(result.truncated, false); assert.equal(result.status, 'partial');
    assert.equal(result.workoutsAvailability, 'no_data_or_access');
  }
});

test('preserves boundary-overlapping sessions while excluding future and duplicate records', async () => {
  const crossing = { metadata: { id: 'crossing' }, startTime: '2026-10-25T14:30:00.000Z', endTime: '2026-10-25T15:30:00.000Z', exerciseType: 1 };
  const future = { metadata: { id: 'future' }, startTime: '2026-11-01T12:00:00.000Z', endTime: '2026-11-01T13:00:00.000Z', exerciseType: 1 };
  const adapter = createHealthAdapter(() => bridge({ async getGrantedPermissions() { return [perms[1]]; },
    async readRecords() { return { records: [crossing, crossing, future] }; } }));
  const result = await adapter.read({ ...input, selection: { steps: false, workouts: true } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.workouts, [{ source: 'health_connect', id: 'crossing', startAt: crossing.startTime, endAt: crossing.endTime, kind: '1' }]);
});

test('openSettings uses the official native method only when available', async () => {
  let opens = 0;
  const adapter = createHealthAdapter(() => bridge({ openHealthConnectSettings() { opens++; } }));
  await adapter.openSettings(); assert.equal(opens, 1);
  await assert.rejects(() => createHealthAdapter(() => bridge({ async getSdkStatus() { return 2; } })).openSettings(), { message: 'HEALTH_UNAVAILABLE' });
  assert.equal(opens, 1);
});
