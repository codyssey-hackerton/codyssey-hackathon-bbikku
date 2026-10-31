import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { ContactService } from '../src/contact-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const userId = 'local-developer'; const sender = 'sender@example.test'; const recipient = 'recipient@example.test';
const now = '2026-10-31T12:00:00Z';
const event: ScheduleFields = { kind: 'event', title: '합성 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00',
  endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };

async function fixture(t: TestContext, lookup: () => Promise<{ events: ReturnType<typeof replyEvent>[]; unmatchedCount: number }>, existingStore?: PlanningStore) {
  const guard = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = existingStore ?? { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const clock = () => new Date(now); const planning = new PlanningService(store, clock); const contacts = new ContactService(store, planning, clock);
  const item = (await planning.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: event }] } })).items[0]!;
  const baseline = await planning.capture(userId, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '합성 대안', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
    after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T10:00+09:00', endsAt: '2026-11-02T11:00+09:00' } },
  }] } });
  assert.equal(proposal.kind, 'proposal'); if (proposal.kind !== 'proposal') throw new Error('fixture');
  const target = (await contacts.createRecipient(userId, { displayName: '상대', channel: 'email', address: recipient, confirmed: true })).recipient;
  const draft = (await contacts.create(userId, { recipientRef: target.id, channel: 'email', purpose: '합성 확인', messageOrCallBrief: '가능한 시간을 알려주세요.',
    allowedOptions: [{ optionId: 'option-1', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
  await contacts.decide(userId, draft.id, { contactRevision: draft.revision, decision: 'accept' });
  const dispatch = new ContactDispatch(store, planning, { userId, senderAddress: sender,
    async dispatch(_payload, _signal, beforeSend) { await beforeSend?.(); return { status: 'submitted', providerOperationId: 'sent-message' }; } }, clock);
  assert.equal((await dispatch.send(userId, draft.id, { requestId: 'send', contactRevision: draft.revision, expectedSenderAddress: sender }, 'send')).status, 200);
  const app = buildApp({ store, clock, sessions: { resolve: async token => token === 'owner' ? { userId } : token === 'other' ? { userId: 'other' } : null },
    gmailReplyConnection: { userId, senderAddress: sender, checkReplies: async input => {
      assert.deepEqual(input, { providerOperationId: 'sent-message', recipientAddress: recipient, expectedSenderAddress: sender });
      return lookup();
    } } });
  t.after(async () => { await app.close(); assert.equal(guard.mock.callCount(), 0); });
  const request = (url: string, payload: object, key: string, token = 'owner') => app.inject({ method: 'POST', url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload });
  return { app, store, draft, item, request };
}

function replyEvent(providerEventId = 'reply-1') {
  return { providerEventId, providerOperationId: 'sent-message', channel: 'email' as const, recipientAddress: recipient, receivedAt: now,
    outcome: 'unclear' as const, selectedOptionId: null, evidenceRef: providerEventId, displayText: '그 시간 가능합니다.', reviewReason: 'sender_unverified' };
}

test('reply lookup is retryable without effects, and explicit confirmation applies once', async t => {
  let lookups = 0;
  const f = await fixture(t, async () => { if (++lookups === 1) throw new Error('synthetic provider failure'); return { events: [replyEvent()], unmatchedCount: 1 }; });
  const path = `/v1/contact-requests/${f.draft.id}`; const payload = { requestId: 'check', contactRevision: f.draft.revision };
  assert.equal((await f.app.inject({ method: 'GET', url: `${path}/responses` })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'GET', url: `${path}/responses`, headers: { authorization: 'Bearer other' } })).statusCode, 404);
  const settings = await f.app.inject({ method: 'GET', url: '/v1/email-reply-connection', headers: { authorization: 'Bearer owner' } });
  assert.deepEqual(settings.json().data, { status: 'available', senderAddress: sender });
  const failed = await f.request(`${path}/check-replies`, payload, 'check-key');
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.retryable, true);
  assert.equal((await f.store.read(userId)).contactResponses.size, 0);
  const checked = await f.request(`${path}/check-replies`, payload, 'check-key');
  assert.equal(checked.statusCode, 200); assert.equal(checked.json().data.unmatchedCount, 1);
  assert.equal(checked.json().data.checkedCount, 1); assert.equal(checked.json().data.contactRequest.negotiationStatus, 'needs_user_review');
  assert.deepEqual((await f.store.read(userId)).items.get(f.item.id), f.item);
  assert.deepEqual((await f.request(`${path}/check-replies`, payload, 'check-key')).json(), checked.json());
  assert.equal(lookups, 2);
  const responseId = checked.json().data.responses[0].id;
  const confirm = { requestId: 'confirm', contactRevision: f.draft.revision, selectedOptionId: 'option-1' };
  assert.equal((await f.request(`${path}/responses/not-stored/confirm`, confirm, 'bad-confirm')).statusCode, 404);
  const applied = await f.request(`${path}/responses/${responseId}/confirm`, confirm, 'confirm-key');
  assert.equal(applied.statusCode, 200); assert.equal(applied.json().data.changed, true);
  assert.equal((await f.store.read(userId)).items.get(f.item.id)?.timeSlot?.startsAt, '2026-11-02T10:00+09:00');
  assert.deepEqual((await f.request(`${path}/responses/${responseId}/confirm`, confirm, 'confirm-key')).json(), applied.json());
});

test('lookup result is rejected if the contact changed while the external read was pending', async t => {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async () => { entered(); await gate; return { events: [replyEvent()], unmatchedCount: 0 }; });
  const pending = f.request(`/v1/contact-requests/${f.draft.id}/check-replies`, { requestId: 'check', contactRevision: f.draft.revision }, 'check');
  try {
    await started;
    await f.store.transaction(userId, state => { const contact = state.contactRequests.get(f.draft.id)!; contact.negotiationStatus = 'declined'; });
  } finally { release(); }
  assert.equal((await pending).statusCode, 409);
  assert.equal((await f.store.read(userId)).contactResponses.size, 0);
});

