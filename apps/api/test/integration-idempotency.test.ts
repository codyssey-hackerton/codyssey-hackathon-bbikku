import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RepositoryIdempotency } from '../src/idempotency.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

for (const operation of ['preparation_proposal', 'calendar_import', 'contact_reply_check', 'contact_response_confirm']) {
  test(`${operation} recovers an expired claim and replays its committed result`, async () => {
    const store = new MemoryPlanningStore(); const userId = 'integration-user';
    const now = new Date('2026-10-31T12:00:00Z');
    await store.transaction(userId, state => state.idempotency.set(JSON.stringify([operation, 'key']), {
      fingerprint: createHash('sha256').update('{}').digest('hex'), operationId: 'old', state: 'running',
      token: 'old-token', leaseUntil: new Date(now.getTime() - 1).toISOString(),
    }));
    const idempotency = new RepositoryIdempotency(store, () => now); let writes = 0;
    const input = { userId, operation, key: 'key', requestId: 'request', payload: {},
      async run(control: { finalize: (run: () => Promise<{ status: number; body: unknown }>) => Promise<{ status: number; body: unknown }> }) {
        const write = async () => {
          writes++; await store.transaction(userId, state => { state.scheduleRevision++; });
          return { status: 200, body: { result: 'saved' } };
        };
        return operation === 'calendar_import' || operation === 'contact_reply_check' ? control.finalize(write) : write();
      } };
    const result = await idempotency.execute(input);
    assert.equal(result.status, 200);
    assert.deepEqual(await idempotency.execute(input), result);
    assert.equal(writes, 1);
    assert.equal((await store.read(userId)).scheduleRevision, 1);
  });
}

for (const operation of ['calendar_import', 'contact_reply_check']) test(`${operation} preflight does not hold the user transaction while awaiting the provider`, async () => {
  const store = new MemoryPlanningStore(); const idempotency = new RepositoryIdempotency(store);
  let signalStarted!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = idempotency.execute({ userId: 'user', operation, key: 'key', requestId: 'request', payload: {},
    async run({ finalize }) {
      signalStarted(); await gate;
      return finalize(async () => ({ status: 200, body: { ok: true } }));
    } });
  try {
    await started;
    const concurrent = store.transaction('user', state => { state.contextRevision++; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([concurrent, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider wait held transaction')), 1000); })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.equal((await store.read('user')).contextRevision, 1);
  } finally { release(); await pending; }
});

test('reply lookup retries only explicitly no-effect provider failures with the same key', async () => {
  const store = new MemoryPlanningStore(); const idempotency = new RepositoryIdempotency(store); let calls = 0;
  const input = { userId: 'user', operation: 'contact_reply_check', key: 'key', requestId: 'request', payload: {},
    async run({ finalize }: { finalize: (run: () => Promise<{ status: number; body: unknown }>) => Promise<{ status: number; body: unknown }> }) {
      calls++;
      if (calls === 1) return { status: 503, body: { error: { code: 'provider_unavailable' } }, retryableWithoutEffects: true as const };
      return finalize(async () => {
        await store.transaction('user', state => { state.contextRevision++; });
        return { status: 200, body: { ok: true } };
      });
    } };
  assert.equal((await idempotency.execute(input)).status, 503);
  const succeeded = await idempotency.execute(input);
  assert.equal(succeeded.status, 200);
  assert.deepEqual(await idempotency.execute(input), succeeded);
  assert.equal(calls, 2); assert.equal((await store.read('user')).contextRevision, 1);
  let unsafeCalls = 0;
  const unsafe = { ...input, key: 'unsafe', async run() { unsafeCalls++; return { status: 503, body: { error: { code: 'provider_unavailable' } } }; } };
  await idempotency.execute(unsafe); await idempotency.execute(unsafe);
  assert.equal(unsafeCalls, 1);
});
