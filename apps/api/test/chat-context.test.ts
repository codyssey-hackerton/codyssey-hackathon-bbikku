import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createResponsesModel } from '../src/model.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { PlanningService } from '../src/planning-service.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (user: string, key: string) => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const body = { requestId: 'r1', conversationId: null, message: '도와줘', timezone: 'Asia/Seoul' };
const item = { id: 'item-1', revision: 1, kind: 'task' as const, title: '사용자 일정', timeSlot: null,
  durationMinutes: 30, deadline: null, flexibility: 'flexible' as const, involvement: 'personal' as const,
  completion: 'pending' as const, sourceRefs: [] };

test('선택 항목은 인증 사용자 소유와 버전을 확인하고 서버 데이터만 모델에 제공한다', async t => {
  const store = new MemoryPlanningStore();
  await store.transaction('alice', state => { state.items.set(item.id, item); state.scheduleRevision++; });
  let calls = 0;
  const app = buildApp({ store, sessions, model: { async decide(input) {
    calls++;
    const { sourceRefs: _sourceRefs, ...safeItem } = item;
    assert.deepEqual(input.context.entryContext, { kind: 'item', item: safeItem });
    return { kind: 'answer', text: '확인했어요.' };
  } } });
  t.after(() => app.close());
  const entryContext = { kind: 'item', id: item.id, expectedRevision: item.revision };
  const stolen = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('bob', 'stolen'), payload: { ...body, entryContext } });
  assert.equal(stolen.statusCode, 404);
  const stale = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'stale'), payload: { ...body, entryContext: { ...entryContext, expectedRevision: 2 } } });
  assert.equal(stale.statusCode, 409);
  const spoofed = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'spoofed'), payload: { ...body, entryContext: { ...entryContext, title: '다른 내용', userId: 'bob' } } });
  assert.equal(spoofed.statusCode, 400);
  const good = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'good'), payload: { ...body, entryContext } });
  assert.equal(good.statusCode, 200);
  assert.equal(calls, 1);
});

test('폼과 신규 작성은 구조화된 초안만 반환하고 일정 및 제안은 저장하지 않는다', async t => {
  const store = new MemoryPlanningStore();
  let calls = 0;
  const model = createResponsesModel('synthetic-key', async () => {
    calls++;
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
      kind: 'draft', text: '초안을 확인해 주세요.', draft: { kind: 'routine', fields: { title: '운동', weekdays: ['1', '3'] } },
    }) }] }] });
  });
  const app = buildApp({ store, sessions, model });
  t.after(() => app.close());
  const entryContext = { kind: 'form', draft: { kind: 'routine', fields: { title: '', weekdays: ['1'], duration: '30' } } };
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'form'), payload: { ...body, entryContext } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().data.result, { kind: 'reply', message: '초안을 확인해 주세요.', draft: { kind: 'routine', fields: { title: '운동', weekdays: ['1', '3'] } } });
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'form'), payload: { ...body, entryContext } });
  assert.deepEqual(replay.json(), first.json());
  assert.equal(calls, 1);
  const fresh = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'create'), payload: { ...body, entryContext: { kind: 'create' } } });
  assert.equal(fresh.json().data.result.draft.kind, 'routine');
  const state = await store.read('alice');
  assert.equal(state.items.size, 0);
  assert.equal(state.proposals.size, 0);
});

test('폼에서 일정 제안 저장과 비허용 필드의 초안 반환을 막는다', async t => {
  let next: unknown = { kind: 'proposal', reason: '변경', changeSet: { changes: [] }, evidenceRefs: [] };
  const store = new MemoryPlanningStore();
  const app = buildApp({ store, sessions, model: { async decide() { return next; } } });
  t.after(() => app.close());
  const entryContext = { kind: 'form', draft: { kind: 'task', fields: { title: '원래 값' } } };
  const proposal = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'proposal'), payload: { ...body, entryContext } });
  assert.equal(proposal.json().data.result.kind, 'failure');
  next = { kind: 'draft', text: '초안', draft: { kind: 'task', fields: { title: '새 값', durationMinutes: '30' } } };
  const extra = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'extra'), payload: { ...body, entryContext } });
  assert.equal(extra.json().data.result.kind, 'failure');
  assert.equal((await store.read('alice')).proposals.size, 0);
});

