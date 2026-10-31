import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Approval, Proposal, Recipient, ScheduleFields, ScheduleItem } from '@pikku/domain';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { ContactService } from '../src/contact-service.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const fixedNow = '2026-10-31T12:00:00.000Z';
const range = 'from=2026-11-02T00%3A00%2B09%3A00&to=2026-11-03T00%3A00%2B09%3A00&timezone=Asia%2FSeoul';
const headers = (user: string, key: string) => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const event: ScheduleFields = {
  kind: 'event', title: '공동 약속', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending',
};
type Option = { optionId: string; proposalId: string; proposalRevision: number };
type ContactRequest = {
  id: string; revision: number; baseScheduleRevision: number; baseContextRevision: number; recipientRef: string;
  recipientSnapshot: { displayName: string; channel: 'email' | 'phone'; address: string };
  channel: 'email' | 'phone'; purpose: string; messageOrCallBrief: string; allowedOptions: Option[];
  approvalId: string | null; executionKey: string; providerOperationId: string | null;
  deliveryStatus: string; negotiationStatus: string; createdAt: string;
};
type ContactApproval = { approval: Approval; subject: ContactRequest; proposals: Proposal[] };
type ContactCollections = { recipients: Map<string, Recipient>; contactRequests: Map<string, ContactRequest>; contactApprovals: ContactApproval[] };
type App = ReturnType<typeof buildApp>;

async function post(app: App, url: string, payload: object, key: string, user = 'alice') {
  return app.inject({ method: 'POST', url, headers: headers(user, key), payload });
}
async function get(app: App, url: string, user = 'alice') {
  return app.inject({ method: 'GET', url, headers: headers(user, 'unused') });
}
function assertOk(response: { statusCode: number; body: string }) {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
}
function assertRejected(response: { statusCode: number; body: string; json(): any }) {
  assert.ok([400, 403, 404, 409, 422].includes(response.statusCode), response.body);
  assert.equal(typeof response.json().error.code, 'string', response.body);
}
function recipientBody(requestId = 'recipient') {
  return { requestId, displayName: '테스트 상대', channel: 'email' as const, address: 'contact@example.test', confirmed: true as const };
}
function contactBody(recipient: Recipient, proposals: Proposal[], requestId = 'contact') {
  return { requestId, recipientRef: recipient.id, channel: 'email' as const, purpose: '약속 시간 조정', messageOrCallBrief: '가능한 시간을 확인해 주세요.',
    allowedOptions: proposals.map((proposal, index) => ({ optionId: `option-${index + 1}`, proposalId: proposal.id, proposalRevision: proposal.revision })) };
}

function setup(t: TestContext) {
  const store = new MemoryPlanningStore();
  let now = fixedNow;
  const model: ModelPort = { async decide(input) {
    const [id, hour] = input.message.split('|');
    const item = (await store.read(input.userId)).items.get(id!);
    assert.ok(item && hour);
    const { id: targetId, revision, sourceRefs: _sourceRefs, ...fields } = item;
    const endHour = String(Number(hour) + 1).padStart(2, '0');
    return { kind: 'proposal', reason: '공동 약속 대안', evidenceRefs: [], changeSet: { changes: [{
      changeId: 'move', operation: 'update', targetId, expectedRevision: revision,
      after: { ...fields, timeSlot: { startsAt: `2026-11-02T${hour}:00+09:00`, endsAt: `2026-11-02T${endHour}:00+09:00`, timezone: 'Asia/Seoul' } },
    }] } };
  } };
  const fetchGuard = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external fetch'); });
  const app = buildApp({ sessions, model, store, clock: () => new Date(now) });
  t.after(async () => { await app.close(); assert.equal(fetchGuard.mock.callCount(), 0, 'contact tests must not call an external service'); });
  return { app, store, setNow(value: string) { now = value; } };
}

