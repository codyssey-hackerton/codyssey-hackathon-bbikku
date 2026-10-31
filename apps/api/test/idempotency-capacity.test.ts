import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { MemoryIdempotency, type HttpResult } from '../src/idempotency.ts';

const sessions = { async resolve(token: string) { return token === 'alice' || token === 'bob' ? { userId: token } : null; } };
const headers = (user: string, key: string) => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const task = { kind: 'task', title: '공부', timeSlot: null, durationMinutes: 60, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const command = (requestId: string) => ({ requestId, expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'task', operation: 'create', after: task }] } });

test('the default 10,000-entry limit is per user, including validation failures', async () => {
  const idempotency = new MemoryIdempotency(); let calls = 0;
  for (let i = 0; i < 10_000; i++) {
    const result = await idempotency.execute({ userId: 'alice', operation: 'chat', key: `invalid-${i}`, requestId: `request-${i}`, payload: { message: '' },
      async run() { calls++; return { status: 400, body: { requestId: `request-${i}`, error: { code: 'invalid_request' } } }; } });
    assert.equal(result.status, 400);
  }
  const full = await idempotency.execute({ userId: 'alice', operation: 'chat', key: 'extra', requestId: 'extra', payload: { message: 'valid' },
    async run() { throw new Error('full user must not execute a new key'); } });
  assert.equal(full.status, 503);
  const other = await idempotency.execute({ userId: 'bob', operation: 'schedule_command', key: 'new', requestId: 'bob', payload: { title: 'valid' },
    async run() { return { status: 200, body: { requestId: 'bob', data: { outcome: 'applied' } } }; } });
  assert.equal(other.status, 200);
  const replay = await idempotency.execute({ userId: 'alice', operation: 'chat', key: 'invalid-0', requestId: 'retry', payload: { message: '' },
    async run() { throw new Error('must replay'); } });
  assert.equal(replay.status, 400);
  assert.equal((replay.body as { requestId: string }).requestId, 'request-0');
  const conflict = await idempotency.execute({ userId: 'alice', operation: 'chat', key: 'invalid-0', requestId: 'changed', payload: { message: 'changed' },
    async run() { throw new Error('must conflict'); } });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { error: { code: string } }).error.code, 'idempotency_conflict');
  assert.equal(calls, 10_000);
});

test('one users malformed HTTP requests cannot prevent another users normal write', async t => {
  const app = buildApp({ sessions, idempotency: new MemoryIdempotency(2) }); t.after(() => app.close());
  const invalid = (requestId: string) => ({ requestId, conversationId: null, message: '', timezone: 'Asia/Seoul' });
  for (const key of ['a-1', 'a-2']) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', key), payload: invalid(key) });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
  }
  const blockedAlice = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('alice', 'a-3'), payload: command('a-3') });
  assert.equal(blockedAlice.statusCode, 503);
  const bob = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('bob', 'b-1'), payload: command('b-1') });
  assert.equal(bob.statusCode, 200, bob.body);
  assert.equal(bob.json().data.outcome, 'applied');
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'a-1'), payload: invalid('retry') });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().requestId, 'a-1');
  const conflict = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('alice', 'a-1'), payload: { ...invalid('changed'), message: '다른 본문' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
});

test('at capacity, a known-no-effect chat retry preserves fingerprint and concurrency protection', async () => {
  const idempotency = new MemoryIdempotency(1);
  let started!: () => void; let release!: () => void; let calls = 0;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const input = { userId: 'alice', operation: 'chat', key: 'same', requestId: 'first', payload: { message: 'x' }, async run(): Promise<HttpResult> {
    calls++; started(); await gate;
    return { status: 503, body: { requestId: 'first', error: { code: 'provider_unavailable' } }, retryableWithoutEffects: true };
  } };
  const first = idempotency.execute(input);
  await running;
  try {
    const concurrent = await idempotency.execute({ ...input, requestId: 'concurrent' });
    assert.equal((concurrent.body as { error: { code: string } }).error.code, 'operation_in_progress');
    const conflict = await idempotency.execute({ ...input, payload: { message: 'y' } });
    assert.equal((conflict.body as { error: { code: string } }).error.code, 'idempotency_conflict');
    const sameUserNew = await idempotency.execute({ ...input, key: 'other' });
    assert.equal(sameUserNew.status, 503);
    const otherUser = await idempotency.execute({ ...input, userId: 'bob', async run() { return { status: 200, body: { data: 'bob' } }; } });
    assert.equal(otherUser.status, 200);
  } finally { release(); }
  assert.equal((await first).status, 503);
  const retried = await idempotency.execute({ ...input, requestId: 'retry', async run() { calls++; return { status: 200, body: { requestId: 'retry', data: 'done' } }; } });
  assert.equal(retried.status, 200);
  const replay = await idempotency.execute({ ...input, requestId: 'again', async run() { throw new Error('must replay'); } });
  assert.deepEqual(replay, retried);
  assert.equal(calls, 2);
  const changed = await idempotency.execute({ ...input, payload: { message: 'different' } });
  assert.equal((changed.body as { error: { code: string } }).error.code, 'idempotency_conflict');
});

test('unknown write results remain recorded at capacity and are not evicted for new keys', async () => {
  const idempotency = new MemoryIdempotency(1); let calls = 0;
  const input = { userId: 'alice', operation: 'schedule_command', key: 'write', requestId: 'first', payload: { title: 'x' },
    async run(): Promise<HttpResult> { calls++; throw new Error('possibly committed'); } };
  const first = await idempotency.execute(input);
  assert.equal(first.status, 500);
  const full = await idempotency.execute({ ...input, key: 'new' });
  assert.equal(full.status, 503);
  const otherUser = await idempotency.execute({ ...input, userId: 'bob', async run() { return { status: 200, body: { data: 'bob' } }; } });
  assert.equal(otherUser.status, 200);
  const replay = await idempotency.execute({ ...input, requestId: 'retry' });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  const changed = await idempotency.execute({ ...input, payload: { title: 'y' } });
  assert.equal((changed.body as { error: { code: string } }).error.code, 'idempotency_conflict');
});

test('per-user capacity configuration requires a positive safe integer', () => {
  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new MemoryIdempotency(value));
  }
});
