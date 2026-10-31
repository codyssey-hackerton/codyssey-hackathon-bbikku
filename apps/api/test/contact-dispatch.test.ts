import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import type { ContactRequest } from '../src/contact-service.ts';
import { createGmailContact, type ApprovedGmailContact, type GmailContactResult } from '../src/gmail-contact.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore, type UserPlanningState } from '../src/planning-store.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const fixedNow = '2026-10-31T12:00:00.000Z';
const recipientAddress = 'contact@example.test';
const senderAddress = 'sender@example.test';
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (key: string, user = 'alice') => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const event: ScheduleFields = {
  kind: 'event', title: '공동 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending',
};
type GmailContact = { userId: string; senderAddress: string; dispatch(input: ApprovedGmailContact, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<GmailContactResult> };
type AppOptions = NonNullable<Parameters<typeof buildApp>[0]> & { gmailContact?: GmailContact };
type App = ReturnType<typeof buildApp>;
const buildDispatchApp = (options: AppOptions) => buildApp(options);

function noExternalFetch(t: TestContext) {
  const guard = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external fetch'); });
  t.after(() => { assert.equal(guard.mock.callCount(), 0, 'tests must never make an external fetch'); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function delayedGmail(onFetch?: () => Promise<void>) {
  const started = deferred<void>(); const token = deferred<string>();
  let tokenCalls = 0; let fetchCalls = 0;
  const adapter = createGmailContact({ senderAddress,
    async getAccessToken(signal) { tokenCalls++; assert.ok(signal instanceof AbortSignal); started.resolve(); return token.promise; },
    async fetch() { fetchCalls++; await onFetch?.(); return Response.json({ id: 'synthetic-provider-id' }); },
  });
  return { adapter, started, token, get tokenCalls() { return tokenCalls; }, get fetchCalls() { return fetchCalls; } };
}
async function within<T>(promise: PromiseLike<T>, description: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error(`Timed out: ${description}`)), ms); })]);
  } finally { if (timer) realClearTimeout(timer); }
}
function assertOk(response: { statusCode: number; body: string }) { assert.equal(response.statusCode, 200, response.body); }
async function post(app: App, url: string, payload: object, key: string, user = 'alice') {
  return app.inject({ method: 'POST', url, headers: headers(key, user), payload });
}
async function get(app: App, url: string, user = 'alice') {
  return app.inject({ method: 'GET', url, headers: headers('unused', user) });
}
function send(app: App, contact: ContactRequest, key: string, user = 'alice', requestId = key, expectedSenderAddress = senderAddress) {
  return post(app, `/v1/contact-requests/${contact.id}/send`, { requestId, contactRevision: contact.revision, expectedSenderAddress }, key, user);
}
function assertScheduleUnchanged(before: UserPlanningState, after: UserPlanningState) {
  assert.equal(after.scheduleRevision, before.scheduleRevision);
  assert.deepEqual(after.items, before.items);
}

async function seed(store: PlanningStore, app: App, clock: () => Date, user = 'alice') {
  const planning = new PlanningService(store, clock);
  const created = await planning.command(user, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: event }] } });
  const item = created.items[0]!;
  const baseline = await planning.capture(user, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposalIds: string[] = [];
  for (const hour of ['10', '12']) {
    const result = await planning.saveProposal(baseline, { kind: 'proposal', reason: '시간 대안', evidenceRefs: [], changeSet: { changes: [{
      changeId: `move-${hour}`, operation: 'update', targetId: item.id, expectedRevision: item.revision,
      after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: `2026-11-02T${hour}:00+09:00`, endsAt: `2026-11-02T${Number(hour) + 1}:00+09:00` } },
    }] } });
    assert.equal(result.kind, 'proposal');
    if (result.kind !== 'proposal') throw new Error('Proposal fixture failed');
    proposalIds.push(result.proposalIds[0]!);
  }
  const recipient = await post(app, '/v1/recipients', { requestId: 'recipient', displayName: '테스트 상대', channel: 'email', address: recipientAddress, confirmed: true }, 'recipient', user);
  assertOk(recipient);
  return { item, proposalIds, recipientId: recipient.json().data.recipient.id as string };
}
async function draft(app: App, recipientId: string, proposalId: string, key: string, user = 'alice') {
  const response = await post(app, '/v1/contact-requests', { requestId: key, recipientRef: recipientId, channel: 'email', purpose: '일정 조정',
    messageOrCallBrief: '가능한 시간을 알려주세요.', allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] }, key, user);
  assertOk(response);
  return response.json().data.contactRequest as ContactRequest;
}
async function decide(app: App, contact: ContactRequest, decision: 'accept' | 'reject', key: string, user = 'alice') {
  const response = await post(app, `/v1/contact-requests/${contact.id}/decision`, { requestId: key, contactRevision: contact.revision, decision }, key, user);
  assertOk(response);
  return response.json().data.contactRequest as ContactRequest;
}
async function postgres(t: TestContext, dispatch: GmailContact['dispatch'] = async () => ({ status: 'submitted', providerOperationId: 'synthetic-provider-id' })) {
  noExternalFetch(t);
  const schema = `pikku_dispatch_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools: pg.Pool[] = []; const apps: App[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const pool of pools) await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const pool = (readOnly = false) => {
    const value = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}${readOnly ? ' -c default_transaction_read_only=on' : ''}` });
    pools.push(value); return value;
  };
  const firstPool = pool(); const secondPool = pool();
  const store = new PostgresPlanningStore(firstPool); const otherStore = new PostgresPlanningStore(secondPool);
  await store.migrate();
  let now = fixedNow;
  const clock = () => new Date(now);
  const gmailContact = { userId: 'alice', senderAddress, dispatch };
  const app = (selectedStore: PlanningStore = store, provider: GmailContact | null = gmailContact) => {
    const value = buildDispatchApp({ sessions, store: selectedStore, clock, ...(provider ? { gmailContact: provider } : {}) });
    apps.push(value); return value;
  };
  const first = app(); const second = app(otherStore);
  return { schema, pool, firstPool, secondPool, store, otherStore, first, second, app, clock, setNow(value: string) { now = value; }, gmailContact };
}
async function readyFixture(env: Awaited<ReturnType<typeof postgres>>) {
  const seeded = await seed(env.store, env.first, env.clock);
  const initial = await draft(env.first, seeded.recipientId, seeded.proposalIds[0]!, 'draft');
  const approved = await decide(env.first, initial, 'accept', 'approve');
  assert.equal(approved.deliveryStatus, 'ready');
  return { ...seeded, initial, approved };
}
async function readLockedContact(pool: pg.Pool, id: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s'");
    const result = await client.query('SELECT state FROM pikku_user_state_v1 WHERE user_id = $1 FOR UPDATE NOWAIT', ['alice']);
    const entries = result.rows[0].state.contactRequests as [string, ContactRequest][];
    return entries.find(([key]) => key === id)?.[1];
  } finally { await client.query('ROLLBACK'); client.release(); }
}
async function physicalRow(pool: pg.Pool, user: string) {
  const result = await pool.query('SELECT schema_version, state, updated_at::text, xmin::text AS row_version FROM pikku_user_state_v1 WHERE user_id = $1', [user]);
  return result.rows[0] ?? null;
}

