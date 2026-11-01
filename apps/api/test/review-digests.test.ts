import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Proposal } from '@pikku/domain';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { listReviewDigests } from '../src/review-digests.ts';
import { buildApp } from '../src/app.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { PlanningService } from '../src/planning-service.ts';

test('review digest reads only the owner’s valid recent completed messages without changing proposals', async () => {
  const store = new MemoryPlanningStore();
  const now = new Date('2030-01-10T12:00:00.000Z');
  const base = { status: 'completed', eventId: 'event', reason: 'morning_review', timezone: 'Asia/Seoul',
    targetDate: '2030-01-10', scheduledFor: '2030-01-10T10:00:00.000Z', at: '2030-01-10T10:01:00.000Z' };
  await store.transaction('alice', state => {
    state.proposals.set('p1', { id: 'p1', status: 'pending', revision: 1 } as Proposal);
    state.reviewLedger.set('good', { ...base, result: { kind: 'proposal', message: '제안을 확인해 주세요.', proposalIds: ['p1'] }, privateNote: 'SECRET' });
    state.reviewLedger.set('reply', { ...base, eventId: 'reply', reason: 'evening_plan', result: { kind: 'reply', message: '오늘 회고입니다.' } });
    state.reviewLedger.set('old', { ...base, eventId: 'old', scheduledFor: '2030-01-02T00:00:00Z', at: '2030-01-02T00:00:01Z', result: { kind: 'reply', message: '오래됨' } });
    state.reviewLedger.set('failure', { ...base, eventId: 'failed', result: { kind: 'failure', message: '실패', code: 'error', retryable: false } });
    state.reviewLedger.set('legacy', { eventId: 'legacy', status: 'completed', at: base.at, result: { kind: 'reply', message: '이전 형식' } });
    state.reviewLedger.set('foreign', { ...base, eventId: 'foreign', result: { kind: 'proposal', message: '없는 제안', proposalIds: ['other-user'] } });
    state.reviewLedger.set('future', { ...base, eventId: 'future', at: '2030-01-11T00:00:00Z', result: { kind: 'reply', message: '미래' } });
  });
  await store.transaction('bob', state => {
    state.reviewLedger.set('bob', { ...base, eventId: 'bob', result: { kind: 'reply', message: '다른 사용자' } });
  });
  const before = await store.read('alice');
  const found = listReviewDigests(before, now);
  assert.deepEqual(found.digests.map(item => item.id), ['event', 'reply']);
  assert.deepEqual(found.digests[0]?.proposalIds, ['p1']);
  assert.equal(JSON.stringify(found).includes('SECRET'), false);
  assert.equal(JSON.stringify(found).includes('다른 사용자'), false);
  assert.deepEqual((await store.read('alice')).proposals, before.proposals);
  assert.deepEqual(listReviewDigests(await store.read('bob'), now).digests.map(item => item.id), ['bob']);
});

test('review digest output is bounded and deduplicated', async () => {
  const store = new MemoryPlanningStore(), now = new Date('2030-01-10T12:00:00Z');
  await store.transaction('alice', state => {
    for (let i = 0; i < 15; i++) state.reviewLedger.set(String(i), { eventId: `e${i}`, status: 'completed',
      reason: 'morning_review', timezone: 'Asia/Seoul', targetDate: '2030-01-10', scheduledFor: '2030-01-10T10:00:00Z',
      at: new Date(now.getTime() - (i + 1) * 1000).toISOString(), result: { kind: 'reply', message: '확인' } });
  });
  const result = listReviewDigests(await store.read('alice'), now).digests;
  assert.equal(result.length, 10); assert.equal(result[0]?.id, 'e0'); assert.equal(result[9]?.id, 'e9');
});

