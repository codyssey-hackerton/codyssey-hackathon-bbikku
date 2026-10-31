import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeSet, ScheduleFields, TimingConstraint } from '@pikku/domain';
import { createResponsesModel } from '../src/model.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createPreparationProposal } from '../src/preparation-service.ts';

const now = '2026-11-01T00:00:00Z';
const slot = (start: string, end: string) => ({ startsAt: `2026-11-01T${start}:00+09:00`, endsAt: `2026-11-01T${end}:00+09:00`, timezone: 'Asia/Seoul' });
const event: ScheduleFields = { kind: 'event', title: '약속', timeSlot: slot('15:00', '16:00'), durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' };
function task(title: string, start: string, end: string, durationMinutes: number): ScheduleFields {
  return { kind: 'task', title, timeSlot: slot(start, end), durationMinutes, deadline: event.timeSlot!.startsAt, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
}
async function setup() {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date(now));
  const created = await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'event', operation: 'create', after: event }] } });
  const target = created.items[0];
  const constraint: TimingConstraint = { appointment: { kind: 'existing', id: target.id, expectedRevision: target.revision },
    preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10, segments: { preparation: 'prep', travel: 'travel', buffer: 'buffer' } };
  const changes: ChangeSet = { changes: [
    { changeId: 'prep', operation: 'create', after: task('준비', '14:05', '14:20', 15) },
    { changeId: 'travel', operation: 'create', after: task('이동', '14:20', '14:50', 30) },
    { changeId: 'buffer', operation: 'create', after: task('여유', '14:50', '15:00', 10) },
  ], timingConstraints: [constraint] };
  return { store, planning, target, changes, constraint };
}
const decision = (changes: ChangeSet) => ({ kind: 'proposal' as const, reason: '약속 준비', changeSet: changes, evidenceRefs: [] });

test('model, graph, tool validation, persisted proposal and approval preserve the declared relationship', async () => {
  const { planning, target, changes } = await setup();
  const model = createResponsesModel('synthetic', async () => new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision(changes)) }] },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const runner = new PlanningAgentRunner(planning, model);
  const baseline = await planning.capture('alice', 'Asia/Seoul');
  assert.equal((await planning.validateTool(baseline, changes)).valid, true);
  const prepared = await runner.prepare({ userId: 'alice', requestId: 'r1', conversationId: null, message: '약속 준비해줘', timezone: 'Asia/Seoul', history: [] });
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'proposal'); if (result.kind !== 'proposal') return;
  const proposal = (await planning.getProposal('alice', result.proposalIds[0])).proposal;
  assert.deepEqual(proposal.changeSet.timingConstraints, changes.timingConstraints);
  const accepted = await planning.decideProposal('alice', proposal.id, { proposalRevision: proposal.revision, decision: 'accept' });
  assert.equal(accepted.outcome, 'applied');
  assert.ok((await planning.listSchedule('alice', { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', includeUnscheduled: 'true' })).items.some(item => item.id === target.id));
});

test('missing durations, swapped segments, duplicate references, stale targets and schedule conflicts fail closed', async () => {
  const { planning, target, changes, constraint } = await setup();
  const baseline = await planning.capture('alice', 'Asia/Seoul');
  const validation = async (value: ChangeSet) => planning.validateTool(baseline, value);
  const missing = await validation({ ...changes, timingConstraints: [{ ...constraint, travelMinutes: null }] });
  assert.equal(missing.valid, false); assert.ok(missing.missingFields.some(value => value.includes('travelMinutes')));
  const question = await planning.saveProposal(baseline, decision({ ...changes, timingConstraints: [{ ...constraint, travelMinutes: null }] }));
  assert.equal(question.kind, 'question');
  for (const value of [
    { ...constraint, segments: { ...constraint.segments, preparation: 'travel', travel: 'prep' } },
    { ...constraint, segments: { ...constraint.segments, travel: 'prep' } },
    { ...constraint, segments: { ...constraint.segments, travel: 'does-not-exist' } },
    { ...constraint, appointment: { kind: 'existing' as const, id: target.id, expectedRevision: target.revision + 1 } },
  ]) assert.equal((await validation({ ...changes, timingConstraints: [value] })).valid, false);
  assert.equal((await validation({ ...changes, timingConstraints: [constraint, constraint] })).valid, false);
  const duplicated = changes.changes.map(change => ({ ...change, changeId: `${change.changeId}-other` }));
  const overlapping = await validation({ changes: [...changes.changes, ...duplicated], timingConstraints: [constraint,
    { ...constraint, segments: { preparation: 'prep-other', travel: 'travel-other', buffer: 'buffer-other' } }] });
  assert.ok(overlapping.conflicts.some(value => value.reason.startsWith('overlapping_timing_constraints:')));
  const overlap = { ...changes, changes: [...changes.changes, { changeId: 'conflict', operation: 'create' as const, after: task('다른 작업', '14:10', '14:15', 5) }] };
  const invalid = await validation(overlap);
  assert.equal(invalid.valid, false); assert.ok(invalid.conflicts.some(value => value.reason.startsWith('overlap:')));
});

test('approval rejects a proposal after its linked appointment has changed', async () => {
  const { planning, target, changes } = await setup();
  const saved = await planning.saveProposal(await planning.capture('alice', 'Asia/Seoul'), decision(changes));
  assert.equal(saved.kind, 'proposal'); if (saved.kind !== 'proposal') return;
  await planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: target.id,
    expectedRevision: target.revision, after: { ...event, timeSlot: slot('16:00', '17:00') } }] } });
  await assert.rejects(planning.decideProposal('alice', saved.proposalIds[0], { proposalRevision: 1, decision: 'accept' }), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'stale_proposal');
});

