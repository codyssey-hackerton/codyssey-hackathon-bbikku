import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import twilio from 'twilio';
import { buildApp } from '../src/app.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { VoiceTokens } from '../src/voice-token.ts';

function durableMemory(): PlanningStore {
  const memory = new MemoryPlanningStore();
  return { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
}
const userId = 'voice-user'; const contactId = 'voice-contact';
const accountSid = `AC${'1'.repeat(32)}`; const authToken = 'a'.repeat(32); const callSid = `CA${'2'.repeat(32)}`;
const fromNumber = '+12025550123'; const toNumber = '+12025550124'; const origin = 'https://voice.example.test';
const sessionKey = Buffer.alloc(32, 3).toString('base64'); const clock = () => new Date('2026-10-31T12:00:00Z');
const model = { classify: async () => ({ kind: 'unclear' as const }) };

test('voice is not configured without an HTTPS origin, key, model and durable store', async () => {
  const app = buildApp({ store: durableMemory(), sessions: { resolve: async () => ({ userId }) } });
  try {
    const result = await app.inject({ method: 'POST', url: `/v1/contact-requests/${contactId}/call`,
      headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'call' },
      payload: { requestId: 'call', contactRevision: 1, expectedSenderNumber: fromNumber } });
    assert.equal(result.statusCode, 503); assert.equal(result.json().error.code, 'not_configured');
    const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: 'Bearer synthetic' } });
    assert.equal(capabilities.json().data.integrations.phone, 'not_configured');
  } finally { await app.close(); }
});

test('only signed, bound Twilio POSTs bypass user session auth and exact form/query are verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-voice-route-'));
  const connections = new PhoneConnections({ directory: dir, fetcher: async () => Response.json({
    incoming_phone_numbers: [{ phone_number: fromNumber, capabilities: { voice: true } }],
  }) });
  await connections.connect(userId, { accountSid, authToken, fromNumber });
  const store = durableMemory();
  await store.transaction(userId, state => {
    state.contactRequests.set(contactId, { id: contactId, channel: 'phone', recipientSnapshot: { address: toNumber },
      deliveryStatus: 'submitting', providerOperationId: null } as never);
  });
  const app = buildApp({ store, phoneConnections: connections, clock, voice: { publicBaseUrl: origin, sessionKey, model } });
  try {
    const token = new VoiceTokens(origin, sessionKey).issue(userId, contactId, clock());
    const path = `/v1/voice/twilio/${token}`; const query = '?turn=0&retry=0';
    const params = { AccountSid: accountSid, CallSid: callSid, From: fromNumber, To: toNumber, Extra: ['one', 'two'] };
    const signature = twilio.getExpectedTwilioSignature(authToken, `${origin}${path}${query}`, params);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
    const send = (url: string, signed: string, payload: string) => app.inject({ method: 'POST', url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signed,
        'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' }, payload });
    const verified = await send(path + query, signature, body.toString());
    assert.equal(verified.statusCode, 200); assert.match(String(verified.headers['content-type']), /text\/xml/);
    assert.match(verified.body, /<Redirect/); assert.doesNotMatch(verified.body, /voice-user|voice-contact/);
    assert.equal((await send(path + query, 'invalid', body.toString())).statusCode, 403);
    assert.equal((await send(path + '?turn=0&retry=1', signature, body.toString())).statusCode, 403);
    body.append('CallSid', callSid);
    const duplicateSignature = twilio.getExpectedTwilioSignature(authToken, `${origin}${path}${query}`, { ...params, CallSid: [callSid, callSid] });
    assert.equal((await send(path + query, duplicateSignature, body.toString())).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: path + query })).statusCode, 401);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
