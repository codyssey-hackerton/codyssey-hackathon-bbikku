import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { ContactService } from '../src/contact-service.ts';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PhoneDispatch } from '../src/phone-dispatch.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';

const credential = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber: '+12025550123' };
const recipientNumber = '+12025550124';
const now = () => new Date('2030-01-01T00:00:00Z');
const event: ScheduleFields = { kind: 'event', title: '합성 약속', timeSlot: { startsAt: '2030-01-02T10:00:00+09:00',
  endsAt: '2030-01-02T11:00:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null,
  flexibility: 'fixed', involvement: 'shared', completion: 'pending' };

async function fixture(t: TestContext, callResponse: () => Promise<Response> = async () => Response.json({ sid: `CA${'2'.repeat(32)}` }, { status: 201 })) {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).includes('IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ phone_number: credential.fromNumber, capabilities: { voice: true } }] });
    assert.ok(String(url).endsWith('/Calls.json'));
    assert.equal(options?.method, 'POST');
    calls++;
    return callResponse();
  };
  const connections = new PhoneConnections({ directory, fetcher });
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const planning = new PlanningService(store, now);
  const contacts = new ContactService(store, planning, now);
  const dispatch = new PhoneDispatch(store, planning, connections, now);
  return { directory, connections, contacts, dispatch, planning, store, get calls() { return calls; } };
}

