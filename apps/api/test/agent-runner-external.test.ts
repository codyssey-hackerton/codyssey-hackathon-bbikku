import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { ModelPort, ReadTool } from '../src/agent.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { createResponsesModel } from '../src/model.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createExternalTools } from '../src/external-tools.ts';
import { createExternalAccountTools } from '../src/external-account-tools.ts';

const names = ['search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals',
  'list_calendars', 'read_calendar_events', 'list_contact_requests', 'read_contact_replies'];
const input = { userId: 'alice', requestId: 'request', conversationId: null, message: '날씨를 알려줘', timezone: 'UTC', history: [] };
const success = (expiresAt = '2026-10-31T00:05:00.000Z') => ({ ok: true, provider: 'test', fetchedAt: '2026-10-31T00:00:00.000Z', expiresAt, data: { value: 12 } });
const makeTool = (name: string, result: unknown): ReadTool => ({ name, description: 'synthetic read', input: z.object({}).strict(),
  async run(_input, userId) { assert.equal(userId, 'alice'); return result; } });
const service = (clock: () => Date) => new PlanningService(new MemoryPlanningStore(), clock);

test('native external call is executed for the server user and returned to the same model', async () => {
  let requests = 0; let factories = 0; let runs = 0;
  const output = success();
  const model = createResponsesModel('test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ['read_schedule', 'read_memory', 'calculate_timing', 'validate_changes', ...names]);
    assert.equal(JSON.parse(body.input[1].content).message, input.message);
    requests++;
    if (requests === 1) return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call1', name: 'get_weather', arguments: '{}' }] });
    assert.deepEqual(body.input.slice(2), [
      { type: 'function_call', call_id: 'call1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call1', output: JSON.stringify(output) },
    ]);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"kind":"answer","text":"12도입니다."}' }] }] });
  });
  const tools = names.map(name => ({ ...makeTool(name, output), async run(value: unknown, actor: string) {
    assert.deepEqual(value, {}); assert.equal(actor, 'alice'); runs++; return output;
  } }));
  const runner = new PlanningAgentRunner(service(() => new Date('2026-10-31T00:00:00Z')), model, undefined, async userId => {
    factories++; assert.equal(userId, 'alice'); return tools;
  });
  const prepared = await runner.prepare(input);
  assert.deepEqual(await runner.finish(prepared), { kind: 'reply', message: '12도입니다.' });
  assert.equal(factories, 1); assert.equal(runs, 1); assert.equal(requests, 2);
  assert.equal(prepared.baseline.externalExpiresAt, output.expiresAt);
});

test('simple greetings do not invoke external tools', async () => {
  let calls = 0; let factories = 0;
  const tool = { ...makeTool('get_weather', success()), async run() { calls++; return success(); } };
  const model: ModelPort = { async decide() { return { kind: 'answer', text: '천만에요.' }; } };
  const runner = new PlanningAgentRunner(service(() => new Date('2026-10-31T00:00:00Z')), model, undefined, async () => { factories++; return [tool]; });
  assert.equal((await runner.finish(await runner.prepare({ ...input, message: '고마워' }))).kind, 'reply');
  assert.equal(factories, 1); assert.equal(calls, 0);
});

