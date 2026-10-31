import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChanges, type Change, type ChangeValidationContext, type ScheduleFields, type ScheduleItem } from '@pikku/domain';
import { changeSet } from '../src/planning-schemas.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { ContactService } from '../src/contact-service.ts';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { ContactResponseService } from '../src/contact-response.ts';
import { findCalendarContactAuthorization } from '../src/calendar-contact-authorization.ts';

const fields: ScheduleFields = { kind: 'event', title: '약속', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const item: ScheduleItem = { ...fields, location: '원래 장소', id: 'item', revision: 1, sourceRefs: [] };
const update = (after: ScheduleFields, target = item): Change => ({ changeId: 'update', operation: 'update', targetId: target.id, expectedRevision: target.revision, after });
const request = (target: ScheduleItem, after: ScheduleFields): ChangeValidationContext => ({ authenticatedUserId: 'user', snapshotUserId: 'user',
  snapshot: { now: '2026-11-01T00:00Z', timezone: 'UTC', scheduleRevision: 1, contextRevision: 1, items: [target], facts: [], missingFields: [] },
  changeSet: { changes: [update(after, target)] }, purpose: 'ai_proposal', checkedAt: '2026-11-01T00:00Z' });

test('location accepts optional nonempty text or null at API and domain boundaries', () => {
  for (const location of [undefined, null, '서울역', '😀'.repeat(2000)]) {
    const after = { ...fields, location };
    assert.equal(changeSet.safeParse({ changes: [update(after)] }).success, true);
    assert.equal(validateChanges(request(item, after)).conflicts.some(c => c.reason.endsWith('.location')), false);
  }
  for (const location of ['', '   ', 'x'.repeat(2001), 1]) {
    const after = { ...fields, location } as unknown as ScheduleFields;
    assert.equal(changeSet.safeParse({ changes: [update(after)] }).success, false);
    assert.ok(validateChanges(request(item, after)).conflicts.some(c => c.reason.endsWith('.location')));
  }
});

test('location participates in no-op detection and cannot bypass shared fixed coordination protection', () => {
  for (const after of [fields, { ...fields, location: '원래 장소' }]) {
    assert.ok(validateChanges(request(item, after)).conflicts.some(c => c.reason === 'no_effective_change'));
  }
  for (const location of ['새 장소', null]) assert.equal(validateChanges(request(item, { ...fields, location })).valid, true);
  const shared: ScheduleItem = { ...item, involvement: 'shared', flexibility: 'fixed' };
  const sameFields = { ...fields, involvement: 'shared' as const, flexibility: 'fixed' as const };
  const target = { id: shared.id, expectedRevision: shared.revision };
  assert.deepEqual(validateChanges({ ...request(shared, { ...sameFields, location: '새 장소' }), coordinationTarget: target }).protectedTargets, [shared.id]);
  const moved = { ...sameFields, location: '새 장소', timeSlot: { ...sameFields.timeSlot!, startsAt: '2026-11-03T15:00+09:00', endsAt: '2026-11-03T16:00+09:00' } };
  assert.ok(validateChanges({ ...request(shared, moved), coordinationTarget: target }).conflicts.some(c => c.reason === 'coordination_fields_changed'));
  assert.equal(validateChanges({ ...request(shared, { ...moved, location: undefined }), coordinationTarget: target }).valid, true);
});

test('commands preserve omitted location and clear explicit null', async () => {
  const store = new MemoryPlanningStore();
  const planning = new PlanningService(store, () => new Date('2026-11-01T00:00Z'));
  const created = await planning.command('user', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: { ...fields, location: '원래 장소' } }] } });
  const initial = created.items[0]!;
  const preserved = await planning.command('user', { expectedScheduleRevision: 1, changeSet: { changes: [update({ ...fields, title: '변경' }, initial)] } });
  assert.equal(preserved.items[0]!.location, '원래 장소');
  const explicitlyUndefined = await planning.command('user', { expectedScheduleRevision: 2, changeSet: { changes: [update({ ...fields, location: undefined }, preserved.items[0]!)] } });
  assert.equal(explicitlyUndefined.items[0]!.location, '원래 장소');
  const cleared = await planning.command('user', { expectedScheduleRevision: 3, changeSet: { changes: [update({ ...fields, location: null }, explicitlyUndefined.items[0]!)] } });
  assert.equal(cleared.items[0]!.location, null);
});

