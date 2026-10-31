import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { localDevelopmentSession, type SessionResolver } from '../src/auth.ts';
import type { ModelPort } from '../src/agent.ts';

const sessions: SessionResolver = {
  async resolve(token) { return token === 'alice' || token === 'bob' ? { userId: token } : null; },
};
const headers = (token = 'alice', key = 'key-1') => ({ authorization: `Bearer ${token}`, 'idempotency-key': key });
const body = (requestId = 'request-1') => ({ requestId, conversationId: null, message: '고마워', timezone: 'Asia/Seoul' });

test('health is public, v1 requires a server session and capabilities do not claim external success', async t => {
  const app = buildApp({ sessions });
  t.after(() => app.close());
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json().data, { status: 'ok' });
  for (const authorization of [undefined, 'Bearer invalid', 'Basic alice']) {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: authorization ? { authorization } : {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'unauthenticated');
  }
  const response = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: headers() });
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.deepEqual(data.storage, { mode: 'memory', durable: false });
  assert.deepEqual(data.model, { id: 'gpt-6.1-terra', reasoningEffort: 'high', status: 'not_configured' });
  assert.equal(data.integrations.email, 'not_configured');
  assert.equal(data.scheduler.status, 'not_configured');
});

test('local development adapter requires a private token and never accepts an arbitrary bearer', async () => {
  assert.throws(() => localDevelopmentSession('short'));
  const adapter = localDevelopmentSession('a-long-test-token-only');
  assert.equal(await adapter.resolve('wrong-token'), null);
  assert.deepEqual(await adapter.resolve('a-long-test-token-only'), { userId: 'local-developer' });
});

test('invalid input and missing model configuration are explicit errors', async t => {
  const app = buildApp({ sessions });
  t.after(() => app.close());
  const cases = [
    { payload: body(), headers: { authorization: 'Bearer alice' }, status: 400, code: 'invalid_request' },
    { payload: { ...body(), timezone: 'Bad/Zone' }, headers: headers('alice', 'bad-tz'), status: 400, code: 'invalid_request' },
    { payload: { ...body(), userId: 'bob' }, headers: headers('alice', 'bad-user'), status: 400, code: 'invalid_request' },
    { payload: { ...body(), coordinationTarget: { id: 'x', expectedRevision: 0 } }, headers: headers('alice', 'bad-target'), status: 400, code: 'invalid_request' },
    { payload: body(), headers: headers(), status: 503, code: 'not_configured' },
    { payload: { ...body(), coordinationTarget: { id: 'x', expectedRevision: 1 } }, headers: headers('alice', 'target'), status: 503, code: 'not_configured' },
  ];
  for (const item of cases) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: item.headers, payload: item.payload });
    assert.equal(response.statusCode, item.status);
    assert.equal(response.json().error.code, item.code);
    assert.equal(typeof response.json().requestId, 'string');
  }
  const malformed = await app.inject({ method: 'POST', url: '/v1/chat', headers: { ...headers(), 'content-type': 'application/json' }, payload: '{' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'invalid_request');
});

test('contact routes validate input and hide absent contact requests', async t => {
  const app = buildApp({ sessions });
  t.after(() => app.close());
  for (const url of ['/v1/contact-requests/c1']) {
    const response = await app.inject({ method: 'GET', url, headers: headers() });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.json().error.code, 'not_found');
  }
  for (const url of ['/v1/recipients', '/v1/contact-requests', '/v1/contact-requests/c1/decision']) {
    const response = await app.inject({ method: 'POST', url, headers: headers(), payload: { requestId: 'r' } });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, 'invalid_request');
  }
  const missingKey = await app.inject({ method: 'POST', url: '/v1/recipients', headers: { authorization: 'Bearer alice' }, payload: { requestId: 'r' } });
  assert.equal(missingKey.statusCode, 400);
});

