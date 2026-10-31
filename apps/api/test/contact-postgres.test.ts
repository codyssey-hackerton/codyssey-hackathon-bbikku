import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const now = '2026-10-31T12:00:00.000Z';
const clock = () => new Date(now);
const sessions = { async resolve(token: string) { return token === 'test' ? { userId: 'contact-test' } : null; } };
const headers = (key: string) => ({ authorization: 'Bearer test', 'idempotency-key': key });
const recipientInput = { requestId: 'recipient', displayName: '테스트 상대', channel: 'email', address: 'contact@example.test', confirmed: true };
const event = { kind: 'event' as const, title: '공동 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed' as const, involvement: 'shared' as const, completion: 'pending' as const };
const legacy = { format: 1, scheduleRevision: 0, contextRevision: 0, items: [], facts: [], proposals: [], proposalFacts: [], approvals: [],
  conversations: [], idempotency: [], reviewSchedule: null, reviewLedger: [] };

async function createSchema() {
  const schema = `pikku_contact_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  return schema;
}
function poolFor(schema: string) { return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 }); }
function assertOk(response: { statusCode: number; body: string }) { assert.equal(response.statusCode, 200, response.body); }

async function seedProposal(store: PostgresPlanningStore) {
  const planning = new PlanningService(store, clock);
  const created = await planning.command('contact-test', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: event }] } });
  const item = created.items[0]!;
  const baseline = await planning.capture('contact-test', 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const result = await planning.saveProposal(baseline, { kind: 'proposal', reason: '대안', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
    after: { ...event, timeSlot: { ...event.timeSlot, startsAt: '2026-11-02T10:00+09:00', endsAt: '2026-11-02T11:00+09:00' } },
  }] } });
  assert.equal(result.kind, 'proposal');
  if (result.kind !== 'proposal') throw new Error('Proposal fixture failed');
  return { item, proposalId: result.proposalIds[0]! };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
async function seedClaim(store: PostgresPlanningStore, operation: string, key: string, body: { requestId: string }, params: object, leaseUntil: string) {
  const { requestId: _requestId, ...payload } = body;
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ body: payload, params }))).digest('hex');
  await store.transaction('contact-test', state => state.idempotency.set(JSON.stringify([operation, key]), {
    fingerprint, operationId: randomUUID(), state: 'running', token: randomUUID(), leaseUntil,
  }));
}

test('contact state and immutable approvals survive PostgreSQL restart and older rows remain readable', { skip: !connectionString }, async () => {
  const schema = await createSchema();
  const pool1 = poolFor(schema); let pool2: pg.Pool | undefined; let pool3: pg.Pool | undefined;
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined; let app3: ReturnType<typeof buildApp> | undefined;
  try {
    const store1 = new PostgresPlanningStore(pool1); await store1.migrate();
    await pool1.query('INSERT INTO pikku_user_state_v1(user_id, schema_version, state) VALUES ($1, 1, $2::jsonb)', ['legacy', JSON.stringify(legacy)]);
    const old = await store1.read('legacy');
    assert.equal(old.recipients.size, 0); assert.equal(old.contactRequests.size, 0); assert.deepEqual(old.contactApprovals, []);
    await store1.transaction('legacy', state => { state.contextRevision = 1; });
    assert.equal((await store1.read('legacy')).contextRevision, 1);
    const legacyRow = await pool1.query('SELECT state FROM pikku_user_state_v1 WHERE user_id = $1', ['legacy']);
    assert.equal('recipients' in legacyRow.rows[0].state, false);
    assert.equal('contactRequests' in legacyRow.rows[0].state, false);
    assert.equal('contactDraftSnapshots' in legacyRow.rows[0].state, false);
    assert.equal('contactApprovals' in legacyRow.rows[0].state, false);
    const { item, proposalId } = await seedProposal(store1);
    app1 = buildApp({ sessions, store: store1, clock });
    const recipient = await app1.inject({ method: 'POST', url: '/v1/recipients', headers: headers('recipient'), payload: recipientInput });
    assertOk(recipient);
    const body = { requestId: 'contact', recipientRef: recipient.json().data.recipient.id, channel: 'email', purpose: '일정 조정', messageOrCallBrief: '가능한 시간을 알려주세요.',
      allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] };
    const draft = await app1.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('contact'), payload: body });
    assertOk(draft);
    const saved = draft.json().data.contactRequest; const before = await store1.read('contact-test');
    await app1.close(); app1 = undefined; await pool1.end();

    pool2 = poolFor(schema); const store2 = new PostgresPlanningStore(pool2); await store2.migrate();
    app2 = buildApp({ sessions, store: store2, clock });
    const get = await app2.inject({ method: 'GET', url: `/v1/contact-requests/${saved.id}`, headers: headers('unused') });
    assert.deepEqual(get.json().data.contactRequest, saved);
    const replayDraft = await app2.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('contact'), payload: { ...body, requestId: 'retry' } });
    assert.deepEqual(replayDraft.json(), draft.json());
    const decisionBody = { requestId: 'accept', contactRevision: saved.revision, decision: 'accept' };
    const decision = await app2.inject({ method: 'POST', url: `/v1/contact-requests/${saved.id}/decision`, headers: headers('accept'), payload: decisionBody });
    assertOk(decision); assert.equal(decision.json().data.contactRequest.deliveryStatus, 'ready');
    const state = await store2.read('contact-test');
    assert.equal(state.contactApprovals.length, 1);
    assert.deepEqual(state.contactApprovals[0]!.subject, saved);
    assert.equal(state.contactApprovals[0]!.proposals[0]!.id, proposalId);
    assert.equal(state.scheduleRevision, before.scheduleRevision);
    assert.deepEqual(state.items.get(item.id), item);
    await app2.close(); app2 = undefined; await pool2.end();

    pool3 = poolFor(schema); const store3 = new PostgresPlanningStore(pool3); await store3.migrate();
    app3 = buildApp({ sessions, store: store3, clock });
    const replay = await app3.inject({ method: 'POST', url: `/v1/contact-requests/${saved.id}/decision`, headers: headers('accept'), payload: { ...decisionBody, requestId: 'retry' } });
    assert.deepEqual(replay.json(), decision.json());
    const restored = await store3.read('contact-test');
    assert.equal(restored.contactApprovals.length, 1);
    assert.equal(restored.contactRequests.get(saved.id)?.executionKey, saved.executionKey);
    assert.deepEqual(restored.items.get(item.id), item);
  } finally {
    if (app1) await app1.close(); if (app2) await app2.close(); if (app3) await app3.close();
    if (!pool1.ended) await pool1.end(); if (pool2 && !pool2.ended) await pool2.end(); if (pool3 && !pool3.ended) await pool3.end();
  }
});

test('rejecting an expired and stale contact persists its original snapshot and replays after restart', { skip: !connectionString }, async () => {
  const schema = await createSchema(); const pool1 = poolFor(schema); let pool2: pg.Pool | undefined;
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined;
  let current = now;
  try {
    const store1 = new PostgresPlanningStore(pool1); await store1.migrate();
    const { item, proposalId } = await seedProposal(store1);
    app1 = buildApp({ sessions, store: store1, clock: () => new Date(current) });
    const recipient = await app1.inject({ method: 'POST', url: '/v1/recipients', headers: headers('recipient'), payload: recipientInput });
    assertOk(recipient);
    const recipientId = recipient.json().data.recipient.id as string;
    const draftBody = { requestId: 'contact', recipientRef: recipientId, channel: 'email', purpose: '일정 조정', messageOrCallBrief: '시간을 확인해 주세요.',
      allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] };
    const draft = await app1.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('contact'), payload: draftBody });
    assertOk(draft);
    const saved = draft.json().data.contactRequest;
    const originalProposals = (await store1.read('contact-test')).contactDraftSnapshots.get(saved.id)!.proposals;
    current = '2026-10-31T13:00:00.000Z';
    await store1.transaction('contact-test', state => {
      state.recipients.get(recipientId)!.address = 'changed@example.test';
      state.contextRevision += 1;
      state.proposals.delete(proposalId);
    });
    const url = `/v1/contact-requests/${saved.id}/decision`;
    const body = { requestId: 'reject', contactRevision: saved.revision, decision: 'reject' };
    const response = await app1.inject({ method: 'POST', url, headers: headers('reject'), payload: body });
    assertOk(response);
    assert.equal(response.json().data.contactRequest.deliveryStatus, 'rejected');
    const beforeRestart = await store1.read('contact-test');
    assert.deepEqual(beforeRestart.items.get(item.id), item);
    assert.equal(beforeRestart.contactApprovals.length, 1);
    assert.deepEqual(beforeRestart.contactApprovals[0]!.subject, saved);
    assert.deepEqual(beforeRestart.contactApprovals[0]!.proposals, originalProposals);
    await app1.close(); app1 = undefined; await pool1.end();

    pool2 = poolFor(schema); const store2 = new PostgresPlanningStore(pool2); await store2.migrate();
    app2 = buildApp({ sessions, store: store2, clock: () => new Date(current) });
    const replay = await app2.inject({ method: 'POST', url, headers: headers('reject'), payload: { ...body, requestId: 'retry' } });
    assert.deepEqual(replay.json(), response.json());
    const restored = await store2.read('contact-test');
    assert.equal(restored.contactRequests.get(saved.id)?.deliveryStatus, 'rejected');
    assert.equal(restored.contactApprovals.length, 1);
    assert.deepEqual(restored.contactApprovals[0]!.proposals, originalProposals);
    assert.deepEqual(restored.items.get(item.id), item);
  } finally {
    if (app1) await app1.close(); if (app2) await app2.close();
    if (!pool1.ended) await pool1.end(); if (pool2 && !pool2.ended) await pool2.end();
  }
});

test('expired claims recover for all contact writes, while active claims remain busy', { skip: !connectionString }, async () => {
  const schema = await createSchema(); const pool = poolFor(schema); const store = new PostgresPlanningStore(pool);
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    await store.migrate(); const { item, proposalId } = await seedProposal(store);
    app = buildApp({ sessions, store, clock });
    await seedClaim(store, 'recipient_create', 'recover-recipient', recipientInput, {}, '2026-10-31T11:59:00.000Z');
    const recipient = await app.inject({ method: 'POST', url: '/v1/recipients', headers: headers('recover-recipient'), payload: recipientInput });
    assertOk(recipient);
    const contactBody = { requestId: 'contact', recipientRef: recipient.json().data.recipient.id, channel: 'email', purpose: '일정 조정', messageOrCallBrief: '시간을 확인해 주세요.',
      allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] };
    await seedClaim(store, 'contact_request_create', 'recover-contact', contactBody, {}, '2026-10-31T11:59:00.000Z');
    const draft = await app.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('recover-contact'), payload: contactBody });
    assertOk(draft); const id = draft.json().data.contactRequest.id as string;
    const decisionBody = { requestId: 'decision', contactRevision: 1, decision: 'accept' };
    await seedClaim(store, 'contact_decision', 'recover-decision', decisionBody, { id }, '2026-10-31T12:10:00.000Z');
    const busy = await app.inject({ method: 'POST', url: `/v1/contact-requests/${id}/decision`, headers: headers('recover-decision'), payload: decisionBody });
    assert.equal(busy.statusCode, 409); assert.equal(busy.json().error.code, 'operation_in_progress');
    await store.transaction('contact-test', state => { state.idempotency.get(JSON.stringify(['contact_decision', 'recover-decision']))!.leaseUntil = '2026-10-31T11:59:00.000Z'; });
    const decision = await app.inject({ method: 'POST', url: `/v1/contact-requests/${id}/decision`, headers: headers('recover-decision'), payload: decisionBody });
    assertOk(decision); assert.equal(decision.json().data.contactRequest.deliveryStatus, 'ready');
    const state = await store.read('contact-test');
    assert.equal(state.recipients.size, 1); assert.equal(state.contactRequests.size, 1); assert.equal(state.contactApprovals.length, 1);
    assert.deepEqual(state.items.get(item.id), item);
    for (const [operation, key] of [['recipient_create', 'recover-recipient'], ['contact_request_create', 'recover-contact'], ['contact_decision', 'recover-decision']]) {
      assert.equal(state.idempotency.get(JSON.stringify([operation, key]))?.state, 'completed');
    }
  } finally { if (app) await app.close(); await pool.end(); }
});

test('concurrent contact approvals serialize across API instances without duplicate approvals or schedule writes', { skip: !connectionString }, async () => {
  const schema = await createSchema(); const pool = poolFor(schema);
  const firstStore = new PostgresPlanningStore(pool); const secondStore = new PostgresPlanningStore(pool);
  let firstApp: ReturnType<typeof buildApp> | undefined; let secondApp: ReturnType<typeof buildApp> | undefined;
  try {
    await firstStore.migrate(); const { item, proposalId } = await seedProposal(firstStore);
    firstApp = buildApp({ sessions, store: firstStore, clock }); secondApp = buildApp({ sessions, store: secondStore, clock });
    const recipient = await firstApp.inject({ method: 'POST', url: '/v1/recipients', headers: headers('recipient'), payload: recipientInput });
    assertOk(recipient);
    const body = { requestId: 'draft', recipientRef: recipient.json().data.recipient.id, channel: 'email', purpose: '일정 조정', messageOrCallBrief: '시간을 확인해 주세요.',
      allowedOptions: [{ optionId: 'one', proposalId, proposalRevision: 1 }] };
    const draft = await firstApp.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('draft'), payload: body });
    assertOk(draft); const id = draft.json().data.contactRequest.id as string;
    const payload = { requestId: 'decision', contactRevision: 1, decision: 'accept' };
    const decisions = await Promise.all([
      firstApp.inject({ method: 'POST', url: `/v1/contact-requests/${id}/decision`, headers: headers('decision-a'), payload }),
      secondApp.inject({ method: 'POST', url: `/v1/contact-requests/${id}/decision`, headers: headers('decision-b'), payload }),
    ]);
    assert.deepEqual(decisions.map(response => response.statusCode).sort(), [200, 409]);
    assert.equal((await firstStore.read('contact-test')).contactApprovals.length, 1);

    const secondDraft = await firstApp.inject({ method: 'POST', url: '/v1/contact-requests', headers: headers('draft-2'), payload: { ...body, requestId: 'draft-2' } });
    assertOk(secondDraft); const nextId = secondDraft.json().data.contactRequest.id as string;
    const sameKey = await Promise.all([
      firstApp.inject({ method: 'POST', url: `/v1/contact-requests/${nextId}/decision`, headers: headers('same-key'), payload }),
      secondApp.inject({ method: 'POST', url: `/v1/contact-requests/${nextId}/decision`, headers: headers('same-key'), payload }),
    ]);
    const accepted = sameKey.find(response => response.statusCode === 200);
    assert.ok(accepted);
    for (const response of sameKey) {
      if (response.statusCode === 409) assert.equal(response.json().error.code, 'operation_in_progress');
      else assert.deepEqual(response.json(), accepted.json());
    }
    const replay = await secondApp.inject({ method: 'POST', url: `/v1/contact-requests/${nextId}/decision`, headers: headers('same-key'), payload });
    assert.deepEqual(replay.json(), accepted.json());
    const state = await secondStore.read('contact-test');
    assert.equal(state.contactApprovals.length, 2);
    assert.equal(state.contactRequests.get(id)?.deliveryStatus, 'ready');
    assert.equal(state.contactRequests.get(nextId)?.deliveryStatus, 'ready');
    assert.deepEqual(state.items.get(item.id), item);
    assert.equal(state.scheduleRevision, 1);
  } finally { if (firstApp) await firstApp.close(); if (secondApp) await secondApp.close(); await pool.end(); }
});

test('a failed final transaction rolls back the contact write and records a replayable failure', { skip: !connectionString }, async () => {
  const schema = await createSchema(); const pool = poolFor(schema);
  const identity = JSON.stringify(['recipient_create', 'failure']);
  class FailFinalStore extends PostgresPlanningStore {
    private fail = true;
    override async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
      return super.atomic(userId, async () => {
        const result = await run(); const state = await this.read(userId);
        if (this.fail && state.recipients.size > 0 && state.idempotency.get(identity)?.state === 'completed') {
          this.fail = false; throw new Error('Simulated rollback before commit');
        }
        return result;
      });
    }
  }
  const store = new FailFinalStore(pool); let app: ReturnType<typeof buildApp> | undefined;
  try {
    await store.migrate(); app = buildApp({ sessions, store, clock });
    const first = await app.inject({ method: 'POST', url: '/v1/recipients', headers: headers('failure'), payload: recipientInput });
    assert.equal(first.statusCode, 500);
    const state = await store.read('contact-test');
    assert.equal(state.recipients.size, 0);
    assert.equal(state.idempotency.get(identity)?.state, 'completed');
    const replay = await app.inject({ method: 'POST', url: '/v1/recipients', headers: headers('failure'), payload: recipientInput });
    assert.deepEqual(replay.json(), first.json());
    assert.equal((await store.read('contact-test')).recipients.size, 0);
  } finally { if (app) await app.close(); await pool.end(); }
});
