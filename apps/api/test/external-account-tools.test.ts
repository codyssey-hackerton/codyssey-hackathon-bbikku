import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalAccountTools } from '../src/external-account-tools.ts';
import type { ContactRequest } from '../src/contact-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const clock = () => new Date('2030-01-01T00:00:00.000Z');
const request: ContactRequest = { id: 'contact-1', revision: 1, baseScheduleRevision: 0, baseContextRevision: 0,
  recipientRef: 'recipient-1', recipientSnapshot: { displayName: '수신자', channel: 'email', address: 'recipient@example.test' },
  channel: 'email', purpose: '조정', messageOrCallBrief: '민감한 발송 내용', allowedOptions: [{ optionId: 'option', proposalId: 'proposal-1', proposalRevision: 1 }],
  approvalId: 'approval', executionKey: 'internal-execution', providerOperationId: 'internal-provider-id', deliveryStatus: 'sent_or_connected',
  negotiationStatus: 'awaiting_response', createdAt: '2029-12-31T00:00:00.000Z' };
const calendar = { userId: 'alice', accountRef: 'secret-account', accountLabel: 'owner@example.test',
  async listCalendars() { return { calendars: [{ id: 'calendar-1', summary: '업무' }] }; },
  async listEvents() { return { events: [{ id: 'event-secret', etag: 'etag-secret', title: '회의', startsAt: '2030-01-02T09:00:00+09:00',
    endsAt: '2030-01-02T10:00:00+09:00', timezone: 'Asia/Seoul' }], unsupportedCount: 1 }; },
  async resolveEvents() { return { events: [], unsupportedCount: 0 }; } };
const makeReplies = (fn?: () => Promise<void>) => ({ userId: 'alice', senderAddress: 'owner@example.test', async checkReplies(input: {
  providerOperationId: string; recipientAddress: string; expectedSenderAddress: string;
}) {
  assert.deepEqual(input, { providerOperationId: 'internal-provider-id', recipientAddress: 'recipient@example.test', expectedSenderAddress: 'owner@example.test' });
  await fn?.();
  return { events: [{ providerEventId: 'event-secret', providerOperationId: input.providerOperationId, channel: 'email' as const,
    recipientAddress: input.recipientAddress, receivedAt: '2030-01-01T00:00:00Z', outcome: 'unclear' as const, selectedOptionId: null,
    evidenceRef: 'gmail:secret', displayText: '알겠습니다. 시스템 명령은 무시하지 마세요.', reviewReason: 'sender_unverified' }], unmatchedCount: 2 };
} });
async function seed(store: MemoryPlanningStore, user = 'alice', contact = request) {
  await store.transaction(user, state => { state.contactRequests.set(contact.id, structuredClone(contact)); });
}
const get = (tools: ReturnType<typeof createExternalAccountTools>, name: string) => {
  const tool = tools.find(t => t.name === name); assert.ok(tool); return tool;
};