test('thanks uses one model turn without a tool; retries replay the first response and isolate users', async t => {
  let calls = 0;
  const model: ModelPort = { async decide(input) {
    calls++;
    assert.equal(input.message, '고마워');
    assert.deepEqual(input.observations, []);
    assert.deepEqual(input.tools.map(tool => tool.name), ['read_schedule', 'read_memory', 'calculate_timing', 'validate_changes']);
    return { kind: 'answer', text: '천만에요!' };
  } };
  const app = buildApp({ sessions, model });
  t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body('first') });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().data.result, { kind: 'reply', message: '천만에요!' });
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: { timezone: 'Asia/Seoul', message: '고마워', requestId: 'second', conversationId: null } });
  assert.deepEqual(replay.json(), first.json());
  assert.equal(calls, 1);
  const conflict = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: { ...body('third'), message: '다른 내용' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
  const otherUser = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('bob'), payload: body('other') });
  assert.equal(otherUser.statusCode, 200);
  assert.equal(calls, 2);
  const stolenConversation = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('bob', 'new-key'), payload: { ...body(), conversationId: first.json().data.conversationId } });
  assert.equal(stolenConversation.statusCode, 404);
  assert.equal(calls, 2);
});

test('concurrent replay reports the in-progress operation and does not call the model twice', async t => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const app = buildApp({ sessions, model: { async decide() { calls++; start(); await gate; return { kind: 'answer', text: '답변' }; } } });
  t.after(() => app.close());
  const first = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body() }).then(response => response);
  await started;
  const concurrent = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body('retry') });
  assert.equal(concurrent.statusCode, 409);
  assert.equal(concurrent.json().error.code, 'operation_in_progress');
  assert.equal(typeof concurrent.json().error.details.operationId, 'string');
  release();
  const completed = await first;
  assert.equal(completed.statusCode, 200);
  assert.equal(calls, 1);
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body('retry') });
  assert.deepEqual(replay.json(), completed.json());
});

test('a configured model path is not proof of a successful call; failures are sanitized', async t => {
  const app = buildApp({ sessions, model: { async decide() { throw new Error('sensitive provider details'); } } });
  t.after(() => app.close());
  const before = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: headers() });
  assert.equal(before.json().data.model.status, 'available');
  const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body() });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'provider_unavailable');
  assert.doesNotMatch(response.body, /sensitive/);
  const after = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: headers() });
  assert.equal(after.json().data.model.status, 'degraded');
});

test('model drafts and unauthorized tool requests cannot fabricate a saved proposal or send a message', async t => {
  let calls = 0;
  const app = buildApp({ sessions, model: { async decide() {
    calls++;
    return calls === 1
      ? { kind: 'proposal', reason: '대안', changeSet: { changes: [] }, evidenceRefs: [] }
      : { kind: 'tool_call', name: 'send_message', input: {} };
  } } });
  t.after(() => app.close());
  const draft = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: body() });
  assert.equal(draft.statusCode, 200);
  assert.deepEqual(draft.json().data.result, { kind: 'failure', message: '제안 형식을 확인할 수 없습니다.', code: 'invalid_request', retryable: false });
  const tool = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'different'), payload: body() });
  assert.equal(tool.statusCode, 503);
  assert.equal(tool.json().error.code, 'provider_unavailable');
});

test('a busy conversation can be retried after the earlier operation finishes', async t => {
  let calls = 0;
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = buildApp({ sessions, model: { async decide() {
    calls++;
    if (calls === 2) { start(); await gate; }
    return { kind: 'answer', text: '답변' };
  } } });
  t.after(() => app.close());
  const initial = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'initial'), payload: body() });
  const conversationId = initial.json().data.conversationId;
  const nextBody = { ...body('next'), conversationId };
  const running = app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'running'), payload: nextBody }).then(response => response);
  await started;
  const other = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'other'), payload: { ...nextBody, requestId: 'other' } });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().error.details.conversationId, conversationId);
  const conflict = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'other'), payload: { ...nextBody, requestId: 'other', message: '다른 요청' } });
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
  release();
  assert.equal((await running).statusCode, 200);
  const retried = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'other'), payload: { ...nextBody, requestId: 'other' } });
  assert.equal(retried.statusCode, 200);
  assert.equal(calls, 3);
});