async function draft(env: Awaited<ReturnType<typeof fixture>>, channel: 'email' | 'phone' = 'phone') {
  const item = (await env.planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: event }] } })).items[0]!;
  const baseline = await env.planning.capture('alice', 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposal = await env.planning.saveProposal(baseline, { kind: 'proposal', reason: '합성 대안', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
    after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2030-01-02T12:00:00+09:00', endsAt: '2030-01-02T13:00:00+09:00' } },
  }] } });
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') throw new Error('Fixture failed');
  const recipient = (await env.contacts.createRecipient('alice', { displayName: '합성 상대', channel, address: channel === 'phone' ? recipientNumber : 'person@example.test', confirmed: true })).recipient;
  return (await env.contacts.create('alice', { recipientRef: recipient.id, channel, purpose: '일정 조정',
    messageOrCallBrief: '합성 안내입니다.', allowedOptions: [{ optionId: 'one', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
}

test('wrong channel is rejected before side effects in both directions', async t => {
  const phone = await fixture(t);
  await phone.connections.connect('alice', credential);
  const phoneDraft = await draft(phone);
  await phone.contacts.decide('alice', phoneDraft.id, { contactRevision: phoneDraft.revision, decision: 'accept' });
  let emailCalls = 0;
  const email = new ContactDispatch(phone.store, phone.planning, { userId: 'alice', senderAddress: 'sender@example.test',
    async dispatch() { emailCalls++; return { status: 'submitted', providerOperationId: 'synthetic' }; } }, now);
  const phoneBefore = await phone.store.read('alice');
  const rejectedEmail = await email.send('alice', phoneDraft.id,
    { requestId: 'wrong-channel', contactRevision: phoneDraft.revision, expectedSenderAddress: 'sender@example.test' }, 'wrong-email');
  assert.equal(rejectedEmail.status, 409);
  assert.deepEqual(await phone.store.read('alice'), phoneBefore);
  assert.equal(emailCalls, 0);
  assert.equal((await phone.dispatch.call('alice', phoneDraft.id,
    { requestId: 'correct-channel', contactRevision: phoneDraft.revision, expectedSenderNumber: credential.fromNumber }, 'wrong-email')).status, 200);
  assert.equal(phone.calls, 1);

  const mail = await fixture(t);
  await mail.connections.connect('alice', credential);
  const mailDraft = await draft(mail, 'email');
  await mail.contacts.decide('alice', mailDraft.id, { contactRevision: mailDraft.revision, decision: 'accept' });
  const mailBefore = await mail.store.read('alice');
  const rejectedCall = await mail.dispatch.call('alice', mailDraft.id,
    { requestId: 'wrong-channel', contactRevision: mailDraft.revision, expectedSenderNumber: credential.fromNumber }, 'wrong-phone');
  assert.equal(rejectedCall.status, 409);
  assert.deepEqual(await mail.store.read('alice'), mailBefore);
  assert.equal(mail.calls, 0);
  let validEmailCalls = 0;
  const mailer = new ContactDispatch(mail.store, mail.planning, { userId: 'alice', senderAddress: 'sender@example.test',
    async dispatch() { validEmailCalls++; return { status: 'submitted', providerOperationId: 'synthetic' }; } }, now);
  assert.equal((await mailer.send('alice', mailDraft.id,
    { requestId: 'correct-channel', contactRevision: mailDraft.revision, expectedSenderAddress: 'sender@example.test' }, 'wrong-phone')).status, 200);
  assert.equal(validEmailCalls, 1);
});

test('phone connection is user-scoped, private, validated and never returns credentials', async t => {
  const env = await fixture(t);
  assert.deepEqual(await env.connections.status('alice'), { status: 'not_configured', senderNumber: null, lastRequestId: null });
  assert.deepEqual(await env.connections.connect('alice', credential), { status: 'available', senderNumber: credential.fromNumber, lastRequestId: null });
  assert.deepEqual(await env.connections.status('bob'), { status: 'not_configured', senderNumber: null, lastRequestId: null });
  const names = await readdir(env.directory);
  assert.equal(names.length, 1);
  assert.ok(!names[0]!.includes('alice'));
  assert.equal((await stat(join(env.directory, names[0]!))).mode & 0o777, 0o600);
  await assert.rejects(env.connections.connect('alice', { ...credential, fromNumber: 'invalid' }));
  assert.equal((await env.connections.status('alice')).senderNumber, credential.fromNumber);
});

test('same-number token update has an atomic request receipt and old files remain readable', async t => {
  const env = await fixture(t);
  await env.connections.connect('alice', credential, 'first-request');
  const oldStatus = await env.connections.status('alice');
  assert.deepEqual(oldStatus, { status: 'available', senderNumber: credential.fromNumber, lastRequestId: 'first-request' });
  const confirms = (status: Awaited<ReturnType<PhoneConnections['status']>>, requestId: string, number: string) =>
    status.status === 'available' && status.lastRequestId === requestId && status.senderNumber === number;
  assert.equal(confirms(oldStatus, 'second-request', credential.fromNumber), false);
  const updated = { ...credential, authToken: 'b'.repeat(32) };
  assert.deepEqual(await env.connections.connect('alice', updated, 'second-request'),
    { status: 'available', senderNumber: credential.fromNumber, lastRequestId: 'second-request' });
  const latest = await env.connections.status('alice');
  assert.equal(confirms(latest, 'second-request', credential.fromNumber), true);
  assert.equal(confirms(latest, 'first-request', credential.fromNumber), false);
  assert.equal(confirms(latest, 'second-request', '+12025550125'), false);
  assert.deepEqual(await env.connections.read('alice'), updated);
  assert.ok(!JSON.stringify(latest).includes(updated.authToken));
  const denied = new PhoneConnections({ directory: env.directory, fetcher: async () => new Response('', { status: 403 }) });
  await assert.rejects(denied.connect('alice', credential, 'failed-request'));
  assert.deepEqual(await env.connections.status('alice'), latest);
  assert.deepEqual(await env.connections.read('alice'), updated);
  const file = join(env.directory, (await readdir(env.directory))[0]!);
  await writeFile(file, JSON.stringify(credential));
  assert.deepEqual(await env.connections.status('alice'), { status: 'available', senderNumber: credential.fromNumber, lastRequestId: null });
  assert.deepEqual(await env.connections.read('alice'), credential);
});

test('approved phone contact submits once with unchanged schedule and replays idempotently', async t => {
  const env = await fixture(t);
  await env.connections.connect('alice', credential);
  const contact = await draft(env);
  const input = { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber };
  assert.equal((await env.dispatch.call('alice', contact.id, input, 'early')).status, 409);
  await env.contacts.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' });
  const before = await env.store.read('alice');
  assert.equal((await env.dispatch.call('alice', contact.id, { ...input, expectedSenderNumber: '+12025550125' }, 'wrong-sender')).status, 409);
  const sent = await env.dispatch.call('alice', contact.id, input, 'one');
  assert.equal(sent.status, 200);
  assert.equal((sent.body as { data: { contactRequest: { deliveryStatus: string } } }).data.contactRequest.deliveryStatus, 'sent_or_connected');
  assert.deepEqual(await env.dispatch.call('alice', contact.id, input, 'one'), sent);
  assert.equal((await env.dispatch.call('alice', contact.id, input, 'another')).status, 409);
  assert.equal(env.calls, 1);
  const after = await env.store.read('alice');
  assert.deepEqual(after.items, before.items);
  assert.equal(after.scheduleRevision, before.scheduleRevision);
});

test('unknown provider outcome is retained without retry', async t => {
  const env = await fixture(t, async () => { throw new Error('synthetic network failure'); });
  await env.connections.connect('alice', credential);
  const contact = await draft(env);
  await env.contacts.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' });
  const input = { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber };
  const result = await env.dispatch.call('alice', contact.id, input, 'one');
  assert.equal((result.body as { data: { contactRequest: { deliveryStatus: string } } }).data.contactRequest.deliveryStatus, 'outcome_unknown');
  assert.deepEqual(await env.dispatch.call('alice', contact.id, input, 'one'), result);
  assert.equal(env.calls, 1);
});

test('rejected approval and missing connection never initiate a call', async t => {
  const env = await fixture(t);
  const contact = await draft(env);
  const input = { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber };
  assert.equal((await env.dispatch.call('alice', contact.id, input, 'unconfigured')).status, 503);
  await env.connections.connect('alice', credential);
  await env.contacts.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'reject' });
  assert.equal((await env.dispatch.call('alice', contact.id, input, 'rejected')).status, 409);
  assert.equal(env.calls, 0);
});

test('changed connection between claim and dispatch blocks the call', async t => {
  const env = await fixture(t);
  await env.connections.connect('alice', credential);
  const contact = await draft(env);
  await env.contacts.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' });
  const actualRead = env.connections.read.bind(env.connections);
  let reads = 0;
  t.mock.method(env.connections, 'read', async (userId: string) => ++reads === 1 ? actualRead(userId) : { ...credential, fromNumber: '+12025550125' });
  const result = await env.dispatch.call('alice', contact.id,
    { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber }, 'changed');
  assert.equal((result.body as { data: { contactRequest: { deliveryStatus: string } } }).data.contactRequest.deliveryStatus, 'failed');
  assert.equal(env.calls, 0);
});

test('connection verification rejects unowned or non-voice numbers and sanitizes provider errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const denied = new PhoneConnections({ directory, fetcher: async () => Response.json({ error: 'provider details' }, { status: 403 }) });
  await assert.rejects(denied.connect('alice', credential), (error: Error) => !error.message.includes('provider details'));
  const noVoice = new PhoneConnections({ directory, fetcher: async () => Response.json({ incoming_phone_numbers: [
    { phone_number: credential.fromNumber, capabilities: { voice: false } },
  ] }) });
  await assert.rejects(noVoice.connect('alice', credential));
  assert.deepEqual(await noVoice.status('alice'), { status: 'not_configured', senderNumber: null, lastRequestId: null });
});
