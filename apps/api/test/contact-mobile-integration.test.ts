import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import type { ScheduleFields } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import { createGmailContact } from '../src/gmail-contact.ts';
import { ApiError, createApiClient } from '../../mobile/src/api/http.ts';
import { createContactClient } from '../../mobile/src/contacts/client.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const operation = <I>(input: I) => ({ input, requestId: randomUUID(), idempotencyKey: randomUUID() });

test('real PostgreSQL/HTTP: mobile contact client approves immutable mail and dispatches once through Gmail adapter', { skip: !connectionString }, async t => {
  const schema = `pikku_contact_http_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  t.after(() => pool.end());
  const store = new PostgresPlanningStore(pool); await store.migrate();
  const clock = () => new Date('2026-10-31T12:00:00.000Z');
  const planning = new PlanningService(store, clock);
  const original: ScheduleFields = { kind: 'event', title: '합성 저녁 약속',
    timeSlot: { startsAt: '2026-11-02T18:00:00+09:00', endsAt: '2026-11-02T19:00:00+09:00', timezone: 'Asia/Seoul' },
    durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };
  const { items: [item] } = await planning.command('alice', { expectedScheduleRevision: 0,
    changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: original }] } });
  assert.ok(item);
  const baseline = await planning.capture('alice', 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposed = await planning.saveProposal(baseline, { kind: 'proposal', reason: '공동 일정 대안', evidenceRefs: [],
    changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
      after: { ...original, timeSlot: { ...original.timeSlot!, startsAt: '2026-11-03T18:00:00+09:00', endsAt: '2026-11-03T19:00:00+09:00' } } }] } });
  assert.equal(proposed.kind, 'proposal');
  if (proposed.kind !== 'proposal') throw new Error('Expected proposal fixture');
  const proposalId = proposed.proposalIds[0]!;
  let calls = 0;
  const adapter = createGmailContact({ senderAddress: 'sender@example.test', getAccessToken: async () => 'synthetic-token',
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      const mime = Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString('utf8');
      assert.match(mime, /To: recipient@example\.test\r\n/);
      assert.match(mime, /From: sender@example\.test\r\n/);
      const [head, body] = mime.split('\r\n\r\n');
      const subject = head!.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)?.[1];
      assert.equal(Buffer.from(subject!, 'base64').toString('utf8'), '합성 약속 조정');
      assert.equal(Buffer.from(body!, 'base64').toString('utf8'), '다음 날 같은 시간은 어떠신가요?');
      return Response.json({ id: 'synthetic-provider-message' });
    } });
  const app = buildApp({ store, clock, gmailContact: { userId: 'alice', senderAddress: 'sender@example.test', dispatch: adapter.dispatch },
    sessions: { async resolve(token) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } } });
  t.after(() => app.close());
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const contacts = createContactClient(createApiClient({ baseUrl, getSessionToken: () => 'alice' }));
  assert.deepEqual(await contacts.emailConnection(), { status: 'available', senderAddress: 'sender@example.test' });
  const recipient = await contacts.createRecipient(operation({ displayName: '합성 수신자', channel: 'email' as const, address: 'recipient@example.test', confirmed: true as const }));
  const draft = await contacts.createDraft(operation({ recipientRef: recipient.id, channel: 'email' as const,
    purpose: '합성 약속 조정', messageOrCallBrief: '다음 날 같은 시간은 어떠신가요?', allowedOptions: [{ optionId: 'next-day', proposalId, proposalRevision: 1 }] }));
  await assert.rejects(contacts.send(operation({ id: draft.id, contactRevision: draft.revision, expectedSenderAddress: 'sender@example.test' })),
    (error: unknown) => error instanceof ApiError && error.code === 'conflict');
  const ready = await contacts.decide(operation({ id: draft.id, contactRevision: draft.revision, decision: 'accept' as const }));
  assert.equal(ready.deliveryStatus, 'ready'); assert.equal(calls, 0);
  const send = operation({ id: draft.id, contactRevision: draft.revision, expectedSenderAddress: 'sender@example.test' });
  const sent = await contacts.send(send);
  assert.equal(sent.deliveryStatus, 'sent_or_connected'); assert.equal(sent.negotiationStatus, 'awaiting_response');
  assert.deepEqual(await contacts.send(send), sent);
  await contacts.send(operation(send.input)).catch((error: unknown) => assert.ok(error instanceof ApiError));
  assert.equal(calls, 1, 'even a new request key must never resend an already submitted contact');
  const reentered = createContactClient(createApiClient({ baseUrl, getSessionToken: () => 'alice' }));
  assert.deepEqual(await reentered.list(proposalId), [sent]);
  assert.deepEqual(await reentered.get(sent.id), sent);
  assert.deepEqual((await store.read('alice')).items.get(item.id), item, 'sending is not counterpart acceptance');
  const other = createContactClient(createApiClient({ baseUrl, getSessionToken: () => 'bob' }));
  assert.deepEqual(await other.emailConnection(), { status: 'not_configured', senderAddress: null });
  assert.deepEqual(await other.list(proposalId), []);
  await assert.rejects(other.get(sent.id), (error: unknown) => error instanceof ApiError && error.code === 'not_found');
});
