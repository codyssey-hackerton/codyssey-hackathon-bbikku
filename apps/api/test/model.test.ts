import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createPlanningAgent } from '../src/agent.ts';
import { createResponsesModel } from '../src/model.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createPlanningTools } from '../src/planning-tools.ts';

const scheduleInput = z.object({ from: z.string(), to: z.string(), timezone: z.string() }).strict();
const timingInput = z.object({ appointmentStart: z.string(), travelMinutes: z.number(), bufferMinutes: z.number().optional() }).strict();
const tools = [
  { name: 'read_schedule', description: 'Read schedules', inputSchema: z.toJSONSchema(scheduleInput) },
  { name: 'calculate_timing', description: 'Calculate timing', inputSchema: z.toJSONSchema(timingInput) },
];
const input = { userId: 'server-user', message: '내 일정을 확인해줘', context: { timezone: 'Asia/Seoul' }, observations: [], tools };
const call = (name: string, args: string, extra = {}) => ({ type: 'function_call', call_id: 'call_test', name, arguments: args, ...extra });
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const completed = (...output: unknown[]) => ({ status: 'completed', output });
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

test('sends native tools, exact model settings and only user-facing context', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6.1-terra');
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.tools, tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })));
    assert.equal(body.previous_response_id, undefined);
    assert.deepEqual(JSON.parse(body.input[1].content), { message: input.message, context: input.context, observations: [] });
    assert.ok(!JSON.stringify(body.input).includes('server-user'));
    for (const phrase of ['ScheduleFields', 'expectedRevision', 'evidenceRefs', 'coordination target', 'approval']) {
      assert.ok(body.input[0].content.includes(phrase));
    }
    return jsonResponse(completed(message('{"kind":"answer","text":"네"}')));
  };
  const model = createResponsesModel('project-test-key', fakeFetch);
  assert.deepEqual(await model.decide(input), { kind: 'answer', text: '네' });
  assert.equal(calls, 1);
});

test('maps one native function call and replays context and observations in a fresh next step', async () => {
  const args = { from: '2026-10-31T00:00:00+09:00', to: '2026-11-01T00:00:00+09:00', timezone: 'Asia/Seoul' };
  const observation = { name: 'read_schedule', result: { items: [], scheduleRevision: 1 } };
  let step = 0;
  const model = createResponsesModel('project-test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.previous_response_id, undefined);
    const context = JSON.parse(body.input[1].content);
    assert.deepEqual(context, { message: input.message, context: input.context, observations: step === 0 ? [] : [observation] });
    if (step++ === 0) return jsonResponse(completed({ type: 'reasoning', summary: [] }, call('read_schedule', JSON.stringify(args))));
    return jsonResponse(completed(message('{"kind":"answer","text":"일정이 없습니다."}')));
  });
  assert.deepEqual(await model.decide(input), { kind: 'tool_call', name: 'read_schedule', input: args });
  assert.deepEqual(await model.decide({ ...input, observations: [observation] }), { kind: 'answer', text: '일정이 없습니다.' });
  assert.equal(step, 2);
});

test('accepts the actual registered schemas for all four read and calculation tools', async () => {
  const service = new PlanningService(new MemoryPlanningStore(), () => new Date('2026-10-31T00:00:00Z'));
  const registered = createPlanningTools(service, await service.capture('server-user', 'Asia/Seoul'));
  const descriptors = registered.map(tool => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) }));
  const values = [
    { name: 'read_schedule', input: { from: '2026-10-31T00:00:00+09:00', to: '2026-11-01T00:00:00+09:00', timezone: 'Asia/Seoul' } },
    { name: 'read_memory', input: { keys: ['preference'], at: '2026-10-31T00:00:00+09:00' } },
    { name: 'calculate_timing', input: { appointmentStart: '2026-10-31T15:00:00+09:00', travelMinutes: 30 } },
    { name: 'validate_changes', input: { changeSet: { changes: [{ changeId: 'new', operation: 'create', after: {
      kind: 'task', title: '청소', timeSlot: null, durationMinutes: 20, deadline: null,
      flexibility: 'flexible', involvement: 'personal', completion: 'pending',
    } }] } } },
  ];
  for (const value of values) {
    const model = createResponsesModel('project-test-key', async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), values.map(tool => tool.name));
      return jsonResponse(completed(call(value.name, JSON.stringify(value.input))));
    });
    assert.deepEqual(await model.decide({ ...input, tools: descriptors }), { kind: 'tool_call', ...value });
  }
});

test('the agent executes the native call under the server user and passes the result to the next step', async () => {
  const service = new PlanningService(new MemoryPlanningStore(), () => new Date('2026-10-31T00:00:00Z'));
  const registered = createPlanningTools(service, await service.capture('server-user', 'Asia/Seoul'));
  let step = 0;
  const model = createResponsesModel('project-test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.input[1].content);
    assert.ok(!JSON.stringify(body.input).includes('server-user'));
    if (step++ === 0) {
      assert.deepEqual(context.observations, []);
      return jsonResponse(completed(call('read_schedule', JSON.stringify({ from: '2026-10-31T00:00:00+09:00', to: '2026-11-01T00:00:00+09:00', timezone: 'Asia/Seoul' }))));
    }
    assert.deepEqual(context.observations, [{ name: 'read_schedule', input: { from: '2026-10-31T00:00:00+09:00', to: '2026-11-01T00:00:00+09:00', timezone: 'Asia/Seoul' }, result: { items: [], scheduleRevision: 0 } }]);
    return jsonResponse(completed(message('{"kind":"answer","text":"일정이 없습니다."}')));
  });
  const agent = createPlanningAgent({ model, tools: registered, validateProposal: async () => [] });
  const result = await agent.invoke({ userId: 'server-user', message: input.message, context: input.context });
  assert.deepEqual(result.decision, { kind: 'answer', text: '일정이 없습니다.' });
  assert.equal(step, 2);
});