test('a volatile store refuses to send without changing the saved state', async t => {
  noExternalFetch(t);
  const store = new MemoryPlanningStore(); let calls = 0;
  const clock = () => new Date(fixedNow);
  const app = buildDispatchApp({ sessions, store, clock, gmailContact: { userId: 'alice', senderAddress, async dispatch() {
    calls++; return { status: 'submitted', providerOperationId: 'synthetic-provider-id' };
  } } });
  t.after(() => app.close());
  const seeded = await seed(store, app, clock);
  const contact = await draft(app, seeded.recipientId, seeded.proposalIds[0]!, 'draft');
  const approved = await decide(app, contact, 'accept', 'approve');
  const before = await store.read('alice');
  const result = await send(app, approved, 'send');
  assert.equal(result.statusCode, 503, result.body);
  assert.deepEqual(await store.read('alice'), before);
  assert.equal(calls, 0);
});

test('an unconfigured sender returns 503 before changing a database row', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'synthetic-provider-id' }; });
  const { approved } = await readyFixture(env);
  const before = await physicalRow(env.firstPool, 'alice');
  const noProvider = env.app(env.store, null);
  const unavailable = await send(noProvider, approved, 'send-unconfigured');
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.equal(calls, 0);
  assert.deepEqual(await physicalRow(env.firstPool, 'alice'), before);
});

test('a sender bound to another user returns 503 without creating that user\'s database row', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'synthetic-provider-id' }; });
  const { approved } = await readyFixture(env);
  const before = await physicalRow(env.firstPool, 'bob');
  assert.equal(before, null);
  const result = await send(env.first, approved, 'wrong-sender-owner', 'bob');
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(calls, 0);
  assert.deepEqual(await physicalRow(env.firstPool, 'bob'), before);
});

test('a PostgreSQL read-only connection returns 503 without a claim or other mutation', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'synthetic-provider-id' }; });
  const { approved } = await readyFixture(env);
  const before = await physicalRow(env.firstPool, 'alice');
  const readonlyPool = env.pool(true);
  assert.equal((await readonlyPool.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  const readOnlyApp = env.app(new PostgresPlanningStore(readonlyPool));
  const readOnlyResult = await send(readOnlyApp, approved, 'send-read-only');
  assert.equal(calls, 0);
  assert.deepEqual(await physicalRow(env.firstPool, 'alice'), before);
  assert.equal(readOnlyResult.statusCode, 503, readOnlyResult.body);
});

test('send requires a valid expected sender address', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'should-not-run' }; });
  const { approved } = await readyFixture(env);
  const before = await env.store.read('alice');
  const missing = await post(env.first, `/v1/contact-requests/${approved.id}/send`,
    { requestId: 'missing-sender', contactRevision: approved.revision }, 'missing-sender');
  assert.equal(missing.statusCode, 400, missing.body);
  for (const [index, address] of ['', 'not-an-email'].entries()) {
    const invalid = await send(env.first, approved, `invalid-sender-${index}`, 'alice', `invalid-sender-${index}`, address);
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await env.store.read('alice'), before);
});

