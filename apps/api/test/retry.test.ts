import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { MemoryIdempotency } from '../src/idempotency.ts';
import { MemoryPlanningStore, type UserPlanningState } from '../src/planning-store.ts';

const sessions = { async resolve(token: string) { return token === 'alice' ? { userId: 'alice' } : null; } };
const now = '2026-10-31T12:00:00.000Z';
const headers = (key = 'chat-key') => ({ authorization: 'Bearer alice', 'idempotency-key': key });
const chat = (requestId: string) => ({ requestId, conversationId: null, message: '공부 계획', timezone: 'Asia/Seoul' });
const task = { kind: 'task', title: '공부', timeSlot: { startsAt: '2026-11-02T09:00+09:00', endsAt: '2026-11-02T10:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: 60, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const proposal = { kind: 'proposal', reason: '계획', changeSet: { changes: [{ changeId: 'task', operation: 'create', after: task }] }, evidenceRefs: [] };

test('a read-only provider failure can retry the same key once at a time and creates exactly one proposal', async t => {
  let attempts = 0; let calls = 0; let started!: () => void; let release!: () => void;
  const retryStarted = new Promise<void>(resolve => { started = resolve; });
  const retryGate = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async decide(input) {
    calls++;
    if (!input.observations.length) {
      attempts++;
      if (attempts === 1) return { kind: 'tool_call', name: 'read_schedule', input: { from: '2026-11-02T00:00+09:00', to: '2026-11-03T00:00+09:00', timezone: 'Asia/Seoul' } };
      started(); await retryGate; return proposal;
    }
    throw new Error('provider failed after a read');
  } };
  const store = new MemoryPlanningStore();
  const app = buildApp({ sessions, model, store, clock: () => new Date(now) }); t.after(() => { release(); return app.close(); });
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(first.statusCode, 503);
  assert.equal(first.json().error.code, 'provider_unavailable');
  assert.equal(first.json().error.retryable, true);
  assert.equal((await store.read('alice')).proposals.size, 0);
  assert.equal((await store.read('alice')).items.size, 0);
  const changed = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: { ...chat('changed'), message: '다른 요청' } });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'idempotency_conflict');
  assert.equal(calls, 2);

  const retry = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') }).then(response => response);
  await retryStarted;
  const concurrent = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(concurrent.statusCode, 409);
  assert.equal(concurrent.json().error.code, 'operation_in_progress');
  const conflicting = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: { ...chat('concurrent'), message: '다른 요청' } });
  assert.equal(conflicting.json().error.code, 'idempotency_conflict');
  release();
  const succeeded = await retry;
  assert.equal(succeeded.statusCode, 200, succeeded.body);
  assert.equal(succeeded.json().data.result.kind, 'proposal');
  assert.equal((await store.read('alice')).proposals.size, 1);
  assert.equal(calls, 3);
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.deepEqual(replay.json(), succeeded.json());
  assert.equal((await store.read('alice')).proposals.size, 1);
  assert.equal(calls, 3);
});

test('invalid read-tool arguments can be retried without saving anything', async t => {
  let calls = 0;
  const model: ModelPort = { async decide() {
    calls++;
    return calls === 1 ? { kind: 'tool_call', name: 'read_schedule', input: { from: 'invalid', to: 'invalid', timezone: 'UTC' } }
      : { kind: 'answer', text: '다시 확인했습니다.' };
  } };
  const store = new MemoryPlanningStore();
  const app = buildApp({ sessions, model, store, clock: () => new Date(now) }); t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(first.statusCode, 503);
  assert.equal(first.json().error.code, 'provider_unavailable');
  const second = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().data.result.kind, 'reply');
  assert.equal((await store.read('alice')).proposals.size, 0);
  assert.equal(calls, 2);
});

test('proposal saving revalidates after graph completion if context changes before the write', async t => {
  let start!: () => void; let release!: () => void;
  const saving = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class GatedStore extends MemoryPlanningStore {
    count = 0;
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      this.count++;
      if (this.count === 2) { start(); await gate; }
      return super.atomic(userId, run);
    }
  }
  const store = new GatedStore();
  const app = buildApp({ sessions, store, clock: () => new Date(now), model: { async decide() { return proposal; } } });
  t.after(() => { release(); return app.close(); });
  const pending = app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') }).then(response => response);
  await saving;
  const changed = await app.inject({ method: 'POST', url: '/v1/memory', headers: headers('memory'), payload: {
    requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'study', value: 'rest', validUntil: null,
  } });
  assert.equal(changed.statusCode, 200);
  release();
  const result = await pending;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().data.result.code, 'stale_proposal');
  assert.equal((await store.read('alice')).proposals.size, 0);
});