async function seed(app: App) {
  const response = await post(app, '/v1/schedule/commands', { requestId: 'seed', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'first', operation: 'create', after: event },
    { changeId: 'second', operation: 'create', after: { ...event, title: '다른 공동 약속', timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T18:00+09:00', endsAt: '2026-11-02T19:00+09:00' } } },
  ] } }, 'seed');
  assertOk(response);
  return response.json().data.items as ScheduleItem[];
}
async function propose(app: App, item: ScheduleItem, hour: string, key: string): Promise<Proposal> {
  const response = await post(app, '/v1/chat', { requestId: key, conversationId: null, message: `${item.id}|${hour}`, timezone: 'Asia/Seoul',
    coordinationTarget: { id: item.id, expectedRevision: item.revision } }, key);
  assertOk(response);
  assert.equal(response.json().data.result.kind, 'proposal', response.body);
  const proposalResponse = await get(app, `/v1/proposals/${response.json().data.result.proposalIds[0]}`);
  assertOk(proposalResponse);
  const proposal = proposalResponse.json().data.proposal as Proposal;
  assert.equal(proposal.mode, 'coordination');
  assert.equal(proposal.validation.valid, true);
  assert.deepEqual(proposal.coordinationTarget, { id: item.id, expectedRevision: item.revision });
  return proposal;
}
async function fixture(t: TestContext) {
  const context = setup(t);
  const [first, second] = await seed(context.app);
  assert.ok(first && second);
  const morning = await propose(context.app, first, '10', 'proposal-morning');
  const noon = await propose(context.app, first, '12', 'proposal-noon');
  return { ...context, first, second, proposals: [morning, noon] };
}
async function register(app: App, key = 'recipient', user = 'alice') {
  const response = await post(app, '/v1/recipients', recipientBody(key), key, user);
  assertOk(response);
  return response.json().data.recipient as Recipient;
}
async function createContact(app: App, recipient: Recipient, proposals: Proposal[], key = 'contact') {
  const response = await post(app, '/v1/contact-requests', contactBody(recipient, proposals, key), key);
  assertOk(response);
  return response.json().data.contactRequest as ContactRequest;
}
async function schedule(app: App) {
  const response = await get(app, `/v1/schedule?${range}`);
  assertOk(response);
  return response.json().data;
}
async function contactApprovals(store: MemoryPlanningStore) {
  const state = await store.read('alice');
  return (state as unknown as ContactCollections).contactApprovals;
}
async function assertNoApprovalOrScheduleChange(store: MemoryPlanningStore, app: App, before: unknown, contactId: string) {
  assert.deepEqual(await schedule(app), before);
  assert.equal((await contactApprovals(store)).length, 0);
  const response = await get(app, `/v1/contact-requests/${contactId}`);
  assertOk(response);
  assert.notEqual(response.json().data.contactRequest.deliveryStatus, 'ready');
  assert.equal(response.json().data.contactRequest.approvalId, null);
}

test('fixture creates separate domain-validated alternatives for the same unchanged shared event', async t => {
  const { app, first, proposals } = await fixture(t);
  assert.notEqual(proposals[0]!.id, proposals[1]!.id);
  assert.notDeepEqual(proposals[0]!.changeSet, proposals[1]!.changeSet);
  assert.equal(proposals[0]!.status, 'pending');
  assert.equal(proposals[1]!.status, 'pending');
  assert.equal(proposals[0]!.baseScheduleRevision, proposals[1]!.baseScheduleRevision);
  assert.equal(proposals[0]!.baseContextRevision, proposals[1]!.baseContextRevision);
  assert.deepEqual((await schedule(app)).items.find((item: ScheduleItem) => item.id === first.id), first);
});

test('recipient registration requires confirmation and a valid email or phone number', async t => {
  const { app } = setup(t);
  for (const [key, body] of [
    ['unconfirmed', { ...recipientBody(), confirmed: false }],
    ['missing-confirmation', (({ confirmed: _confirmed, ...rest }) => rest)(recipientBody())],
    ['invalid-email', { ...recipientBody(), address: 'not-an-email' }],
    ['email-local-too-long', { ...recipientBody(), address: `${'a'.repeat(65)}@example.test` }],
    ['email-label-too-long', { ...recipientBody(), address: `a@${'a'.repeat(64)}.test` }],
    ['invalid-phone', { ...recipientBody(), channel: 'phone', address: '01012345678' }],
  ] as const) {
    const response = await post(app, '/v1/recipients', body, key);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'invalid_request');
  }
  const phone = await post(app, '/v1/recipients', { ...recipientBody(), channel: 'phone', address: '+821012345678' }, 'phone');
  assert.equal(phone.statusCode, 200, phone.body);
  assert.equal(phone.json().data.recipient.address, '+821012345678');
  const recipient = await register(app);
  assert.ok(recipient.id);
  assert.deepEqual({ displayName: recipient.displayName, channel: recipient.channel, address: recipient.address },
    { displayName: '테스트 상대', channel: 'email', address: 'contact@example.test' });
  assert.equal(recipient.confirmedByUserAt, fixedNow);
});

