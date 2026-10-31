import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Change, ScheduleFields } from '@pikku/domain';
import { createPreparationProposal } from '../src/preparation-service.ts';
import { PlanningError, PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const event: ScheduleFields = { kind: 'event', title: '약속', timeSlot: { startsAt: '2030-01-02T15:00+09:00', endsAt: '2030-01-02T16:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' };
async function fixture() {
  const store = new MemoryPlanningStore(); const planning = new PlanningService(store, () => new Date('2030-01-01T00:00:00Z'));
  const created = await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'event', operation: 'create', after: event }] } });
  const item = created.items[0]!;
  return { store, planning, item, input: { targetId: item.id, expectedTargetRevision: item.revision, expectedScheduleRevision: 1,
    timezone: 'Asia/Seoul', preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 } };
}

test('15 and 45 minute preparation produces computed pending alternatives without changing the schedule', async () => {
  for (const preparationMinutes of [15, 45]) {
    const { store, planning, item, input } = await fixture(); const before = await store.read('alice');
    const result = await createPreparationProposal(planning, 'alice', { ...input, preparationMinutes });
    assert.equal(result.kind, 'proposal'); if (result.kind !== 'proposal') throw new Error('Expected proposal');
    const after = await store.read('alice'); const proposal = after.proposals.get(result.proposalIds[0]!)!;
    assert.equal(proposal.status, 'pending'); assert.deepEqual(after.items, before.items); assert.equal(after.scheduleRevision, 1);
    assert.deepEqual(proposal.evidenceRefs, [item.id]); assert.match(proposal.reason, /사용자 입력/);
    const changes = proposal.changeSet.changes.filter((change): change is Extract<Change, { operation: 'create' }> => change.operation === 'create');
    assert.equal(changes.length, 3);
    assert.equal(proposal.changeSet.changes.length, changes.length);
    assert.equal(changes[0]!.after.timeSlot!.startsAt, preparationMinutes === 15 ? '2030-01-02T05:05:00.000Z' : '2030-01-02T04:35:00.000Z');
    assert.equal(changes[0]!.after.timeSlot!.endsAt, '2030-01-02T05:20:00.000Z');
    assert.equal(changes[1]!.after.timeSlot!.endsAt, '2030-01-02T05:50:00.000Z');
    assert.equal(changes[2]!.after.timeSlot!.endsAt, event.timeSlot!.startsAt);
  }
});

test('zero segments are omitted and missing, invalid or all-zero durations are rejected', async () => {
  const { planning, input } = await fixture();
  const result = await createPreparationProposal(planning, 'alice', { ...input, preparationMinutes: 0, travelMinutes: 30, bufferMinutes: 0 });
  assert.equal(result.kind, 'proposal'); if (result.kind !== 'proposal') throw new Error('Expected proposal');
  assert.equal((await planning.getProposal('alice', result.proposalIds[0]!)).proposal.changeSet.changes.length, 1);
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, preparationMinutes: 0, travelMinutes: 0, bufferMinutes: 0 }), (e: unknown) => e instanceof PlanningError && e.code === 'no_effective_change');
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, preparationMinutes: undefined } as never), (e: unknown) => e instanceof PlanningError && e.status === 400);
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, travelMinutes: -1 }), (e: unknown) => e instanceof PlanningError && e.status === 400);
});

test('conflicting intervals and stale revisions cannot save a preparation proposal', async () => {
  const { store, planning, input } = await fixture();
  const busy: ScheduleFields = { ...event, title: '다른 일정', timeSlot: { ...event.timeSlot!, startsAt: '2030-01-02T14:00+09:00', endsAt: '2030-01-02T14:30+09:00' } };
  await planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'busy', operation: 'create', after: busy }] } });
  await assert.rejects(createPreparationProposal(planning, 'alice', input), (e: unknown) => e instanceof PlanningError && e.code === 'stale_proposal');
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, expectedScheduleRevision: 2, expectedTargetRevision: 2 }), (e: unknown) => e instanceof PlanningError && e.code === 'stale_proposal');
  const result = await createPreparationProposal(planning, 'alice', { ...input, expectedScheduleRevision: 2 });
  assert.equal(result.kind, 'failure'); if (result.kind === 'failure') assert.equal(result.code, 'conflict');
  assert.equal((await store.read('alice')).proposals.size, 0);
});

test('a change after capture is rejected when saving the proposal', async () => {
  const { store, planning, item, input } = await fixture();
  const save = planning.saveProposal.bind(planning);
  planning.saveProposal = async (baseline, decision) => {
    await planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'edit', operation: 'update', targetId: item.id, expectedRevision: item.revision, after: { ...event, title: '변경됨' } }] } });
    return save(baseline, decision);
  };
  const result = await createPreparationProposal(planning, 'alice', input);
  assert.equal(result.kind, 'failure'); if (result.kind === 'failure') assert.equal(result.code, 'stale_proposal');
  const state = await store.read('alice'); assert.equal(state.proposals.size, 0); assert.equal(state.items.size, 1);
});

test('acceptance applies only the proposed tasks and retains the original appointment', async () => {
  const { store, planning, item, input } = await fixture();
  const result = await createPreparationProposal(planning, 'alice', input);
  assert.equal(result.kind, 'proposal'); if (result.kind !== 'proposal') throw new Error('Expected proposal');
  const decision = await planning.decideProposal('alice', result.proposalIds[0]!, { proposalRevision: 1, decision: 'accept' });
  assert.equal(decision.outcome, 'applied');
  const state = await store.read('alice'); assert.equal(state.items.size, 4);
  assert.deepEqual(state.items.get(item.id), item);
});

test('wrong owner, completed event, task target, and stale approvals do not change the appointment', async () => {
  const { store, planning, item, input } = await fixture();
  await assert.rejects(createPreparationProposal(planning, 'bob', { ...input, expectedScheduleRevision: 0 }), (e: unknown) => e instanceof PlanningError && e.status === 404);
  await planning.checkin('alice', item.id, { expectedRevision: item.revision, completion: 'completed' });
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, expectedScheduleRevision: 2, expectedTargetRevision: 2 }), (e: unknown) => e instanceof PlanningError && e.code === 'conflict');
  const task: ScheduleFields = { kind: 'task', title: '할 일', timeSlot: null, durationMinutes: 30, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
  const created = await planning.command('alice', { expectedScheduleRevision: 2, changeSet: { changes: [{ changeId: 'task', operation: 'create', after: task }] } });
  await assert.rejects(createPreparationProposal(planning, 'alice', { ...input, targetId: created.items[0]!.id, expectedTargetRevision: 1, expectedScheduleRevision: 3 }), (e: unknown) => e instanceof PlanningError && e.code === 'conflict');
  assert.equal((await store.read('alice')).proposals.size, 0);

  const fresh = await fixture();
  const proposal = await createPreparationProposal(fresh.planning, 'alice', fresh.input);
  if (proposal.kind !== 'proposal') throw new Error('Expected proposal');
  await fresh.planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'edit', operation: 'update', targetId: fresh.item.id, expectedRevision: 1, after: { ...event, title: '변경됨' } }] } });
  await assert.rejects(fresh.planning.decideProposal('alice', proposal.proposalIds[0]!, { proposalRevision: 1, decision: 'accept' }), (e: unknown) => e instanceof PlanningError && e.code === 'stale_proposal');
  assert.equal((await fresh.store.read('alice')).items.size, 1);
});