test('a mismatched event rolls back the entire reply batch', async t => {
  const f = await fixture(t, async () => ({ events: [replyEvent(), { ...replyEvent('reply-2'), providerOperationId: 'wrong' }], unmatchedCount: 0 }));
  const result = await f.request(`/v1/contact-requests/${f.draft.id}/check-replies`, { requestId: 'check', contactRevision: f.draft.revision }, 'check');
  assert.equal(result.statusCode, 409);
  const state = await f.store.read(userId);
  assert.equal(state.contactResponses.size, 0);
  assert.equal(state.contactRequests.get(f.draft.id)?.negotiationStatus, 'awaiting_response');
});

test('reply confirmation and idempotent replay survive PostgreSQL store restart', { skip: !process.env.PIKKU_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
  const schema = `pikku_replies_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools: pg.Pool[] = []; let firstApp: ReturnType<typeof buildApp> | undefined; let secondApp: ReturnType<typeof buildApp> | undefined;
  try {
    const open = async () => {
      const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 }); pools.push(pool);
      const store = new PostgresPlanningStore(pool); await store.migrate(); return store;
    };
    const store = await open();
    const f = await fixture(t, async () => ({ events: [replyEvent()], unmatchedCount: 0 }), store); firstApp = f.app;
    const path = `/v1/contact-requests/${f.draft.id}`;
    const checked = await f.request(`${path}/check-replies`, { requestId: 'check', contactRevision: f.draft.revision }, 'check-key');
    assert.equal(checked.statusCode, 200);
    const responseId = checked.json().data.responses[0].id;
    const body = { requestId: 'confirm', contactRevision: f.draft.revision, selectedOptionId: 'option-1' };
    const applied = await f.request(`${path}/responses/${responseId}/confirm`, body, 'confirm-key');
    assert.equal(applied.statusCode, 200); assert.equal(applied.json().data.changed, true);
    await firstApp.close(); await pools[0]!.end();
    const restarted = await open();
    secondApp = buildApp({ store: restarted, clock: () => new Date(now), sessions: { resolve: async () => ({ userId }) } });
    const replay = await secondApp.inject({ method: 'POST', url: `${path}/responses/${responseId}/confirm`,
      headers: { authorization: 'Bearer owner', 'idempotency-key': 'confirm-key' }, payload: body });
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), applied.json());
    const response = await secondApp.inject({ method: 'GET', url: `${path}/responses`, headers: { authorization: 'Bearer owner' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().data.responses[0].displayText, '그 시간 가능합니다.');
    const after = await restarted.read(userId);
    assert.equal(after.items.get(f.item.id)?.timeSlot?.startsAt, '2026-11-02T10:00+09:00');
    assert.equal(after.contactResponses.size, 1);
  } finally {
    await firstApp?.close(); await secondApp?.close();
    for (const pool of pools) if (!pool.ended) await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});