test('선택 일정이 모델 호출 중 바뀌면 과거 정보에 근거한 답변을 반환하지 않는다', async () => {
  const store = new MemoryPlanningStore();
  await store.transaction('alice', state => { state.items.set(item.id, item); state.scheduleRevision++; });
  const runner = new PlanningAgentRunner(new PlanningService(store), { async decide() { return { kind: 'answer', text: '기존 상태' }; } });
  const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, message: '설명해줘', timezone: 'UTC', history: [],
    entryContext: { kind: 'item', id: item.id, expectedRevision: item.revision } });
  await store.transaction('alice', state => { state.items.set(item.id, { ...item, revision: 2, title: '변경됨' }); state.scheduleRevision++; });
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'stale_snapshot');
});

test('일정 폼의 날짜와 시각 입력을 맥락과 초안으로 전달한다', async t => {
  const app = buildApp({ sessions, model: { async decide() { return { kind: 'draft', text: '확인',
    draft: { kind: 'event', fields: { startDate: '2026-11-01', startTime: '10:00', endDate: '2026-11-01', endTime: '11:00' } } }; } } });
  t.after(() => app.close());
  const fields = { title: '회의', startsAt: '', endsAt: '', startDate: '2026-11-01', startTime: '', endDate: '2026-11-01', endTime: '' };
  const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'date'), payload: {
    ...body, entryContext: { kind: 'form', draft: { kind: 'event', fields } },
  } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.result.draft.fields.startTime, '10:00');
});

test('수정 요청은 새 제안을 만들고 새 제안의 거절·승인은 기존 제안 원본을 바꾸지 않는다', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date('2026-11-01T00:00:00Z'));
  await store.transaction('alice', state => { state.items.set(item.id, item); state.scheduleRevision++; });
  const { id: _id, revision: _revision, sourceRefs: _refs, ...before } = item;
  const decision = (title: string) => ({ kind: 'proposal' as const, reason: '변경 요청', evidenceRefs: [],
    changeSet: { changes: [{ changeId: 'change', operation: 'update', targetId: item.id, expectedRevision: 1, after: { ...before, title } }] } });
  const originalResult = await planning.saveProposal(await planning.capture('alice', 'UTC'), decision('원래 제안'));
  assert.equal(originalResult.kind, 'proposal'); if (originalResult.kind !== 'proposal') return;
  const originalId = originalResult.proposalIds[0];
  const original = structuredClone((await planning.getProposal('alice', originalId)).proposal);
  const runner = new PlanningAgentRunner(planning, { async decide() { return decision('수정된 제안'); } });
  const revised = await runner.finish(await runner.prepare({ userId: 'alice', requestId: 'revision', conversationId: null,
    message: `제안 ${originalId}를 바탕으로 새 제안을 작성해줘`, timezone: 'UTC', history: [] }));
  assert.equal(revised.kind, 'proposal'); if (revised.kind !== 'proposal') return;
  assert.deepEqual((await planning.getProposal('alice', originalId)).proposal, original);
  assert.equal((await store.read('alice')).items.get(item.id)?.title, item.title);
  await planning.decideProposal('alice', revised.proposalIds[0], { proposalRevision: 1, decision: 'reject' });
  assert.deepEqual((await planning.getProposal('alice', originalId)).proposal, original);
  assert.equal((await store.read('alice')).items.get(item.id)?.title, item.title);
  const accepted = await planning.saveProposal(await planning.capture('alice', 'UTC'), decision('승인한 변경'));
  assert.equal(accepted.kind, 'proposal'); if (accepted.kind !== 'proposal') return;
  await planning.decideProposal('alice', accepted.proposalIds[0], { proposalRevision: 1, decision: 'accept' });
  assert.equal((await store.read('alice')).items.get(item.id)?.title, '승인한 변경');
  assert.deepEqual((await planning.getProposal('alice', originalId)).proposal, original);
});