test('a changed sender account rejects a new claim without dispatch', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'should-not-run' }; });
  const { approved } = await readyFixture(env);
  const before = await env.store.read('alice');
  const accountA = await get(env.first, '/v1/email-connection');
  assertOk(accountA); assert.equal(accountA.json().data.senderAddress, senderAddress);
  const accountBApp = env.app(env.otherStore, { ...env.gmailContact, senderAddress: 'changed-sender@example.test' });
  const accountB = await get(accountBApp, '/v1/email-connection');
  assertOk(accountB); assert.equal(accountB.json().data.senderAddress, 'changed-sender@example.test');
  const response = await send(accountBApp, approved, 'sender-account-changed');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'conflict');
  assert.equal(calls, 0);
  const after = await env.store.read('alice');
  assert.equal(after.contactRequests.get(approved.id)?.deliveryStatus, 'ready');
  assertScheduleUnchanged(before, after);
});

test('two PostgreSQL instances persist intent, release the row lock, and dispatch once for same or different keys', { skip: !connectionString, timeout: 30000 }, async t => {
  const started = deferred<ApprovedGmailContact>(); const finish = deferred<GmailContactResult>();
  const calls: ApprovedGmailContact[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const env = await postgres(t, async (input, signal) => { calls.push(input); signals.push(signal); started.resolve(input); return finish.promise; });
  const { approved } = await readyFixture(env);
  const scheduleBefore = await env.store.read('alice');
  const firstSend = send(env.first, approved, 'same-key');
  try {
    const input = await within(Promise.race([started.promise, firstSend.then(response => { throw new Error(`send returned before dispatch: ${response.statusCode} ${response.body}`); })]), 'dispatch starts');
    assert.equal(input.recipient, approved.recipientSnapshot.address);
    assert.equal(input.recipient, recipientAddress);
    assert.ok(input.subject.includes(approved.purpose));
    assert.ok(input.message.includes(approved.messageOrCallBrief));
    assert.equal(input.executionKey, approved.executionKey);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(signals[0].aborted, false);
    const committed = await readLockedContact(env.secondPool, approved.id);
    assert.equal(committed?.deliveryStatus, 'submitting');
    assert.equal(committed?.providerOperationId, null);
    const during = await get(env.second, `/v1/contact-requests/${approved.id}`);
    assertOk(during); assert.equal(during.json().data.contactRequest.deliveryStatus, 'submitting');
    const duplicates = await within(Promise.all([send(env.second, approved, 'same-key'), send(env.second, approved, 'other-key')]), 'concurrent duplicates');
    assert.equal(duplicates[0]!.statusCode, 409, duplicates[0]!.body);
    assert.equal(duplicates[0]!.json().error.code, 'operation_in_progress');
    assert.ok([200, 409].includes(duplicates[1]!.statusCode), duplicates[1]!.body);
    assert.equal(calls.length, 1);
    finish.resolve({ status: 'submitted', providerOperationId: 'synthetic-provider-id' });
    const response = await within(firstSend, 'successful send');
    assertOk(response);
    const sent = response.json().data.contactRequest as ContactRequest;
    assert.equal(sent.deliveryStatus, 'sent_or_connected');
    assert.equal(sent.negotiationStatus, 'awaiting_response');
    assert.equal(sent.providerOperationId, 'synthetic-provider-id');
    assert.equal(sent.revision, approved.revision);
    const restarted = env.app(new PostgresPlanningStore(env.pool()));
    const replay = await send(restarted, approved, 'same-key', 'alice', 'new-request-id');
    assertOk(replay); assert.deepEqual(replay.json(), response.json());
    const changedPayload = await post(env.second, `/v1/contact-requests/${approved.id}/send`,
      { requestId: 'changed-payload', contactRevision: approved.revision + 1, expectedSenderAddress: senderAddress }, 'same-key');
    assert.equal(changedPayload.statusCode, 409, changedPayload.body);
    assert.equal(changedPayload.json().error.code, 'idempotency_conflict');
    const changedSender = await send(env.second, approved, 'same-key', 'alice', 'same-key', 'changed-sender@example.test');
    assert.equal(changedSender.statusCode, 409, changedSender.body);
    assert.equal(changedSender.json().error.code, 'idempotency_conflict');
    const another = await send(env.second, approved, 'after-send');
    assert.ok([200, 409].includes(another.statusCode), another.body);
    assert.equal(calls.length, 1);
    assertScheduleUnchanged(scheduleBefore, await env.otherStore.read('alice'));
  } finally {
    finish.resolve({ status: 'outcome_unknown', providerOperationId: null });
    await within(firstSend.catch(() => undefined), 'release pending send').catch(() => undefined);
  }
});

test('a missing provider still reports an in-flight claim and replays a completed send', { skip: !connectionString }, async t => {
  const started = deferred<void>(); const finish = deferred<GmailContactResult>(); let calls = 0;
  const env = await postgres(t, async () => { calls++; started.resolve(); return finish.promise; });
  const { approved } = await readyFixture(env);
  const noProvider = env.app(env.otherStore, null);
  const pending = send(env.first, approved, 'provider-removed');
  try {
    await within(Promise.race([started.promise, pending.then(response => { throw new Error(`send returned before dispatch: ${response.statusCode}`); })]), 'dispatch starts');
    const busy = await within(send(noProvider, approved, 'provider-removed', 'alice', 'in-flight-retry'), 'in-flight replay without provider');
    assert.equal(busy.statusCode, 409, busy.body);
    assert.equal(busy.json().error.code, 'operation_in_progress');
    assert.equal(calls, 1);
    finish.resolve({ status: 'submitted', providerOperationId: 'synthetic-provider-id' });
    const original = await within(pending, 'original send');
    assertOk(original);
    const replay = await send(noProvider, approved, 'provider-removed', 'alice', 'completed-retry');
    assertOk(replay);
    assert.deepEqual(replay.json(), original.json());
    assert.equal(calls, 1);
  } finally {
    finish.resolve({ status: 'outcome_unknown', providerOperationId: null });
    await within(pending.catch(() => undefined), 'provider replay cleanup').catch(() => undefined);
  }
});

for (const changed of ['record', 'current'] as const) {
  test(`post-dispatch ${changed} tampering returns non-retryable provider_unavailable and never resends`, { skip: !connectionString }, async t => {
    const started = deferred<void>(); const finish = deferred<GmailContactResult>(); let calls = 0;
    const env = await postgres(t, async () => { calls++; started.resolve(); return finish.promise; });
    const { approved } = await readyFixture(env);
    const before = await env.store.read('alice');
    const key = `tampered-${changed}`;
    const pending = send(env.first, approved, key);
    try {
      await within(Promise.race([started.promise, pending.then(response => { throw new Error(`send returned before dispatch: ${response.statusCode}`); })]), 'dispatch starts');
      await within(env.otherStore.transaction('alice', state => {
        if (changed === 'record') {
          const running = [...state.idempotency.values()].filter(record => record.state === 'running');
          assert.equal(running.length, 1);
          running[0]!.token = 'synthetic-tampered-token';
        } else {
          state.contactRequests.set(approved.id, structuredClone(approved));
        }
      }), 'change state during dispatch');
      finish.resolve({ status: 'submitted', providerOperationId: 'synthetic-provider-id' });
      const result = await within(pending, 'post-dispatch tampering result');
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.json().error.code, 'provider_unavailable');
      assert.equal(result.json().error.retryable, false);
      const same = await send(env.second, approved, key, 'alice', 'retry');
      const different = await send(env.second, approved, `${key}-other`);
      assert.ok([409, 503].includes(same.statusCode), same.body);
      if (changed === 'current') assert.equal(different.statusCode, 409, different.body);
      else assert.ok([409, 503].includes(different.statusCode), different.body);
      assert.equal(calls, 1);
      assertScheduleUnchanged(before, await env.store.read('alice'));
    } finally {
      finish.resolve({ status: 'outcome_unknown', providerOperationId: null });
      await within(pending.catch(() => undefined), 'post-dispatch tampering cleanup').catch(() => undefined);
    }
  });
}