test('shortest successful expiry governs answers and questions; failures do not add an expiry', async () => {
  let now = new Date('2026-10-31T00:00:00Z');
  const results = [success('2026-10-31T00:05:00.000Z'), { ok: false, error: 'not_configured' }, success('2026-10-31T00:00:15.000Z')];
  for (const kind of ['answer', 'question'] as const) {
    const model: ModelPort = { async decide(value) {
      if (value.observations.length < results.length) return { kind: 'tool_call', name: 'get_weather', input: {} };
      return kind === 'answer' ? { kind, text: '결과' } : { kind, text: '질문', missingFields: [] };
    } };
    let calls = 0;
    const tool = { ...makeTool('get_weather', null), async run() { return results[calls++]; } };
    const runner = new PlanningAgentRunner(service(() => now), model, undefined, async () => [tool]);
    const prepared = await runner.prepare(input);
    assert.equal(prepared.baseline.externalExpiresAt, '2026-10-31T00:00:15.000Z');
    now = new Date('2026-10-31T00:00:15Z');
    const result = await runner.finish(prepared);
    assert.equal(result.kind, 'failure');
    if (result.kind === 'failure') { assert.equal(result.code, 'external_data_expired'); assert.equal(result.retryable, true); }
    now = new Date('2026-10-31T00:00:00Z');
  }
  const errorModel: ModelPort = { async decide(value) { return value.observations.length ? { kind: 'answer', text: '조회 실패' } : { kind: 'tool_call', name: 'get_weather', input: {} }; } };
  const runner = new PlanningAgentRunner(service(() => now), errorModel, undefined, async () => [makeTool('get_weather', { ok: false, error: 'not_configured' })]);
  const prepared = await runner.prepare(input);
  assert.equal(prepared.baseline.externalExpiresAt, undefined);
  assert.equal((await runner.finish(prepared)).kind, 'reply');
});

test('missing or malformed successful expiry cannot enter the model continuation', async () => {
  for (const result of [{ ok: true }, { ok: true, expiresAt: 'bad' }, { ok: false }, {}, null]) {
    let decisions = 0;
    const model: ModelPort = { async decide() { decisions++; return { kind: 'tool_call', name: 'get_weather', input: {} }; } };
    const runner = new PlanningAgentRunner(service(() => new Date('2026-10-31T00:00:00Z')), model, undefined, async () => [makeTool('get_weather', result)]);
    await assert.rejects(() => runner.prepare(input), /AGENT_READ_FAILURE/);
    assert.equal(decisions, 1);
  }
});

test('real geo and account tool schemas support a native place lookup with synthetic ports', async () => {
  const now = () => new Date('2026-10-31T00:00:00Z');
  const store = new MemoryPlanningStore();
  let calls = 0;
  const model = createResponsesModel('test-key', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools.slice(4).map((tool: { name: string }) => tool.name), names);
    if (calls++ === 0) return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'place', name: 'search_places', arguments: '{"query":"시청"}' }] });
    const result = JSON.parse(body.input.at(-1).output);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.places, [{ id: 'place-1', name: '시청', address: '서울', roadAddress: '서울' }]);
    assert.equal(JSON.stringify(result).includes('latitude'), false);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"kind":"answer","text":"시청을 찾았습니다."}' }] }] });
  });
  const runner = new PlanningAgentRunner(new PlanningService(store, now), model, undefined, async userId => [
    ...createExternalTools(userId, { clock: now, places: { async search() { return { ok: true, places: [
      { id: 'place-1', name: '시청', address: '서울', roadAddress: '서울', latitude: 37.5, longitude: 127 },
    ] }; } } }),
    ...createExternalAccountTools(userId, { store, clock: now }),
  ]);
  assert.equal((await runner.finish(await runner.prepare({ ...input, message: '시청을 찾아줘' }))).kind, 'reply');
  assert.equal(calls, 2);
});

test('a runner proposal inherits the earliest external expiry', async () => {
  const now = () => new Date('2026-10-31T00:00:00Z');
  const planning = service(now);
  const model: ModelPort = { async decide(value) {
    if (!value.observations.length) return { kind: 'tool_call', name: 'get_weather', input: {} };
    return { kind: 'proposal', reason: '조회 기반 계획', evidenceRefs: [], changeSet: { changes: [{ changeId: 'task', operation: 'create', after: {
      kind: 'task', title: '할 일', durationMinutes: 30, deadline: null,
      timeSlot: { startsAt: '2026-10-31T01:00:00Z', endsAt: '2026-10-31T01:30:00Z', timezone: 'UTC' },
      flexibility: 'flexible', involvement: 'personal', completion: 'pending',
    } }] } };
  } };
  const runner = new PlanningAgentRunner(planning, model, undefined, async () => [makeTool('get_weather', success())]);
  const result = await runner.finish(await runner.prepare(input));
  assert.equal(result.kind, 'proposal');
  if (result.kind === 'proposal') assert.equal((await planning.getProposal('alice', result.proposalIds[0]!)).proposal.expiresAt, success().expiresAt);
});

