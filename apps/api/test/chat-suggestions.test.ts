import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createResponsesModel } from '../src/model.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const suggestion = { label: '시간 조정', message: '오후 2시로 옮기는 제안을 만들어줘' };
const output = (decision: unknown) => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] });

test('native model accepts bounded suggestions only on answer and question', async () => {
  const invoke = (decision: unknown) => createResponsesModel('synthetic', async () => output(decision)).decide({
    userId: 'alice', message: '계획을 도와줘', context: {}, observations: [], tools: [],
  });
  for (const value of [
    { kind: 'answer', text: '선택해 주세요', suggestions: [suggestion] },
    { kind: 'question', text: '어떻게 할까요?', missingFields: [], suggestions: [suggestion, suggestion] },
    { kind: 'answer', text: '선택지 없음' },
  ]) assert.deepEqual(await invoke(value), value);
  for (const suggestions of [[], [suggestion, suggestion, suggestion], [{ label: ' ', message: '요청' }],
    [{ label: 'x'.repeat(61), message: '요청' }], [{ label: '제안', message: 'x'.repeat(501) }],
    [{ ...suggestion, action: 'approve' }]]) {
    await assert.rejects(invoke({ kind: 'answer', text: '선택', suggestions }), /MODEL_OUTPUT_INVALID/);
  }
  await assert.rejects(invoke({ kind: 'phone_request', text: '확인', itemId: 'a', expectedRevision: 1, suggestions: [suggestion] }), /MODEL_OUTPUT_INVALID/);
});

test('following a suggestion creates only a new pending proposal in the same conversation', async t => {
  const store = new MemoryPlanningStore(), seen: string[] = [];
  const app = buildApp({ store, clock: () => new Date('2030-01-01T00:00:00Z'), onChatMetrics() {},
    sessions: { async resolve(token) { return token === 'alice' ? { userId: token } : null; } }, model: { async decide(input) {
      seen.push(input.message);
      if (seen.length === 1) return { kind: 'question', text: '어떤 제안을 원하세요?', missingFields: [], suggestions: [suggestion] };
      return { kind: 'proposal', reason: '합성 제안', evidenceRefs: [], changeSet: { changes: [{
        changeId: 'create', operation: 'create', after: { kind: 'event', title: '합성 일정',
          timeSlot: { startsAt: '2030-01-02T14:00:00+09:00', endsAt: '2030-01-02T15:00:00+09:00', timezone: 'Asia/Seoul' },
          durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' },
      }] } };
    } } });
  t.after(() => app.close());
  const post = (requestId: string, conversationId: string | null, message: string) => app.inject({ method: 'POST', url: '/v1/chat',
    headers: { authorization: 'Bearer alice', 'idempotency-key': requestId }, payload: { requestId, conversationId, message, timezone: 'Asia/Seoul' } });
  const first = await post('first', null, '오늘 계획을 도와줘');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().data.result.suggestions, [suggestion]);
  const conversation = first.json().data.conversationId;
  const before = await store.read('alice');
  const next = await post('second', conversation, suggestion.message);
  assert.equal(next.statusCode, 200, next.body); assert.equal(next.json().data.conversationId, conversation);
  assert.equal(next.json().data.result.kind, 'proposal');
  const after = await store.read('alice');
  assert.deepEqual(seen, ['오늘 계획을 도와줘', suggestion.message]);
  assert.deepEqual([...after.items], [...before.items]); assert.equal(after.scheduleRevision, before.scheduleRevision);
  assert.equal(after.approvals.length, 0); assert.equal(after.contactRequests.size, 0);
  assert.equal(after.proposals.get(next.json().data.result.proposalIds[0])?.status, 'pending');
});
