import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import type { ModelPort } from '../src/agent.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (key = 'synthetic-key', user = 'alice') => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const body = { requestId: 'synthetic-request', conversationId: null, message: '합성 요청', timezone: 'UTC' };
const statusUrl = '/v1/chat/requests/synthetic-request';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// This test creates and removes its own cluster and never reads a configured database URL.
test('chat status and recovery persist across app instances in isolated PostgreSQL',
  { skip: process.env.PIKKU_CHAT_STATUS_ISOLATED_PG !== '1', timeout: 45_000 }, async t => {
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
    const directory = await mkdtemp(join(tmpdir(), 'pikku-chat-status-'));
    const listener = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'synthetic', password: 'synthetic-only-password',
      persistent: false, authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
    let started = false; let pool: pg.Pool | undefined;
    const apps: ReturnType<typeof buildApp>[] = [];
    const gates = [deferred(), deferred(), deferred()];
    t.after(async () => {
      gates.forEach(gate => gate.resolve());
      for (const app of apps) await app.close();
      await pool?.end(); if (started) await postgres.stop();
      await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0);
    });
    process.umask(0o077);
    await postgres.initialise(); await postgres.start(); started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'synthetic', password: 'synthetic-only-password', database: 'postgres',
      options: '-c statement_timeout=4000' });
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const reopenedStore = new PostgresPlanningStore(pool);
    let now = new Date('2030-01-01T00:00:00Z');
    const entered = [deferred(), deferred()]; let calls = 0;
    const model: ModelPort = { async decide() {
      const index = calls++; entered[index]!.resolve(); await gates[index]!.promise;
      return { kind: 'answer', text: index ? '새 응답' : '오래된 응답' };
    } };
    const options = { sessions, model, clock: () => now, onChatMetrics() {} };
    const first = buildApp({ ...options, store }); const second = buildApp({ ...options, store: reopenedStore }); apps.push(first, second);
    const get = (url = statusUrl, h = headers()) => second.inject({ method: 'GET', url, headers: h });
    const post = (app: typeof first, payload = body) => app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload });

    const oldAttempt = post(first); await entered[0]!.promise;
    const original = (await store.read('alice')).idempotency.get(JSON.stringify(['chat', 'synthetic-key']));
    assert.equal(original?.state, 'running');
    assert.deepEqual((await get()).json(), { requestId: body.requestId, data: { status: 'running' } });
    now = new Date('2030-01-01T00:16:00Z');
    assert.equal((await get()).json().data.status, 'running');
    assert.deepEqual((await reopenedStore.read('alice')).idempotency.get(JSON.stringify(['chat', 'synthetic-key'])), original);
    for (const response of [await get(statusUrl, headers('wrong')), await get(statusUrl, headers('synthetic-key', 'bob')), await get('/v1/chat/requests/wrong')]) {
      assert.equal(response.statusCode, 404);
    }
    assert.equal((await post(second, { ...body, requestId: 'wrong' })).statusCode, 409);

    const newAttempt = post(second); await entered[1]!.promise;
    const reclaimed = (await store.read('alice')).idempotency.get(JSON.stringify(['chat', 'synthetic-key']));
    assert.equal(reclaimed?.state, 'running'); assert.notEqual(reclaimed?.token, original?.token);
    gates[0]!.resolve(); assert.equal((await oldAttempt).statusCode, 409);
    assert.equal((await get()).json().data.status, 'running');
    assert.equal((await store.read('alice')).proposals.size, 0);
    gates[1]!.resolve();
    const completed = await newAttempt; assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual((await get()).json().data, { status: 'completed', result: { status: 200, body: completed.json() } });
    assert.deepEqual((await post(second)).json(), completed.json());
    const state = await reopenedStore.read('alice');
    assert.equal(state.conversations.size, 1); assert.equal(state.items.size, 0); assert.equal(state.proposals.size, 0);
    assert.equal([...state.conversations.values()][0]!.turns.at(-1)?.content, '새 응답'); assert.equal(calls, 2);

    let deadlineCalls = 0; let signal: AbortSignal | undefined;
    const deadlineApp = buildApp({ sessions, store: reopenedStore, clock: () => now, chatDeadlineMs: 100, onChatMetrics() {},
      model: { async decide(_input, options) {
        deadlineCalls++; if (deadlineCalls === 1) { signal = options?.signal; await gates[2]!.promise; }
        return { kind: 'answer', text: '재시도 응답' };
      } } });
    apps.push(deadlineApp);
    const deadlineBody = { ...body, requestId: 'deadline-request' };
    const deadlineHeaders = headers('deadline-key');
    const deadlinePost = () => deadlineApp.inject({ method: 'POST', url: '/v1/chat', headers: deadlineHeaders, payload: deadlineBody });
    const timedOut = await deadlinePost(); assert.equal(timedOut.statusCode, 503, timedOut.body); assert.equal(signal?.aborted, true);
    assert.equal((await deadlineApp.inject({ method: 'GET', url: '/v1/chat/requests/deadline-request', headers: deadlineHeaders })).json().data.status, 'retryable');
    const retried = await deadlinePost(); assert.equal(retried.statusCode, 200, retried.body);
    gates[2]!.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await deadlinePost()).json(), retried.json()); assert.equal(deadlineCalls, 2);
    assert.equal((await store.read('alice')).conversations.size, 2);
  });