test('a newly created appointment can be linked by changeId and is checked again at approval', async () => {
  const { planning, store } = await setup();
  const changes: ChangeSet = { changes: [
    { changeId: 'new-event', operation: 'create', after: { ...event, timeSlot: slot('17:00', '18:00') } },
    { changeId: 'prep', operation: 'create', after: task('준비', '16:05', '16:20', 15) },
    { changeId: 'travel', operation: 'create', after: task('이동', '16:20', '16:50', 30) },
    { changeId: 'buffer', operation: 'create', after: task('여유', '16:50', '17:00', 10) },
  ], timingConstraints: [{ appointment: { kind: 'change', changeId: 'new-event' }, preparationMinutes: 15, travelMinutes: 30,
    bufferMinutes: 10, segments: { preparation: 'prep', travel: 'travel', buffer: 'buffer' } }] };
  // These segments are for the new appointment, not the existing 15:00 one.
  for (const change of changes.changes) if (change.operation === 'create' && change.after.kind === 'task') change.after.deadline = '2026-11-01T17:00:00+09:00';
  const saved = await planning.saveProposal(await planning.capture('alice', 'Asia/Seoul'), decision(changes));
  assert.equal(saved.kind, 'proposal'); if (saved.kind !== 'proposal') return;
  await store.transaction('alice', state => { state.proposals.get(saved.proposalIds[0])!.changeSet.timingConstraints![0].travelMinutes = 31; });
  await assert.rejects(planning.decideProposal('alice', saved.proposalIds[0], { proposalRevision: 1, decision: 'accept' }), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'stale_proposal');
});

test('existing preparation screen proposals preserve the target and declared segment values', async () => {
  const { planning, target } = await setup();
  const result = await createPreparationProposal(planning, 'alice', { targetId: target.id, expectedTargetRevision: target.revision, expectedScheduleRevision: 1,
    timezone: 'Asia/Seoul', preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 });
  assert.equal(result.kind, 'proposal'); if (result.kind !== 'proposal') return;
  const proposal = (await planning.getProposal('alice', result.proposalIds[0])).proposal;
  assert.deepEqual(proposal.changeSet.timingConstraints?.[0], { appointment: { kind: 'existing', id: target.id, expectedRevision: target.revision },
    preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10, segments: { preparation: 'preparation', travel: 'travel', buffer: 'buffer' } });
});
