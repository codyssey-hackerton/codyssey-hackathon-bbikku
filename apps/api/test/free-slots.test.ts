import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContextSnapshot, ScheduleItem } from '@pikku/domain';
import { findFreeSlots, freeSlotsInput } from '../src/free-slots.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createPlanningTools } from '../src/planning-tools.ts';

const now = '2026-11-01T00:00:00.000Z';
const snapshot = (items: ScheduleItem[] = []): ContextSnapshot =>
  ({ now, timezone: 'UTC', scheduleRevision: 7, contextRevision: 2, items, facts: [], missingFields: [] });
const item = (id: string, startsAt: string, endsAt: string, overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id, revision: 1, kind: 'event', title: 'private', timeSlot: { startsAt, endsAt, timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', sourceRefs: [], ...overrides,
});
const query = { from: '2026-11-01T08:00:00+09:00', to: '2026-11-01T18:00:00+09:00', timezone: 'Asia/Seoul', durationMinutes: 30 };

test('clips past time and merges overlapping or adjacent timed items regardless of status', () => {
  const items = [
    item('private-1', '2026-11-01T09:30:00+09:00', '2026-11-01T11:00:00+09:00', { completion: 'completed', attendance: 'absent' }),
    item('private-2', '2026-11-01T10:00:00+09:00', '2026-11-01T10:30:00+09:00'),
    item('private-3', '2026-11-01T11:00:00+09:00', '2026-11-01T12:00:00+09:00'),
    item('private-4', '2026-11-01T13:00:00+09:00', '2026-11-01T14:00:00+09:00'),
    { ...item('unplaced', '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z'), kind: 'task' as const, timeSlot: null, durationMinutes: 30 },
  ];
  const result = findFreeSlots(snapshot(items), query);
  assert.deepEqual(result, { slots: [
    { startsAt: now, endsAt: '2026-11-01T09:30:00+09:00' },
    { startsAt: '2026-11-01T12:00:00+09:00', endsAt: '2026-11-01T13:00:00+09:00' },
    { startsAt: '2026-11-01T14:00:00+09:00', endsAt: query.to },
  ], truncated: false, scheduleRevision: 7, timezone: 'Asia/Seoul', asOf: now });
  assert.doesNotMatch(JSON.stringify(result), /private|unplaced/);
});

test('half-open intervals clip cross-day boundaries and preserve fractional-second precision', () => {
  const range = { from: '2026-11-02T00:00:00.0001Z', to: '2026-11-02T00:04:00Z', timezone: 'UTC', durationMinutes: 1 };
  const items = [
    item('one', '2026-11-01T23:00:00Z', '2026-11-02T00:01:00.0001Z'),
    item('two', '2026-11-02T00:02:00.0000Z', '2026-11-02T00:03:00Z'),
    item('touching', range.to, '2026-11-02T00:05:00Z'),
  ];
  assert.deepEqual(findFreeSlots(snapshot(items), range).slots,
    [{ startsAt: '2026-11-02T00:03:00Z', endsAt: range.to }]);
  assert.deepEqual(findFreeSlots(snapshot(), { ...range, to: '2026-11-02T00:01:00.0001Z' }).slots,
    [{ startsAt: range.from, endsAt: '2026-11-02T00:01:00.0001Z' }]);
});

test('validates exact 31-day range, timezones, ordering and duration', () => {
  const base = { from: '2026-11-01T00:00:00.0001Z', to: '2026-12-02T00:00:00.0001Z', timezone: 'UTC', durationMinutes: 1 };
  assert.equal(freeSlotsInput.safeParse(base).success, true);
  for (const value of [
    { ...base, to: '2026-12-02T00:00:00.0002Z' }, { ...base, to: base.from },
    { ...base, from: '2026-11-01T00:00:00' }, { ...base, timezone: 'Not/A_Zone' },
    { ...base, durationMinutes: 0 }, { ...base, durationMinutes: 1.5 }, { ...base, durationMinutes: 44641 },
    { ...base, excludeItemId: 'x' },
  ]) assert.equal(freeSlotsInput.safeParse(value).success, false);
  assert.deepEqual(findFreeSlots(snapshot(), { ...base, from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }).slots, []);
});

test('absolute offsets handle DST while requested timezone may differ from snapshot timezone', () => {
  const range = { from: '2026-11-01T01:00:00-04:00', to: '2026-11-01T02:00:00-05:00', timezone: 'America/New_York', durationMinutes: 120 };
  assert.deepEqual(findFreeSlots(snapshot(), range), { slots: [{ startsAt: range.from, endsAt: range.to }],
    truncated: false, scheduleRevision: 7, timezone: 'America/New_York', asOf: now });
  assert.deepEqual(findFreeSlots(snapshot(), { ...range, durationMinutes: 121 }).slots, []);
});

test('returns only 20 maximal windows and signals truncation without item identities', async () => {
  const from = '2026-11-01T00:00:00Z';
  const items = Array.from({ length: 21 }, (_, index) => {
    const start = Date.parse(from) + (index * 2 + 1) * 60_000;
    return item(`id-${index}`, new Date(start).toISOString(), new Date(start + 60_000).toISOString());
  });
  const range = { from, to: '2026-11-01T01:00:00Z', timezone: 'UTC', durationMinutes: 1 };
  const result = findFreeSlots(snapshot(items), range);
  assert.equal(result.slots.length, 20); assert.equal(result.truncated, true);
  const store = new MemoryPlanningStore();
  await store.transaction('alice', state => { for (const value of items) state.items.set(value.id, value); state.scheduleRevision = 7; });
  const planning = new PlanningService(store, () => new Date(now));
  const tool = createPlanningTools(planning, await planning.capture('alice', 'UTC')).find(value => value.name === 'find_free_slots')!;
  assert.deepEqual(await tool.run(range, 'alice'), result);
  await assert.rejects(tool.run(range, 'bob'), /TOOL_SCOPE_MISMATCH/);
});

test('fails closed when a timed snapshot item has invalid or missing boundaries', () => {
  const broken = item('bad', '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z');
  broken.timeSlot!.endsAt = 'invalid';
  assert.throws(() => findFreeSlots(snapshot([broken]), query), /Invalid snapshot item/);
});
