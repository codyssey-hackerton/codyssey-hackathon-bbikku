import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import pg from 'pg';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { ContactResponseService } from '../src/contact-response.ts';
import { ContactService } from '../src/contact-service.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore, type UserPlanningState } from '../src/planning-store.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const user = 'alice';
const address = '+821012345678';
const operationId = 'fake-provider-operation';
const fixedNow = '2026-10-31T12:00:00.000Z';
const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const event: ScheduleFields = {
  kind: 'event', title: '공동 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending',
};

// The memory dispatch adapter is test-only; the actual service still sees its ordinary transaction methods.
function durableMemory(): PlanningStore {
  const memory = new MemoryPlanningStore();
  return { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
}
function guardFetch(t: TestContext) {
  const guard = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external fetch'); });
  t.after(() => assert.equal(guard.mock.callCount(), 0));
}
async function fixture(store: PlanningStore, channel: 'email' | 'phone' = 'phone') {
  let now = fixedNow;
  const clock = () => new Date(now);
  const planning = new PlanningService(store, clock);
  const contacts = new ContactService(store, planning, clock);
  const responses = new ContactResponseService(store, planning, clock);
  const created = await planning.command(user, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: event }] } });
  const item = created.items[0]!;
  const baseline = await planning.capture(user, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
  const proposalIds: string[] = [];
  for (const hour of ['10', '12']) {
    const result = await planning.saveProposal(baseline, { kind: 'proposal', reason: '시간 대안', evidenceRefs: [], changeSet: { changes: [{
      changeId: `move-${hour}`, operation: 'update', targetId: item.id, expectedRevision: item.revision,
      after: { ...event, timeSlot: { ...event.timeSlot!, startsAt: `2026-11-02T${hour}:00+09:00`, endsAt: `2026-11-02T${Number(hour) + 1}:00+09:00` } },
    }] } });
    assert.equal(result.kind, 'proposal');
    if (result.kind !== 'proposal') throw new Error('fixture proposal was rejected');
    proposalIds.push(result.proposalIds[0]!);
  }
  const recipientAddress = channel === 'phone' ? address : 'contact@example.test';
  const { recipient } = await contacts.createRecipient(user, { displayName: '상대', channel, address: recipientAddress, confirmed: true });
  const { contactRequest: draft } = await contacts.create(user, { recipientRef: recipient.id, channel, purpose: '일정 조정',
    messageOrCallBrief: '가능한 시간을 알려주세요.', allowedOptions: proposalIds.map((proposalId, i) => ({ optionId: `option-${i + 1}`, proposalId, proposalRevision: 1 })) });
  const { contactRequest: approved } = await contacts.decide(user, draft.id, { contactRevision: draft.revision, decision: 'accept' });
  let calls = 0;
  const dispatch = new ContactDispatch(store, planning, { userId: user, senderAddress: 'sender@example.test', async dispatch(_input, _signal, beforeSend) {
    calls++; await beforeSend?.(); return { status: 'submitted', providerOperationId: operationId };
  } }, clock, channel);
  const sent = await dispatch.send(user, draft.id, { requestId: 'send', contactRevision: approved.revision, expectedSenderAddress: 'sender@example.test' }, 'send');
  assert.equal(sent.status, 200);
  assert.equal(calls, 1);
  const before = await store.read(user);
  assert.equal(before.contactRequests.get(draft.id)?.deliveryStatus, 'sent_or_connected');
  assert.equal(before.contactRequests.get(draft.id)?.providerOperationId, operationId);
  assert.deepEqual(before.items.get(item.id), item);
  return { store, planning, responses, contactId: draft.id, item, proposalIds, before, clock, setNow(value: string) { now = value; } };
}
function reply(overrides: Partial<{ providerEventId: string; providerOperationId: string; channel: 'email' | 'phone'; recipientAddress: string;
  receivedAt: string; outcome: 'accepted' | 'declined' | 'alternative_proposed' | 'unclear'; selectedOptionId: string | null; evidenceRef: string }> = {}) {
  return { providerEventId: 'fake-event-1', providerOperationId: operationId, channel: 'phone' as const, recipientAddress: address,
    receivedAt: fixedNow, outcome: 'accepted' as const, selectedOptionId: 'option-1', evidenceRef: 'fake-evidence-1', ...overrides };
}
function unchangedSchedule(before: UserPlanningState, after: UserPlanningState) {
  assert.equal(after.scheduleRevision, before.scheduleRevision);
  assert.deepEqual(after.items, before.items);
}
async function record(f: Awaited<ReturnType<typeof fixture>>, input = reply()) {
  return f.responses.recordVerified(user, f.contactId, input);
}
async function status(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.store.read(user)).contactRequests.get(f.contactId)?.negotiationStatus;
}

