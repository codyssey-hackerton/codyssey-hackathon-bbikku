import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PhoneConnections } from '../src/phone-connection.ts';

// The HTTP path uses only synthetic credentials, mocked voice/model ports and isolated memory.
test('chat → explicit call approval → Hongdae correction → separate approval keeps time unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-schedule-call-routes-'));
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { durable: true, mode: 'memory', read: memory.read.bind(memory),
    transaction: memory.transaction.bind(memory), atomic: memory.atomic.bind(memory),
    transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const now = '2026-11-01T03:00:00.000Z'; const clock = () => new Date(now);
  const planning = new PlanningService(store, clock);
  const timeSlot = { startsAt: '2026-11-02T18:00:00+09:00', endsAt: '2026-11-02T19:00:00+09:00', timezone: 'Asia/Seoul' };
  const original = (await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create',
    after: { kind: 'event', title: '저녁 약속', location: '강남역', timeSlot, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' } }] } })).items[0]!;
  let calls = 0;
  const credential = { provider: 'clawops' as const, mode: 'agent' as const, accountId: 'synthetic-account', apiKey: 'synthetic-key', agentId: 'synthetic-agent', fromNumber: '+827012345678' };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.claw-ops.com');
    // All upstream waits must be outside the user's DB lock.
    await store.transaction('alice', () => undefined);
    if (url.pathname.endsWith('/numbers')) return Response.json({ data: [{ number: '07012345678' }] });
    if (url.pathname.endsWith('/agents/synthetic-agent')) return Response.json({ agentId: credential.agentId, maxDurationSeconds: 120, liveEvents: { events: ['transcript.final'] } });
    if (url.pathname.endsWith('/calls') && init?.method === 'POST') {
      calls++; const body = JSON.parse(String(init.body)); assert.equal(body.AgentId, credential.agentId);
      assert.match(body.CallContext.Instruction, calls === 1 ? /강남역/ : /영업시간을 물어봐 주세요/);
      return Response.json({ callId: 'synthetic-call' }, { status: 201 });
    }
    if (url.pathname.endsWith('/live-events')) {
      const event = (id: string, name: string, detail: object = {}) => ({ id, event: name, timestamp: now, detail });
      return Response.json({ data: [event('1', 'stream.started'),
        event('2', 'transcript.final', { utteranceId: 'a1', role: 'agent', text: '내일 오후 6시에 강남역이 맞나요?' }),
        event('3', 'transcript.final', { utteranceId: 'u1', role: 'user', text: '아니, 홍대야. 시간은 똑같이 오후 6시.' }),
        event('4', 'stream.ended', { reason: 'completed' })], hasMore: false });
    }
    return Response.json({ callId: 'synthetic-call', accountId: credential.accountId, from: credential.fromNumber,
      to: '+821012345678', direction: 'outbound', status: 'completed', dateCreated: now });
  };
  const connections = new PhoneConnections({ directory, fetcher });
  await connections.connect('alice', credential);
  const app = buildApp({ store, clock, phoneConnections: connections,
    sessions: { async resolve(token) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } },
    model: { async decide(input) {
      if (input.context.callReview) return { kind: 'call_review', text: '시간은 그대로 두고 장소를 홍대로 정정합니다.', location: '홍대' };
      if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: { from: '2026-11-02T00:00:00+09:00', to: '2026-11-03T00:00:00+09:00', timezone: 'Asia/Seoul' } };
      return { kind: 'phone_request', text: '전화로 확인할까요?', itemId: original.id, expectedRevision: original.revision };
    } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function post(path: string, body: object, key: string, actor = 'alice') {
    return app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${actor}`, 'idempotency-key': key }, payload: { requestId: key, ...body } });
  }
  const chat = await post('/v1/chat', { conversationId: null, message: '내일 저녁 약속이 맞는지 나에게 전화해줘', timezone: 'Asia/Seoul' }, 'chat');
  assert.equal(chat.statusCode, 200, chat.body); assert.equal(chat.json().data.result.kind, 'phone_request'); assert.equal(calls, 0);
  const created = await post('/v1/schedule-calls', { itemId: original.id, expectedRevision: original.revision, toNumber: '01012345678' }, 'create');
  assert.equal(created.statusCode, 200, created.body); let call = created.json().data.call;
  assert.equal(call.status, 'pending'); assert.equal(calls, 0);
  const denied = await app.inject({ method: 'GET', url: `/v1/schedule-calls/${call.id}`, headers: { authorization: 'Bearer bob' } });
  assert.equal(denied.statusCode, 404);
  const unauthorized = await app.inject({ method: 'GET', url: `/v1/schedule-calls/${call.id}` }); assert.equal(unauthorized.statusCode, 401);
  const approvalBody = { revision: call.revision };
  const sent = await post(`/v1/schedule-calls/${call.id}/approve`, approvalBody, 'approve');
  assert.equal(sent.statusCode, 200, sent.body); call = sent.json().data.call; assert.equal(calls, 1);
  const replay = await post(`/v1/schedule-calls/${call.id}/approve`, approvalBody, 'approve'); assert.equal(replay.statusCode, 200); assert.equal(calls, 1);
  const checked = await post(`/v1/schedule-calls/${call.id}/check`, { revision: call.revision }, 'check');
  assert.equal(checked.statusCode, 200, checked.body); call = checked.json().data.call;
  assert.deepEqual((await store.read('alice')).items.get(original.id), original);
  const proposed = await post(`/v1/schedule-calls/${call.id}/propose`, { revision: call.revision }, 'propose');
  assert.equal(proposed.statusCode, 200, proposed.body); call = proposed.json().data.call;
  assert.equal(call.status, 'review_pending'); assert.equal(call.correction.afterLocation, '홍대');
  assert.deepEqual((await store.read('alice')).items.get(original.id), original);
  const decisionBody = { revision: call.revision, decision: 'accept' };
  const accepted = await post(`/v1/schedule-calls/${call.id}/decision`, decisionBody, 'accept');
  assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(accepted.json().data.call.status, 'applied');
  const current = (await store.read('alice')).items.get(original.id)!;
  assert.equal(current.location, '홍대'); assert.deepEqual(current.timeSlot, original.timeSlot); assert.equal(current.title, original.title);
  const duplicate = await post(`/v1/schedule-calls/${call.id}/decision`, decisionBody, 'accept'); assert.equal(duplicate.statusCode, 200);
  assert.equal((await store.read('alice')).items.get(original.id)!.revision, current.revision);
  assert.equal(calls, 1);
  const inquiry = await post('/v1/schedule-calls', { mode: 'inquiry', brief: ' 영업시간을 물어봐 주세요 ', toNumber: '01012345678' }, 'inquiry-create');
  assert.equal(inquiry.statusCode, 200, inquiry.body); let inquiryCall = inquiry.json().data.call;
  assert.equal(inquiryCall.mode, 'inquiry'); assert.equal(inquiryCall.brief, '영업시간을 물어봐 주세요');
  assert.equal(inquiryCall.question, inquiryCall.brief); assert.equal(inquiryCall.toNumber, '+821012345678');
  assert.equal('itemId' in inquiryCall, false); assert.equal(calls, 1);
  const sentInquiry = await post(`/v1/schedule-calls/${inquiryCall.id}/approve`, { revision: inquiryCall.revision }, 'inquiry-approve');
  assert.equal(sentInquiry.statusCode, 200, sentInquiry.body); inquiryCall = sentInquiry.json().data.call;
  const replayInquiry = await post(`/v1/schedule-calls/${inquiryCall.id}/approve`, { revision: 1 }, 'inquiry-approve');
  assert.equal(replayInquiry.statusCode, 200); assert.equal(calls, 2);
  const checkedInquiry = await post(`/v1/schedule-calls/${inquiryCall.id}/check`, { revision: inquiryCall.revision }, 'inquiry-check');
  assert.equal(checkedInquiry.statusCode, 200, checkedInquiry.body); inquiryCall = checkedInquiry.json().data.call;
  assert.equal(inquiryCall.status, 'completed'); assert.equal(inquiryCall.question, '영업시간을 물어봐 주세요');
  assert.equal((await post(`/v1/schedule-calls/${inquiryCall.id}/propose`, { revision: inquiryCall.revision }, 'inquiry-propose')).statusCode, 400);
  assert.equal((await post(`/v1/schedule-calls/${inquiryCall.id}/decision`, { revision: inquiryCall.revision, decision: 'accept' }, 'inquiry-decision')).statusCode, 400);
  assert.deepEqual((await store.read('alice')).items.get(original.id), current);
});