test('recipient writes replay by user and operation, reject conflicting bodies, and do not grant a spoofed user', async t => {
  const { app, proposals } = await fixture(t);
  const first = await post(app, '/v1/recipients', recipientBody('first-trace'), 'same-key');
  assertOk(first);
  const replay = await post(app, '/v1/recipients', { ...recipientBody('retry-trace') }, 'same-key');
  assert.deepEqual(replay.json(), first.json());
  const conflict = await post(app, '/v1/recipients', { ...recipientBody('other-trace'), address: 'other@example.test' }, 'same-key');
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
  const bob = await post(app, '/v1/recipients', recipientBody('bob-trace'), 'same-key', 'bob');
  assertOk(bob);
  assert.notEqual(bob.json().data.recipient.id, first.json().data.recipient.id);
  const differentOperation = await post(app, '/v1/contact-requests', contactBody(first.json().data.recipient, proposals), 'same-key');
  assertOk(differentOperation);
  const spoof = await post(app, '/v1/recipients', { ...recipientBody(), userId: 'bob' }, 'spoof');
  assert.equal(spoof.statusCode, 400, spoof.body);
});

test('a valid contact draft preserves the confirmed target and all alternatives without sending', async t => {
  const { app, store, proposals } = await fixture(t);
  const recipient = await register(app);
  const before = await schedule(app);
  const input = contactBody(recipient, proposals);
  const response = await post(app, '/v1/contact-requests', input, 'contact');
  assertOk(response);
  const contact = response.json().data.contactRequest as ContactRequest;
  assert.ok(contact.id && contact.executionKey);
  assert.equal(contact.revision, 1);
  assert.equal(contact.baseScheduleRevision, proposals[0]!.baseScheduleRevision);
  assert.equal(contact.baseContextRevision, proposals[0]!.baseContextRevision);
  assert.equal(contact.recipientRef, recipient.id);
  assert.deepEqual(contact.recipientSnapshot, { displayName: recipient.displayName, channel: recipient.channel, address: recipient.address });
  assert.equal(contact.channel, input.channel);
  assert.equal(contact.purpose, input.purpose);
  assert.equal(contact.messageOrCallBrief, input.messageOrCallBrief);
  assert.deepEqual(contact.allowedOptions, input.allowedOptions);
  assert.equal(contact.approvalId, null);
  assert.equal(contact.providerOperationId, null);
  assert.equal(contact.deliveryStatus, 'pending_approval');
  assert.equal(contact.negotiationStatus, 'not_started');
  assert.equal(contact.createdAt, fixedNow);
  const fetched = await get(app, `/v1/contact-requests/${contact.id}`);
  assertOk(fetched);
  assert.deepEqual(fetched.json().data.contactRequest, contact);
  assert.deepEqual((await store.read('alice')).contactDraftSnapshots.get(contact.id), { subject: contact, proposals });
  assert.deepEqual(await schedule(app), before);
});

test('a previously accepted coordination proposal can be offered alongside a pending alternative', async t => {
  const { app, proposals } = await fixture(t);
  const before = await schedule(app);
  const approval = await post(app, `/v1/proposals/${proposals[0]!.id}/decision`,
    { requestId: 'proposal-decision', proposalRevision: proposals[0]!.revision, decision: 'accept' }, 'proposal-decision');
  assertOk(approval);
  assert.equal(approval.json().data.outcome, 'awaiting_contact');
  const awaiting = approval.json().data.proposal as Proposal;
  const recipient = await register(app);
  const contact = await createContact(app, recipient, [awaiting, proposals[1]!]);
  assert.deepEqual(contact.allowedOptions, contactBody(recipient, [awaiting, proposals[1]!]).allowedOptions);
  assert.deepEqual(await schedule(app), before);
});