class CommitThenFailStore extends MemoryPlanningStore {
  calls = 0;
  private depth = 0;
  constructor(private readonly effect: 'proposal' | 'item') { super(); }
  override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
    if (this.depth) return super.atomic(userId, run);
    const before = await this.read(userId);
    this.depth++;
    let result: T;
    try { result = await super.atomic(userId, run); } finally { this.depth--; }
    const after = await this.read(userId);
    if (this.effect === 'proposal' ? after.proposals.size > before.proposals.size : after.items.size > before.items.size) {
      this.calls++;
      throw new Error('simulated failure after commit');
    }
    return result;
  }
}

test('a failure after proposal commit remains a cached 500 and cannot create a second proposal', async t => {
  let modelCalls = 0;
  const store = new CommitThenFailStore('proposal');
  const app = buildApp({ sessions, store, clock: () => new Date(now), model: { async decide() { modelCalls++; return proposal; } } });
  t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(first.statusCode, 500);
  assert.equal(first.json().error.code, 'internal_error');
  assert.equal((await store.read('alice')).proposals.size, 1);
  const retry = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.deepEqual(retry.json(), first.json());
  assert.equal((await store.read('alice')).proposals.size, 1);
  assert.equal(store.calls, 1);
  assert.equal(modelCalls, 1);
});

test('a failure after a manual write remains a cached 500 and never executes that key twice', async t => {
  const store = new CommitThenFailStore('item');
  const app = buildApp({ sessions, store, clock: () => new Date(now) }); t.after(() => app.close());
  const payload = { requestId: 'first', expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'task', operation: 'create', after: task }] } };
  const first = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('write'), payload });
  assert.equal(first.statusCode, 500);
  assert.equal((await store.read('alice')).items.size, 1);
  const retry = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('write'), payload: { ...payload, requestId: 'retry' } });
  assert.deepEqual(retry.json(), first.json());
  assert.equal(store.calls, 1);
  const conflict = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('write'), payload: { ...payload, expectedScheduleRevision: 1 } });
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
  assert.equal((await store.read('alice')).items.size, 1);
});

test('an unexpected exception inside idempotency is retained as an unknown 500, including for writes', async () => {
  const idempotency = new MemoryIdempotency(); let calls = 0;
  const input = { userId: 'alice', operation: 'schedule_command', key: 'key', requestId: 'first', payload: { title: 'x' },
    async run() { calls++; throw new Error('possibly committed'); } };
  const first = await idempotency.execute(input);
  const retry = await idempotency.execute({ ...input, requestId: 'second' });
  assert.equal(first.status, 500);
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
});

test('other 503s and all 500s remain cached even if a caller incorrectly marks them retryable', async () => {
  const cases = [
    { operation: 'schedule_command', status: 503, marked: true, code: 'provider_unavailable' },
    { operation: 'chat', status: 503, marked: false, code: 'provider_unavailable' },
    { operation: 'chat', status: 500, marked: true, code: 'provider_unavailable' },
  ];
  for (const item of cases) {
    const idempotency = new MemoryIdempotency(); let calls = 0;
    const input = { userId: 'alice', operation: item.operation, key: 'key', requestId: 'first', payload: {}, async run() {
      calls++;
      return { status: item.status, body: { requestId: 'first', error: { code: item.code } },
        ...(item.marked ? { retryableWithoutEffects: true as const } : {}) };
    } };
    const first = await idempotency.execute(input);
    const replay = await idempotency.execute({ ...input, requestId: item.operation === 'chat' ? 'first' : 'second' });
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
  }
});

test('a validation exception is not misclassified as a retryable provider failure', async t => {
  class ValidationReadFailure extends MemoryPlanningStore {
    reads = 0;
    override async read(userId: string): Promise<UserPlanningState> {
      this.reads++;
      if (this.reads === 2) throw new Error('validation read failed');
      return super.read(userId);
    }
  }
  const store = new ValidationReadFailure(); let modelCalls = 0;
  const app = buildApp({ sessions, store, clock: () => new Date(now), model: { async decide() { modelCalls++; return proposal; } } });
  t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.equal(first.statusCode, 500);
  assert.equal(first.json().error.code, 'internal_error');
  assert.equal((await store.read('alice')).proposals.size, 0);
  const replay = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers(), payload: chat('first') });
  assert.deepEqual(replay.json(), first.json());
  assert.equal(modelCalls, 1);
});