test('a direct user command can correct only the location of a shared fixed event', () => {
  const shared: ScheduleItem = { ...item, involvement: 'shared', flexibility: 'fixed' };
  const { id: _id, revision: _revision, sourceRefs: _sourceRefs, ...before } = shared;
  const input = request(shared, { ...before, location: '새 장소' });
  assert.equal(validateChanges({ ...input, purpose: 'user_command' }).valid, true);
});

test('shared time-change contact proof preserves location and rejects a forged location change', async () => {
  const memory = new MemoryPlanningStore();
  const store = { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const clock = () => new Date('2026-11-01T00:00Z');
  const planning = new PlanningService(store, clock);
  const contacts = new ContactService(store, planning, clock);
  const responses = new ContactResponseService(store, planning, clock);
  const source = { accountRef: 'google:synthetic', calendarId: 'calendar', externalEventId: 'event', sourceVersion: 'etag' };
  const beforeFields: ScheduleFields = { ...fields, flexibility: 'fixed', involvement: 'shared', location: '원래 장소' };
  const made = await planning.command('user', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: beforeFields }] } });
  const id = made.items[0]!.id;
  await store.transaction('user', state => { state.items.get(id)!.sourceRefs.push({ provider: 'google_calendar', ...source, lastSyncedAt: clock().toISOString() }); });
  const before = (await store.read('user')).items.get(id)!;
  const baseline = await planning.capture('user', 'Asia/Seoul', { id, expectedRevision: before.revision });
  const after: ScheduleFields = { ...fields, flexibility: 'fixed', involvement: 'shared', location: undefined,
    timeSlot: { ...fields.timeSlot!, startsAt: '2026-11-03T15:00+09:00', endsAt: '2026-11-03T16:00+09:00' } };
  const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '시간 변경', evidenceRefs: [], changeSet: { changes: [update(after, before)] } });
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  const { recipient } = await contacts.createRecipient('user', { displayName: '상대', channel: 'phone', address: '+12025550124', confirmed: true });
  const { contactRequest } = await contacts.create('user', { recipientRef: recipient.id, channel: 'phone', purpose: '시간 변경', messageOrCallBrief: '시간 확인',
    allowedOptions: [{ optionId: 'option', proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] });
  await contacts.decide('user', contactRequest.id, { contactRevision: 1, decision: 'accept' });
  const dispatch = new ContactDispatch(store, planning, { userId: 'user', senderAddress: 'sender@example.test', async dispatch(_input, _signal, beforeSend) {
    await beforeSend?.(); return { status: 'submitted', providerOperationId: 'operation' };
  } }, clock, 'phone');
  assert.equal((await dispatch.send('user', contactRequest.id, { requestId: 'send', contactRevision: 1, expectedSenderAddress: 'sender@example.test' }, 'send')).status, 200);
  await responses.recordVerified('user', contactRequest.id, { providerEventId: 'response', providerOperationId: 'operation', channel: 'phone',
    recipientAddress: '+12025550124', receivedAt: clock().toISOString(), outcome: 'accepted', selectedOptionId: 'option', evidenceRef: 'evidence' });
  const state = await store.read('user');
  const current = state.items.get(id)!;
  assert.equal(current.location, '원래 장소');
  assert.ok(findCalendarContactAuthorization({ state, userId: 'user', item: current, source }));
  for (const p of [state.contactApprovals[0]!.proposals[0]!, state.contactDraftSnapshots.get(contactRequest.id)!.proposals[0]!, state.proposals.get(proposal.proposalIds[0]!)!]) {
    const change = p.changeSet.changes[0]!;
    if (change.operation !== 'update') throw new Error('Expected update');
    change.after.location = '변조된 장소';
  }
  current.location = '변조된 장소';
  assert.equal(findCalendarContactAuthorization({ state, userId: 'user', item: current, source }), null);
});
