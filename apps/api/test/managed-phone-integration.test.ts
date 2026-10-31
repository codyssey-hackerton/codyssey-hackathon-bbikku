import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { ContactService } from '../src/contact-service.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { managedCallBindingKey, PhoneDispatch } from '../src/phone-dispatch.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import { VoiceTokens } from '../src/voice-token.ts';
import { VoiceWebhook } from '../src/voice-webhook.ts';
import { ContactResponseService } from '../src/contact-response.ts';
import type { Pool } from 'pg';

const credential = { provider: 'clawops' as const, mode: 'agent' as const, accountId: 'account1', apiKey: 'secret-test', agentId: 'agent1', fromNumber: '+827012345678' };
const target = '+821012345678';
const callId = 'call1';
const baseTime = '2026-10-31T12:00:00.000Z';
const event: ScheduleFields = { kind: 'event', title: '합성 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };
async function fixture(t: TestContext, autoSend = true) {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-agent-phone-'));
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory), atomic: memory.atomic.bind(memory),
    transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  let now = baseTime; const clock = () => new Date(now);
  let callStatus = 'completed'; let speaking = true; let end = true; let longTranscript = false; let lookups = 0; let calls = 0; let dispatchStatus = 201;
  const watchStarts: string[] = []; let watchStopped = false;
  let onLookup: (() => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url));
    assert.equal(path.origin, 'https://api.claw-ops.com');
    if (path.pathname.endsWith('/numbers')) return Response.json({ data: [{ number: '07012345678' }] });
    if (path.pathname.endsWith('/agents/agent1')) return Response.json({ agentId: 'agent1' });
    if (path.pathname.endsWith('/calls') && init?.method === 'POST') {
      calls++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.AgentId, 'agent1'); assert.equal(body.Url, undefined);
      assert.match(body.CallContext.Instruction, /합성 안내/);
      assert.match(body.CallContext.Instruction, /11월 2일 오전 10시부터 오전 11시까지/);
      assert.doesNotMatch(body.CallContext.Instruction, /한국 표준시|협정 세계시/);
      assert.doesNotMatch(body.CallContext.Instruction, /option-one/);
      return Response.json({ callId }, { status: dispatchStatus });
    }
    lookups++;
    // A lookup must never hold the per-user write lock while waiting on a provider.
    await store.transaction('alice', () => undefined);
    if (onLookup) { const action = onLookup; onLookup = undefined; await action(); }
    if (path.pathname.endsWith('/live-events')) {
      const row = (id: string, name: string, detail: unknown = {}) => ({ id, event: name, timestamp: '2026-10-31T12:00:01Z', detail });
      return Response.json({ data: [row('1', 'stream.started'), ...(speaking ? [row('2', 'transcript.final', { utteranceId: 'u1', role: 'user', text: longTranscript ? '가'.repeat(1100) : '그 시간이 좋아요.' })] : []),
        row('3', 'transcript.final', { utteranceId: 'a1', role: 'agent', text: longTranscript ? '나'.repeat(1100) : '확인했습니다.' }),
        ...(end ? [row('4', 'stream.ended', { reason: 'completed' })] : [])], hasMore: false });
    }
    return Response.json({ callId, accountId: credential.accountId, from: '07012345678', to: '01012345678', direction: 'outbound', status: callStatus, dateCreated: baseTime });
  };
  const connections = new PhoneConnections({ directory, fetcher });
  const app = buildApp({ store, clock, phoneConnections: connections, allowLocalPhoneConnect: true,
    managedCallWatch: { start(userId, contactId) { watchStarts.push(`${userId}:${contactId}`); }, async stop() { watchStopped = true; } },
    sessions: { async resolve(token) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await connections.connect('alice', credential);
  const planning = new PlanningService(store, clock); const contacts = new ContactService(store, planning, clock);
  const item = (await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: event }] } })).items[0]!;
  const baseline = await planning.capture('alice', 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '대안', evidenceRefs: [], changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: item.id,
    expectedRevision: item.revision, after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T10:00+09:00', endsAt: '2026-11-02T11:00+09:00' } } }] } });
  if (proposal.kind !== 'proposal') throw new Error('proposal fixture');
  const recipient = (await contacts.createRecipient('alice', { displayName: '상대', channel: 'phone', address: target, confirmed: true })).recipient;
  const contact = (await contacts.create('alice', { recipientRef: recipient.id, channel: 'phone', purpose: '일정 조정', messageOrCallBrief: '합성 안내',
    allowedOptions: [{ optionId: 'option-one', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
  await contacts.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' });
  const post = (path: string, payload: object, key: string, user = 'alice') => app.inject({ method: 'POST', url: path,
    headers: { authorization: `Bearer ${user}`, 'idempotency-key': key }, payload });
  if (autoSend) {
    const send = await post(`/v1/contact-requests/${contact.id}/call`, { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber }, 'call');
    assert.equal(send.statusCode, 200, send.body); assert.equal(send.json().data.contactRequest.deliveryStatus, 'sent_or_connected');
  }
  return { store, planning, connections, clock, contact, item, app, post, calls: () => calls, lookups: () => lookups, setStatus: (value: string) => { callStatus = value; },
    setSpeaking: (value: boolean) => { speaking = value; }, setEnd: (value: boolean) => { end = value; }, setTime: (value: string) => { now = value; },
    setLookupHook: (action: () => Promise<void>) => { onLookup = action; }, setLongTranscript: () => { longTranscript = true; },
    setDispatchStatus: (value: number) => { dispatchStatus = value; }, watchStarts, watchStopped: () => watchStopped };
}

test('managed call is bound, complete transcript stays unclear until explicit confirmation, and duplicate checks do not refetch', async t => {
  const f = await fixture(t); const { contact, store } = f;
  const binding = (await store.read('alice')).voiceSessions.get(managedCallBindingKey(contact.executionKey));
  assert.deepEqual(binding, { contactId: contact.id, accountId: credential.accountId, agentId: credential.agentId, fromNumber: credential.fromNumber, mode: 'agent' });
  assert.doesNotMatch(JSON.stringify(binding), /secret-test/);
  const path = `/v1/contact-requests/${contact.id}/check-call`; const payload = { requestId: 'check', contactRevision: contact.revision };
  const checked = await f.post(path, payload, 'check'); assert.equal(checked.statusCode, 200, checked.body);
  const data = checked.json().data;
  assert.equal(data.complete, true); assert.equal(data.truncated, false); assert.equal(data.callStatus, 'completed');
  assert.equal(data.responses.length, 1); assert.equal(data.responses[0].outcome, 'unclear');
  assert.equal(data.responses[0].reviewReason, 'voice_transcript_unverified'); assert.equal(data.responses[0].displayText, '상대: 그 시간이 좋아요.\nAI: 확인했습니다.');
  assert.deepEqual((await store.read('alice')).items.get(f.item.id), f.item);
  const count = f.lookups(); assert.deepEqual((await f.post(path, payload, 'check')).json(), checked.json()); assert.equal(f.lookups(), count);
  assert.equal((await f.post(path, payload, 'check-other-user', 'bob')).statusCode, 404);
  const confirm = `/v1/contact-requests/${contact.id}/responses/${data.responses[0].id}/confirm`;
  const selected = { requestId: 'confirm', contactRevision: contact.revision, selectedOptionId: 'option-one' };
  assert.equal((await f.post(confirm, { ...selected, selectedOptionId: 'other' }, 'bad')).statusCode, 409);
  const result = await f.post(confirm, selected, 'confirm'); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().data.changed, true);
  assert.equal((await store.read('alice')).items.get(f.item.id)?.timeSlot?.startsAt, '2026-11-02T10:00+09:00');
  assert.equal((await f.post(confirm, selected, 'duplicate')).statusCode, 409);
  await f.post(path, { ...payload, requestId: 'again' }, 'again');
  assert.equal((await store.read('alice')).contactResponses.size, 1); assert.equal(f.calls(), 1);
});

test('running, incomplete and silent calls create no review response', async t => {
  const f = await fixture(t); const path = `/v1/contact-requests/${f.contact.id}/check-call`;
  const payload = { requestId: 'check', contactRevision: f.contact.revision };
  for (const variant of ['running', 'incomplete', 'silent']) {
    f.setStatus(variant === 'running' ? 'in-progress' : 'completed'); f.setEnd(variant !== 'incomplete'); f.setSpeaking(variant !== 'silent');
    const result = await f.post(path, payload, variant); assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().data.complete, false); assert.equal(result.json().data.responses.length, 0);
    assert.deepEqual((await f.store.read('alice')).items.get(f.item.id), f.item);
  }
});

test('confirmation after expiry remains review-only', async t => {
  const f = await fixture(t); const contact = f.contact;
  const checked = await f.post(`/v1/contact-requests/${contact.id}/check-call`, { requestId: 'check', contactRevision: contact.revision }, 'check');
  const response = checked.json().data.responses[0];
  f.setTime('2026-11-15T12:00:00.000Z');
  const result = await f.post(`/v1/contact-requests/${contact.id}/responses/${response.id}/confirm`,
    { requestId: 'confirm', contactRevision: contact.revision, selectedOptionId: 'option-one' }, 'confirm');
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().data.changed, false);
  assert.deepEqual((await f.store.read('alice')).items.get(f.item.id), f.item);
});

test('missing binding and unknown delivery outcomes cannot start a lookup', async t => {
  const f = await fixture(t); const path = `/v1/contact-requests/${f.contact.id}/check-call`;
  const payload = { requestId: 'check', contactRevision: f.contact.revision };
  await f.store.transaction('alice', state => state.voiceSessions.delete(managedCallBindingKey(f.contact.executionKey)));
  assert.equal((await f.post(path, payload, 'missing-binding')).statusCode, 409); assert.equal(f.lookups(), 0);
  await f.store.transaction('alice', state => {
    const current = state.contactRequests.get(f.contact.id)!;
    state.contactRequests.set(current.id, { ...current, deliveryStatus: 'outcome_unknown', providerOperationId: null });
  });
  assert.equal((await f.post(path, payload, 'unknown')).statusCode, 409); assert.equal(f.lookups(), 0);
});

test('a contact changed during provider lookup rejects the result without storing a response', async t => {
  const f = await fixture(t);
  f.setLookupHook(async () => f.store.transaction('alice', state => {
    const current = state.contactRequests.get(f.contact.id)!;
    state.contactRequests.set(current.id, { ...current, purpose: '변경됨' });
  }));
  const result = await f.post(`/v1/contact-requests/${f.contact.id}/check-call`, { requestId: 'check', contactRevision: f.contact.revision }, 'check');
  assert.equal(result.statusCode, 409); assert.equal((await f.store.read('alice')).contactResponses.size, 0);
  assert.deepEqual((await f.store.read('alice')).items.get(f.item.id), f.item);
});

test('a complete provider stream exceeding the formatted transcript limit is not reviewable', async t => {
  const f = await fixture(t); f.setLongTranscript();
  const result = await f.post(`/v1/contact-requests/${f.contact.id}/check-call`, { requestId: 'check', contactRevision: f.contact.revision }, 'check');
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().data.complete, false);
  assert.equal(result.json().data.truncated, true); assert.equal(result.json().data.responses.length, 0);
  assert.deepEqual((await f.store.read('alice')).items.get(f.item.id), f.item);
});

test('managed credentials cannot authenticate VoiceML callbacks', async t => {
  const f = await fixture(t); const base = 'https://example.test'; const key = Buffer.alloc(32, 8).toString('base64');
  const tokens = new VoiceTokens(base, key); const token = tokens.issue('alice', f.contact.id, f.clock());
  const webhook = new VoiceWebhook({ store: f.store, planning: f.planning, connections: f.connections,
    responseService: new ContactResponseService(f.store, f.planning, f.clock), publicBaseUrl: base, sessionKey: key, clock: f.clock });
  const response = await webhook.handle({ provider: 'clawops', token, rawQuery: '?turn=0&retry=0', contentType: 'application/x-www-form-urlencoded',
    signature: 'synthetic', params: { AccountId: credential.accountId, CallId: callId, From: credential.fromNumber, To: target } });
  assert.equal(response.status, 403); assert.equal((await f.store.read('alice')).contactResponses.size, 0);
});

test('provider mode changed since readiness check cannot start a managed call', async t => {
  const f = await fixture(t, false);
  const dispatch = new PhoneDispatch(f.store, f.planning, f.connections, f.clock);
  const input = { requestId: 'call', contactRevision: f.contact.revision, expectedSenderNumber: credential.fromNumber };
  assert.equal((await dispatch.call('alice', f.contact.id, input, 'mismatched-mode', 'clawops')).status, 503);
  assert.equal(f.calls(), 0); assert.equal(f.watchStarts.length, 0); assert.equal((await f.store.read('alice')).voiceSessions.size, 0);
  assert.equal((await f.post(`/v1/contact-requests/${f.contact.id}/call`, input, 'correct-mode')).statusCode, 200);
  assert.equal(f.calls(), 1); assert.deepEqual(f.watchStarts, [`alice:${f.contact.id}`]);
  await f.app.close(); assert.equal(f.watchStopped(), true);
});

test('failed managed dispatch does not start a call watcher', async t => {
  const f = await fixture(t, false); f.setDispatchStatus(400);
  const result = await f.post(`/v1/contact-requests/${f.contact.id}/call`,
    { requestId: 'call', contactRevision: f.contact.revision, expectedSenderNumber: credential.fromNumber }, 'failed');
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().data.contactRequest.deliveryStatus, 'failed');
  assert.equal(f.watchStarts.length, 0);
});

test('existing JSONB codec restores a namespaced managed binding after store recreation', async () => {
  let data: unknown;
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('INSERT INTO')) { data ??= JSON.parse(String(args![1])); return { rows: [] }; }
    if (sql.startsWith('SELECT schema_version')) return { rows: data ? [{ schema_version: 1, state: data }] : [] };
    if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ locked_at: new Date(baseTime) }] };
    if (sql.startsWith('UPDATE pikku_user_state')) { data = JSON.parse(String(args![1])); return { rows: [] }; }
    return { rows: [] };
  };
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const first = new PostgresPlanningStore(pool);
  const key = managedCallBindingKey('execution');
  const binding = { contactId: 'contact', accountId: 'account', agentId: 'agent', fromNumber: '+821012345678', mode: 'agent' };
  await first.transaction('alice', state => state.voiceSessions.set(key, binding));
  assert.deepEqual((await new PostgresPlanningStore(pool).read('alice')).voiceSessions.get(key), binding);
  assert.deepEqual((data as { voiceSessions: unknown }).voiceSessions, [[key, binding]]);
});
