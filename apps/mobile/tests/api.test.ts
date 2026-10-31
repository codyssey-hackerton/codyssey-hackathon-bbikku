import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../src/api/http';
import { createChatClient } from '../src/chat/client';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('v1 chat sends the bearer session, separate idempotency key, and contract fields', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const api = createApiClient({
    baseUrl: 'http://localhost:3001/',
    getSessionToken: () => 'development-session',
    fetcher: async (input, init) => {
      request = { url: String(input), init: init! };
      return json({ requestId: 'request-1', data: { conversationId: 'conversation-1', result: { kind: 'question', message: '시간을 알려주세요.', missingFields: ['time'] } } });
    },
  });
  const response = await createChatClient(api).sendMessage({
    requestId: 'request-1', idempotencyKey: 'idempotency-1', conversationId: null,
    message: '일정 조정', timezone: 'Asia/Seoul', coordinationTarget: { id: 'item-1', expectedRevision: 2 },
  });
  assert.equal(request?.url, 'http://localhost:3001/v1/chat');
  assert.equal(request?.init.method, 'POST');
  assert.equal((request?.init.headers as Record<string, string>).Authorization, 'Bearer development-session');
  assert.equal((request?.init.headers as Record<string, string>)['Idempotency-Key'], 'idempotency-1');
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    requestId: 'request-1', conversationId: null, message: '일정 조정', timezone: 'Asia/Seoul',
    coordinationTarget: { id: 'item-1', expectedRevision: 2 },
  });
  assert.equal(response.conversationId, 'conversation-1');
  assert.equal(response.result.kind, 'question');
});

test('missing session fails before a network request', async () => {
  let called = false;
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => '', fetcher: async () => { called = true; return json({}); } });
  await assert.rejects(api.get('/v1/schedule'), (error: unknown) => error instanceof ApiError && error.code === 'unauthenticated');
  assert.equal(called, false);
});

test('provider not configured and unimplemented are errors, never fabricated successful data', async () => {
  for (const [code, status] of [['not_configured', 503], ['not_implemented', 501]] as const) {
    const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async () => json({ requestId: 'r', error: { code, message: 'unavailable', retryable: false } }, status) });
    await assert.rejects(api.get('/v1/schedule'), (error: unknown) => error instanceof ApiError && error.code === code && error.status === status);
  }
});

test('invalid envelopes and invalid agent results are rejected', async () => {
  const badEnvelope = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async () => json({ items: [] }) });
  await assert.rejects(badEnvelope.get('/v1/schedule'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  const badChat = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async () => json({ requestId: 'r', data: { conversationId: 'c', result: { kind: 'proposal', message: '제안', proposalIds: 'bad' } } }) });
  await assert.rejects(createChatClient(badChat).sendMessage({ requestId: 'r', idempotencyKey: 'i', conversationId: null, message: 'x', timezone: 'Asia/Seoul' }), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
});

test('network failures and aborted timeouts remain distinct', async () => {
  const network = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async () => { throw new Error('offline'); } });
  await assert.rejects(network.get('/v1/schedule'), (error: unknown) => error instanceof ApiError && error.code === 'network');
  const timeout = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', timeoutMs: 5, fetcher: async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(timeout.get('/v1/schedule'), (error: unknown) => error instanceof ApiError && error.code === 'timeout');
});

test('chat uses the 180-second development timeout while normal GET and POST stay at 20 seconds', async (t) => {
  const durations: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((_callback: () => void, delay?: number) => {
    durations.push(delay ?? 0);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', (() => {}) as typeof clearTimeout);
  const api = createApiClient({
    baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev',
    fetcher: async (input) => String(input).endsWith('/v1/chat')
      ? json({ requestId: 'r', data: { conversationId: 'c', result: { kind: 'reply', message: 'ok' } } })
      : json({ requestId: 'r', data: {} }),
  });
  await api.get('/v1/schedule');
  await createChatClient(api).sendMessage({ requestId: 'r', idempotencyKey: 'i', conversationId: null, message: 'hello', timezone: 'Asia/Seoul' });
  await api.post('/v1/memory', { requestId: 'r2' }, { idempotencyKey: 'i2' });
  assert.deepEqual(durations, [20_000, 180_000, 20_000]);
});

test('chat retry after a network error sends the same body and idempotency key', async () => {
  const { createMutationMachine } = await import('../src/api/mutation');
  const requests: { body: string; key: string }[] = [];
  const api = createApiClient({
    baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev',
    fetcher: async (_input, init) => {
      requests.push({ body: String(init?.body), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
      if (requests.length === 1) throw new Error('network disconnected');
      return json({ requestId: 'r', data: { conversationId: 'c', result: { kind: 'reply', message: 'ok' } } });
    },
  });
  const client = createChatClient(api);
  const machine = createMutationMachine({
    execute: (op: import('../src/api/mutation').Mutation<{ conversationId: string | null; message: string; timezone: string }>) =>
      client.sendMessage({ ...op.input, requestId: op.requestId, idempotencyKey: op.idempotencyKey }),
    changed: () => {},
  });
  machine.submit({ conversationId: null, message: '일정 검토', timezone: 'Asia/Seoul' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(machine.getState().status, 'error');
  machine.retry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(machine.getState().status, 'success');
  assert.deepEqual(requests[1], requests[0]);
});

test('chat timeout can be configured independently of the shared default', async () => {
  let timeout: number | undefined;
  const client = createChatClient({
    get: async <T>() => ({} as T),
    post: async <T>(_path: string, _body: object, options: { idempotencyKey: string; timeoutMs?: number }) => {
      timeout = options.timeoutMs;
      return { conversationId: 'c', result: { kind: 'reply', message: 'ok' } } as T;
    },
  }, { timeoutMs: 90_000 });
  await client.sendMessage({ requestId: 'r', idempotencyKey: 'i', conversationId: null, message: 'hello', timezone: 'Asia/Seoul' });
  assert.equal(timeout, 90_000);
});