test('the original server tool schema rejects refinements that JSON Schema cannot express', async () => {
  const service = new PlanningService(new MemoryPlanningStore(), () => new Date('2026-10-31T00:00:00Z'));
  const original = createPlanningTools(service, await service.capture('server-user', 'Asia/Seoul'))[0];
  let executions = 0;
  let calls = 0;
  const model = createResponsesModel('project-test-key', async () => {
    calls++;
    return jsonResponse(completed(call('read_schedule', JSON.stringify({ from: '2026-11-01T00:00:00+09:00', to: '2026-10-31T00:00:00+09:00', timezone: 'Asia/Seoul' }))));
  });
  const agent = createPlanningAgent({
    model,
    tools: [{ ...original, async run(value, userId) { executions++; return original.run(value, userId); } }],
    validateProposal: async () => [],
  });
  await assert.rejects(() => agent.invoke({ userId: 'server-user', message: input.message, context: input.context }));
  assert.equal(calls, 1);
  assert.equal(executions, 0);
});

test('accepts validated question and proposal drafts without treating them as applied', async () => {
  const question = { kind: 'question', text: '언제인가요?', missingFields: ['timeSlot'] };
  const proposal = {
    kind: 'proposal', reason: '남은 시간에 배치합니다.', evidenceRefs: [],
    changeSet: { changes: [{
      changeId: 'change-1', operation: 'create', after: {
        kind: 'task', title: '청소', timeSlot: null, durationMinutes: 20, deadline: null,
        flexibility: 'flexible', involvement: 'personal', completion: 'pending',
      },
    }] },
  };
  for (const decision of [question, proposal]) {
    const model = createResponsesModel('project-test-key', async () => jsonResponse(completed(message(JSON.stringify(decision)))));
    assert.deepEqual(await model.decide(input), decision);
  }
});

test('rejects invalid, unauthorized, multiple, incomplete and mixed output', async t => {
  const validArgs = JSON.stringify({ from: 'a', to: 'b', timezone: 'Asia/Seoul' });
  const cases: [string, unknown][] = [
    ['unknown tool', completed(call('send_message', '{}'))],
    ['unregistered known tool', completed(call('read_memory', '{}'))],
    ['malformed arguments', completed(call('read_schedule', '{'))],
    ['non-object arguments', completed(call('read_schedule', '[]'))],
    ['missing argument', completed(call('read_schedule', '{"from":"a"}'))],
    ['wrong argument type', completed(call('read_schedule', '{"from":1,"to":"b","timezone":"Asia/Seoul"}'))],
    ['server user override', completed(call('read_schedule', '{"from":"a","to":"b","timezone":"Asia/Seoul","userId":"other"}'))],
    ['server scope override', completed(call('read_schedule', '{"from":"a","to":"b","timezone":"Asia/Seoul","scope":"all"}'))],
    ['missing call id', completed({ type: 'function_call', name: 'read_schedule', arguments: validArgs })],
    ['multiple calls', completed(call('read_schedule', validArgs), call('calculate_timing', '{}'))],
    ['call and final message', completed(call('read_schedule', validArgs), message('{"kind":"answer","text":"ok"}'))],
    ['incomplete call', completed(call('read_schedule', validArgs, { status: 'incomplete' }))],
    ['incomplete response', { status: 'incomplete', output: [] }],
    ['error in completed response', { status: 'completed', error: { message: 'private' }, output: [] }],
    ['refusal', completed({ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] })],
    ['unknown response item', completed({ type: 'computer_call' })],
    ['malformed final JSON', completed(message('{'))],
    ['forged JSON tool call', completed(message('{"kind":"tool_call","name":"read_schedule","input":{}}'))],
    ['invalid answer', completed(message('{"kind":"answer","text":42}'))],
    ['identity in answer', completed(message('{"kind":"answer","text":"ok","userId":"other"}'))],
    ['malformed proposal', completed(message('{"kind":"proposal","reason":"x","changeSet":{"changes":[{"operation":"create"}]},"evidenceRefs":[]}'))],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      const model = createResponsesModel('project-test-key', async () => jsonResponse(payload));
      await assert.rejects(() => model.decide(input), { message: 'MODEL_OUTPUT_INVALID' });
    });
  }
});

test('rejects unsupported or unsafe tool definitions before calling fetch', async () => {
  let calls = 0;
  const model = createResponsesModel('project-test-key', async () => { calls++; return jsonResponse(completed()); });
  const badTools = [
    [{ name: 'send_message', description: 'write', inputSchema: z.toJSONSchema(z.object({})) }],
    [tools[0], tools[0]],
    [{ name: 'read_schedule', description: 'bad', inputSchema: { type: 'array' } }],
    [{ name: 'read_schedule', description: 'bad', inputSchema: z.toJSONSchema(z.object({ userId: z.string() })) }],
  ];
  for (const definitions of badTools) await assert.rejects(() => model.decide({ ...input, tools: definitions }));
  assert.equal(calls, 0);
});

test('does not expose provider errors and never retries', async () => {
  for (const fetcher of [
    async () => new Response('private provider response', { status: 401 }),
    async () => { throw new Error('private network error'); },
  ]) {
    let calls = 0;
    const model = createResponsesModel('project-test-key', async () => { calls++; return fetcher(); });
    await assert.rejects(() => model.decide(input), { message: 'MODEL_REQUEST_FAILED' });
    assert.equal(calls, 1);
  }
});
