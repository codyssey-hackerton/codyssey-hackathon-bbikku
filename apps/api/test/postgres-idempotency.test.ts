import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { RepositoryIdempotency } from '../src/idempotency.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
async function poolForTest(): Promise<pg.Pool> {
  const schema = `pikku_idem_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
}

test('a DB-only write recovers after a crash immediately after its reservation', { skip: !connectionString }, async () => {
  class CrashAfterClaim extends PostgresPlanningStore {
    first = true;
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      const result = await super.atomic(userId, run);
      if (this.first) { this.first = false; throw new Error('simulated process loss after claim'); }
      return result;
    }
  }
  const pool = await poolForTest(); const userId = `user-${randomUUID()}`;
  let current = new Date('2026-10-31T12:00:00Z'); let calls = 0;
  try {
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const first = new RepositoryIdempotency(new CrashAfterClaim(pool), () => current);
    const input = { userId, operation: 'schedule_command', key: 'key', requestId: 'first', payload: { action: 'write' },
      async run() { calls++; await store.transaction(userId, state => { state.scheduleRevision++; }); return { status: 200, body: { requestId: 'first', data: { ok: true } } }; } };
    await assert.rejects(() => first.execute(input));
    assert.equal(calls, 0); assert.equal((await store.read(userId)).scheduleRevision, 0);
    const restarted = new RepositoryIdempotency(store, () => current);
    const busy = await restarted.execute({ ...input, requestId: 'early' });
    assert.equal((busy.body as { error: { code: string } }).error.code, 'operation_in_progress');
    const conflict = await restarted.execute({ ...input, payload: { action: 'different' } });
    assert.equal((conflict.body as { error: { code: string } }).error.code, 'idempotency_conflict');
    current = new Date(current.getTime() + 15 * 60_000 + 1);
    const recovered = await restarted.execute({ ...input, requestId: 'retry' });
    assert.equal(recovered.status, 200);
    const replay = await restarted.execute({ ...input, requestId: 'replay' });
    assert.deepEqual(replay, recovered);
    assert.equal(calls, 1); assert.equal((await store.read(userId)).scheduleRevision, 1);
  } finally { await pool.end(); }
});

test('a stale reservation owner is fenced after another instance recovers it', { skip: !connectionString }, async () => {
  let started!: () => void; let release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  class GateBeforeFinalize extends PostgresPlanningStore {
    calls = 0;
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      this.calls++;
      if (this.calls === 2) { started(); await gate; }
      return super.atomic(userId, run);
    }
  }
  const pool = await poolForTest(); const userId = `user-${randomUUID()}`;
  let current = new Date('2026-10-31T12:00:00Z'); let oldRuns = 0; let newRuns = 0;
  try {
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const old = new RepositoryIdempotency(new GateBeforeFinalize(pool), () => current);
    const input = { userId, operation: 'schedule_command', key: 'key', requestId: 'old', payload: { action: 'write' },
      async run() { oldRuns++; await store.transaction(userId, state => { state.scheduleRevision++; }); return { status: 200, body: { data: 'old' } }; } };
    const pending = old.execute(input); await startedPromise;
    current = new Date(current.getTime() + 15 * 60_000 + 1);
    const replacement = new RepositoryIdempotency(store, () => current);
    const recovered = await replacement.execute({ ...input, requestId: 'new', async run() {
      newRuns++; await store.transaction(userId, state => { state.scheduleRevision++; }); return { status: 200, body: { data: 'new' } };
    } });
    assert.equal(recovered.status, 200);
    release();
    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.equal(oldRuns, 0); assert.equal(newRuns, 1);
    assert.equal((await store.read(userId)).scheduleRevision, 1);
  } finally { release(); await pool.end(); }
});

test('a lost COMMIT response is resolved by the atomically persisted result', { skip: !connectionString }, async () => {
  class CommitReplyLost extends PostgresPlanningStore {
    depth = 0; roots = 0;
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      if (this.depth) return super.atomic(userId, run);
      this.depth++;
      try {
        const result = await super.atomic(userId, run); this.roots++;
        if (this.roots === 2) throw new Error('simulated lost commit reply');
        return result;
      } finally { this.depth--; }
    }
  }
  const pool = await poolForTest(); const userId = `user-${randomUUID()}`;
  try {
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const flaky = new CommitReplyLost(pool); const idempotency = new RepositoryIdempotency(flaky); let calls = 0;
    const input = { userId, operation: 'memory_write', key: 'key', requestId: 'first', payload: { action: 'write' },
      async run() { calls++; await flaky.transaction(userId, state => { state.contextRevision++; }); return { status: 200, body: { data: 'saved' } }; } };
    const result = await idempotency.execute(input);
    assert.equal(result.status, 200);
    assert.deepEqual(await idempotency.execute({ ...input, requestId: 'again' }), result);
    assert.equal(calls, 1); assert.equal((await store.read(userId)).contextRevision, 1);
  } finally { await pool.end(); }
});
