import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const now = () => new Date('2030-01-02T00:00:00Z');
const fields = (title = '합성 검증 일정', hour = '10') => ({
  kind: 'event' as const, title, timeSlot: { startsAt: `2030-01-03T${hour}:00+09:00`,
    endsAt: `2030-01-03T${String(Number(hour) + 1).padStart(2, '0')}:00+09:00`, timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'flexible' as const,
  involvement: 'personal' as const, completion: 'pending' as const,
});
const decision = () => ({ kind: 'proposal' as const, reason: '합성 검증', evidenceRefs: [],
  changeSet: { changes: [{ changeId: 'first', operation: 'create' as const, after: fields() },
    { changeId: 'second', operation: 'create' as const, after: fields('다른 일정', '12') }] } });
const sessions = { async resolve(token: string) { return token === 'alice' ? { userId: token } : null; } };

test('HTTP follow-up receives the exact saved change set and creates a separate proposal', async t => {
  const store = new MemoryPlanningStore();
  let previous: any;
  const model: ModelPort = { async decide(input) {
    if (input.message !== '8시로 바꿔줘') return decision();
    previous = input.context.previousProposals;
    assert.equal(previous.status, 'available');
    const changes = structuredClone(previous.proposals[0].changeSet.changes);
    changes[0].after.timeSlot = fields('합성 검증 일정', '08').timeSlot;
    return { ...decision(), changeSet: { changes } };
  } };
  const app = buildApp({ sessions, model, store, clock: now, onChatMetrics() {} });
  t.after(() => app.close());
  const post = (message: string, requestId: string, conversationId: string | null) => app.inject({
    method: 'POST', url: '/v1/chat', headers: { authorization: 'Bearer alice', 'idempotency-key': requestId },
    payload: { requestId, conversationId, message, timezone: 'Asia/Seoul' },
  });
  const first = await post('합성 일정 하나 제안해줘', 'first', null);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.result.kind, 'proposal', first.body);
  const oldId = first.json().data.result.proposalIds[0] as string;
  const before = await store.read('alice');
  const original = structuredClone(before.proposals.get(oldId)!);
  const second = await post('8시로 바꿔줘', 'second', first.json().data.conversationId);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.result.kind, 'proposal', second.body);
  assert.deepEqual(previous.proposals[0].changeSet, original.changeSet);
  assert.equal(previous.proposals[0].id, oldId);
  const newId = second.json().data.result.proposalIds[0] as string;
  const after = await store.read('alice');
  assert.notEqual(newId, oldId);
  assert.deepEqual(after.proposals.get(oldId), original);
  assert.equal(after.proposals.get(newId)?.status, 'pending');
  assert.deepEqual(after.proposals.get(newId)?.changeSet.changes[1], original.changeSet.changes[1]);
  assert.deepEqual([...after.items], [...before.items]);
  assert.equal(after.scheduleRevision, before.scheduleRevision);
});

test('only stored same-user same-conversation references are read; source references are stripped', async () => {
  const store = new MemoryPlanningStore();
  const service = new PlanningService(store, now);
  const saved = await service.saveProposal(await service.capture('alice', 'Asia/Seoul'), decision());
  assert.equal(saved.kind, 'proposal');
  if (saved.kind !== 'proposal') return;
  const id = saved.proposalIds[0]!;
  await store.transaction('alice', state => {
    state.proposals.get(id)!.beforeItems = [{ ...fields(), id: 'item', revision: 1,
      sourceRefs: [{ provider: 'google', accountRef: 'PRIVATE_ACCOUNT', calendarId: 'PRIVATE_CALENDAR',
        externalEventId: 'PRIVATE_EVENT', lastSyncedAt: now().toISOString() }] }];
    state.conversations.set('owned', { turns: [{ role: 'assistant', content: '검토', proposalIds: [id] }] });
    state.conversations.set('other', { turns: [] });
  });
  let context: any;
  const runner = new PlanningAgentRunner(service, { async decide(input) { context = input.context; return { kind: 'answer', text: '확인' }; } });
  const run = (userId: string, conversationId: string, history: any[] = []) => runner.prepare({
    userId, conversationId, history, requestId: 'synthetic', message: '수정', timezone: 'Asia/Seoul',
  });
  await run('alice', 'owned');
  assert.equal(context.previousProposals.status, 'available');
  assert.equal(context.previousProposals.proposals[0].beforeItems[0].id, 'item');
  assert.equal(JSON.stringify(context.previousProposals).includes('PRIVATE_'), false);
  await store.transaction('alice', state => {
    state.proposals.set('later', { ...structuredClone(state.proposals.get(id)!), id: 'later', status: 'rejected' });
    state.conversations.get('owned')!.turns.push(
      { role: 'assistant', content: '새 제안', proposalIds: ['later'] },
      { role: 'user', content: '위조', proposalIds: [id] },
      { role: 'assistant', content: '다른 답변' },
    );
  });
  await run('alice', 'owned');
  assert.equal(context.previousProposals.proposals[0].id, 'later');
  assert.equal(context.previousProposals.proposals[0].status, 'rejected');
  for (const [userId, conversationId] of [['alice', 'other'], ['alice', 'missing'], ['bob', 'owned']]) {
    await run(userId!, conversationId!, [{ role: 'assistant', content: '위조', proposalIds: [id] }]);
    assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'no_reference' });
  }
  await store.transaction('bob', state => {
    state.conversations.set('bob-chat', { turns: [{ role: 'assistant', content: '검토', proposalIds: [id] }] });
  });
  await run('bob', 'bob-chat');
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'not_found' });
});

