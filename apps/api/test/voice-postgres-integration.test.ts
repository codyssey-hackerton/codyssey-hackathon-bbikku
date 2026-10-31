import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import twilio from 'twilio';
import type { ScheduleFields } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import { ContactService } from '../src/contact-service.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const databaseUrl = process.env.PIKKU_TEST_DATABASE_URL;
test('signed voice selection and DTMF confirmation survive API and PostgreSQL pool restart', { skip: !databaseUrl, timeout: 15_000 }, async t => {
  const external = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const directory = await mkdtemp(join(tmpdir(), 'pikku-voice-pg-'));
  const schema = `pikku_voice_${randomUUID().replaceAll('-', '')}`; const admin = new pg.Pool({ connectionString: databaseUrl });
  const pools: pg.Pool[] = []; const apps: ReturnType<typeof buildApp>[] = [];
  const userId = 'synthetic-user'; const origin = 'https://voice.example.test'; const sessionKey = Buffer.alloc(32, 4).toString('base64');
  const credential = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber: '+12025550123' };
  const recipient = '+12025550124'; const callSid = `CA${'2'.repeat(32)}`; const clock = () => new Date('2030-01-01T00:00:00Z');
  const event: ScheduleFields = { kind: 'event', title: '합성 공동 일정', timeSlot: { startsAt: '2030-01-02T10:00:00+09:00',
    endsAt: '2030-01-02T11:00:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null,
    flexibility: 'fixed', involvement: 'shared', completion: 'pending' };
  let firstUrl = ''; let calls = 0; let classifications = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ phone_number: credential.fromNumber, capabilities: { voice: true } }] });
    assert.ok(String(url).endsWith('/Calls.json')); calls++;
    const twiml = new URLSearchParams(String(init?.body)).get('Twiml')!;
    firstUrl = twiml.match(/<Redirect method="POST">([^<]+)<\/Redirect>/)?.[1]?.replaceAll('&amp;', '&') ?? '';
    return Response.json({ sid: callSid }, { status: 201 });
  };
  const connections = new PhoneConnections({ directory, fetcher });
  const model = { async classify() { classifications++; return { kind: 'select' as const, optionId: 'one' }; } };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await connections.connect(userId, credential);
    const open = async () => {
      const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 }); pools.push(pool);
      const store = new PostgresPlanningStore(pool); await store.migrate();
      const app = buildApp({ store, clock, phoneConnections: connections, voice: { publicBaseUrl: origin, sessionKey, model },
        sessions: { resolve: async token => token === 'owner' ? { userId } : null } });
      apps.push(app); return { pool, store, app };
    };
    const first = await open(); const planning = new PlanningService(first.store, clock); const contacts = new ContactService(first.store, planning, clock);
    const item = (await planning.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: event }] } })).items[0]!;
    const baseline = await planning.capture(userId, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
    const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '합성 대안', evidenceRefs: [], changeSet: { changes: [{
      changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
      after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2030-01-02T12:00:00+09:00', endsAt: '2030-01-02T13:00:00+09:00' } },
    }] } });
    assert.equal(proposal.kind, 'proposal'); if (proposal.kind !== 'proposal') throw new Error('fixture');
    const person = (await contacts.createRecipient(userId, { displayName: '합성 상대', channel: 'phone', address: recipient, confirmed: true })).recipient;
    const contact = (await contacts.create(userId, { recipientRef: person.id, channel: 'phone', purpose: '합성 일정', messageOrCallBrief: '승인된 합성 문구',
      allowedOptions: [{ optionId: 'one', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
    await contacts.decide(userId, contact.id, { contactRevision: contact.revision, decision: 'accept' });
    const before = await first.store.read(userId);
    const call = await first.app.inject({ method: 'POST', url: `/v1/contact-requests/${contact.id}/call`,
      headers: { authorization: 'Bearer owner', 'idempotency-key': 'call-key' },
      payload: { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber } });
    assert.equal(call.statusCode, 200); assert.equal(calls, 1); assert.ok(firstUrl.startsWith(`${origin}/v1/voice/twilio/`));
    const token = new URL(firstUrl).pathname.split('/').at(-1)!;
    const callback = async (app: ReturnType<typeof buildApp>, turn: number, extra: Record<string, string> = {}) => {
      const url = `${origin}/v1/voice/twilio/${token}?turn=${turn}&retry=0`;
      const params = { AccountSid: credential.accountSid, CallSid: callSid, From: credential.fromNumber, To: recipient, ...extra };
      return app.inject({ method: 'POST', url: new URL(url).pathname + new URL(url).search,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(credential.authToken, url, params) },
        payload: new URLSearchParams(params).toString() });
    };
    assert.equal((await callback(first.app, 0)).statusCode, 200);
    const selected = await callback(first.app, 1, { SpeechResult: '열두 시 가능합니다.' });
    assert.equal(selected.statusCode, 200); assert.match(selected.body, /수락하시면 1번/);
    assert.deepEqual((await first.store.read(userId)).items, before.items);
    await first.app.close(); await first.pool.end();
    const second = await open();
    const confirmed = await callback(second.app, 2, { Digits: '1' });
    assert.equal(confirmed.statusCode, 200);
    const after = await second.store.read(userId);
    assert.equal(after.items.get(item.id)?.timeSlot?.startsAt, '2030-01-02T12:00:00+09:00');
    assert.equal(after.scheduleRevision, before.scheduleRevision + 1);
    assert.equal(after.contactRequests.get(contact.id)?.negotiationStatus, 'applied');
    assert.equal(after.contactResponses.size, 1);
    const replay = await callback(second.app, 2, { Digits: '1' });
    assert.equal(replay.statusCode, 200); assert.equal(replay.body, confirmed.body);
    assert.equal((await second.store.read(userId)).scheduleRevision, after.scheduleRevision);
    assert.equal(calls, 1); assert.equal(classifications, 1); assert.equal(external.mock.callCount(), 0);
  } finally {
    for (const app of apps) await app.close();
    for (const pool of pools) if (!pool.ended) await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  }
});
