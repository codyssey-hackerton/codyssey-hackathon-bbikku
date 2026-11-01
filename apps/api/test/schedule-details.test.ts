import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChanges, type ScheduleFields, type ScheduleItem } from '@pikku/domain';
import { changeSet } from '../src/planning-schemas.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { findFreeSlots } from '../src/free-slots.ts';

const now = '2030-01-01T00:00:00Z';
const fields: ScheduleFields = { kind: 'event', title: '종일 일정', timeSlot: {
  startsAt: '2030-01-02T00:00:00+09:00', endsAt: '2030-01-03T00:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const update = (item: ScheduleItem, after: ScheduleFields) => ({ changeId: 'edit', operation: 'update' as const, targetId: item.id, expectedRevision: item.revision, after });
const snapshot = (items: ScheduleItem[]) => ({ now, timezone: 'Asia/Seoul', scheduleRevision: 1, contextRevision: 0, items, facts: [], missingFields: [] });
function validate(item: ScheduleItem, after: ScheduleFields) {
  return validateChanges({ authenticatedUserId: 'owner', snapshotUserId: 'owner', snapshot: snapshot([item]),
    checkedAt: now, purpose: 'ai_proposal', changeSet: { changes: [update(item, after)] } });
}

test('schedule details validate, survive omitted updates and accept explicit clear', async () => {
  const store = new MemoryPlanningStore(); const service = new PlanningService(store, () => new Date(now));
  const created = await service.command('owner', { expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'create', operation: 'create', after: { ...fields, allDay: true, blocksTime: false, notes: '직접 입력한 메모' } },
  ] } });
  const item = created.items[0]!;
  assert.equal(validate(item, fields).conflicts.some(value => value.reason === 'no_effective_change'), true);
  const renamed = await service.command('owner', { expectedScheduleRevision: 1, changeSet: { changes: [update(item, { ...fields, title: '제목 수정' })] } });
  assert.equal(renamed.items[0]!.allDay, true);
  assert.equal(renamed.items[0]!.blocksTime, false);
  assert.equal(renamed.items[0]!.notes, item.notes);
  const cleared = await service.command('owner', { expectedScheduleRevision: 2, changeSet: { changes: [update(renamed.items[0]!, { ...fields, notes: null })] } });
  assert.equal(cleared.items[0]!.notes, null);
  assert.equal((await store.read('other')).items.size, 0);
  for (const value of [{ ...fields, notes: 'x'.repeat(20_001) }, { ...fields, allDay: null }, { ...fields, blocksTime: 'false' }]) {
    assert.equal(changeSet.safeParse({ changes: [update(item, value as ScheduleFields)] }).success, false);
  }
});

test('all-day requires local midnight boundaries even when an update omits the flag', () => {
  const item: ScheduleItem = { ...fields, allDay: true, id: 'item', revision: 1, sourceRefs: [] };
  const after = { ...fields, timeSlot: { ...fields.timeSlot!, startsAt: '2030-01-02T01:00:00+09:00' } };
  assert.equal(validate(item, after).valid, false);
  assert.equal(validate(item, { ...after, allDay: false }).valid, true);
  assert.equal(validate(item, { ...fields, allDay: true, notes: '메모만 수정' }).valid, true);
});

test('transparent source events do not block free time, and AI cannot bypass conflicts by clearing blocksTime', () => {
  const item: ScheduleItem = { ...fields, id: 'item', revision: 1, sourceRefs: [] };
  const range = { from: fields.timeSlot!.startsAt, to: fields.timeSlot!.endsAt, timezone: 'Asia/Seoul', durationMinutes: 60 };
  assert.equal(findFreeSlots(snapshot([item]), range).slots.length, 0);
  assert.equal(findFreeSlots(snapshot([{ ...item, blocksTime: false }]), range).slots.length, 1);
  assert.equal(validate(item, { ...fields, blocksTime: false }).valid, false);
  const context = { authenticatedUserId: 'owner', snapshotUserId: 'owner', snapshot: snapshot([{ ...item, blocksTime: false }]),
    checkedAt: now, purpose: 'user_command' as const, changeSet: { changes: [{ changeId: 'new', operation: 'create' as const, after: fields }] } };
  assert.equal(validateChanges(context).valid, true);
});