test('failed, unknown, and thrown dispatch outcomes persist safely without automatic duplicate sends', { skip: !connectionString }, async t => {
  let calls = 0;
  let outcome: GmailContactResult | Error = { status: 'failed', providerOperationId: null };
  const env = await postgres(t, async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; });
  const fixture = await readyFixture(env);
  const cases: { label: string; result: GmailContactResult | Error; status: ContactRequest['deliveryStatus'] }[] = [
    { label: 'failed', result: { status: 'failed', providerOperationId: null }, status: 'failed' },
    { label: 'unknown', result: { status: 'outcome_unknown', providerOperationId: null }, status: 'outcome_unknown' },
    { label: 'thrown', result: new Error('synthetic timeout'), status: 'outcome_unknown' },
  ];
  const originalSchedule = await env.store.read('alice');
  for (const [index, item] of cases.entries()) {
    const contact = index === 0 ? fixture.approved : await decide(env.first,
      await draft(env.first, fixture.recipientId, fixture.proposalIds[0]!, `draft-${item.label}`), 'accept', `approve-${item.label}`);
    outcome = item.result;
    const first = await send(env.first, contact, `send-${item.label}`);
    assertOk(first);
    assert.equal(first.json().data.contactRequest.deliveryStatus, item.status, item.label);
    const current = await get(env.second, `/v1/contact-requests/${contact.id}`);
    assertOk(current);
    assert.equal(current.json().data.contactRequest.deliveryStatus, item.status, item.label);
    assert.equal(current.json().data.contactRequest.negotiationStatus, 'not_started');
    assert.equal(current.json().data.contactRequest.providerOperationId, null);
    const replay = await send(env.second, contact, `send-${item.label}`, 'alice', 'retry');
    assert.deepEqual(replay.json(), first.json());
    await send(env.second, contact, `different-${item.label}`);
    assert.equal(calls, index + 1, item.label);
    assertScheduleUnchanged(originalSchedule, await env.store.read('alice'));
  }
});

