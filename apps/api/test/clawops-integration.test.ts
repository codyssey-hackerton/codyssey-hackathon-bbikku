import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import { ContactService } from '../src/contact-service.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';

const user = 'claw-synthetic', other = 'other-synthetic';
const credential = { provider: 'clawops' as const, accountId: 'ACsynthetic', apiKey: 'fake-key', signingSecret: 'fake-signing-secret', fromNumber: '+827012340001' };
const recipient = '+821012345678', callId = 'CAabcdef1234567890';
const clock = () => new Date('2030-01-01T00:00:00Z');
const origin = 'https://voice.example.test', sessionKey = Buffer.alloc(32, 4).toString('base64');
const sessions = { async resolve(token: string) { return token === 'synthetic' ? { userId: user } : token === 'other' ? { userId: other } : null; } };
const headers = { authorization: 'Bearer synthetic' };
function storeFixture(): PlanningStore {
  const memory = new MemoryPlanningStore();
  return { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
}
function sign(url: string, params: Record<string, string>): string {
  const payload = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac('sha256', credential.signingSecret).update(payload).digest('base64');
}
const event: ScheduleFields = { kind: 'event', title: '합성 일정', timeSlot: { startsAt: '2030-01-02T10:00:00+09:00', endsAt: '2030-01-02T11:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };

test('ClawOps connection verifies owned number and stores isolated credentials without exposing secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-claw-connect-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.claw-ops.com/v1/accounts/ACsynthetic/numbers');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-key'); assert.equal(init?.redirect, 'error');
    return Response.json({ data: [{ number: '07012340001' }] });
  };
  const connections = new PhoneConnections({ directory, fetcher });
  const app = buildApp({ store: storeFixture(), sessions, phoneConnections: connections, allowLocalPhoneConnect: true });
  t.after(() => app.close());
  const invalid = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers, payload: { requestId: 'missing', ...credential, signingSecret: '' } });
  assert.equal(invalid.statusCode, 400); assert.equal(calls, 0);
  const connected = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers, payload: { requestId: 'connect', ...credential } });
  assert.equal(connected.statusCode, 200); assert.deepEqual(connected.json().data, { status: 'available', provider: 'clawops', senderNumber: credential.fromNumber, lastRequestId: 'connect' });
  assert.doesNotMatch(connected.body, /fake-key|fake-signing-secret|ACsynthetic/);
  const status = await app.inject({ method: 'GET', url: '/v1/phone-connection', headers });
  assert.deepEqual(status.json().data, connected.json().data);
  const otherStatus = await app.inject({ method: 'GET', url: '/v1/phone-connection', headers: { authorization: 'Bearer other' } });
  assert.equal(otherStatus.json().data.status, 'not_configured');
  const unowned = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers, payload: { requestId: 'unowned', ...credential, fromNumber: '+827099999999' } });
  assert.equal(unowned.statusCode, 400); assert.deepEqual((await connections.status(user)), connected.json().data);
  assert.equal(calls, 2);
  const path = join(directory, `${createHash('sha256').update(user).digest('hex')}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8')); delete stored.signingSecret;
  await writeFile(path, JSON.stringify(stored)); await chmod(path, 0o600);
  assert.equal((await connections.status(user)).status, 'not_configured');
});

test('legacy Twilio stays unavailable without its speech classifier', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-legacy-voice-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const fromNumber = '+12025550123';
  const connections = new PhoneConnections({ directory, fetcher: async () => Response.json({ incoming_phone_numbers: [{ phone_number: fromNumber, capabilities: { voice: true } }] }) });
  await connections.connect(user, { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber });
  const app = buildApp({ store: storeFixture(), sessions, phoneConnections: connections, clock, voice: { publicBaseUrl: origin, sessionKey } });
  t.after(() => app.close());
  const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers });
  assert.equal(capabilities.json().data.integrations.phone, 'not_configured');
  const call = await app.inject({ method: 'POST', url: '/v1/contact-requests/unknown/call', headers: { ...headers, 'idempotency-key': 'call' },
    payload: { requestId: 'call', contactRevision: 1, expectedSenderNumber: fromNumber } });
  assert.equal(call.statusCode, 503);
});

test('ClawOps callback verifies original signature and uses two keypad confirmations exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-claw-flow-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let voiceUrl = '', sent = 0;
  let startRequest!: () => void, releaseRequest!: () => void;
  const started = new Promise<void>(resolve => { startRequest = resolve; });
  const released = new Promise<void>(resolve => { releaseRequest = resolve; });
  t.after(() => releaseRequest());
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/numbers')) return Response.json({ data: [{ number: '07012340001' }] });
    if (String(url).endsWith('/calls')) {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.From, '07012340001'); assert.equal(payload.To, '01012345678');
      assert.equal(payload.message, undefined); voiceUrl = payload.Url; sent++;
      startRequest(); await released;
      return Response.json({ callId }, { status: 201 });
    }
    throw new Error('Unexpected network');
  };
  const connections = new PhoneConnections({ directory, fetcher }); await connections.connect(user, credential);
  const store = storeFixture(), planning = new PlanningService(store, clock), contacts = new ContactService(store, planning, clock);
  const created = await planning.command(user, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'event', operation: 'create', after: event }] } });
  const item = created.items[0]!;
  const baseline = await planning.capture(user, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposed = await planning.saveProposal(baseline, { kind: 'proposal', reason: '합성 변경', evidenceRefs: [], changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
    after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2030-01-02T12:00:00+09:00', endsAt: '2030-01-02T13:00:00+09:00' } } }] } });
  assert.equal(proposed.kind, 'proposal'); if (proposed.kind !== 'proposal') return;
  const person = (await contacts.createRecipient(user, { displayName: '합성 상대', channel: 'phone', address: recipient, confirmed: true })).recipient;
  const contact = (await contacts.create(user, { recipientRef: person.id, channel: 'phone', purpose: '합성 조율', messageOrCallBrief: '승인된 안내입니다.',
    allowedOptions: [{ optionId: 'one', proposalId: proposed.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
  await contacts.decide(user, contact.id, { contactRevision: contact.revision, decision: 'accept' });
  // ClawOps does not require a speech classifier; Twilio still does.
  const app = buildApp({ store, sessions, phoneConnections: connections, clock, voice: { publicBaseUrl: origin, sessionKey } });
  t.after(() => app.close());
  const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers });
  assert.equal(capabilities.json().data.integrations.phone, 'available');
  // status() still sees ClawOps, but the connection changes before dispatch reads it.
  const changedProvider = t.mock.method(connections, 'read', async (_id: string) => ({
    accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber: credential.fromNumber,
  }));
  const race = await app.inject({ method: 'POST', url: `/v1/contact-requests/${contact.id}/call`, headers: { ...headers, 'idempotency-key': 'race' },
    payload: { requestId: 'race', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber } });
  assert.equal(race.statusCode, 503); assert.equal(sent, 0);
  assert.equal((await store.read(user)).contactRequests.get(contact.id)?.deliveryStatus, 'ready');
  const appWithClassifier = buildApp({ store, sessions, phoneConnections: connections, clock, voice: { publicBaseUrl: origin, sessionKey,
    model: { async classify() { return { kind: 'unclear' as const }; } } } });
  t.after(() => appWithClassifier.close());
  const switched = await appWithClassifier.inject({ method: 'POST', url: `/v1/contact-requests/${contact.id}/call`, headers: { ...headers, 'idempotency-key': 'switched' },
    payload: { requestId: 'switched', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber } });
  assert.equal(switched.statusCode, 503); assert.equal(sent, 0);
  changedProvider.mock.restore();
  const initialParams = { AccountId: credential.accountId, CallId: callId, From: '07012340001', To: '01012345678', Direction: 'outbound', CallStatus: 'in-progress' };
  async function callback(url: string, params: Record<string, string>, signature = sign(url, params)) {
    const target = new URL(url);
    return app.inject({ method: 'POST', url: target.pathname + target.search, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-signature': signature },
      payload: new URLSearchParams(params).toString() });
  }
  const pendingCall = app.inject({ method: 'POST', url: `/v1/contact-requests/${contact.id}/call`, headers: { ...headers, 'idempotency-key': 'once' },
    payload: { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber } });
  await started; assert.equal(sent, 1); assert.match(voiceUrl, /\/v1\/voice\/clawops\//);
  const early = await callback(voiceUrl, initialParams);
  assert.equal(early.statusCode, 200); assert.match(early.body, /<Redirect>/); assert.doesNotMatch(early.body, /<Gather/);
  const retryUrl = early.body.match(/<Redirect>([^<]+)<\/Redirect>/)?.[1]?.replaceAll('&amp;', '&'); assert.ok(retryUrl);
  releaseRequest();
  const call = await pendingCall; assert.equal(call.statusCode, 200);
  const before = await store.read(user);
  assert.equal((await callback(voiceUrl, initialParams, 'invalid')).statusCode, 403);
  const missing = { ...initialParams }; delete (missing as Partial<typeof missing>).AccountId;
  assert.equal((await callback(voiceUrl, missing)).statusCode, 403);
  assert.equal((await callback(voiceUrl, { ...initialParams, AccountId: 'wrong' })).statusCode, 403);
  assert.equal((await callback(voiceUrl, { ...initialParams, CallStatus: 'completed' })).statusCode, 403);
  assert.equal((await callback(voiceUrl, { ...initialParams, Direction: 'inbound' })).statusCode, 403);
  assert.equal((await callback(voiceUrl, { ...initialParams, From: '07012340002' })).statusCode, 403);
  assert.equal((await callback(voiceUrl, { ...initialParams, To: '01099999999' })).statusCode, 403);
  const retryParams = { CallId: callId, From: '07012340001', To: '01012345678', Direction: 'outbound' };
  assert.equal((await callback(retryUrl, { ...retryParams, CallId: 'foreign' })).statusCode, 403);
  assert.equal((await callback(retryUrl, { ...retryParams, AccountId: 'wrong' })).statusCode, 403);
  assert.equal((await callback(retryUrl, retryParams, 'forged')).statusCode, 403);
  const intro = await callback(retryUrl, retryParams);
  assert.equal(intro.statusCode, 200); assert.match(String(intro.headers['content-type']), /application\/xml/);
  assert.match(intro.body, /인공지능 대리 통화/); assert.match(intro.body, /<Gather/); assert.match(intro.body, /<Hangup\/>/);
  assert.doesNotMatch(intro.body, /말씀해|speech|actionOnEmptyResult|Google\.ko-KR/);
  assert.ok(intro.body.indexOf('해당 번호를 눌러 주세요') < intro.body.indexOf('<Gather'));
  assert.match(intro.body, /<Gather\b[^>]*\/>/);
  const next = intro.body.match(/<Gather action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&'); assert.ok(next);
  const action = { CallId: callId, From: '07012340001', To: '01012345678', Direction: 'outbound', Digits: '1' };
  assert.equal((await callback(next, { ...action, AccountId: 'wrong' })).statusCode, 403);
  assert.equal((await callback(next, { ...action, CallId: 'CAwrong' })).statusCode, 403);
  assert.equal((await callback(next, { ...action, CallStatus: 'completed' })).statusCode, 403);
  assert.equal((await callback(next, { ...action, SpeechResult: '예' })).statusCode, 403);
  const selected = await callback(next, action);
  assert.equal(selected.statusCode, 200); assert.match(selected.body, /수락하시면 1번/);
  assert.ok(selected.body.indexOf('수락하시면 1번') < selected.body.indexOf('<Gather'));
  assert.match(selected.body, /<Gather\b[^>]*\/>/);
  assert.equal((await callback(next, { ...action, Digits: '0' })).statusCode, 403);
  assert.equal((await store.read(user)).scheduleRevision, before.scheduleRevision);
  const confirmUrl = selected.body.match(/<Gather action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&'); assert.ok(confirmUrl);
  const originalRead = connections.read.bind(connections); let reads = 0;
  const changedCredential = t.mock.method(connections, 'read', async (id: string) => ++reads === 1 ? originalRead(id) : { ...credential, signingSecret: 'changed-secret' });
  assert.equal((await callback(confirmUrl, action)).statusCode, 403);
  assert.equal((await store.read(user)).scheduleRevision, before.scheduleRevision);
  changedCredential.mock.restore();
  const confirmed = await callback(confirmUrl, action);
  assert.equal(confirmed.statusCode, 200); assert.equal((await store.read(user)).contactRequests.get(contact.id)?.negotiationStatus, 'applied');
  assert.equal((await store.read(user)).scheduleRevision, before.scheduleRevision + 1);
  assert.equal((await callback(confirmUrl, action)).body, confirmed.body);
  assert.equal((await store.read(user)).scheduleRevision, before.scheduleRevision + 1); assert.equal(sent, 1);
});
