import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { ContactResponseService } from '../src/contact-response.ts';
import { ContactService } from '../src/contact-service.ts';
import { findCalendarContactAuthorization, type CalendarContactSource } from '../src/calendar-contact-authorization.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore, type UserPlanningState } from '../src/planning-store.ts';

const userId = 'member:alice';
const source: CalendarContactSource = { accountRef: 'google:synthetic', calendarId: 'calendar', externalEventId: 'event', sourceVersion: 'etag-1' };
const fixed = '2026-10-31T12:00:00.000Z';
const clock = () => new Date(fixed);
const event: ScheduleFields = { kind: 'event', title: '공동 일정', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };

async function fixture(channel: 'email' | 'phone' = 'email', apply = true, legacyNulls = false) {
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const planning = new PlanningService(store, clock); const contacts = new ContactService(store, planning, clock);
  const responses = new ContactResponseService(store, planning, clock);
  const made = await planning.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: legacyNulls ? event : { ...event, category: 'work', attendance: 'attended' } }] } });
  const id = made.items[0]!.id;
  await store.transaction(userId, state => { state.items.get(id)!.sourceRefs.push({ provider: 'google_calendar', ...source, lastSyncedAt: fixed }); });
  const before = (await store.read(userId)).items.get(id)!;
  const baseline = await planning.capture(userId, 'Asia/Seoul', { id, expectedRevision: before.revision });
  const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '대안', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: id, expectedRevision: before.revision,
    after: { ...event, ...(legacyNulls ? { category: null, attendance: null } : {}), timeSlot: { ...event.timeSlot!, startsAt: '2026-11-03T10:00+09:00', endsAt: '2026-11-03T11:00+09:00' } },
  }] } });
  if (proposal.kind !== 'proposal') throw new Error('Synthetic proposal failed');
  const address = channel === 'email' ? 'other@example.test' : '+12025550124';
  const { recipient } = await contacts.createRecipient(userId, { displayName: '상대', channel, address, confirmed: true });
  const { contactRequest } = await contacts.create(userId, { recipientRef: recipient.id, channel, purpose: '일정 변경', messageOrCallBrief: '시간 확인',
    allowedOptions: [{ optionId: 'option', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] });
  await contacts.decide(userId, contactRequest.id, { contactRevision: 1, decision: 'accept' });
  const dispatch = new ContactDispatch(store, planning, { userId, senderAddress: 'sender@example.test', async dispatch(_input, _signal, beforeSend) {
    await beforeSend?.(); return { status: 'submitted', providerOperationId: 'operation' };
  } }, clock, channel);
  const sent = await dispatch.send(userId, contactRequest.id, { requestId: 'send', contactRevision: 1, expectedSenderAddress: 'sender@example.test' }, 'send');
  assert.equal(sent.status, 200);
  const received = await responses.recordVerified(userId, contactRequest.id, { providerEventId: 'response', providerOperationId: 'operation',
    channel, recipientAddress: address, receivedAt: fixed, outcome: channel === 'phone' ? 'accepted' : 'unclear',
    selectedOptionId: channel === 'phone' ? 'option' : null, evidenceRef: 'evidence',
    displayText: channel === 'email' ? '가능합니다' : null, reviewReason: channel === 'email' ? 'sender_unverified' : null });
  if (apply && channel === 'email') await responses.confirm(userId, contactRequest.id, { responseId: received.response.id, contactRevision: 1, selectedOptionId: 'option' });
  const state = await store.read(userId);
  return { state, before, item: state.items.get(id)!, contactId: contactRequest.id, proposalId: proposal.proposalIds[0]! };
}