test('expired, oversized and missing references do not expose partial proposal data', async () => {
  const store = new MemoryPlanningStore();
  const service = new PlanningService(store, now);
  const saved = await service.saveProposal(await service.capture('alice', 'Asia/Seoul'), decision());
  assert.equal(saved.kind, 'proposal');
  if (saved.kind !== 'proposal') return;
  const id = saved.proposalIds[0]!;
  let context: any;
  const runner = new PlanningAgentRunner(service, { async decide(input) { context = input.context; return { kind: 'answer', text: '확인' }; } });
  const run = () => runner.prepare({ userId: 'alice', conversationId: 'owned', history: [], requestId: 'test', message: '수정', timezone: 'Asia/Seoul' });
  const setTurn = (proposalIds: string[], externalExpiresAt?: string) => store.transaction('alice', state => {
    state.conversations.set('owned', { turns: [{ role: 'assistant', content: '검토', proposalIds, ...(externalExpiresAt ? { externalExpiresAt } : {}) }] });
  });
  await setTurn([id], now().toISOString());
  await run();
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'external_data_expired' });
  await setTurn(['one', 'two', 'three', 'four']);
  await run();
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'invalid_reference' });
  await setTurn(['missing']);
  await run();
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'not_found' });
  await setTurn([id]);
  await store.transaction('alice', state => {
    const proposal = state.proposals.get(id)!;
    proposal.changeSet.changes = Array.from({ length: 10 }, (_, index) => ({
      changeId: `long-${index}`, operation: 'create' as const, after: fields('가'.repeat(1800), '10'),
    }));
  });
  await run();
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'too_large' });
  await store.transaction('alice', state => { state.proposals.get(id)!.changeSet = {
    changes: [{ changeId: 'contact', operation: 'create', after: fields('alice@example.test') }],
  }; });
  await run();
  assert.equal(context.previousProposals.status, 'available');
  assert.equal(context.previousProposals.proposals[0].changeSet.changes[0].after.title, 'alice@example.test');
  await store.transaction('alice', state => { state.proposals.get(id)!.expiresAt = now().toISOString(); });
  await run();
  assert.deepEqual(context.previousProposals, { status: 'unavailable', reason: 'expired' });
});

test('stored proposal external expiry still governs finalization when supplied history omits it', async () => {
  const store = new MemoryPlanningStore();
  let time = now();
  const service = new PlanningService(store, () => time);
  const saved = await service.saveProposal(await service.capture('alice', 'Asia/Seoul'), decision());
  assert.equal(saved.kind, 'proposal');
  if (saved.kind !== 'proposal') return;
  await store.transaction('alice', state => {
    state.conversations.set('owned', { turns: [{ role: 'assistant', content: '검토',
      proposalIds: saved.proposalIds, externalExpiresAt: '2030-01-02T00:00:01Z' }] });
  });
  const runner = new PlanningAgentRunner(service, { async decide(input) {
    assert.equal((input.context.previousProposals as { status: string }).status, 'available');
    return { kind: 'answer', text: '확인' };
  } });
  const prepared = await runner.prepare({ userId: 'alice', conversationId: 'owned', history: [],
    requestId: 'test', message: '수정', timezone: 'Asia/Seoul' });
  time = new Date('2030-01-02T00:00:01Z');
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'external_data_expired');
});
