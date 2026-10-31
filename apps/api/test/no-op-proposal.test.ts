import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const fields: ScheduleFields = { kind: 'task', title: '공부', timeSlot: null, durationMinutes: 30, deadline: null,
  flexibility: 'flexible', involvement: 'personal', completion: 'incomplete' };

test('server refuses an unchanged AI proposal without creating it or changing schedule revisions', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date('2026-10-31T00:00:00Z'));
  const created = await planning.command('user', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'new', operation: 'create', after: fields }] } });
  const item = created.items[0]!;
  const changeSet = { changes: [{ changeId: 'same', operation: 'update' as const, targetId: item.id, expectedRevision: item.revision, after: fields }] };
  const baseline = await planning.capture('user', 'UTC');
  const before = await store.read('user');
  const result = await planning.saveProposal(baseline, { kind: 'proposal', reason: '같은 일정', changeSet, evidenceRefs: [] });
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'conflict');
  assert.deepEqual(await store.read('user'), before);
  const direct = await planning.command('user', { expectedScheduleRevision: before.scheduleRevision, changeSet });
  assert.equal(direct.scheduleRevision, before.scheduleRevision + 1);
});