test('verified acceptance applies exactly the approved option and disposes of the other alternative', async t => {
  guardFetch(t);
  const f = await fixture(durableMemory());
  await record(f);
  const after = await f.store.read(user);
  assert.equal(after.scheduleRevision, f.before.scheduleRevision + 1);
  assert.equal(after.items.get(f.item.id)?.timeSlot?.startsAt, '2026-11-02T10:00+09:00');
  assert.equal(after.items.get(f.item.id)?.revision, f.item.revision + 1);
  assert.equal(after.proposals.get(f.proposalIds[0]!)?.status, 'applied');
  assert.ok(['stale', 'rejected'].includes(after.proposals.get(f.proposalIds[1]!)?.status ?? ''));
  assert.equal(await status(f), 'applied');
});

test('redelivery, including concurrent redelivery, creates one response and applies once', async t => {
  guardFetch(t);
  const f = await fixture(durableMemory());
  const empty = await f.responses.list(user, f.contactId);
  assert.equal(empty.responses.length, 0);
  const first = await Promise.all([record(f), record(f), record(f)]);
  assert.deepEqual(first[1].response, first[0].response);
  assert.deepEqual(first[2].response, first[0].response);
  const after = await f.store.read(user);
  const listed = await f.responses.list(user, f.contactId);
  assert.equal(after.contactResponses.size, 1);
  assert.equal(listed.responses.length, 1);
  assert.equal(listed.responses[0]?.providerEventId, 'fake-event-1');
  assert.equal(after.scheduleRevision, f.before.scheduleRevision + 1);
  assert.deepEqual((await record(f)).response, first[0].response);
  assert.deepEqual(await f.store.read(user), after);
  await assert.rejects(record(f, reply({ selectedOptionId: 'option-2' })), { code: 'conflict' });
  assert.deepEqual(await f.responses.list(user, f.contactId), listed);
  assert.deepEqual(await f.store.read(user), after);
});

test('rejects replies that do not match the sent operation, channel or approved recipient', async t => {
  guardFetch(t);
  const f = await fixture(durableMemory());
  for (const input of [reply({ providerOperationId: 'other-operation' }), reply({ channel: 'email', outcome: 'unclear', selectedOptionId: null }), reply({ recipientAddress: '+821099999999' })]) {
    await assert.rejects(record(f, input), { code: 'conflict' });
    assert.deepEqual(await f.store.read(user), f.before);
  }
  await assert.rejects(f.responses.recordVerified('bob', f.contactId, reply()), { code: 'not_found' });
  assert.deepEqual(await f.store.read(user), f.before);
});

test('tampering with approval or approved contact content cannot apply a response', async t => {
  guardFetch(t);
  for (const tamper of ['message', 'recipient', 'option', 'actor'] as const) {
    const f = await fixture(durableMemory());
    await f.store.transaction(user, state => {
      const approved = state.contactApprovals[0]!;
      if (tamper === 'message') approved.subject.messageOrCallBrief = '변조된 내용';
      if (tamper === 'recipient') approved.subject.recipientSnapshot.address = 'other@example.test';
      if (tamper === 'option') approved.subject.allowedOptions[0]!.proposalId = f.proposalIds[1]!;
      if (tamper === 'actor') approved.approval.actorRef = 'bob';
    });
    const before = await f.store.read(user);
    const result = await record(f);
    assert.equal(result.contactRequest.negotiationStatus, 'needs_user_review', tamper);
    unchangedSchedule(before, await f.store.read(user));
    assert.notEqual(await status(f), 'applied', tamper);
  }
});

