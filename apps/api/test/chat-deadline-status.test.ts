import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { buildApp } from '../src/app.ts';
import { createPlanningAgent, type ModelPort } from '../src/agent.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { RepositoryIdempotency } from '../src/idempotency.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { createResponsesModel } from '../src/model.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (key = 'key', user = 'alice') => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const body = { requestId: 'request', conversationId: null, message: 'private message', timezone: 'UTC' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const statusUrl = '/v1/chat/requests/request';

test('status binds user, original request ID and key; returns the committed original result', async t => {
  const start = deferred<void>(), gate = deferred<void>();
  const store = new MemoryPlanningStore();
  const idem = new RepositoryIdempotency(store);
  const app = buildApp({ sessions, store, idempotency: idem, onChatMetrics() {}, model: { async decide() {
    start.resolve(); await gate.promise; return { kind: 'answer', text: 'private answer' };
  } } });
  t.after(() => { gate.resolve(); return app.close(); });
  const pending = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  await start.promise;
  const get = (url = statusUrl, h = headers()) => app.inject({ method: 'GET', url, headers: h });
  const running = await get();
  assert.deepEqual(running.json(), { requestId: 'request', data: { status: 'running' } });
  assert.equal(running.headers['cache-control'], 'no-store');
  for (const response of [await get(statusUrl, headers('wrong')), await get(statusUrl, headers('key', 'bob')), await get('/v1/chat/requests/other')]) {
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await app.inject({ method: 'GET', url: statusUrl })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: { ...body, requestId: 'other' } })).json().error.code, 'idempotency_conflict');
  gate.resolve();
  const result = await pending;
  const completed = (await get()).json();
  assert.deepEqual(completed, { requestId: 'request', data: { status: 'completed', result: { status: 200, body: result.json() } } });
  const changed = { fingerprint: 'x', operationId: 'old', state: 'completed' as const, result: { status: 200, body: { requestId: 'legacy' } } };
  await store.transaction('alice', state => state.idempotency.set(JSON.stringify(['chat', 'legacy-key']), changed));
  assert.equal((await get('/v1/chat/requests/legacy', headers('legacy-key'))).statusCode, 404);
});

test('deadline aborts the model, returns retryable, ignores late completion, and logs only numeric timing', async t => {
  const gate = deferred<unknown>();
  const start = deferred<void>();
  const store = new MemoryPlanningStore();
  const metrics: unknown[] = [];
  let calls = 0; let firstSignal: AbortSignal | undefined;
  const model: ModelPort = { async decide(_input, options) {
    calls++;
    if (calls === 1) { firstSignal = options?.signal; start.resolve(); return gate.promise; }
    return { kind: 'answer', text: 'new answer' };
  } };
  const app = buildApp({ sessions, store, idempotency: new RepositoryIdempotency(store), model, chatDeadlineMs: 30, onChatMetrics: value => metrics.push(value) });
  t.after(() => { gate.resolve({ kind: 'answer', text: 'late' }); return app.close(); });
  const first = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  await start.promise;
  const timedOut = await first;
  assert.equal(timedOut.statusCode, 503);
  assert.equal(firstSignal?.aborted, true);
  assert.equal((await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data.status, 'retryable');
  assert.equal((await store.read('alice')).conversations.size, 0);
  const retry = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  assert.equal(retry.statusCode, 200);
  gate.resolve({ kind: 'answer', text: 'late' });
  await new Promise(resolve => setImmediate(resolve));
  const state = await store.read('alice');
  assert.equal(state.conversations.size, 1);
  assert.equal([...state.conversations.values()][0]!.turns.at(-1)?.content, 'new answer');
  assert.equal(calls, 2);
  assert.ok(metrics.length >= 2);
  for (const metric of metrics) {
    assert.deepEqual(Object.keys(metric as object).sort(), ['finalizeMs', 'modelCalls', 'modelMs', 'prepareMs', 'requestMs', 'toolCalls', 'toolMs'].sort());
    assert.ok(Object.values(metric as Record<string, number>).every(value => typeof value === 'number' && value >= 0));
  }
  assert.doesNotMatch(JSON.stringify(metrics), /private|key|answer|alice/);
});

test('an unabortable tool finishing late cannot trigger another model decision', async () => {
  const controller = new AbortController(), entered = deferred<void>(), gate = deferred<void>();
  let calls = 0;
  const graph = createPlanningAgent({ signal: controller.signal, model: { async decide() { calls++; return { kind: 'tool_call', name: 'read', input: {} }; } },
    tools: [{ name: 'read', description: 'read', input: z.object({}), async run() { entered.resolve(); await gate.promise; return {}; } }],
    validateProposal: async () => [] });
  const pending = graph.invoke({ userId: 'alice', message: 'test', context: {} });
  await entered.promise;
  controller.abort(); gate.resolve();
  await assert.rejects(pending);
  assert.equal(calls, 1);
});

test('model passes request abort through to fetch without exposing its contents', async () => {
  const controller = new AbortController(), started = deferred<void>();
  let observed: AbortSignal | null | undefined;
  const model = createResponsesModel('synthetic', async (_url, init) => {
    observed = init?.signal; started.resolve();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const pending = model.decide({ userId: 'alice', message: 'private', context: {}, observations: [], tools: [] }, { signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, /MODEL_REQUEST_FAILED/);
  assert.equal(observed?.aborted, true);
});

test('free slot observation is invalidated when the schedule changes before finish', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date('2026-11-01T00:00:00Z'));
  const model: ModelPort = { async decide(input) {
    if (input.observations.length === 0) return { kind: 'tool_call', name: 'find_free_slots', input: {
      from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', timezone: 'UTC', durationMinutes: 30 } };
    await store.transaction('alice', state => { state.scheduleRevision++; });
    return { kind: 'answer', text: '빈 시간' };
  } };
  const runner = new PlanningAgentRunner(planning, model);
  const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, message: '빈 시간', timezone: 'UTC', history: [] });
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'stale_snapshot');
});

test('once finalization starts the deadline never races its transaction', async t => {
  const finalizing = deferred<void>(), gate = deferred<void>();
  let gateNext = false;
  class GatedStore extends MemoryPlanningStore {
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      if (gateNext) { gateNext = false; finalizing.resolve(); await gate.promise; }
      return super.atomic(userId, run);
    }
  }
  const store = new GatedStore();
  const app = buildApp({ sessions, store, idempotency: new RepositoryIdempotency(store), chatDeadlineMs: 20, onChatMetrics() {},
    model: { async decide() { gateNext = true; return { kind: 'answer', text: 'complete' }; } } });
  t.after(() => { gate.resolve(); return app.close(); });
  const pending = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  await finalizing.promise;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data.status, 'running');
  gate.resolve();
  assert.equal((await pending).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data.status, 'completed');
});