test('contact creation replays the first result and rejects a changed message or alternatives under the same key', async t => {
  const { app, proposals } = await fixture(t);
  const recipient = await register(app);
  const input = contactBody(recipient, proposals, 'first');
  const first = await post(app, '/v1/contact-requests', input, 'contact-key');
  assertOk(first);
  const replay = await post(app, '/v1/contact-requests', { ...input, requestId: 'retry' }, 'contact-key');
  assert.deepEqual(replay.json(), first.json());
  for (const changed of [{ ...input, messageOrCallBrief: '다른 내용' }, { ...input, allowedOptions: input.allowedOptions.slice(0, 1) }]) {
    const conflict = await post(app, '/v1/contact-requests', changed, 'contact-key');
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, 'idempotency_conflict');
  }
});

test('the approved subject rejects header controls and malformed Unicode', async t => {
  const { app, proposals } = await fixture(t);
  const recipient = await register(app);
  for (const [key, purpose] of [['newline', '제목\r\nBcc: other@example.test'], ['control', '제목\u0000'], ['surrogate', '\ud800']] as const) {
    const response = await post(app, '/v1/contact-requests', { ...contactBody(recipient, proposals), purpose }, `invalid-${key}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'invalid_request');
  }
});

test('recipients, proposals, contact reads, and decisions are isolated by authenticated user', async t => {
  const { app, proposals } = await fixture(t);
  const alice = await register(app, 'alice-recipient');
  const bob = await register(app, 'bob-recipient', 'bob');
  const aliceContact = await createContact(app, alice, proposals);
  const foreignRecipient = await post(app, '/v1/contact-requests', contactBody(bob, proposals), 'foreign-recipient');
  assertRejected(foreignRecipient);
  const foreignProposal = await post(app, '/v1/contact-requests', contactBody(bob, proposals), 'foreign-proposal', 'bob');
  assertRejected(foreignProposal);
  assert.equal((await get(app, `/v1/contact-requests/${aliceContact.id}`, 'bob')).statusCode, 404);
  const foreignDecision = await post(app, `/v1/contact-requests/${aliceContact.id}/decision`,
    { requestId: 'foreign', contactRevision: aliceContact.revision, decision: 'accept' }, 'foreign-decision', 'bob');
  assert.equal(foreignDecision.statusCode, 404, foreignDecision.body);
  assert.equal((await get(app, `/v1/contact-requests/${aliceContact.id}`)).json().data.contactRequest.deliveryStatus, 'pending_approval');
});

test('contact alternatives must share a target and name the current proposal revisions', async t => {
  const { app, second, proposals } = await fixture(t);
  const otherTarget = await propose(app, second, '10', 'other-target');
  const recipient = await register(app);
  const wrongTarget = await post(app, '/v1/contact-requests', contactBody(recipient, [proposals[0]!, otherTarget]), 'wrong-target');
  assertRejected(wrongTarget);
  const wrongVersion = contactBody(recipient, proposals);
  wrongVersion.allowedOptions[1]!.proposalRevision++;
  const wrongRevision = await post(app, '/v1/contact-requests', wrongVersion, 'wrong-revision');
  assertRejected(wrongRevision);
  const valid = contactBody(recipient, proposals);
  const duplicateProposal = { ...valid, allowedOptions: [valid.allowedOptions[0]!, { ...valid.allowedOptions[0]!, optionId: 'another-option' }] };
  const duplicateOption = { ...valid, allowedOptions: [valid.allowedOptions[0]!, { ...valid.allowedOptions[1]!, optionId: valid.allowedOptions[0]!.optionId }] };
  for (const [key, body] of [['empty', { ...valid, allowedOptions: [] }], ['duplicate-proposal', duplicateProposal], ['duplicate-option', duplicateOption]] as const) {
    assertRejected(await post(app, '/v1/contact-requests', body, key));
  }
});

for (const change of ['context', 'schedule'] as const) {
  test(`contact alternatives with different ${change} baselines are rejected`, async t => {
    const { app, first, proposals } = await fixture(t);
    const recipient = await register(app);
    if (change === 'context') {
      const response = await post(app, '/v1/memory', { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'preference', value: '새 맥락', validUntil: null }, 'memory');
      assertOk(response);
    } else {
      const response = await post(app, '/v1/schedule/commands', { requestId: 'new-event', expectedScheduleRevision: 1,
        changeSet: { changes: [{ changeId: 'new', operation: 'create', after: { ...event, title: '추가 일정', involvement: 'personal',
          timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T21:00+09:00', endsAt: '2026-11-02T22:00+09:00' } } }] } }, 'new-event');
      assertOk(response);
    }
    const newer = await propose(app, first, '12', `newer-${change}`);
    assert.notEqual(change === 'context' ? newer.baseContextRevision : newer.baseScheduleRevision,
      change === 'context' ? proposals[0]!.baseContextRevision : proposals[0]!.baseScheduleRevision);
    const mixed = await post(app, '/v1/contact-requests', contactBody(recipient, [proposals[0]!, newer]), `mixed-${change}`);
    assertRejected(mixed);
  });
}

test('expired proposals cannot form a contact draft or be approved after a draft is created', async t => {
  const { app, store, proposals, setNow } = await fixture(t);
  const recipient = await register(app);
  const contact = await createContact(app, recipient, proposals);
  const before = await schedule(app);
  setNow(proposals[0]!.expiresAt!);
  const draft = await post(app, '/v1/contact-requests', contactBody(recipient, proposals), 'expired-draft');
  assertRejected(draft);
  const decision = await post(app, `/v1/contact-requests/${contact.id}/decision`,
    { requestId: 'expired', contactRevision: contact.revision, decision: 'accept' }, 'expired-decision');
  assertRejected(decision);
  await assertNoApprovalOrScheduleChange(store, app, before, contact.id);
});

for (const change of ['expired', 'context', 'schedule', 'recipient', 'proposal-removed'] as const) {
  test(`a ${change} contact can be rejected and replayed without changing the schedule`, async t => {
    const { app, store, proposals, setNow } = await fixture(t);
    const recipient = await register(app);
    const contact = await createContact(app, recipient, proposals);
    if (change === 'expired') setNow(proposals[0]!.expiresAt!);
    if (change === 'context') {
      assertOk(await post(app, '/v1/memory', { requestId: 'memory', expectedContextRevision: 0,
        kind: 'preference', key: 'changed', value: true, validUntil: null }, 'memory'));
    }
    if (change === 'schedule') {
      assertOk(await post(app, '/v1/schedule/commands', { requestId: 'new-event', expectedScheduleRevision: 1,
        changeSet: { changes: [{ changeId: 'new', operation: 'create', after: { ...event, title: '추가 일정', involvement: 'personal',
          timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T21:00+09:00', endsAt: '2026-11-02T22:00+09:00' } } }] } }, 'new-event'));
    }
    if (change === 'recipient') await store.transaction('alice', state => { state.recipients.get(recipient.id)!.address = 'changed@example.test'; });
    if (change === 'proposal-removed') await store.transaction('alice', state => { state.proposals.delete(proposals[0]!.id); });
    const before = await schedule(app);
    const url = `/v1/contact-requests/${contact.id}/decision`;
    const body = { requestId: 'reject', contactRevision: contact.revision, decision: 'reject' };
    const accept = await post(app, url, { ...body, decision: 'accept' }, `accept-${change}`);
    assertRejected(accept);
    const response = await post(app, url, body, `reject-${change}`);
    assertOk(response);
    const rejected = response.json().data.contactRequest as ContactRequest;
    assert.equal(rejected.deliveryStatus, 'rejected');
    assert.equal(rejected.negotiationStatus, 'not_started');
    assert.equal(rejected.revision, contact.revision);
    assert.equal(rejected.providerOperationId, null);
    const approvals = await contactApprovals(store);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.approval.decision, 'reject');
    assert.equal(rejected.approvalId, approvals[0]!.approval.id);
    assert.deepEqual(approvals[0]!.subject, contact);
    assert.deepEqual(approvals[0]!.proposals, proposals);
    assert.deepEqual(await schedule(app), before);
    const replay = await post(app, url, { ...body, requestId: 'retry' }, `reject-${change}`);
    assert.deepEqual(replay.json(), response.json());
    assertRejected(await post(app, url, body, `other-reject-${change}`));
    assert.equal((await contactApprovals(store)).length, 1);
    assert.deepEqual(await schedule(app), before);
  });
}

test('reject still requires the owner, matching revision and unchanged pending draft', async t => {
  const { app, store, proposals } = await fixture(t);
  const recipient = await register(app);
  const contact = await createContact(app, recipient, proposals);
  const before = await schedule(app);
  const url = `/v1/contact-requests/${contact.id}/decision`;
  const body = { requestId: 'reject', contactRevision: contact.revision, decision: 'reject' };
  assert.equal((await post(app, url, body, 'foreign-reject', 'bob')).statusCode, 404);
  assertRejected(await post(app, url, { ...body, contactRevision: contact.revision + 1 }, 'stale-revision-reject'));
  await store.transaction('alice', state => { state.contactRequests.get(contact.id)!.messageOrCallBrief = '원본과 다른 내용'; });
  assertRejected(await post(app, url, body, 'changed-draft-reject'));
  assert.equal((await contactApprovals(store)).length, 0);
  assert.deepEqual(await schedule(app), before);
});

for (const missing of ['draft', 'proposal snapshots'] as const) {
  test(`reject cannot proceed without the saved ${missing}`, async t => {
    const { app, store, proposals } = await fixture(t);
    const recipient = await register(app);
    const contact = await createContact(app, recipient, proposals);
    const before = await schedule(app);
    await store.transaction('alice', state => {
      if (missing === 'draft') state.contactDraftSnapshots.delete(contact.id);
      else state.contactDraftSnapshots.get(contact.id)!.proposals = undefined as unknown as Proposal[];
    });
    const response = await post(app, `/v1/contact-requests/${contact.id}/decision`,
      { requestId: 'reject', contactRevision: contact.revision, decision: 'reject' }, `missing-${missing}`);
    assertRejected(response);
    assert.equal((await contactApprovals(store)).length, 0);
    assert.deepEqual(await schedule(app), before);
  });
}

test('approval fails if a proposal expires while it is being validated', async t => {
  const { app, store, proposals } = await fixture(t);
  const recipient = await register(app);
  const contact = await createContact(app, recipient, proposals);
  const before = await schedule(app);
  const expiry = proposals[0]!.expiresAt!;
  const almostExpired = new Date(Date.parse(expiry) - 1);
  const service = new ContactService(store, new PlanningService(store, () => almostExpired), () => new Date(expiry));
  await assert.rejects(service.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' }),
    (error: any) => error.code === 'expired_proposal');
  await assertNoApprovalOrScheduleChange(store, app, before, contact.id);
});

test('approval fails if an active preference expires while it is being validated', async t => {
  const { app, store } = setup(t);
  const [first] = await seed(app); assert.ok(first);
  const expires = '2026-10-31T12:10:00.000Z';
  assertOk(await post(app, '/v1/memory', { requestId: 'preference', expectedContextRevision: 0, kind: 'preference', key: '시간', value: '오전', validUntil: expires }, 'preference'));
  const proposal = await propose(app, first, '10', 'proposal');
  assert.ok(Date.parse(proposal.expiresAt!) > Date.parse(expires));
  const recipient = await register(app);
  const contact = await createContact(app, recipient, [proposal]);
  const before = await schedule(app);
  const service = new ContactService(store, new PlanningService(store, () => new Date(Date.parse(expires) - 1)), () => new Date(expires));
  await assert.rejects(service.decide('alice', contact.id, { contactRevision: contact.revision, decision: 'accept' }),
    (error: any) => error.code === 'stale_proposal');
  await assertNoApprovalOrScheduleChange(store, app, before, contact.id);
});

for (const change of ['context', 'schedule'] as const) {
  test(`a changed ${change} baseline prevents contact approval`, async t => {
    const { app, store, proposals } = await fixture(t);
    const recipient = await register(app);
    const contact = await createContact(app, recipient, proposals);
    if (change === 'context') {
      assertOk(await post(app, '/v1/memory', { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'changed', value: true, validUntil: null }, 'memory'));
    } else {
      assertOk(await post(app, '/v1/schedule/commands', { requestId: 'new-event', expectedScheduleRevision: 1,
        changeSet: { changes: [{ changeId: 'new', operation: 'create', after: { ...event, title: '추가 일정', involvement: 'personal',
          timeSlot: { ...event.timeSlot!, startsAt: '2026-11-02T21:00+09:00', endsAt: '2026-11-02T22:00+09:00' } } }] } }, 'new-event'));
    }
    const beforeDecision = await schedule(app);
    const response = await post(app, `/v1/contact-requests/${contact.id}/decision`,
      { requestId: 'stale', contactRevision: contact.revision, decision: 'accept' }, 'stale');
    assertRejected(response);
    await assertNoApprovalOrScheduleChange(store, app, beforeDecision, contact.id);
  });
}

test('a changed recipient, proposal, or draft cannot be approved using the old contact snapshot', async t => {
  for (const changed of ['recipient', 'proposal-revision', 'proposal-content', 'draft-message', 'draft-options', 'draft-recipient'] as const) {
    await t.test(changed, async child => {
      const { app, store, proposals } = await fixture(child);
      const recipient = await register(app);
      const contact = await createContact(app, recipient, proposals);
      const before = await schedule(app);
      let replacement: Recipient | undefined;
      if (changed === 'draft-recipient') {
        const response = await post(app, '/v1/recipients', { ...recipientBody(), address: 'replacement@example.test' }, 'replacement');
        assertOk(response);
        replacement = response.json().data.recipient as Recipient;
      }
      await store.transaction('alice', state => {
        if (changed === 'recipient') {
          const recipients = (state as unknown as ContactCollections).recipients;
          assert.ok(recipients instanceof Map, 'memory store must expose recipients for this tamper fixture');
          const current = recipients.get(recipient.id);
          assert.ok(current);
          current.address = 'changed@example.test';
        } else if (changed.startsWith('draft-')) {
          const contacts = (state as unknown as ContactCollections).contactRequests;
          const current = contacts.get(contact.id);
          assert.ok(current);
          if (changed === 'draft-message') current.messageOrCallBrief = '승인 화면과 다른 내용';
          if (changed === 'draft-options') current.allowedOptions.pop();
          if (changed === 'draft-recipient') {
            assert.ok(replacement);
            current.recipientRef = replacement.id;
            current.recipientSnapshot = { displayName: replacement.displayName, channel: replacement.channel, address: replacement.address };
          }
        } else {
          const proposal = state.proposals.get(proposals[0]!.id);
          assert.ok(proposal);
          if (changed === 'proposal-revision') proposal.revision++;
          else {
            const change = proposal.changeSet.changes[0];
            assert.ok(change && change.operation === 'update' && change.after.timeSlot);
            change.after.timeSlot = { ...change.after.timeSlot, startsAt: '2026-11-02T11:00+09:00', endsAt: '2026-11-02T12:00+09:00' };
          }
        }
      });
      const response = await post(app, `/v1/contact-requests/${contact.id}/decision`,
        { requestId: 'changed', contactRevision: contact.revision, decision: 'accept' }, 'changed');
      assertRejected(response);
      await assertNoApprovalOrScheduleChange(store, app, before, contact.id);
    });
  }
});

for (const decision of ['accept', 'reject'] as const) {
  test(`${decision} records the complete approval snapshot, replays once, and leaves the schedule unchanged`, async t => {
    const { app, store, proposals } = await fixture(t);
    const recipient = await register(app);
    const contact = await createContact(app, recipient, proposals);
    const before = await schedule(app);
    const url = `/v1/contact-requests/${contact.id}/decision`;
    const input = { requestId: 'decision', contactRevision: contact.revision, decision };
    const response = await post(app, url, input, 'decision-key');
    assertOk(response);
    const decided = response.json().data.contactRequest as ContactRequest;
    assert.equal(decided.deliveryStatus, decision === 'accept' ? 'ready' : 'rejected');
    assert.equal(decided.negotiationStatus, 'not_started');
    assert.equal(decided.revision, contact.revision);
    assert.equal(decided.providerOperationId, null);
    const approvals = await contactApprovals(store);
    assert.equal(approvals.length, 1);
    const record = approvals[0]!;
    assert.equal(record.approval.subjectId, contact.id);
    assert.equal(record.approval.subjectRevision, contact.revision);
    assert.equal(record.approval.decision, decision);
    assert.equal(record.approval.actorRef, 'alice');
    assert.equal(record.approval.decidedAt, fixedNow);
    if (decision === 'accept') assert.equal(decided.approvalId, record.approval.id);
    for (const field of ['recipientRef', 'recipientSnapshot', 'channel', 'purpose', 'messageOrCallBrief', 'allowedOptions'] as const) {
      assert.deepEqual(record.subject[field], contact[field], field);
    }
    assert.deepEqual(record.proposals, proposals, 'approval must preserve the full alternatives as well as their references');
    const replay = await post(app, url, { ...input, requestId: 'retry' }, 'decision-key');
    assert.deepEqual(replay.json(), response.json());
    const conflict = await post(app, url, { ...input, decision: decision === 'accept' ? 'reject' : 'accept' }, 'decision-key');
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, 'idempotency_conflict');
    const repeated = await post(app, url, { ...input, requestId: 'new-intent' }, 'another-key');
    assertRejected(repeated);
    assert.equal((await contactApprovals(store)).length, 1);
    assert.deepEqual(await schedule(app), before);
    await store.transaction('alice', state => {
      const contacts = (state as unknown as ContactCollections).contactRequests;
      assert.ok(contacts instanceof Map, 'memory store must expose contactRequests for this tamper fixture');
      const current = contacts.get(contact.id);
      assert.ok(current);
      current.recipientSnapshot.address = 'changed@example.test';
      current.messageOrCallBrief = '변경된 내용';
      current.allowedOptions.pop();
      state.proposals.get(proposals[0]!.id)!.reason = '변경된 대안';
    });
    assert.deepEqual((await contactApprovals(store))[0], record, 'approval subject and alternatives must be independent snapshots');
  });
}

test('decision rejects a stale contact revision and cannot replace the approved target or content in the decision body', async t => {
  const { app, store, proposals } = await fixture(t);
  const recipient = await register(app);
  const contact = await createContact(app, recipient, proposals);
  const before = await schedule(app);
  const url = `/v1/contact-requests/${contact.id}/decision`;
  const stale = await post(app, url, { requestId: 'stale', contactRevision: contact.revision + 1, decision: 'accept' }, 'stale-revision');
  assertRejected(stale);
  for (const [key, extra] of Object.entries({ recipient: { recipientRef: 'other' }, message: { messageOrCallBrief: '다른 내용' }, options: { allowedOptions: [] } })) {
    const changed = await post(app, url, { requestId: key, contactRevision: contact.revision, decision: 'accept', ...extra }, key);
    assert.equal(changed.statusCode, 400, changed.body);
  }
  await assertNoApprovalOrScheduleChange(store, app, before, contact.id);
});

test('all contact writes require requestId and an idempotency key', async t => {
  const { app, proposals } = await fixture(t);
  const recipient = await register(app);
  const contact = await createContact(app, recipient, proposals);
  const cases = [
    { url: '/v1/recipients', payload: recipientBody() },
    { url: '/v1/contact-requests', payload: contactBody(recipient, proposals) },
    { url: `/v1/contact-requests/${contact.id}/decision`, payload: { requestId: 'decision', contactRevision: contact.revision, decision: 'accept' } },
  ];
  for (const [index, item] of cases.entries()) {
    const missingKey = await app.inject({ method: 'POST', url: item.url, headers: { authorization: 'Bearer alice' }, payload: item.payload });
    assert.equal(missingKey.statusCode, 400, missingKey.body);
    const { requestId: _requestId, ...withoutId } = item.payload;
    const missingId = await post(app, item.url, withoutId, `missing-id-${index}`);
    assert.equal(missingId.statusCode, 400, missingId.body);
  }
});