test('a 30-second adapter timeout aborts the signal, returns unknown, and suppresses late success', { skip: !connectionString, timeout: 15000 }, async t => {
  const started = deferred<void>(); const finish = deferred<GmailContactResult>(); let calls = 0; let signal: AbortSignal | undefined;
  const env = await postgres(t, async (_input, receivedSignal) => { calls++; signal = receivedSignal; started.resolve(); return finish.promise; });
  const { approved } = await readyFixture(env);
  const before = await env.store.read('alice');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send(env.first, approved, 'timeout-send');
  try {
    await within(Promise.race([started.promise, pending.then(response => { throw new Error(`send returned before dispatch: ${response.statusCode}`); })]), 'timeout dispatch starts');
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(30_000);
    const result = await within(pending, 'timeout result');
    assert.equal(signal.aborted, true);
    assertOk(result);
    assert.equal(result.json().data.contactRequest.deliveryStatus, 'outcome_unknown');
    finish.resolve({ status: 'submitted', providerOperationId: 'late-provider-id' });
    await Promise.resolve();
    const replay = await send(env.second, approved, 'timeout-send', 'alice', 'retry');
    assert.deepEqual(replay.json(), result.json());
    await send(env.second, approved, 'timeout-other-key');
    assert.equal(calls, 1);
    const state = await env.store.read('alice');
    assert.equal(state.contactRequests.get(approved.id)?.deliveryStatus, 'outcome_unknown');
    assertScheduleUnchanged(before, state);
  } finally {
    finish.resolve({ status: 'outcome_unknown', providerOperationId: null });
    t.mock.timers.reset();
    await within(pending.catch(() => undefined), 'timeout cleanup').catch(() => undefined);
  }
});

test('the real Gmail adapter releases the row lock before synthetic fetch after delayed token acquisition', { skip: !connectionString }, async t => {
  let fetchContact: ContactRequest | undefined; let lockFailure: unknown;
  const gmail = delayedGmail(async () => {
    try { fetchContact = await readLockedContact(env.secondPool, approved.id); } catch (error) { lockFailure = error; }
  });
  const env = await postgres(t, gmail.adapter.dispatch);
  const { approved } = await readyFixture(env);
  const pending = send(env.first, approved, 'adapter-control');
  try {
    await within(Promise.race([gmail.started.promise, pending.then(response => { throw new Error(`send returned before token acquisition: ${response.statusCode}`); })]), 'token acquisition starts');
    assert.equal((await env.store.read('alice')).contactRequests.get(approved.id)?.deliveryStatus, 'submitting');
    gmail.token.resolve('synthetic-token');
    const result = await within(pending, 'adapter control');
    assert.ifError(lockFailure);
    assert.equal(fetchContact?.deliveryStatus, 'submitting');
    assertOk(result);
    assert.equal(result.json().data.contactRequest.deliveryStatus, 'sent_or_connected');
    assert.equal(result.json().data.contactRequest.providerOperationId, 'synthetic-provider-id');
    assert.equal(gmail.tokenCalls, 1);
    assert.equal(gmail.fetchCalls, 1);
  } finally {
    gmail.token.resolve('synthetic-token');
    await within(pending.catch(() => undefined), 'adapter control cleanup').catch(() => undefined);
  }
});

for (const revision of ['contextRevision', 'scheduleRevision'] as const) {
  test(`the real Gmail adapter blocks fetch when ${revision} changes while the token is pending`, { skip: !connectionString }, async t => {
    const gmail = delayedGmail();
    const env = await postgres(t, gmail.adapter.dispatch);
    const { approved, item } = await readyFixture(env);
    const before = await env.store.read('alice');
    const pending = send(env.first, approved, `changed-${revision}`);
    try {
      await within(Promise.race([gmail.started.promise, pending.then(response => { throw new Error(`send returned before token acquisition: ${response.statusCode}`); })]), 'token acquisition starts');
      assert.equal((await env.otherStore.read('alice')).contactRequests.get(approved.id)?.deliveryStatus, 'submitting');
      await within(env.otherStore.transaction('alice', state => { state[revision]++; }), 'change revision while token is pending');
      const changed = await env.store.read('alice');
      assert.equal(changed[revision], before[revision] + 1);
      assert.deepEqual(changed.items, before.items);
      gmail.token.resolve('synthetic-token');
      const result = await within(pending, 'stale send result');
      assert.equal(gmail.fetchCalls, 0, 'stale approval must be checked before Gmail fetch');
      assert.equal(gmail.tokenCalls, 1);
      assertOk(result);
      const contact = result.json().data.contactRequest as ContactRequest;
      assert.equal(contact.deliveryStatus, 'failed');
      assert.equal(contact.negotiationStatus, 'not_started');
      assert.equal(contact.providerOperationId, null);
      const state = await env.otherStore.read('alice');
      assert.equal(state.contactRequests.get(approved.id)?.deliveryStatus, 'failed');
      assert.deepEqual(state.items, before.items);
      assert.deepEqual(state.items.get(item.id), item);
      assert.equal(state.scheduleRevision, before.scheduleRevision + Number(revision === 'scheduleRevision'));
      assert.equal(state.contextRevision, before.contextRevision + Number(revision === 'contextRevision'));
      const replay = await send(env.second, approved, `changed-${revision}`, 'alice', 'retry');
      assert.deepEqual(replay.json(), result.json());
      assert.equal(gmail.fetchCalls, 0);
    } finally {
      gmail.token.resolve('synthetic-token');
      await within(pending.catch(() => undefined), 'stale send cleanup').catch(() => undefined);
    }
  });
}