test('expired lease takeover fences the old runner and preserves the new conversation lock', async t => {
  let now = new Date('2026-11-01T00:00:00Z');
  const entered = [deferred<void>(), deferred<void>()], gates = [deferred<void>(), deferred<void>()];
  let calls = 0;
  const model: ModelPort = { async decide() {
    const index = calls++; entered[index]!.resolve(); await gates[index]!.promise;
    return { kind: 'answer', text: index ? 'new' : 'old' };
  } };
  const store = new MemoryPlanningStore();
  const idem = new RepositoryIdempotency(store, () => now);
  const app = buildApp({ sessions, store, idempotency: idem, clock: () => now, model, onChatMetrics() {} });
  t.after(() => { gates.forEach(gate => gate.resolve()); return app.close(); });
  const first = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  await entered[0]!.promise;
  now = new Date('2026-11-01T00:16:00Z');
  assert.equal((await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data.status, 'running');
  const second = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body });
  await entered[1]!.promise;
  gates[0]!.resolve();
  assert.equal((await first).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data.status, 'running');
  const during = await store.read('alice');
  assert.equal([...during.conversations.values()].filter(c => c.lock).length, 1);
  gates[1]!.resolve();
  assert.equal((await second).statusCode, 200);
  const status = (await app.inject({ method: 'GET', url: statusUrl, headers: headers() })).json().data;
  assert.equal(status.status, 'completed');
  assert.equal(status.result.body.data.result.message, 'new');
  assert.equal((await store.read('alice')).proposals.size, 0);
});

test('free windows are rechecked at finish: expired or too short is stale, a sufficient remainder remains valid', async () => {
  for (const example of [
    { to: '2026-11-01T00:01:00Z', minutes: 1, expected: 'failure' },
    { to: '2026-11-01T01:00:00Z', minutes: 30, expected: 'reply' },
    { to: '2026-11-01T00:31:00Z', minutes: 30, expected: 'failure' },
    { to: '2026-11-01T00:32:00Z', minutes: 30, expected: 'reply' },
  ]) {
    let now = new Date('2026-11-01T00:00:00Z');
    const store = new MemoryPlanningStore();
    const planning = new PlanningService(store, () => now);
    const model: ModelPort = { async decide(input) {
      if (!input.observations.length) return { kind: 'tool_call', name: 'find_free_slots', input: {
        from: '2026-11-01T00:00:00Z', to: example.to, timezone: 'UTC', durationMinutes: example.minutes } };
      const result = input.observations[0]!.result as { asOf: string; slots: { startsAt: string; endsAt: string }[] };
      assert.equal(result.asOf, '2026-11-01T00:00:00.000Z');
      assert.equal(result.slots.length, 1);
      now = new Date('2026-11-01T00:02:00Z');
      return { kind: 'answer', text: '조회된 빈 시간' };
    } };
    const runner = new PlanningAgentRunner(planning, model);
    const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, message: '빈 시간', timezone: 'UTC', history: [] });
    const result = await runner.finish(prepared);
    assert.equal(result.kind, example.expected, JSON.stringify(example));
    if (result.kind === 'failure') assert.equal(result.code, 'stale_snapshot');
  }
});