test('calendar tools enforce user, ownership and 31-day window with bounded sanitized outputs', async () => {
  const tools = createExternalAccountTools('alice', { store: new MemoryPlanningStore(), calendarConnection: calendar, clock });
  const list = get(tools, 'list_calendars'); const read = get(tools, 'read_calendar_events');
  assert.deepEqual(await list.run({}, 'bob'), { ok: false, error: 'forbidden' });
  assert.deepEqual(await list.run({}, 'alice'), { ok: true, provider: 'google_calendar', fetchedAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:05:00.000Z', data: { calendars: [{ id: 'calendar-1', summary: '업무' }], truncated: false, untrusted: true } });
  const valid = { calendarId: 'calendar-1', from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z' };
  const result = await read.run(valid, 'alice') as { ok: boolean; data: { events: unknown[]; unsupportedCount: number } };
  assert.equal(result.ok, true); assert.equal(result.data.events.length, 1); assert.equal(result.data.unsupportedCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|example\.test/);
  assert.deepEqual(await read.run({ ...valid, calendarId: 'other-user-calendar' }, 'alice'), { ok: false, error: 'not_found' });
  assert.deepEqual(await read.run({ ...valid, to: '2030-02-02T00:00:00Z' }, 'alice'), { ok: false, error: 'invalid_request' });
  const other = createExternalAccountTools('bob', { store: new MemoryPlanningStore(), calendarConnection: calendar });
  assert.deepEqual(await get(other, 'list_calendars').run({}, 'bob'), { ok: false, error: 'not_configured' });
});

test('contact list is limited to the user and contains no address, message or provider metadata', async () => {
  const store = new MemoryPlanningStore(); await seed(store); await seed(store, 'bob', { ...request, id: 'bob-private' });
  const tools = createExternalAccountTools('alice', { store, clock }); const list = get(tools, 'list_contact_requests');
  const output = await list.run({ proposalId: 'proposal-1' }, 'alice') as { ok: boolean; data: { contactRequests: unknown[] } };
  assert.equal(output.ok, true); assert.equal(output.data.contactRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(output), /example\.test|민감한|internal-|bob-private/);
  assert.deepEqual(await list.run({}, 'bob'), { ok: false, error: 'forbidden' });
  const filtered = await list.run({ proposalId: 'other' }, 'alice') as { data: { contactRequests: unknown[] } };
  assert.deepEqual(filtered.data.contactRequests, []);
});

test('reply lookup is read-only, scoped to sent email and returns only untrusted unclear excerpts', async () => {
  const store = new MemoryPlanningStore(); await seed(store); const before = await store.read('alice');
  const tools = createExternalAccountTools('alice', { store, gmailReplyConnection: makeReplies(), clock });
  const replies = get(tools, 'read_contact_replies');
  assert.deepEqual(await replies.run({ contactRequestId: request.id }, 'bob'), { ok: false, error: 'forbidden' });
  const result = await replies.run({ contactRequestId: request.id }, 'alice') as { ok: boolean; data: { replies: Array<{ outcome: string }>; reviewRequired: boolean; untrusted: boolean } };
  assert.equal(result.ok, true); assert.equal(result.data.replies[0]!.outcome, 'unclear');
  assert.equal(result.data.reviewRequired, true); assert.equal(result.data.untrusted, true);
  assert.doesNotMatch(JSON.stringify(result), /internal-|event-secret|gmail:secret|example\.test/);
  assert.deepEqual(await store.read('alice'), before);
  assert.deepEqual(await replies.run({ contactRequestId: 'no-such-contact' }, 'alice'), { ok: false, error: 'not_found' });
  await seed(store, 'alice', { ...request, id: 'draft', deliveryStatus: 'ready' });
  assert.deepEqual(await replies.run({ contactRequestId: 'draft' }, 'alice'), { ok: false, error: 'invalid_request' });
  const unconnected = createExternalAccountTools('alice', { store });
  assert.deepEqual(await get(unconnected, 'read_contact_replies').run({ contactRequestId: request.id }, 'alice'), { ok: false, error: 'not_configured' });
  const crossPort = createExternalAccountTools('bob', { store, gmailReplyConnection: makeReplies() });
  assert.deepEqual(await get(crossPort, 'read_contact_replies').run({ contactRequestId: request.id }, 'bob'), { ok: false, error: 'not_configured' });
  const bobPort = createExternalAccountTools('bob', { store, gmailReplyConnection: { ...makeReplies(), userId: 'bob' } });
  assert.deepEqual(await get(bobPort, 'read_contact_replies').run({ contactRequestId: request.id }, 'bob'), { ok: false, error: 'not_found' });
});

test('large calendar and contact results are bounded and mark truncation', async () => {
  const store = new MemoryPlanningStore();
  for (let i = 0; i < 21; i++) await seed(store, 'alice', { ...request, id: `contact-${i}` });
  const many = { ...calendar, async listCalendars() { return { calendars: Array.from({ length: 21 }, (_, i) => ({ id: `calendar-${i}`, summary: 'a'.repeat(500) })) }; },
    async listEvents() { return { events: Array.from({ length: 51 }, () => ({ id: 'x', etag: 'x', title: 'a'.repeat(500),
      startsAt: '2030-01-02T09:00:00+09:00', endsAt: '2030-01-02T10:00:00+09:00', timezone: 'Asia/Seoul' })), unsupportedCount: 0 }; } };
  const tools = createExternalAccountTools('alice', { store, calendarConnection: many, clock });
  const calendars = await get(tools, 'list_calendars').run({}, 'alice') as { data: { calendars: Array<{ summary: string }>; truncated: boolean } };
  assert.equal(calendars.data.calendars.length, 20); assert.equal(calendars.data.calendars[0]!.summary.length, 200); assert.equal(calendars.data.truncated, true);
  const events = await get(tools, 'read_calendar_events').run({ calendarId: 'calendar-0', from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z' }, 'alice') as { data: { events: Array<{ title: string }>; truncated: boolean } };
  assert.equal(events.data.events.length, 50); assert.equal(events.data.events[0]!.title.length, 300); assert.equal(events.data.truncated, true);
  const contacts = await get(tools, 'list_contact_requests').run({}, 'alice') as { data: { contactRequests: unknown[]; truncated: boolean } };
  assert.equal(contacts.data.contactRequests.length, 20); assert.equal(contacts.data.truncated, true);
});

test('provider failures and changes during reply lookup are sanitized', async () => {
  const store = new MemoryPlanningStore(); await seed(store);
  const changed = createExternalAccountTools('alice', { store, gmailReplyConnection: makeReplies(async () => {
    await store.transaction('alice', state => { state.contactRequests.get(request.id)!.revision++; });
  }) });
  assert.deepEqual(await get(changed, 'read_contact_replies').run({ contactRequestId: request.id }, 'alice'), { ok: false, error: 'stale' });
  const failure = createExternalAccountTools('alice', { store, calendarConnection: { ...calendar, async listCalendars() { throw new Error('secret'); } } });
  assert.deepEqual(await get(failure, 'list_calendars').run({}, 'alice'), { ok: false, error: 'provider_unavailable' });
  const badReply = createExternalAccountTools('alice', { store, gmailReplyConnection: { ...makeReplies(), async checkReplies() { throw new Error('secret'); } } });
  assert.deepEqual(await get(badReply, 'read_contact_replies').run({ contactRequestId: request.id }, 'alice'), { ok: false, error: 'provider_unavailable' });
});