test('a claim that reaches its deadline before the provider starts remains unknown and is never resent', { skip: !connectionString }, async t => {
  let calls = 0; let advanced = false; let depth = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'should-not-run' }; });
  const { approved, item } = await readyFixture(env);
  const before = await env.store.read('alice');
  const observeCommit = async (userId: string) => {
    if (!advanced && (await env.store.read(userId)).contactRequests.get(approved.id)?.deliveryStatus === 'submitting') {
      advanced = true;
      env.setNow('2026-10-31T12:00:31.000Z');
    }
  };
  const delayedStore: PlanningStore = {
    mode: env.store.mode, durable: env.store.durable,
    read: userId => env.store.read(userId),
    transactionTimestamp: () => env.store.transactionTimestamp(),
    listUserIds: () => env.store.listUserIds(),
    async atomic(userId, run) {
      depth++;
      let result;
      try { result = await env.store.atomic(userId, run); } finally { depth--; }
      if (depth === 0) await observeCommit(userId);
      return result;
    },
    async transaction(userId, apply) {
      const result = await env.store.transaction(userId, apply);
      if (depth === 0) await observeCommit(userId);
      return result;
    },
  };
  const app = env.app(delayedStore);
  const result = await send(app, approved, 'deadline-before-provider');
  assert.equal(advanced, true, 'the clock must advance immediately after the submitting claim commits');
  assert.equal(calls, 0);
  assertOk(result);
  assert.equal(result.json().data.contactRequest.deliveryStatus, 'outcome_unknown');
  const state = await env.otherStore.read('alice');
  assert.equal(state.contactRequests.get(approved.id)?.deliveryStatus, 'outcome_unknown');
  assert.deepEqual(state.items.get(item.id), item);
  assertScheduleUnchanged(before, state);
  const lookup = await get(env.second, `/v1/contact-requests/${approved.id}`);
  assertOk(lookup); assert.equal(lookup.json().data.contactRequest.deliveryStatus, 'outcome_unknown');
  await send(env.second, approved, 'deadline-before-provider', 'alice', 'retry');
  await send(env.second, approved, 'deadline-different-key');
  assert.equal(calls, 0);
});

test('the real Gmail adapter does not fetch after the deadline passes during token acquisition', { skip: !connectionString }, async t => {
  const gmail = delayedGmail();
  const env = await postgres(t, gmail.adapter.dispatch);
  const { approved } = await readyFixture(env);
  const before = await env.store.read('alice');
  const pending = send(env.first, approved, 'deadline-before-fetch');
  try {
    await within(Promise.race([gmail.started.promise, pending.then(response => { throw new Error(`send returned before token acquisition: ${response.statusCode}`); })]), 'token acquisition starts');
    env.setNow('2026-10-31T12:00:31.000Z');
    gmail.token.resolve('synthetic-token');
    const result = await within(pending, 'deadline send result');
    assert.equal(gmail.fetchCalls, 0, 'an expired preflight must not reach Gmail fetch');
    assert.equal(gmail.tokenCalls, 1);
    assertOk(result);
    assert.ok(['failed', 'outcome_unknown'].includes(result.json().data.contactRequest.deliveryStatus), result.body);
    assert.equal(result.json().data.contactRequest.providerOperationId, null);
    assertScheduleUnchanged(before, await env.store.read('alice'));
  } finally {
    gmail.token.resolve('synthetic-token');
    await within(pending.catch(() => undefined), 'deadline send cleanup').catch(() => undefined);
  }
});

