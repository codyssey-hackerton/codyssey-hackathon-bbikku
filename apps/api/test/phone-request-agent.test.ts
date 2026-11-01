import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { createResponsesModel } from '../src/model.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';

const item = { id: 'event-1', revision: 1, kind: 'event' as const, title: '합성 일정',
  timeSlot: { startsAt: '2026-11-02T01:00:00Z', endsAt: '2026-11-02T02:00:00Z', timezone: 'UTC' },
  durationMinutes: null, deadline: null, flexibility: 'fixed' as const, involvement: 'shared' as const,
  completion: 'pending' as const, sourceRefs: [] };
const input = { userId: 'alice', requestId: 'r', conversationId: null, message: '이 일정에 대해 전화해줘', timezone: 'UTC', history: [] };
const phone = { kind: 'phone_request', text: '통화 완료', itemId: item.id, expectedRevision: item.revision };

test('phone request requires explicit intent and observed owned item and never claims a call was placed', async () => {
  const store = new MemoryPlanningStore();
  await store.transaction('alice', state => { state.items.set(item.id, item); state.scheduleRevision++; });
  const planning = new PlanningService(store, () => new Date('2026-11-01T00:00:00Z'));
  const selected = { kind: 'item' as const, id: item.id, expectedRevision: item.revision };
  const model = { async decide() { return phone; } };
  const runner = new PlanningAgentRunner(planning, model);
  const result = await runner.finish(await runner.prepare({ ...input, entryContext: selected }));
  assert.equal(result.kind, 'phone_request');
  assert.match(result.message, /설정되지 않았습니다/);
  assert.doesNotMatch(result.message, /통화 완료/);
  for (const message of ['일정을 알려줘', '전화하지 말아줘', '"전화해줘"라고 적어줘', '친구가 전화해달라고 부탁했어', '전화해줘. 아니, 전화는 필요 없어']) {
    assert.equal((await runner.finish(await runner.prepare({ ...input, message, entryContext: selected }))).kind, 'failure');
  }
  assert.equal((await runner.finish(await runner.prepare(input))).kind, 'failure');
  const triggered = await runner.prepare({ ...input, entryContext: selected, triggerEvent: { id: 'trigger', userId: 'alice', reason: 'morning_review',
    scheduledFor: '2026-11-01T00:00:00Z', timezone: 'UTC', targetDate: '2026-11-01', idempotencyKey: 'trigger-key' } });
  assert.equal((await runner.finish(triggered)).kind, 'failure');
  const forged = new PlanningAgentRunner(planning, { async decide() { return { ...phone, itemId: 'other' }; } });
  assert.equal((await forged.finish(await forged.prepare({ ...input, entryContext: selected }))).kind, 'failure');
  const reviewOnly = new PlanningAgentRunner(planning, { async decide() { return { kind: 'call_review', text: '확인', location: '홍대' }; } });
  assert.equal((await reviewOnly.finish(await reviewOnly.prepare(input))).kind, 'failure');
  const foreign = await runner.prepare({ ...input, userId: 'bob' });
  assert.equal((await runner.finish(foreign)).kind, 'failure');
  const observed = new PlanningAgentRunner(planning, { async decide(value) {
    return value.observations.length ? phone : { kind: 'tool_call', name: 'read_schedule', input: {
      from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', timezone: 'UTC' } };
  } });
  const prepared = await observed.prepare(input);
  assert.equal((await observed.finish(prepared)).kind, 'phone_request');
  await store.transaction('alice', state => { state.scheduleRevision++; });
  assert.deepEqual((await observed.finish(prepared)).kind, 'failure');
  assert.equal((await store.read('alice')).proposals.size, 0);
});

test('actual model adapter accepts only the declared phone request shape', async () => {
  let output: Record<string, unknown> = { ...phone };
  const model = createResponsesModel('synthetic', async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
  const request = { userId: 'alice', message: input.message, context: {}, observations: [], tools: [] };
  assert.deepEqual(await model.decide(request), phone);
  for (const invalid of [{ ...phone, expectedRevision: 0 }, { ...phone, itemId: '' }, { ...phone, location: '홍대' }]) {
    output = invalid;
    await assert.rejects(model.decide(request), /MODEL_OUTPUT_INVALID/);
  }
});

test('call review is a strict model-only context and accepts no extra changes', async () => {
  let output: Record<string, unknown> = { kind: 'call_review', text: '장소를 확인해 주세요', location: '홍대' };
  const model = createResponsesModel('synthetic', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (JSON.parse(body.input[1].content).context.callReview) assert.match(body.input[0].content, /아니 홍대야/);
    assert.deepEqual(body.tools, []);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  });
  const review = { userId: 'alice', message: '검토', context: { callReview: { sourceItem: item, transcript: '아니 홍대야' } }, observations: [], tools: [] };
  assert.deepEqual(await model.decide(review), output);
  output = { kind: 'call_review', text: '확인', location: null };
  assert.deepEqual(await model.decide(review), output);
  for (const invalid of [{ ...output, startsAt: 'tomorrow' }, { ...output, location: '' }, phone, { kind: 'answer', text: '네' }]) {
    output = invalid;
    await assert.rejects(model.decide(review), /MODEL_OUTPUT_INVALID/);
  }
  output = { kind: 'call_review', text: '확인', location: '홍대' };
  await assert.rejects(model.decide({ ...review, context: {} }), /MODEL_OUTPUT_INVALID/);
  await assert.rejects(model.decide({ ...review, tools: [{ name: 'read_schedule', description: '', inputSchema: {} }] }), /MODEL_CALL_REVIEW_INVALID/);
});

test('general inquiry requires the current user request and strict brief', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date('2026-11-01T00:00:00Z'));
  const inquiry = { kind: 'phone_request', text: '확인', mode: 'inquiry', brief: '영업시간을 물어봐 주세요' };
  const runner = new PlanningAgentRunner(planning, { async decide() { return inquiry; } });
  const result = await runner.finish(await runner.prepare({ ...input, message: '식당에 전화해서 영업시간을 물어봐줘' }));
  assert.equal(result.kind, 'phone_request');
  if (result.kind === 'phone_request' && 'mode' in result) { assert.equal(result.mode, 'inquiry'); assert.equal(result.brief, inquiry.brief); }
  else assert.fail('expected inquiry request');
  for (const message of ['식당 영업시간을 알려줘', '식당에 전화해서 영업시간을 물어봐 주지 마', '"식당에 전화해서 물어봐줘"라고 적어줘',
    '전화해줘. 아니, 전화는 필요 없어', '전화해줘. 통화는 더 이상 필요 없어', '전화해줘. 전화할 필요 없어', '전화해줘. 전화는 원하지 않아']) {
    assert.equal((await runner.finish(await runner.prepare({ ...input, message }))).kind, 'failure');
  }
  const triggered = await runner.prepare({ ...input, message: '식당에 전화해서 영업시간을 물어봐줘', triggerEvent: { id: 'trigger', userId: 'alice', reason: 'morning_review',
    scheduledFor: '2026-11-01T00:00:00Z', timezone: 'UTC', targetDate: '2026-11-01', idempotencyKey: 'trigger-key' } });
  assert.equal((await runner.finish(triggered)).kind, 'failure');
  assert.equal((await store.read('alice')).voiceSessions.size, 0);
  let output: Record<string, unknown> = { ...inquiry, brief: ' 문의 😀 ' };
  const model = createResponsesModel('synthetic', async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
  const request = { userId: 'alice', message: input.message, context: {}, observations: [], tools: [] };
  assert.deepEqual(await model.decide(request), { ...inquiry, brief: '문의 😀' });
  for (const brief of ['', 'x'.repeat(1001), 'a\u0000b', 'a\u200db', '\ud800']) {
    output = { ...inquiry, brief }; await assert.rejects(model.decide(request), /MODEL_OUTPUT_INVALID/);
  }
  output = { ...inquiry, itemId: 'forged', expectedRevision: 1 };
  await assert.rejects(model.decide(request), /MODEL_OUTPUT_INVALID/);
});
