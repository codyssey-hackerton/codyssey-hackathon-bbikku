import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const clock = () => new Date('2026-10-31T12:00:00.000Z');
const sessions = { async resolve(token: string) { return token === 'synthetic-session' ? { userId: 'synthetic-user' } : null; } };
const headers = (key: string) => ({ authorization: 'Bearer synthetic-session', 'idempotency-key': key });
const credential = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber: '+12025550123' };
const event: ScheduleFields = { kind: 'event', title: '합성 공동 일정', timeSlot: {
  startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul',
}, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };

test('approved phone request and replay survive PostgreSQL and API reconnection', { skip: !connectionString }, async t => {
  const external = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-pg-'));
  const schema = `pikku_phone_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  const pools: pg.Pool[] = [];
  const apps: ReturnType<typeof buildApp>[] = [];
  let calls = 0; let voiceUrl = '';
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('IncomingPhoneNumbers.json')) {
      assert.equal(init?.method, undefined);
      return Response.json({ incoming_phone_numbers: [{ phone_number: credential.fromNumber, capabilities: { voice: true } }] });
    }
    assert.ok(String(url).endsWith('/Calls.json'));
    assert.equal(init?.method, 'POST');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('From'), credential.fromNumber);
    assert.equal(body.get('To'), '+12025550124');
    const xml = body.get('Twiml') ?? '';
    voiceUrl = xml.match(/<Redirect method="POST">([^<]+)<\/Redirect>/)?.[1]?.replaceAll('&amp;', '&') ?? '';
    assert.ok(voiceUrl.startsWith('https://voice.example.test/v1/voice/twilio/'));
    calls++;
    return Response.json({ sid: `CA${'2'.repeat(32)}` }, { status: 201 });
  };
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const pool of pools) if (!pool.ended) await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
    assert.equal(external.mock.callCount(), 0);
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const open = async () => {
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    pools.push(pool);
    const store = new PostgresPlanningStore(pool);
    await store.migrate();
    const app = buildApp({ sessions, store, clock, phoneConnections: new PhoneConnections({ directory, fetcher }), allowLocalPhoneConnect: true,
      voice: { publicBaseUrl: 'https://voice.example.test', sessionKey: Buffer.alloc(32, 4).toString('base64'),
        model: { async classify() { return { kind: 'unclear' }; } } } });
    apps.push(app);
    return { pool, store, app };
  };
  const post = async (app: ReturnType<typeof buildApp>, url: string, payload: object, key: string) => {
    const response = await app.inject({ method: 'POST', url, headers: headers(key), payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const first = await open();
  const connected = await post(first.app, '/v1/phone-connection', { requestId: 'connect', ...credential }, 'connect');
  assert.deepEqual(connected.data, { status: 'available', senderNumber: credential.fromNumber, lastRequestId: 'connect' });
  assert.ok(!JSON.stringify(connected).includes(credential.authToken));
  const planning = new PlanningService(first.store, clock);
  const item = (await planning.command('synthetic-user', { expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'seed', operation: 'create', after: event },
  ] } })).items[0]!;
  const baseline = await planning.capture('synthetic-user', 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '합성 변경안', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
    after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T10:00+09:00', endsAt: '2026-11-02T11:00+09:00' } },
  }] } });
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') throw new Error('Synthetic proposal fixture failed');
  const recipient = await post(first.app, '/v1/recipients', { requestId: 'recipient', displayName: '합성 상대', channel: 'phone',
    address: '+12025550124', confirmed: true }, 'recipient');
  const draft = await post(first.app, '/v1/contact-requests', { requestId: 'draft', recipientRef: recipient.data.recipient.id,
    channel: 'phone', purpose: '합성 일정 조정', messageOrCallBrief: '합성 안내\n변경 가능 여부를 알려 주세요.',
    allowedOptions: [{ optionId: 'one', proposalId: proposal.proposalIds[0], proposalRevision: 1 }] }, 'draft');
  const contact = draft.data.contactRequest;
  const approval = await post(first.app, `/v1/contact-requests/${contact.id}/decision`, {
    requestId: 'approve', contactRevision: contact.revision, decision: 'accept',
  }, 'approve');
  assert.equal(approval.data.contactRequest.deliveryStatus, 'ready');
  const before = await first.store.read('synthetic-user');
  const payload = { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber };
  const sent = await post(first.app, `/v1/contact-requests/${contact.id}/call`, payload, 'call-key');
  assert.equal(sent.data.contactRequest.deliveryStatus, 'sent_or_connected');
  assert.equal(calls, 1);
  assert.deepEqual((await first.store.read('synthetic-user')).items, before.items);
  await first.app.close();
  await first.pool.end();
  const second = await open();
  const replay = await post(second.app, `/v1/contact-requests/${contact.id}/call`, { ...payload, requestId: 'retry' }, 'call-key');
  assert.deepEqual(replay, sent);
  assert.equal(calls, 1);
  const after = await second.store.read('synthetic-user');
  assert.equal(after.scheduleRevision, before.scheduleRevision);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.items.get(item.id), item);
  assert.equal(after.contactApprovals.length, 1);
});