test('authenticated digest route reads only the current user without modifying the ledger', async t => {
  const store = new MemoryPlanningStore(), now = new Date('2030-01-10T12:00:00Z');
  for (const user of ['alice', 'bob']) await store.transaction(user, state => {
    state.reviewLedger.set('entry', { eventId: `event-${user}`, status: 'completed', reason: 'morning_review',
      timezone: 'Asia/Seoul', targetDate: '2030-01-10', scheduledFor: '2030-01-10T10:00:00Z',
      at: '2030-01-10T10:01:00Z', result: { kind: 'reply', message: `message-${user}` } });
  });
  const app = buildApp({ store, clock: () => now, sessions: { async resolve(token) {
    return ['alice', 'bob'].includes(token) ? { userId: token } : null;
  } } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/v1/review-digests' })).statusCode, 401);
  const response = await app.inject({ method: 'GET', url: '/v1/review-digests', headers: { authorization: 'Bearer alice' } });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().data.digests.map((value: { message: string }) => value.message), ['message-alice']);
  assert.equal((await store.read('alice')).reviewLedger.size, 1);
});

test('ordinary runner sees only its user’s bounded recent reviews; scheduled triggers see none', async t => {
  const store = new MemoryPlanningStore(), now = new Date('2030-01-10T12:00:00Z');
  const seed = (user: string, id: string, message: string, at: string) => store.transaction(user, state => {
    state.reviewLedger.set(id, { eventId: id, status: 'completed', reason: 'morning_review', timezone: 'Asia/Seoul',
      targetDate: '2030-01-10', scheduledFor: '2030-01-10T10:00:00Z', at,
      result: { kind: 'reply', message }, privateNote: 'PRIVATE_LEDGER_VALUE' });
  });
  await seed('alice', 'a-new', '가'.repeat(2000), '2030-01-10T11:59:00Z');
  await seed('alice', 'a-second', '앨리스 회고 질문', '2030-01-10T11:58:00Z');
  await seed('alice', 'a-old', '오래된 앨리스 안내', '2030-01-10T11:57:00Z');
  await seed('bob', 'b-long', '나'.repeat(2001), '2030-01-10T11:59:00Z');
  await seed('bob', 'b-valid', '밥의 브리핑', '2030-01-10T11:58:00Z');
  const read = store.read.bind(store);
  const reads = t.mock.method(store, 'read', async (userId: string) => read(userId));
  const contexts: Record<string, unknown>[] = [];
  const runner = new PlanningAgentRunner(new PlanningService(store, () => now), { async decide(input) {
    contexts.push(input.context); return { kind: 'answer', text: '합성 답변' };
  } });
  const input = { requestId: 'test', conversationId: null, message: '그 질문에 답할게요', timezone: 'Asia/Seoul', history: [] };
  for (const userId of ['alice', 'bob']) await runner.finish(await runner.prepare({ ...input, userId }));
  await runner.finish(await runner.prepare({ ...input, userId: 'alice', triggerEvent: {
    id: 'scheduled', userId: 'alice', reason: 'evening_plan', scheduledFor: now.toISOString(), timezone: 'Asia/Seoul',
    targetDate: '2030-01-10', idempotencyKey: 'scheduled-key',
  } }));
  assert.equal(reads.mock.callCount(), 3);
  const alice = contexts[0]!.recentReviews as { id: string; message: string }[];
  const bob = contexts[1]!.recentReviews as { id: string; message: string }[];
  assert.deepEqual(alice.map(value => value.id), ['a-new', 'a-second']);
  assert.equal(alice[0]!.message.length, 2000);
  assert.deepEqual(bob.map(value => value.id), ['b-valid']);
  assert.equal('recentReviews' in contexts[2]!, false);
  assert.equal(JSON.stringify(contexts).includes('PRIVATE_LEDGER_VALUE'), false);
  assert.equal(JSON.stringify(contexts[0]).includes('밥의 브리핑'), false);
  assert.equal(JSON.stringify(contexts[1]).includes('앨리스 회고 질문'), false);
});
