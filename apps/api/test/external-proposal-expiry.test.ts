import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const start = '2026-11-01T00:00:00.000Z';
const deadline = '2026-11-01T00:05:00.000Z';
const decision = { kind: 'proposal' as const, reason: '현재 외부 조회를 참고한 계획', evidenceRefs: [],
  changeSet: { changes: [{ changeId: 'task', operation: 'create' as const, after: {
    kind: 'task' as const, title: '할 일', durationMinutes: 30, deadline: null,
    timeSlot: { startsAt: '2026-11-01T01:00:00Z', endsAt: '2026-11-01T01:30:00Z', timezone: 'UTC' },
    flexibility: 'flexible' as const, involvement: 'personal' as const, completion: 'pending' as const,
  } }] } };

test('external expiry is persisted and blocks approval without changing the schedule', async () => {
  let now = start;
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date(now));
  const baseline = await planning.capture('alice', 'UTC');
  baseline.externalExpiresAt = deadline;
  const saved = await planning.saveProposal(baseline, decision);
  assert.equal(saved.kind, 'proposal'); if (saved.kind !== 'proposal') return;
  const proposal = (await planning.getProposal('alice', saved.proposalIds[0])).proposal;
  assert.equal(proposal.expiresAt, deadline);
  now = deadline;
  await assert.rejects(planning.decideProposal('alice', proposal.id, { proposalRevision: 1, decision: 'accept' }),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'expired_proposal');
  const state = await store.read('alice');
  assert.equal(state.items.size, 0); assert.equal(state.scheduleRevision, 0);
});

test('expired or malformed external evidence cannot be saved; ordinary proposals keep their expiry', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date(start));
  for (const expiry of [start, 'invalid']) {
    const baseline = await planning.capture('alice', 'UTC'); baseline.externalExpiresAt = expiry;
    const result = await planning.saveProposal(baseline, decision);
    assert.equal(result.kind, 'failure');
    if (result.kind === 'failure') assert.equal(result.code, 'external_data_expired');
    assert.equal((await store.read('alice')).proposals.size, 0);
  }
  const saved = await planning.saveProposal(await planning.capture('alice', 'UTC'), decision);
  assert.equal(saved.kind, 'proposal'); if (saved.kind !== 'proposal') return;
  assert.equal((await planning.getProposal('alice', saved.proposalIds[0])).proposal.expiresAt, '2026-11-01T00:30:00.000Z');
});
