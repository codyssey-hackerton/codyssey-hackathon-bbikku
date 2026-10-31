import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RepositoryIdempotency } from '../src/idempotency.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';

test('calendar sync runs outside the outer planning transaction and durably replays its result', async () => {
  const base = new MemoryPlanningStore(); let depth = 0; let effects = 0;
  const store: PlanningStore = {
    mode: 'memory', durable: false, read: base.read.bind(base), transaction: base.transaction.bind(base),
    transactionTimestamp: base.transactionTimestamp.bind(base), listUserIds: base.listUserIds.bind(base),
    async atomic(userId, run) { depth++; try { return await base.atomic(userId, run); } finally { depth--; } },
  };
  const idempotency = new RepositoryIdempotency(store);
  const input = { userId: 'synthetic-user', operation: 'calendar_sync_run', key: 'sync-key', requestId: 'first', payload: {},
    async run() { assert.equal(depth, 0); effects++; return { status: 200, body: { requestId: 'first', data: { exported: 1 } } }; } };
  const first = await idempotency.execute(input);
  assert.equal(first.status, 200); assert.equal(effects, 1);
  const replay = await new RepositoryIdempotency(store).execute({ ...input, requestId: 'second' });
  assert.deepEqual(replay, first); assert.equal(effects, 1);
});

test('calendar sync never automatically reclaims an expired reservation that may have sent an external write', async () => {
  const store = new MemoryPlanningStore(); let effects = 0;
  await store.transaction('synthetic-user', state => state.idempotency.set(JSON.stringify(['calendar_sync_run', 'unknown-key']), {
    fingerprint: createHash('sha256').update('{}').digest('hex'), operationId: 'original-operation', state: 'running',
    token: 'original-claim', leaseUntil: '2026-01-01T00:00:00Z',
  }));
  const idempotency = new RepositoryIdempotency(store, () => new Date('2026-11-01T00:00:00Z'));
  const result = await idempotency.execute({ userId: 'synthetic-user', operation: 'calendar_sync_run', key: 'unknown-key', requestId: 'later', payload: {},
    async run() { effects++; return { status: 200, body: {} }; } });
  assert.equal(result.status, 409); assert.equal((result.body as { error: { code: string } }).error.code, 'operation_in_progress');
  assert.equal(effects, 0);
});