test('interrupted submitting remains durable, projects unknown after 30 seconds, and cannot be resent after restart', { skip: !connectionString, timeout: 30000 }, async t => {
  let replayCalls = 0;
  const env = await postgres(t, async () => { replayCalls++; return { status: 'submitted', providerOperationId: 'should-not-run' }; });
  const { approved, item } = await readyFixture(env);
  const source = `
    import pg from 'pg';
    import { buildApp } from ${JSON.stringify(new URL('../src/app.ts', import.meta.url).href)};
    import { PostgresPlanningStore } from ${JSON.stringify(new URL('../src/postgres-store.ts', import.meta.url).href)};
    globalThis.fetch = async () => { throw new Error('Unexpected external fetch'); };
    const pool = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL, options: '-c search_path=' + process.env.PIKKU_DISPATCH_SCHEMA });
    const store = new PostgresPlanningStore(pool);
    const sessions = { async resolve(token) { return token === 'alice' ? { userId: 'alice' } : null; } };
    const gmailContact = { userId: 'alice', senderAddress: 'sender@example.test', async dispatch() {
      process.stdout.write('DISPATCH_STARTED\\n');
      return new Promise(() => {});
    } };
    const app = buildApp({ sessions, store, gmailContact, clock: () => new Date('2026-10-31T12:00:00.000Z') });
    const response = await app.inject({ method: 'POST', url: '/v1/contact-requests/' + process.env.PIKKU_CONTACT_ID + '/send',
      headers: { authorization: 'Bearer alice', 'idempotency-key': 'crashed-send' },
      payload: { requestId: 'crashed-send', contactRevision: Number(process.env.PIKKU_CONTACT_REVISION), expectedSenderAddress: 'sender@example.test' } });
    process.stdout.write('EARLY_RESPONSE ' + response.statusCode + '\\n');
    await app.close(); await pool.end();
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, PIKKU_TEST_DATABASE_URL: connectionString!, PIKKU_DISPATCH_SCHEMA: env.schema,
      PIKKU_CONTACT_ID: approved.id, PIKKU_CONTACT_REVISION: String(approved.revision) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  const started = new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('DISPATCH_STARTED\n')) resolve();
      else if (output.includes('EARLY_RESPONSE')) reject(new Error(output.trim()));
    });
    child.once('error', reject);
    child.once('close', code => reject(new Error(`dispatch subprocess exited before checkpoint (${code})`)));
    child.stderr.resume();
  });
  try {
    await within(started, 'child dispatch checkpoint', 12000);
    assert.equal((await readLockedContact(env.secondPool, approved.id))?.deliveryStatus, 'submitting');
    assert.equal(child.kill('SIGKILL'), true);
    await within(exited, 'child process exit');

    const restartedStore = new PostgresPlanningStore(env.pool());
    const restarted = env.app(restartedStore);
    env.setNow('2026-10-31T12:00:29.000Z');
    const beforeTimeout = await get(restarted, `/v1/contact-requests/${approved.id}`);
    assertOk(beforeTimeout); assert.equal(beforeTimeout.json().data.contactRequest.deliveryStatus, 'submitting');
    env.setNow('2026-10-31T12:00:31.000Z');
    const unknown = await get(restarted, `/v1/contact-requests/${approved.id}`);
    assertOk(unknown); assert.equal(unknown.json().data.contactRequest.deliveryStatus, 'outcome_unknown');
    const list = await get(restarted, `/v1/contact-requests?proposalId=${encodeURIComponent(approved.allowedOptions[0]!.proposalId)}`);
    assertOk(list);
    assert.equal((list.json().data.contactRequests as ContactRequest[]).find(contact => contact.id === approved.id)?.deliveryStatus, 'outcome_unknown');
    assert.equal((await restartedStore.read('alice')).contactRequests.get(approved.id)?.deliveryStatus, 'submitting');
    const same = await send(restarted, approved, 'crashed-send', 'alice', 'retry');
    const different = await send(restarted, approved, 'after-crash');
    assert.ok([200, 409].includes(same.statusCode), same.body);
    assert.ok([200, 409].includes(different.statusCode), different.body);
    assert.equal(replayCalls, 0);
    const state = await restartedStore.read('alice');
    assert.equal(state.contactRequests.get(approved.id)?.deliveryStatus, 'submitting');
    assert.deepEqual(state.items.get(item.id), item);
    assert.equal(state.scheduleRevision, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await within(exited, 'child process cleanup').catch(() => undefined);
  }
});

test('send rejects unapproved, rejected, stale, tampered, and cross-user requests without dispatching', { skip: !connectionString }, async t => {
  let calls = 0;
  const env = await postgres(t, async () => { calls++; return { status: 'submitted', providerOperationId: 'should-not-run' }; });
  const fixture = await readyFixture(env);
  const pending = await draft(env.first, fixture.recipientId, fixture.proposalIds[0]!, 'pending');
  const rejected = await decide(env.first, await draft(env.first, fixture.recipientId, fixture.proposalIds[0]!, 'rejected'), 'reject', 'reject');
  for (const contact of [pending, rejected]) {
    const before = await env.store.read('alice');
    const response = await send(env.first, contact, `send-${contact.deliveryStatus}`);
    assert.equal(response.statusCode, 409, response.body);
    assertScheduleUnchanged(before, await env.store.read('alice'));
  }
  const wrongRevision = await post(env.first, `/v1/contact-requests/${fixture.approved.id}/send`,
    { requestId: 'wrong-revision', contactRevision: fixture.approved.revision + 1, expectedSenderAddress: senderAddress }, 'wrong-revision');
  assert.equal(wrongRevision.statusCode, 409, wrongRevision.body);

  const missingKey = await env.first.inject({ method: 'POST', url: `/v1/contact-requests/${fixture.approved.id}/send`,
    headers: { authorization: 'Bearer alice' }, payload: { requestId: 'missing-key', contactRevision: fixture.approved.revision, expectedSenderAddress: senderAddress } });
  assert.equal(missingKey.statusCode, 400, missingKey.body);
  const override = await post(env.first, `/v1/contact-requests/${fixture.approved.id}/send`,
    { requestId: 'override', contactRevision: fixture.approved.revision, expectedSenderAddress: senderAddress, recipient: 'other@example.test' }, 'override');
  assert.equal(override.statusCode, 400, override.body);

  const pristine = await env.store.read('alice');
  const proposalId = fixture.proposalIds[0]!;
  const mutations: [string, (state: UserPlanningState) => void][] = [
    ['missing approval', state => { state.contactApprovals = []; }],
    ['approval rejected', state => { state.contactApprovals[0]!.approval.decision = 'reject'; }],
    ['approval actor changed', state => { state.contactApprovals[0]!.approval.actorRef = 'bob'; }],
    ['approval subject changed', state => { state.contactApprovals[0]!.subject.messageOrCallBrief = '변조된 내용'; }],
    ['approval proposal changed', state => { state.contactApprovals[0]!.proposals[0]!.reason = '변조된 대안'; }],
    ['request content changed', state => { state.contactRequests.get(fixture.approved.id)!.messageOrCallBrief = '변조된 내용'; }],
    ['request allowed options changed', state => { state.contactRequests.get(fixture.approved.id)!.allowedOptions[0]!.optionId = 'tampered-option'; }],
    ['request approval changed', state => { state.contactRequests.get(fixture.approved.id)!.approvalId = 'tampered-approval'; }],
    ['request execution key changed', state => { state.contactRequests.get(fixture.approved.id)!.executionKey = 'tampered'; }],
    ['request recipient snapshot changed', state => { state.contactRequests.get(fixture.approved.id)!.recipientSnapshot.address = 'other@example.test'; }],
    ['recipient changed', state => { state.recipients.get(fixture.recipientId)!.address = 'other@example.test'; }],
    ['recipient display name changed', state => { state.recipients.get(fixture.recipientId)!.displayName = '변경된 상대'; }],
    ['recipient removed', state => { state.recipients.delete(fixture.recipientId); }],
    ['proposal content changed at same revision', state => { state.proposals.get(proposalId)!.reason = '변경된 이유'; }],
    ['proposal revision changed', state => { state.proposals.get(proposalId)!.revision++; }],
    ['proposal already rejected', state => { state.proposals.get(proposalId)!.status = 'rejected'; }],
    ['proposal removed', state => { state.proposals.delete(proposalId); }],
    ['schedule revision changed', state => { state.scheduleRevision++; }],
    ['context revision changed', state => { state.contextRevision++; }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    await env.store.transaction('alice', state => { Object.assign(state, structuredClone(pristine)); mutate(state); });
    const before = await env.store.read('alice');
    const response = await send(env.first, fixture.approved, `tamper-${index}`);
    assert.ok([403, 404, 409].includes(response.statusCode), `${label}: ${response.statusCode} ${response.body}`);
    assert.equal(calls, 0, label);
    assertScheduleUnchanged(before, await env.store.read('alice'));
  }
  await env.store.transaction('alice', state => { Object.assign(state, structuredClone(pristine)); });
  env.setNow('2026-10-31T12:31:00.000Z');
  const expired = await send(env.first, fixture.approved, 'expired');
  assert.equal(expired.statusCode, 409, expired.body);
  env.setNow(fixedNow);
  const bobApp = env.app(env.otherStore, { ...env.gmailContact, userId: 'bob' });
  const notOwned = await send(bobApp, fixture.approved, 'bob-send', 'bob');
  assert.equal(notOwned.statusCode, 404, notOwned.body);
  const hidden = await get(env.second, `/v1/contact-requests/${fixture.approved.id}`, 'bob');
  assert.equal(hidden.statusCode, 404, hidden.body);
  const list = await get(env.second, '/v1/contact-requests', 'bob');
  assertOk(list); assert.deepEqual(list.json().data.contactRequests, []);
  assert.equal(calls, 0);
  assertScheduleUnchanged(pristine, await env.store.read('alice'));
});

test('contact list filters by proposal, is newest first, caps at 100, and stays user scoped', { skip: !connectionString }, async t => {
  const env = await postgres(t);
  const { approved, proposalIds } = await readyFixture(env);
  const generated: ContactRequest[] = [];
  await env.store.transaction('alice', state => {
    for (let index = 1; index <= 105; index++) {
      const id = `list-${String(index).padStart(3, '0')}`;
      const proposalId = index % 20 === 0 ? proposalIds[1]! : proposalIds[0]!;
      const contact: ContactRequest = { ...structuredClone(approved), id, createdAt: new Date(Date.parse(fixedNow) + index * 1000).toISOString(),
        allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] };
      generated.push(contact); state.contactRequests.set(id, contact);
    }
    for (const id of ['tie-first', 'tie-second', 'tie-third']) {
      const contact: ContactRequest = { ...structuredClone(approved), id, createdAt: new Date(Date.parse(fixedNow) + 7000).toISOString() };
      generated.push(contact); state.contactRequests.set(id, contact);
    }
  });
  const all = await get(env.first, '/v1/contact-requests');
  assertOk(all);
  const expectedAll = [...generated].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  const allIds = (all.json().data.contactRequests as ContactRequest[]).map(contact => contact.id);
  assert.deepEqual(allIds, expectedAll.map(contact => contact.id));
  assert.deepEqual(allIds.slice(-2), ['tie-third', 'tie-second']);
  assert.ok(!allIds.includes('tie-first'));
  const filtered = await get(env.first, `/v1/contact-requests?proposalId=${encodeURIComponent(proposalIds[0]!)}`);
  assertOk(filtered);
  const expectedFiltered = [...generated].reverse().filter(contact => contact.allowedOptions.some(option => option.proposalId === proposalIds[0]))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  assert.deepEqual((filtered.json().data.contactRequests as ContactRequest[]).map(contact => contact.id), expectedFiltered.map(contact => contact.id));
  const otherProposal = await get(env.first, `/v1/contact-requests?proposalId=${encodeURIComponent(proposalIds[1]!)}`);
  assertOk(otherProposal);
  assert.deepEqual((otherProposal.json().data.contactRequests as ContactRequest[]).map(contact => contact.id),
    generated.filter(contact => contact.allowedOptions[0]!.proposalId === proposalIds[1]).reverse().map(contact => contact.id));
  const otherUser = await get(env.second, '/v1/contact-requests', 'bob');
  assertOk(otherUser); assert.deepEqual(otherUser.json().data.contactRequests, []);
});
