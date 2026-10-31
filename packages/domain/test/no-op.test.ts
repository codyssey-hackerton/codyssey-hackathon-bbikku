import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChanges } from '@pikku/domain';
import type { Change, ChangeValidationContext, ScheduleFields, ScheduleItem } from '@pikku/domain';

const fields: ScheduleFields = { kind: 'task', title: '공부',
  timeSlot: { startsAt: '2026-11-01T10:00+09:00', endsAt: '2026-11-01T10:30+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: 30, deadline: '2026-11-01T11:00+09:00', flexibility: 'flexible', involvement: 'personal', completion: 'incomplete' };
const item: ScheduleItem = { ...fields, id: 'task', revision: 1, sourceRefs: [] };
const update = (after: ScheduleFields, target = item): Change => ({ changeId: target.id, operation: 'update', targetId: target.id, expectedRevision: target.revision, after });
const input = (changes: Change[]): ChangeValidationContext => ({ authenticatedUserId: 'user', snapshotUserId: 'user',
  snapshot: { now: '2026-10-31T00:00Z', timezone: 'UTC', scheduleRevision: 1, contextRevision: 1, items: [item], facts: [], missingFields: [] },
  changeSet: { changes }, purpose: 'ai_proposal', checkedAt: '2026-10-31T00:00Z' });

test('AI rejects only semantically unchanged updates; direct commands remain valid', () => {
  const equivalent: ScheduleFields = { ...fields, timeSlot: { startsAt: '2026-11-01T01:00:00.000000Z', endsAt: '2026-11-01T01:30Z', timezone: 'Asia/Seoul' }, deadline: '2026-11-01T02:00:00Z' };
  for (const after of [fields, equivalent]) {
    const request = input([update(after)]); const before = structuredClone(request);
    const result = validateChanges(request);
    assert.equal(result.valid, false);
    assert.ok(result.conflicts.some(conflict => conflict.reason === 'no_effective_change'));
    assert.deepEqual(request, before);
    assert.equal(validateChanges({ ...request, purpose: 'user_command' }).valid, true);
  }
});

test('real field changes and mixed sets remain valid without removing unchanged updates', () => {
  for (const after of [{ ...fields, title: '복습' }, { ...fields, deadline: '2026-11-01T12:00+09:00' },
    { ...fields, timeSlot: { ...fields.timeSlot!, timezone: 'UTC' } }]) {
    assert.equal(validateChanges(input([update(after)])).valid, true);
  }
  const second: ScheduleItem = { ...item, id: 'second', timeSlot: null };
  const request = input([update(fields), update({ ...fields, title: '다른 작업', timeSlot: null }, second)]);
  request.snapshot.items.push(second);
  const before = structuredClone(request);
  assert.equal(validateChanges(request).valid, true);
  assert.deepEqual(request, before);
  assert.equal(request.changeSet.changes.length, 2);
});