test('a proposal cannot be saved when external evidence expires after preparation', async () => {
  let now = new Date('2026-10-31T00:00:00Z');
  const planning = service(() => now);
  const model: ModelPort = { async decide(value) {
    if (!value.observations.length) return { kind: 'tool_call', name: 'get_weather', input: {} };
    return { kind: 'proposal', reason: '조회 기반 계획', evidenceRefs: [], changeSet: { changes: [{ changeId: 'task', operation: 'create', after: {
      kind: 'task', title: '할 일', durationMinutes: 30, deadline: null,
      timeSlot: { startsAt: '2026-10-31T01:00:00Z', endsAt: '2026-10-31T01:30:00Z', timezone: 'UTC' },
      flexibility: 'flexible', involvement: 'personal', completion: 'pending',
    } }] } };
  } };
  const runner = new PlanningAgentRunner(planning, model, undefined, async () => [makeTool('get_weather', success())]);
  const prepared = await runner.prepare(input);
  now = new Date(success().expiresAt);
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'external_data_expired');
  assert.equal((await planning.store.read('alice')).proposals.size, 0);
});

test('valid previous external history carries its shortest expiry through new reads', async () => {
  let now = new Date('2026-10-31T00:00:00Z');
  const model: ModelPort = { async decide(value) {
    assert.deepEqual(value.context.history, [
      { role: 'assistant', content: '이전 날씨' }, { role: 'assistant', content: '이전 장소' },
    ]);
    return value.observations.length ? { kind: 'answer', text: '확인했습니다.' } : { kind: 'tool_call', name: 'get_weather', input: {} };
  } };
  const runner = new PlanningAgentRunner(service(() => now), model, undefined, async () => [makeTool('get_weather', success())]);
  const prepared = await runner.prepare({ ...input, history: [
    { role: 'assistant', content: '이전 날씨', externalExpiresAt: '2026-10-31T00:01:00.000Z' },
    { role: 'assistant', content: '이전 장소', externalExpiresAt: '2026-10-31T00:02:00.000Z' },
  ] });
  assert.equal(prepared.baseline.externalExpiresAt, '2026-10-31T00:01:00.000Z');
  now = new Date('2026-10-31T00:01:00.000Z');
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'external_data_expired');
});

test('expired and invalid external history is replaced before the model can requery', async () => {
  const marker = '[이전 외부 조회 결과는 만료되었습니다. 필요한 정보는 도구로 다시 조회하세요.]';
  let calls = 0;
  const model: ModelPort = { async decide(value) {
    assert.deepEqual(value.context.history, [
      { role: 'assistant', content: marker }, { role: 'assistant', content: marker }, { role: 'user', content: '다시 확인해줘' },
    ]);
    return value.observations.length ? { kind: 'answer', text: '새 조회 결과' } : { kind: 'tool_call', name: 'get_weather', input: {} };
  } };
  const tool = { ...makeTool('get_weather', success()), async run() { calls++; return success(); } };
  const runner = new PlanningAgentRunner(service(() => new Date('2026-10-31T00:00:00Z')), model, undefined, async () => [tool]);
  const prepared = await runner.prepare({ ...input, history: [
    { role: 'assistant', content: '오래된 외부 정보', externalExpiresAt: '2026-10-31T00:00:00.000Z' },
    { role: 'assistant', content: '잘못된 외부 정보', externalExpiresAt: 'invalid' },
    { role: 'user', content: '다시 확인해줘' },
  ] });
  assert.equal(calls, 1);
  assert.equal(prepared.baseline.externalExpiresAt, success().expiresAt);
  assert.deepEqual(await runner.finish(prepared), { kind: 'reply', message: '새 조회 결과' });
});