test('real contact services: reviewed email and verified phone acceptance prove only the applied shared time change', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external calls'); });
  for (const channel of ['email', 'phone'] as const) {
    const f = await fixture(channel);
    assert.equal(f.item.category, 'work'); assert.equal(f.item.attendance, 'attended');
    const proof = findCalendarContactAuthorization({ state: f.state, userId, item: f.item, source });
    assert.deepEqual(proof, { beforeItem: f.before, afterItem: f.item, proposalId: f.proposalId, contactRequestId: f.contactId });
    proof!.beforeItem.title = 'mutated returned proof';
    assert.equal(f.state.items.get(f.item.id)?.title, '공동 일정');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('legacy missing category and attendance are equivalent to explicit null for contact authorization', async () => {
  const f = await fixture('email', true, true);
  assert.ok(findCalendarContactAuthorization({ state: f.state, userId, item: f.item, source }));
});

test('unconfirmed or altered history, identity, versions and source mapping fail closed', async () => {
  const pending = await fixture('email', false);
  assert.equal(findCalendarContactAuthorization({ state: pending.state, userId, item: pending.item, source }), null);
  const f = await fixture();
  type Case = { name: string; change: (state: UserPlanningState) => void };
  const cases: Case[] = [
    { name: 'contact not applied', change: s => { s.contactRequests.get(f.contactId)!.negotiationStatus = 'needs_user_review'; } },
    { name: 'wrong approval actor', change: s => { s.contactApprovals[0]!.approval.actorRef = 'member:bob'; } },
    { name: 'approval rejected', change: s => { s.contactApprovals[0]!.approval.decision = 'reject'; } },
    { name: 'altered draft', change: s => { s.contactDraftSnapshots.get(f.contactId)!.subject.purpose = '다른 목적'; } },
    { name: 'changed allowed option', change: s => { s.contactRequests.get(f.contactId)!.allowedOptions[0]!.optionId = 'other'; } },
    { name: 'missing manual confirmation', change: s => { delete [...s.contactResponses.values()][0]!.confirmed; } },
    { name: 'confirmation by another actor', change: s => { [...s.contactResponses.values()][0]!.confirmed!.actorRef = 'member:bob'; } },
    { name: 'different selected option', change: s => { [...s.contactResponses.values()][0]!.confirmed!.selectedOptionId = 'other'; } },
    { name: 'wrong provider operation', change: s => { [...s.contactResponses.values()][0]!.event.providerOperationId = 'other'; } },
    { name: 'altered event', change: s => { [...s.contactResponses.values()][0]!.event.displayText = '변조'; } },
    { name: 'not applied proposal', change: s => { s.proposals.get(f.proposalId)!.status = 'pending'; } },
    { name: 'changed approved snapshot', change: s => { s.contactApprovals[0]!.proposals[0]!.reason = '변조'; } },
    { name: 'extra current change', change: s => { s.items.get(f.item.id)!.revision++; } },
    { name: 'current source version changed', change: s => { s.items.get(f.item.id)!.sourceRefs[0]!.sourceVersion = 'other'; } },
    { name: 'current title changed', change: s => { s.items.get(f.item.id)!.title = '다른 일정'; } },
  ];
  for (const scenario of cases) {
    const state = structuredClone(f.state); scenario.change(state);
    const item = state.items.get(f.item.id)!;
    assert.equal(findCalendarContactAuthorization({ state, userId, item, source }), null, scenario.name);
  }
  assert.equal(findCalendarContactAuthorization({ state: f.state, userId: 'member:bob', item: f.item, source }), null);
  for (const key of Object.keys(source) as (keyof CalendarContactSource)[]) {
    assert.equal(findCalendarContactAuthorization({ state: f.state, userId, item: f.item, source: { ...source, [key]: 'other' } }), null, key);
  }
  const stale = structuredClone(f.state);
  const expiry = '2026-10-31T11:59:00.000Z';
  stale.contactApprovals[0]!.proposals[0]!.expiresAt = expiry;
  stale.contactDraftSnapshots.get(f.contactId)!.proposals[0]!.expiresAt = expiry;
  stale.proposals.get(f.proposalId)!.expiresAt = expiry;
  assert.equal(findCalendarContactAuthorization({ state: stale, userId, item: f.item, source }), null);

  const changedIntoShared = structuredClone(f.state);
  for (const p of [changedIntoShared.contactApprovals[0]!.proposals[0]!, changedIntoShared.contactDraftSnapshots.get(f.contactId)!.proposals[0]!, changedIntoShared.proposals.get(f.proposalId)!]) {
    p.beforeItems[0]!.involvement = 'personal';
  }
  assert.equal(findCalendarContactAuthorization({ state: changedIntoShared, userId, item: f.item, source }), null);

  const laterReply = structuredClone(f.state);
  const next = structuredClone([...laterReply.contactResponses.values()][0]!);
  next.response.id = 'later-response'; next.response.receivedAt = '2026-10-31T12:00:01.000Z';
  laterReply.contactResponses.set('later', next);
  assert.equal(findCalendarContactAuthorization({ state: laterReply, userId, item: f.item, source }), null);
});

test('verified phone acceptance received at or after proposal expiry is not authorization', async () => {
  const f = await fixture('phone');
  const state = structuredClone(f.state);
  const accepted = [...state.contactResponses.values()][0]!;
  const expiry = state.contactApprovals[0]!.proposals[0]!.expiresAt!;
  accepted.event.receivedAt = expiry;
  accepted.response.receivedAt = expiry;
  assert.equal(findCalendarContactAuthorization({ state, userId, item: f.item, source }), null);
});
