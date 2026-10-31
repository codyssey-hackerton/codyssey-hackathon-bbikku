import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../api/src/app';
import type { ModelPort } from '../../api/src/agent';
import { ApiError, createApiClient } from '../src/api/http';
import { createMutationMachine, type Mutation } from '../src/api/mutation';
import { createChatClient, type ChatResponse } from '../src/chat/client';

test('synthetic server ledger recovers the original lost response without a second model call', { timeout: 5000 }, async t => {
  let modelCalls = 0, lost = false;
  const model: ModelPort = { async decide() { modelCalls++; return { kind: 'answer', text: '확인된 응답' }; } };
  const app = buildApp({ model, sessions: { async resolve(token) { return token === 'alice' || token === 'bob' ? { userId: token } : null; } } });
  t.after(() => app.close()); await app.ready();
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
    if (url.pathname === '/v1/chat' && !lost) { lost = true; throw new Error('synthetic lost response'); }
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
  };
  const api = createApiClient({ baseUrl: 'http://synthetic.local', getSessionToken: () => 'alice', fetcher });
  const client = createChatClient(api); let success = 0; let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const machine = createMutationMachine({ execute: (op: Mutation<{ message: string; timezone: string; conversationId: null }>) =>
    client.sendMessage({ ...op.input, requestId: op.requestId, idempotencyKey: op.idempotencyKey }),
    changed(state) { if (state.status === 'error' || state.status === 'success') finish(); }, succeeded() { success++; } });
  machine.submit({ message: '합성 질문', timezone: 'Asia/Seoul', conversationId: null }); await settled;
  assert.equal(machine.getState().status, 'error'); let scope: { requestId: string; idempotencyKey: string; conversationId: null } | undefined;
  const found = await machine.check(op => {
    scope = { requestId: op.requestId, idempotencyKey: op.idempotencyKey, conversationId: op.input.conversationId };
    return client.checkRequest!(scope);
  }, value => value.status !== 'completed' ? null : 'response' in value.result ? { result: value.result.response as ChatResponse } : { error: value.result.error });
  assert.equal(found?.status, 'completed'); assert.equal(machine.getState().status, 'success'); assert.equal(success, 1); assert.equal(modelCalls, 1);
  const other = createChatClient(createApiClient({ baseUrl: 'http://synthetic.local', getSessionToken: () => 'bob', fetcher }));
  await assert.rejects(other.checkRequest!(scope!), (error: unknown) => error instanceof ApiError && error.status === 404);
  await assert.rejects(client.checkRequest!({ ...scope!, idempotencyKey: 'wrong' }), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(modelCalls, 1);
});