test('concurrent competing acceptances cannot apply both alternatives', async t => {
  guardFetch(t);
  const f = await fixture(durableMemory());
  const results = await Promise.allSettled([record(f), record(f, reply({ providerEventId: 'fake-event-2', selectedOptionId: 'option-2' }))]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  const after = await f.store.read(user);
  assert.equal(after.scheduleRevision, f.before.scheduleRevision + 1);
  assert.equal(after.items.get(f.item.id)?.revision, f.item.revision + 1);
  assert.equal(f.proposalIds.filter(id => after.proposals.get(id)?.status === 'applied').length, 1);
});

test('ambiguous, absent and out-of-scope choices require review and preserve the original appointment', async t => {
  guardFetch(t);
  for (const input of [reply({ outcome: 'unclear', selectedOptionId: null }), reply({ selectedOptionId: null }), reply({ selectedOptionId: 'outside' }),
    reply({ outcome: 'alternative_proposed', selectedOptionId: null })]) {
    const f = await fixture(durableMemory());
    await record(f, input);
    unchangedSchedule(f.before, await f.store.read(user));
    assert.equal(await status(f), 'needs_user_review');
  }
});

test('decline never applies an option', async t => {
  guardFetch(t);
  const f = await fixture(durableMemory());
  await record(f, reply({ outcome: 'declined', selectedOptionId: null }));
  unchangedSchedule(f.before, await f.store.read(user));
  assert.equal(await status(f), 'declined');
});

test('stale schedule, stale context, a new conflict and expiry require review without changing the original appointment', async t => {
  guardFetch(t);
  for (const scenario of ['schedule', 'context', 'conflict', 'expired'] as const) {
    const f = await fixture(durableMemory());
    if (scenario === 'schedule') await f.planning.checkin(user, f.item.id, { expectedRevision: f.item.revision, completion: 'incomplete' });
    if (scenario === 'context') await f.planning.saveMemory(user, { expectedContextRevision: 0, kind: 'preference', key: 'test', value: 'changed', validUntil: null });
    if (scenario === 'conflict') await f.planning.command(user, { expectedScheduleRevision: f.before.scheduleRevision, changeSet: { changes: [{ changeId: 'conflict', operation: 'create',
      after: { ...event, title: '충돌', involvement: 'personal', timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T10:00+09:00', endsAt: '2026-11-02T11:00+09:00' } } }] } });
    if (scenario === 'expired') f.setNow('2026-10-31T12:30:00.000Z');
    const before = await f.store.read(user);
    await record(f, reply({ receivedAt: f.clock().toISOString() }));
    unchangedSchedule(before, await f.store.read(user));
    assert.deepEqual((await f.store.read(user)).items.get(f.item.id), before.items.get(f.item.id), scenario);
    assert.equal(await status(f), 'needs_user_review', scenario);
  }
});

test('PostgreSQL persists one response across independent stores, concurrent replay and restart', { skip: !connectionString, timeout: 30000 }, async t => {
  guardFetch(t);
  const schema = `pikku_response_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools: pg.Pool[] = [];
  t.after(async () => {
    for (const pool of pools) await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const newStore = async () => {
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
    pools.push(pool); const store = new PostgresPlanningStore(pool); await store.migrate(); return store;
  };
  const store1 = await newStore(); const f = await fixture(store1);
  const store2 = await newStore(); const second = new ContactResponseService(store2, new PlanningService(store2, f.clock), f.clock);
  const [first, replay] = await Promise.all([record(f), second.recordVerified(user, f.contactId, reply())]);
  assert.deepEqual(replay.response, first.response);
  const committed = await store2.read(user);
  const listed = await second.list(user, f.contactId);
  assert.equal(listed.responses.length, 1);
  assert.equal(listed.responses[0]?.providerEventId, 'fake-event-1');
  assert.equal(committed.contactResponses.size, 1);
  assert.equal(committed.scheduleRevision, f.before.scheduleRevision + 1);
  assert.equal(committed.proposals.get(f.proposalIds[0]!)?.status, 'applied');
  await pools[0]!.end(); pools.splice(0, 1);
  await pools[0]!.end(); pools.splice(0, 1);
  const restarted = await newStore();
  const responseAfterRestart = new ContactResponseService(restarted, new PlanningService(restarted, f.clock), f.clock);
  assert.deepEqual((await responseAfterRestart.recordVerified(user, f.contactId, reply())).response, first.response);
  assert.deepEqual(await restarted.read(user), committed);
  assert.deepEqual(await responseAfterRestart.list(user, f.contactId), listed);
});

function emailReply(overrides: Partial<import('../src/contact-response.ts').VerifiedContactEvent> = {}): import('../src/contact-response.ts').VerifiedContactEvent {
  return { providerEventId: 'email-1', providerOperationId: operationId, channel: 'email', recipientAddress: 'contact@example.test',
    receivedAt: fixedNow, outcome: 'unclear', selectedOptionId: null, evidenceRef: 'email-evidence',
    displayText: '제안한 첫 시간으로 괜찮습니다.', reviewReason: 'sender_unverified', ...overrides };
}

test('owner confirms a stored reviewed email and only the selected approved option applies once', async t => {
  guardFetch(t); const f = await fixture(durableMemory(), 'email');
  const received = await f.responses.recordVerified(user, f.contactId, emailReply());
  assert.equal(received.contactRequest.negotiationStatus, 'needs_user_review');
  unchangedSchedule(f.before, await f.store.read(user));
  const input = { responseId: received.response.id, contactRevision: 1, selectedOptionId: 'option-1' };
  await assert.rejects(f.responses.confirm('bob', f.contactId, input), { code: 'not_found' });
  await assert.rejects(f.responses.confirm(user, f.contactId, { ...input, selectedOptionId: 'outside' }), { code: 'conflict' });
  const applied = await f.responses.confirm(user, f.contactId, input);
  assert.equal(applied.contactRequest.negotiationStatus, 'applied'); assert.equal(applied.changed, true);
  assert.equal((await f.store.read(user)).items.get(f.item.id)?.timeSlot?.startsAt, '2026-11-02T10:00+09:00');
  await assert.rejects(f.responses.confirm(user, f.contactId, input), { code: 'conflict' });
  await assert.rejects(f.responses.confirm(user, f.contactId, { ...input, selectedOptionId: 'option-2' }), { code: 'conflict' });
});

test('email confirmation requires a current human-reviewable saved reply and rejects older or stale responses', async t => {
  guardFetch(t);
  for (const event of [emailReply({ displayText: null }), emailReply({ reviewReason: 'automatic_message' })]) {
    const f = await fixture(durableMemory(), 'email'); const received = await f.responses.recordVerified(user, f.contactId, event);
    await assert.rejects(f.responses.confirm(user, f.contactId, { responseId: received.response.id, contactRevision: 1, selectedOptionId: 'option-1' }), { code: 'conflict' });
    unchangedSchedule(f.before, await f.store.read(user));
  }
  const f = await fixture(durableMemory(), 'email');
  const first = await f.responses.recordVerified(user, f.contactId, emailReply());
  await f.responses.recordVerified(user, f.contactId, emailReply({ providerEventId: 'email-2', receivedAt: '2026-10-31T12:00:01Z' }));
  await assert.rejects(f.responses.confirm(user, f.contactId, { responseId: first.response.id, contactRevision: 1, selectedOptionId: 'option-1' }), { code: 'conflict' });
  unchangedSchedule(f.before, await f.store.read(user));
  const latest = (await f.responses.list(user, f.contactId)).responses[1]!;
  f.setNow('2026-10-31T13:00:00Z');
  const stale = await f.responses.confirm(user, f.contactId, { responseId: latest.id, contactRevision: 1, selectedOptionId: 'option-1' });
  assert.equal(stale.changed, false); assert.equal(stale.contactRequest.negotiationStatus, 'needs_user_review');
  unchangedSchedule(f.before, await f.store.read(user));
});

test('volatile storage cannot record or apply an external response', async () => {
  const store = new MemoryPlanningStore(); const service = new ContactResponseService(store, new PlanningService(store));
  await assert.rejects(service.recordVerified(user, 'contact', reply()), { status: 503, code: 'not_configured' });
  await assert.rejects(service.confirm(user, 'contact', { responseId: 'response', contactRevision: 1, selectedOptionId: 'option' }), { status: 503, code: 'not_configured' });
  assert.deepEqual(await store.listUserIds(), []);
});

test('email callbacks cannot claim an accepted or selected option', async t => {
  guardFetch(t); const f = await fixture(durableMemory(), 'email');
  await assert.rejects(f.responses.recordVerified(user, f.contactId, emailReply({ outcome: 'accepted', selectedOptionId: 'option-1' })), { status: 400, code: 'invalid_request' });
  await assert.rejects(f.responses.recordVerified(user, f.contactId, emailReply({ selectedOptionId: 'option-1' })), { status: 400, code: 'invalid_request' });
  assert.deepEqual(await f.store.read(user), f.before);
});
