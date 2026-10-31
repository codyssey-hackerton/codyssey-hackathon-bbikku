import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import type { ScheduleItem } from '@pikku/domain';
import { CalendarSyncService } from '../src/calendar-sync.ts';
import { MemoryCalendarSyncStore, PostgresCalendarSyncStore, type CalendarSyncStore } from '../src/calendar-sync-store.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import { MemoryIdempotency } from '../src/idempotency.ts';
import { registerCalendarSyncRoutes } from '../src/calendar-sync-routes.ts';
import { PlanningError, PlanningService } from '../src/planning-service.ts';
import { buildApp } from '../src/app.ts';
import { CalendarImportService } from '../src/calendar-import.ts';
import { ContactService } from '../src/contact-service.ts';
import { ContactDispatch } from '../src/contact-dispatch.ts';
import { ContactResponseService } from '../src/contact-response.ts';
import type { GoogleCalendarEvent, GoogleCalendarEventWrite, getCalendarWriteConnection } from '../src/google-calendar-write.ts';

type Google = NonNullable<Awaited<ReturnType<typeof getCalendarWriteConnection>>>;
const slot = (hour: number) => ({ startsAt: `2030-01-01T${String(hour).padStart(2, '0')}:00:00Z`, endsAt: `2030-01-01T${String(hour + 1).padStart(2, '0')}:00:00Z`, timezone: 'UTC' });
const event = (id: string, hour: number): GoogleCalendarEvent => ({ id, etag: 'e1', status: 'confirmed', title: id, description: null,
  timeSlot: slot(hour), unsupported: { allDay: false, recurring: false, shared: false, other: false }, privateProperties: {} });
const item = (id: string, hour: number): ScheduleItem => ({ id, revision: 1, sourceRefs: [], kind: 'event', title: id, timeSlot: slot(hour),
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'unknown' });
function fixture(planning: PlanningStore = new MemoryPlanningStore(), sync: CalendarSyncStore = new MemoryCalendarSyncStore()) {
  const events = new Map<string, GoogleCalendarEvent>();
  let inserts = 0, updates = 0, deletes = 0, failInsert = false, expire = false;
  const google = {
    userId: 'alice', subject: 'subject', accountRef: 'google:hash',
    async listCalendars() { return { calendars: [{ id: 'cal', summary: 'Calendar', accessRole: 'owner' as const }] }; },
    async listEvents(input: { syncToken?: string }) {
      if (input.syncToken && expire) { expire = false; throw { code: 'sync_token_expired' }; }
      return { events: [...events.values()].map(e => structuredClone(e)), nextSyncToken: 'token' };
    },
    async getEvent(input: { eventId: string }) { const e = events.get(input.eventId); if (!e) throw { code: 'not_found' }; return structuredClone(e); },
    async insertEvent(input: { eventId: string; event: GoogleCalendarEventWrite }) {
      inserts++;
      if (failInsert) throw { code: 'outcome_unknown' };
      const e = { ...event(input.eventId, 15), title: input.event.title, timeSlot: input.event.timeSlot, privateProperties: input.event.privateProperties };
      events.set(e.id, e); return structuredClone(e);
    },
    async updateEvent(input: { eventId: string; etag: string; event: GoogleCalendarEventWrite }) {
      updates++;
      const before = events.get(input.eventId)!; assert.equal(before.etag, input.etag);
      const after = { ...before, etag: `e${updates + 1}`, title: input.event.title, timeSlot: input.event.timeSlot, privateProperties: input.event.privateProperties };
      events.set(input.eventId, after); return structuredClone(after);
    },
    async deleteEvent(input: { eventId: string; etag: string }) { assert.equal(events.get(input.eventId)?.etag, input.etag); deletes++; events.delete(input.eventId); },
  } as Google;
  const service = new CalendarSyncService(planning, sync, async userId => userId === 'alice' ? google : undefined);
  return { planning, sync, events, google, service, get inserts() { return inserts; }, get updates() { return updates; }, get deletes() { return deletes; },
    failInsert() { failInsert = true; }, expire() { expire = true; } };
}

async function sharedFixture(mode: 'mapped' | 'legacy' | 'legacy-delta', planningStore?: PlanningStore, syncStore?: CalendarSyncStore) {
  const f = fixture(planningStore, syncStore);
  const remote = { ...event('external', 9), organizerSelf: true, organizerIsAccount: true };
  remote.unsupported.shared = mode !== 'mapped';
  if (mode !== 'legacy-delta') f.events.set(remote.id, remote);
  else f.google.listEvents = async input => ({ events: input.syncToken ? [] : [...f.events.values()], nextSyncToken: 'token' });
  const clock = () => new Date('2029-12-31T12:00:00.000Z');
  const memory = f.planning;
  const durable: PlanningStore = memory.durable ? memory : { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const planning = new PlanningService(durable, clock);
  let itemId = '';
  const importShared = async () => {
    const readPort = { userId: 'alice', accountRef: 'google:subject', async resolveEvents() { return { events: [{ id: remote.id, etag: remote.etag!, title: remote.title!,
      startsAt: remote.timeSlot!.startsAt, endsAt: remote.timeSlot!.endsAt, timezone: 'UTC', involvement: 'shared' as const }] }; } };
    const imported = await new CalendarImportService(memory, readPort as never).importSelected({ userId: 'alice', calendarId: 'cal', from: '2030-01-01T00:00:00Z',
      to: '2030-01-02T00:00:00Z', selectedEvents: [{ id: remote.id, etag: remote.etag! }], expectedScheduleRevision: 0 });
    itemId = imported.items[0].id;
  };
  if (mode === 'legacy') await importShared();
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  const first = await f.service.run('alice', connection.id, { requestId: 'initial', expectedRevision: 1 }) as any;
  if (mode === 'legacy-delta') {
    assert.equal(first.imported, 0); assert.deepEqual(first.conflicts, []);
    f.events.set(remote.id, remote); await importShared();
  } else if (mode === 'mapped') {
    assert.equal(first.imported, 1);
    const original = [...(await memory.read('alice')).items.values()][0]; itemId = original.id;
    const { id, revision, sourceRefs: _refs, ...fields } = original;
    await planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'share', operation: 'update',
      targetId: id, expectedRevision: revision, after: { ...fields, involvement: 'shared' } }] } });
  } else assert.equal(first.conflicts[0].reason, 'contact_required');
  const shared = (await memory.read('alice')).items.get(itemId)!;
  const baseline = await planning.capture('alice', 'UTC', { id: itemId, expectedRevision: shared.revision });
  const { id: _id, revision: _rev, sourceRefs: _sources, ...fields } = shared;
  const proposed = await planning.saveProposal(baseline, { kind: 'proposal', reason: '시간 조정', evidenceRefs: [], changeSet: { changes: [{
    changeId: 'move', operation: 'update', targetId: itemId, expectedRevision: shared.revision, after: { ...fields, timeSlot: slot(12) } }] } });
  if (proposed.kind !== 'proposal') throw new Error('Synthetic proposal failed');
  const contacts = new ContactService(durable, planning, clock), responses = new ContactResponseService(durable, planning, clock);
  const { recipient } = await contacts.createRecipient('alice', { displayName: '상대', channel: 'phone', address: '+12025550124', confirmed: true });
  const { contactRequest: draft } = await contacts.create('alice', { recipientRef: recipient.id, channel: 'phone', purpose: '시간 조정', messageOrCallBrief: '시간 확인',
    allowedOptions: [{ optionId: 'option', proposalId: proposed.proposalIds[0], proposalRevision: 1 }] });
  await contacts.decide('alice', draft.id, { contactRevision: draft.revision, decision: 'accept' });
  const dispatch = new ContactDispatch(durable, planning, { userId: 'alice', senderAddress: 'sender@example.test', async dispatch(_input, _signal, beforeSend) {
    await beforeSend?.(); return { status: 'submitted', providerOperationId: 'operation' };
  } }, clock, 'phone');
  assert.equal((await dispatch.send('alice', draft.id, { requestId: 'send', contactRevision: draft.revision, expectedSenderAddress: 'sender@example.test' }, 'send')).status, 200);
  return { ...f, get updates() { return f.updates; }, itemId, connection, async accept() {
    return responses.recordVerified('alice', draft.id, { providerEventId: 'reply', providerOperationId: 'operation', channel: 'phone',
      recipientAddress: '+12025550124', receivedAt: clock().toISOString(), outcome: 'accepted', selectedOptionId: 'option', evidenceRef: 'synthetic' });
  }, async acceptAgain() {
    const item = (await memory.read('alice')).items.get(itemId)!;
    const baseline = await planning.capture('alice', 'UTC', { id: itemId, expectedRevision: item.revision });
    const { id: _id, revision: _rev, sourceRefs: _refs, ...fields } = item;
    const proposed = await planning.saveProposal(baseline, { kind: 'proposal', reason: '다시 조정', evidenceRefs: [], changeSet: { changes: [{
      changeId: 'move-again', operation: 'update', targetId: itemId, expectedRevision: item.revision, after: { ...fields, timeSlot: slot(14) } }] } });
    if (proposed.kind !== 'proposal') throw new Error('Second synthetic proposal failed');
    const { contactRequest } = await contacts.create('alice', { recipientRef: recipient.id, channel: 'phone', purpose: '다시 조정', messageOrCallBrief: '시간 확인',
      allowedOptions: [{ optionId: 'option-again', proposalId: proposed.proposalIds[0], proposalRevision: 1 }] });
    await contacts.decide('alice', contactRequest.id, { contactRevision: contactRequest.revision, decision: 'accept' });
    assert.equal((await dispatch.send('alice', contactRequest.id, { requestId: 'send-again', contactRevision: contactRequest.revision,
      expectedSenderAddress: 'sender@example.test' }, 'send-again')).status, 200);
    return responses.recordVerified('alice', contactRequest.id, { providerEventId: 'reply-again', providerOperationId: 'operation', channel: 'phone',
      recipientAddress: '+12025550124', receivedAt: clock().toISOString(), outcome: 'accepted', selectedOptionId: 'option-again', evidenceRef: 'synthetic' });
  } };
}

test('pull, selected export, update and deletion guard use persistent mappings', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  await f.planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', allowDeletes: true, exportItemIds: ['local'] });
  const first = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
  assert.equal(first.imported, 1); assert.equal(first.exported, 1); assert.deepEqual(first.conflicts, []);
  const mapping = (await f.sync.read('alice')).connections[0].mappings.find(m => m.itemId === 'local')!;
  await f.planning.transaction('alice', state => { const local = state.items.get('local')!; state.items.set('local', { ...local, title: 'changed', revision: 2 }); state.scheduleRevision++; });
  const second = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
  assert.equal(second.exported, 1); assert.equal(f.events.get(mapping.eventId)?.title, 'changed');
  assert.equal((await f.planning.read('alice')).items.get('local')?.sourceRefs[0].sourceVersion, 'e2');
  const beforeDelete = await f.planning.read('alice');
  await new PlanningService(f.planning).command('alice', { expectedScheduleRevision: beforeDelete.scheduleRevision,
    changeSet: { changes: [{ changeId: 'delete-local', operation: 'delete', targetId: 'local', expectedRevision: 2 }] } });
  f.expire();
  const third = await f.service.run('alice', connection.id, { requestId: 'run3', expectedRevision: 3 }) as any;
  assert.equal(third.deleted, 1); assert.equal(f.deletes, 1); assert.equal(f.events.has(mapping.eventId), false);
  f.events.set('external', { ...event('external', 9), status: 'cancelled', etag: null, title: null, timeSlot: null });
  const fourth = await f.service.run('alice', connection.id, { requestId: 'run4', expectedRevision: 4 }) as any;
  assert.equal(fourth.deleted, 1); assert.deepEqual(fourth.conflicts, []);
  const remoteTombstone = [...(await f.planning.read('alice')).tombstones!.values()].find(value => value.itemId !== 'local');
  assert.equal(remoteTombstone?.deletedRevision, 2); assert.equal(remoteTombstone?.priorInvolvement, 'personal');
});

test('remote edits preserve status undo and remote deletion removes its history', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', allowDeletes: true });
  const first = await f.service.run('alice', connection.id, { requestId: 'status-import', expectedRevision: 1 }) as any;
  assert.equal(first.imported, 1);
  const original = [...(await f.planning.read('alice')).items.values()][0]!;
  const planning = new PlanningService(f.planning);
  const { id: _id, revision: _revision, sourceRefs: _refs, ...fields } = original;
  await planning.command('alice', { expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'category', operation: 'update', targetId: original.id, expectedRevision: 1, after: { ...fields, category: 'work' } }] } });
  await planning.attendance('alice', original.id, { expectedRevision: 2, attendance: 'attended' });
  await planning.checkin('alice', original.id, { expectedRevision: 3, completion: 'completed' });
  await f.planning.transaction('bob', state => {
    state.items.set(original.id, item(original.id, 11));
    state.statusUndo = new Map([[original.id, { completion: { previous: 'pending', current: 'completed' } }]]);
  });
  const pushed = await f.service.run('alice', connection.id, { requestId: 'status-push', expectedRevision: 2 }) as any;
  assert.equal(pushed.exported, 1);
  const remote = f.events.get('external')!;
  f.events.set('external', { ...remote, etag: 'remote-edit', title: '원격 변경', timeSlot: slot(10) });
  const pulled = await f.service.run('alice', connection.id, { requestId: 'status-pull', expectedRevision: 3 }) as any;
  assert.equal(pulled.imported, 1); assert.deepEqual(pulled.conflicts, []);
  const after = await f.planning.read('alice'); const updated = after.items.get(original.id)!;
  assert.equal(updated.revision, 5); assert.equal(updated.title, '원격 변경'); assert.deepEqual(updated.timeSlot, slot(10));
  assert.equal(updated.category, 'work'); assert.equal(updated.completion, 'completed'); assert.equal(updated.attendance, 'attended');
  assert.deepEqual(after.statusUndo?.get(original.id), { completion: { previous: 'unknown', current: 'completed' }, attendance: { previous: null, current: 'attended' } });
  await assert.rejects(planning.undo('alice', original.id, { expectedRevision: 4, field: 'attendance' }), { code: 'conflict' });
  assert.equal((await planning.undo('alice', original.id, { expectedRevision: 5, field: 'attendance' })).item.attendance, null);
  const repushed = await f.service.run('alice', connection.id, { requestId: 'status-repush', expectedRevision: 4 }) as any;
  assert.equal(repushed.exported, 1);
  f.events.set('external', { ...event('external', 10), status: 'cancelled', etag: null, title: null, timeSlot: null });
  const deleted = await f.service.run('alice', connection.id, { requestId: 'status-delete', expectedRevision: 5 }) as any;
  assert.equal(deleted.deleted, 1); assert.deepEqual(deleted.conflicts, []);
  const final = await f.planning.read('alice');
  assert.equal(final.items.has(original.id), false); assert.equal(final.statusUndo?.has(original.id), false);
  assert.ok(final.tombstones?.has(original.id));
  assert.ok((await f.planning.read('bob')).statusUndo?.has(original.id));
});

test('remote edit rechecks item revision after a concurrent status change', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  await f.service.run('alice', connection.id, { requestId: 'race-import', expectedRevision: 1 });
  const original = [...(await f.planning.read('alice')).items.values()][0]!;
  f.events.set('external', { ...event('external', 10), etag: 'remote-edit', title: '원격 변경' });
  f.google.listEvents = async () => ({ events: [], nextSyncToken: 'token' });
  const getEvent = f.google.getEvent.bind(f.google); const planning = new PlanningService(f.planning);
  f.google.getEvent = async input => {
    await planning.attendance('alice', original.id, { expectedRevision: 1, attendance: 'attended' });
    return getEvent(input);
  };
  const result = await f.service.run('alice', connection.id, { requestId: 'race-pull', expectedRevision: 2 }) as any;
  assert.equal(result.imported, 0); assert.equal(result.conflicts[0]?.reason, 'schedule_conflict');
  const state = await f.planning.read('alice'); const current = state.items.get(original.id)!;
  assert.equal(current.revision, 2); assert.equal(current.title, 'external'); assert.deepEqual(current.timeSlot, slot(9));
  assert.equal(current.attendance, 'attended');
  assert.deepEqual(state.statusUndo?.get(original.id)?.attendance, { previous: null, current: 'attended' });
});

test('HTTP endpoints enforce schema, idempotency and authenticated user scope', async () => {
  const f = fixture();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof PlanningError ? error.status : 500).send({ error: true }); });
  registerCalendarSyncRoutes(app, { service: f.service, resolveUser: () => 'alice', idempotency: new MemoryIdempotency() });
  const headers = { 'idempotency-key': 'key1' };
  const response = await app.inject({ method: 'POST', url: '/v1/calendar-sync/connect', headers,
    payload: { requestId: 'request1', calendarId: 'cal' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.connection.allowDeletes, false);
  const replay = await app.inject({ method: 'POST', url: '/v1/calendar-sync/connect', headers,
    payload: { requestId: 'request1', calendarId: 'cal' } });
  assert.deepEqual(replay.json(), response.json());
  const bad = await app.inject({ method: 'POST', url: '/v1/calendar-sync/connect', headers: { 'idempotency-key': 'key2' },
    payload: { requestId: 'request2', calendarId: 'cal', allowDeletes: 'true' } });
  assert.equal(bad.statusCode, 400);
  const list = await app.inject({ method: 'GET', url: '/v1/calendar-sync/calendars' });
  assert.equal(list.json().data.calendars[0].id, 'cal');
  await app.close();
});

test('mounted application routes authenticate users and keep connections isolated', async () => {
  const f = fixture();
  const app = buildApp({ store: f.planning, calendarSync: f.service,
    sessions: { async resolve(token) { return token === 'alice' || token === 'bob' ? { userId: token } : null; } } });
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/calendar-sync' });
    assert.equal(unauthenticated.statusCode, 401);
    const connected = await app.inject({ method: 'POST', url: '/v1/calendar-sync/connect', headers: { authorization: 'Bearer alice', 'idempotency-key': 'connect' },
      payload: { requestId: 'connect', calendarId: 'cal' } });
    assert.equal(connected.statusCode, 200);
    const id = connected.json().data.connection.id;
    const other = await app.inject({ method: 'POST', url: `/v1/calendar-sync/${id}/run`, headers: { authorization: 'Bearer bob', 'idempotency-key': 'run' },
      payload: { requestId: 'run', expectedRevision: 1 } });
    assert.equal(other.statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/v1/calendar-sync', headers: { authorization: 'Bearer bob' } });
    assert.deepEqual(list.json().data.connections, []);
  } finally { await app.close(); }
});

test('existing connections queue selected new items once and replay an identical request', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  const first = await f.service.run('alice', connection.id, { requestId: 'initial', expectedRevision: 1 }) as any;
  assert.equal(first.imported, 1);
  const mapping = (await f.sync.read('alice')).connections[0].mappings[0];
  const { id: _id, revision: _revision, sourceRefs: _sourceRefs, ...after } = item('new', 12);
  const created = await new PlanningService(f.planning).command('alice', { expectedScheduleRevision: 1,
    changeSet: { changes: [{ changeId: 'create', operation: 'create', after }] } });
  const itemId = created.items[0].id;
  const app = buildApp({ store: f.planning, calendarSync: f.service,
    sessions: { async resolve(token) { return token === 'alice' || token === 'bob' ? { userId: token } : null; } } });
  const url = `/v1/calendar-sync/${connection.id}/exports`;
  const headers = { authorization: 'Bearer alice', 'idempotency-key': 'queue-key' };
  const payload = { requestId: 'queue', expectedRevision: 2, exportItemIds: [itemId, itemId, mapping.itemId] };
  try {
    const queued = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(queued.statusCode, 200); assert.equal(queued.json().data.connection.pendingExportCount, 1);
    assert.equal(queued.json().data.connection.revision, 3); assert.equal(f.inserts, 0);
    const replay = await app.inject({ method: 'POST', url, headers, payload: { ...payload, requestId: 'replay' } });
    assert.deepEqual(replay.json(), queued.json());
    const changed = await app.inject({ method: 'POST', url, headers, payload: { ...payload, exportItemIds: [itemId] } });
    assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'idempotency_conflict');
    const bob = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer bob', 'idempotency-key': 'bob' }, payload });
    assert.equal(bob.statusCode, 404);
    assert.deepEqual((await f.sync.read('alice')).connections[0].mappings, [mapping]);
    const run = await f.service.run('alice', connection.id, { requestId: 'export', expectedRevision: 3 }) as any;
    assert.equal(run.exported, 1); assert.equal(f.inserts, 1);
    const repeated = await f.service.run('alice', connection.id, { requestId: 'repeat', expectedRevision: 4 }) as any;
    assert.equal(repeated.exported, 0); assert.equal(f.inserts, 1);
    const mapped = await f.service.enqueueExports('alice', connection.id, { expectedRevision: 5, exportItemIds: [itemId] });
    assert.equal(mapped.connection.pendingExportCount, 0); assert.equal(mapped.connection.revision, 6);
  } finally { await app.close(); }
});

test('enqueue rejects invalid items, stale versions, account changes, active runs and overflow', async () => {
  const f = fixture();
  await f.planning.transaction('alice', state => {
    state.items.set('valid', item('valid', 9));
    state.items.set('shared', { ...item('shared', 10), involvement: 'shared' });
    state.items.set('task', { ...item('task', 11), kind: 'task' });
    state.items.set('unscheduled', { ...item('unscheduled', 12), timeSlot: null });
    state.items.set('other', { ...item('other', 13), sourceRefs: [{ provider: 'google_calendar', accountRef: 'other', calendarId: 'other', externalEventId: 'x', lastSyncedAt: '2030-01-01T00:00:00Z' }] });
    for (let i = 0; i < 101; i++) state.items.set(`item-${i}`, item(`item-${i}`, 14));
  });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  for (const id of ['missing', 'shared', 'task', 'unscheduled', 'other']) {
    await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: ['valid', id] }), { status: 400 });
  }
  await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: [] }), { status: 400 });
  await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 2, exportItemIds: ['valid'] }), { status: 409 });
  f.google.accountRef = 'google:other';
  await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: ['valid'] }), { status: 503 });
  f.google.accountRef = 'google:hash';
  await f.sync.update('alice', state => { state.connections[0].activeRun = 'running'; });
  await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: ['valid'] }), { status: 409 });
  await f.sync.update('alice', state => { state.connections[0].activeRun = null; });
  const full = await f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: Array.from({ length: 100 }, (_, i) => `item-${i}`) });
  assert.equal(full.connection.pendingExportCount, 100);
  const duplicate = await f.service.enqueueExports('alice', connection.id, { expectedRevision: 2, exportItemIds: ['item-0', 'item-0'] });
  assert.equal(duplicate.connection.pendingExportCount, 100); assert.equal(duplicate.connection.revision, 3);
  await assert.rejects(f.service.enqueueExports('alice', connection.id, { expectedRevision: 3, exportItemIds: ['item-100'] }), { status: 400 });
  assert.equal((await f.sync.read('alice')).connections[0].exportItemIds.length, 100); assert.equal(f.inserts, 0);
});

test('operation lookup recovers a lost response without resending a write and isolates users', async () => {
  const f = fixture();
  await f.planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', exportItemIds: ['local'] });
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const insert = f.google.insertEvent.bind(f.google);
  f.google.insertEvent = async input => { start(); await paused; return insert(input); };
  const app = buildApp({ store: f.planning, calendarSync: f.service,
    sessions: { async resolve(token) { return token === 'alice' || token === 'bob' ? { userId: token } : null; } } });
  try {
    const run = app.inject({ method: 'POST', url: `/v1/calendar-sync/${connection.id}/run`,
      headers: { authorization: 'Bearer alice', 'idempotency-key': 'key-run' }, payload: { requestId: 'run-lost', expectedRevision: 1 } });
    await started;
    const path = '/v1/calendar-sync/operations/run-lost';
    const running = await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer alice' } });
    assert.deepEqual(running.json().data, { operation: { state: 'running' } });
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/calendar-sync/operations/missing', headers: { authorization: 'Bearer alice' } })).statusCode, 404);
    release();
    const response = await run;
    assert.equal(response.statusCode, 200);
    assert.equal(f.inserts, 1);
    for (let i = 0; i < 2; i++) {
      const lookup = await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer alice' } });
      assert.equal(lookup.statusCode, 200);
      assert.deepEqual(lookup.json().data, { operation: { state: 'completed', result: response.json().data } });
      assert.equal(f.inserts, 1);
    }
  } finally { release(); await app.close(); }
});

test('operation lookup preserves an uncertain outcome without another external write', async () => {
  const f = fixture();
  await f.planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', exportItemIds: ['local'] });
  f.failInsert();
  const app = buildApp({ store: f.planning, calendarSync: f.service,
    sessions: { async resolve(token) { return token === 'alice' ? { userId: token } : null; } } });
  try {
    const run = await app.inject({ method: 'POST', url: `/v1/calendar-sync/${connection.id}/run`,
      headers: { authorization: 'Bearer alice', 'idempotency-key': 'uncertain-key' }, payload: { requestId: 'uncertain', expectedRevision: 1 } });
    const lookup = await app.inject({ method: 'GET', url: '/v1/calendar-sync/operations/uncertain', headers: { authorization: 'Bearer alice' } });
    assert.deepEqual(lookup.json().data, { operation: { state: 'uncertain', result: run.json().data } });
    assert.equal(lookup.json().data.operation.result.connection.status, 'review_required');
    assert.equal(f.inserts, 1);
  } finally { await app.close(); }
});

test('PostgreSQL atomically persists imported items and mappings', { skip: !process.env.PIKKU_TEST_DATABASE_URL }, async () => {
  const schema = `calendar_sync_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    const planning = new PostgresPlanningStore(pool), sync = new PostgresCalendarSyncStore(pool);
    await planning.migrate(); await sync.migrate();
    const f = fixture(planning, sync); f.events.set('external', event('external', 9));
    await planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
    const { connection } = await f.service.connect('alice', { calendarId: 'cal', allowDeletes: true, exportItemIds: ['local'] });
    const result = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
    assert.equal(result.imported, 1); assert.equal(result.exported, 1);
    assert.deepEqual(await f.service.getOperation('alice', 'run1'), { operation: { state: 'completed', result } });
    const mapping = (await sync.read('alice')).connections[0].mappings.find(value => value.eventId === 'external')!;
    assert.equal((await planning.read('alice')).items.get(mapping.itemId)?.title, 'external');
    await planning.transaction('alice', state => {
      state.statusUndo = new Map([[mapping.itemId, { completion: { previous: 'pending', current: 'unknown' } }]]);
    });
    assert.deepEqual(await sync.read('bob'), { connections: [], operations: [] });
    await assert.rejects(planning.atomicWithClient('alice', async client => {
      await sync.updateWithClient(client, 'alice', async state => {
        state.connections[0].revision = 999;
        await planning.transaction('alice', data => { data.items.clear(); });
        throw new Error('rollback');
      });
    }));
    assert.ok((await planning.read('alice')).items.has(mapping.itemId));
    assert.equal((await sync.read('alice')).connections[0].revision, 2);
    const current = await planning.read('alice');
    await new PlanningService(planning).command('alice', { expectedScheduleRevision: current.scheduleRevision,
      changeSet: { changes: [{ changeId: 'delete', operation: 'delete', targetId: 'local', expectedRevision: 1 }] } });
    const pushDelete = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
    assert.equal(pushDelete.deleted, 1); assert.equal(f.deletes, 1);
    f.events.set('external', { ...event('external', 9), status: 'cancelled', etag: null, title: null, timeSlot: null });
    const pullDelete = await f.service.run('alice', connection.id, { requestId: 'run3', expectedRevision: 3 }) as any;
    assert.equal(pullDelete.deleted, 1);
    const after = await planning.read('alice');
    assert.equal(after.items.has(mapping.itemId), false); assert.equal(after.tombstones?.get(mapping.itemId)?.deletedRevision, 2);
    assert.equal(after.statusUndo?.has(mapping.itemId), false);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

test('PostgreSQL enqueue and idempotency commit together and roll back with planning state', { skip: !process.env.PIKKU_TEST_DATABASE_URL }, async () => {
  const schema = `calendar_exports_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    const planning = new PostgresPlanningStore(pool), sync = new PostgresCalendarSyncStore(pool);
    await planning.migrate(); await sync.migrate();
    const f = fixture(planning, sync);
    await planning.transaction('alice', state => { state.items.set('new', item('new', 12)); });
    const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
    await assert.rejects(planning.atomicWithClient('alice', async () => {
      await f.service.enqueueExports('alice', connection.id, { expectedRevision: 1, exportItemIds: ['new'] });
      throw new Error('rollback');
    }));
    assert.equal((await sync.read('alice')).connections[0].revision, 1);
    assert.deepEqual((await sync.read('alice')).connections[0].exportItemIds, []);
    const app = buildApp({ store: planning, calendarSync: f.service,
      sessions: { async resolve(token) { return token === 'alice' ? { userId: token } : null; } } });
    try {
      const url = `/v1/calendar-sync/${connection.id}/exports`, headers = { authorization: 'Bearer alice', 'idempotency-key': 'pg-key' };
      const payload = { requestId: 'pg-request', expectedRevision: 1, exportItemIds: ['new'] };
      const first = await app.inject({ method: 'POST', url, headers, payload });
      assert.equal(first.statusCode, 200); assert.equal(first.json().data.connection.revision, 2);
      const replay = await app.inject({ method: 'POST', url, headers, payload: { ...payload, requestId: 'retry' } });
      assert.deepEqual(replay.json(), first.json());
      const changed = await app.inject({ method: 'POST', url, headers, payload: { ...payload, exportItemIds: ['other'] } });
      assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'idempotency_conflict');
      const stored = (await planning.read('alice')).idempotency.get(JSON.stringify(['calendar_sync_exports', 'pg-key']));
      assert.equal(stored?.state, 'completed');
      assert.deepEqual((await sync.read('alice')).connections[0].exportItemIds, ['new']);
      assert.equal(f.inserts, 0);
    } finally { await app.close(); }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test('existing same-account source links are adopted without duplicate export', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  await f.planning.transaction('alice', state => {
    state.items.set('existing', { ...item('existing', 9), sourceRefs: [{ provider: 'google_calendar', accountRef: 'google:subject', calendarId: 'cal',
      externalEventId: 'external', sourceVersion: 'e1', lastSyncedAt: '2030-01-01T00:00:00Z' }] });
  });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', exportItemIds: ['existing'] });
  const result = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
  assert.equal(result.imported, 0); assert.equal(result.exported, 0); assert.equal(result.connection.pendingExportCount, 0);
  assert.equal((await f.planning.read('alice')).items.size, 1); assert.equal(f.inserts, 0);
});

test('remote edits update the linked personal item and advance the baseline', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 });
  const mapping = (await f.sync.read('alice')).connections[0].mappings[0];
  f.events.set('external', { ...event('external', 10), title: 'remote edit', etag: 'e2' });
  const result = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
  assert.equal(result.imported, 1); assert.deepEqual(result.conflicts, []);
  const updated = (await f.planning.read('alice')).items.get(mapping.itemId)!;
  assert.equal(updated.title, 'remote edit'); assert.equal(updated.revision, 2); assert.equal(updated.sourceRefs[0].sourceVersion, 'e2');
});

test('remote shared changes are held for review without modifying the schedule', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 });
  const mapping = (await f.sync.read('alice')).connections[0].mappings[0];
  const remote = event('external', 10); remote.etag = 'e2'; remote.unsupported.shared = true; f.events.set(remote.id, remote);
  const result = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
  assert.equal(result.conflicts[0].reason, 'unsupported_or_shared');
  assert.deepEqual((await f.planning.read('alice')).items.get(mapping.itemId)?.timeSlot, slot(9));
});

test('applied contact approval updates only its original shared Google event once', async () => {
  for (const mode of ['mapped', 'legacy'] as const) {
    const f = await sharedFixture(mode);
    const before = await f.service.run('alice', f.connection.id, { requestId: 'before-reply', expectedRevision: 2 }) as any;
    assert.equal(before.exported, 0); assert.equal(f.updates, 0);
    const accepted = await f.accept(); assert.equal(accepted.contactRequest.negotiationStatus, 'applied');
    const applied = await f.service.run('alice', f.connection.id, { requestId: 'after-reply', expectedRevision: 3 }) as any;
    assert.equal(applied.exported, 1, mode); assert.equal(f.updates, 1);
    assert.deepEqual(f.events.get('external')?.timeSlot, slot(12));
    assert.equal((await f.planning.read('alice')).items.get(f.itemId)?.sourceRefs[0].sourceVersion, 'e2');
    const replay = await f.service.run('alice', f.connection.id, { requestId: 'repeat', expectedRevision: 4 }) as any;
    assert.equal(replay.exported, 0); assert.equal(f.updates, 1);
    assert.deepEqual(replay.conflicts, []);
    assert.equal((await f.acceptAgain()).contactRequest.negotiationStatus, 'applied');
    const again = await f.service.run('alice', f.connection.id, { requestId: 'after-second-approval', expectedRevision: 5 }) as any;
    assert.equal(again.exported, 1); assert.equal(f.updates, 2);
    assert.equal((await f.planning.read('alice')).items.get(f.itemId)?.sourceRefs[0].sourceVersion, 'e3');
  }
});

test('approval discovers an unmapped legacy shared source even when the incremental page is empty', async () => {
  const f = await sharedFixture('legacy-delta');
  const get = f.google.getEvent.bind(f.google); let reads = 0;
  f.google.getEvent = async input => { reads++; return get(input); };
  const before = await f.service.run('alice', f.connection.id, { requestId: 'delta-before', expectedRevision: 2 }) as any;
  assert.equal(before.exported, 0); assert.equal(reads, 0); assert.equal(f.updates, 0);
  assert.equal((await f.accept()).contactRequest.negotiationStatus, 'applied');
  const after = await f.service.run('alice', f.connection.id, { requestId: 'delta-approved', expectedRevision: 3 }) as any;
  assert.equal(after.exported, 1); assert.equal(reads, 2); assert.equal(f.updates, 1);
  assert.deepEqual(f.events.get('external')?.timeSlot, slot(12));
  const replay = await f.service.run('alice', f.connection.id, { requestId: 'delta-repeat', expectedRevision: 4 }) as any;
  assert.equal(replay.exported, 0); assert.equal(f.updates, 1);
});

test('shared changes require original version, organizer identity, owner access and unchanged approval', async () => {
  for (const condition of ['foreign-organizer', 'unknown-organizer', 'not-self', 'writer', 'changed-etag', 'changed-time', 'changed-title', 'extra-edit'] as const) {
    const f = await sharedFixture('legacy'); await f.accept();
    const original = f.events.get('external')!;
    if (condition === 'foreign-organizer') f.events.set('external', { ...original, organizerIsAccount: false });
    if (condition === 'unknown-organizer') f.events.set('external', { ...original, organizerIsAccount: undefined });
    if (condition === 'not-self') f.events.set('external', { ...original, organizerSelf: false });
    if (condition === 'writer') f.google.listCalendars = async () => ({ calendars: [{ id: 'cal', summary: 'Calendar', accessRole: 'writer' }] });
    if (condition === 'changed-etag') f.events.set('external', { ...original, etag: 'new-version' });
    if (condition === 'changed-time') f.events.set('external', { ...original, timeSlot: slot(10) });
    if (condition === 'changed-title') f.events.set('external', { ...original, title: 'different' });
    if (condition === 'extra-edit') await f.planning.transaction('alice', state => { const item = state.items.get(f.itemId)!; item.revision++; item.title = 'changed'; });
    const result = await f.service.run('alice', f.connection.id, { requestId: `reject-${condition}`, expectedRevision: 2 }) as any;
    assert.equal(result.exported, 0, condition); assert.equal(f.updates, 0, condition);
    assert.ok(result.conflicts.length > 0, condition);
  }
});

test('calendar ownership is checked again immediately before the approved write', async () => {
  const f = await sharedFixture('legacy'); await f.accept();
  let checks = 0;
  f.google.listCalendars = async () => ({ calendars: [{ id: 'cal', summary: 'Calendar', accessRole: ++checks < 3 ? 'owner' : 'writer' }] });
  const result = await f.service.run('alice', f.connection.id, { requestId: 'role-changed', expectedRevision: 2 }) as any;
  assert.equal(checks, 3); assert.equal(result.exported, 0); assert.equal(f.updates, 0);
  assert.ok(result.conflicts.length > 0);
});

test('PostgreSQL commits approved shared updates and source versions with their mappings', { skip: !process.env.PIKKU_TEST_DATABASE_URL }, async () => {
  const schema = `calendar_shared_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.PIKKU_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    const planning = new PostgresPlanningStore(pool), sync = new PostgresCalendarSyncStore(pool);
    await planning.migrate(); await sync.migrate();
    const f = await sharedFixture('legacy-delta', planning, sync);
    assert.equal((await f.accept()).contactRequest.negotiationStatus, 'applied');
    const result = await f.service.run('alice', f.connection.id, { requestId: 'postgres-approved', expectedRevision: 2 }) as any;
    assert.equal(result.exported, 1); assert.equal(f.updates, 1);
    const stored = (await planning.read('alice')).items.get(f.itemId)!;
    const mapping = (await sync.read('alice')).connections[0].mappings[0];
    assert.equal(stored.sourceRefs[0].sourceVersion, 'e2'); assert.equal(mapping.etag, 'e2'); assert.equal(mapping.itemRevision, stored.revision);
    const replay = await f.service.run('alice', f.connection.id, { requestId: 'postgres-repeat', expectedRevision: 3 }) as any;
    assert.equal(replay.exported, 0); assert.equal(f.updates, 1);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test('missing or stale deletion tombstones never delete a remote event', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', allowDeletes: true });
  await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 });
  const mapping = (await f.sync.read('alice')).connections[0].mappings[0];
  await f.planning.transaction('alice', state => { state.items.delete(mapping.itemId); });
  const missing = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
  assert.equal(missing.conflicts[0].reason, 'delete_requires_review');
  await f.planning.transaction('alice', state => { state.tombstones!.set(mapping.itemId, { itemId: mapping.itemId, deletedRevision: 3,
    priorInvolvement: 'personal', deletedAt: '2030-01-01T00:00:00Z' }); });
  const stale = await f.service.run('alice', connection.id, { requestId: 'run3', expectedRevision: 3 }) as any;
  assert.equal(stale.conflicts[0].reason, 'delete_requires_review');
  await f.planning.transaction('alice', state => { state.tombstones!.set(mapping.itemId, { itemId: mapping.itemId, deletedRevision: 2,
    priorInvolvement: 'shared', deletedAt: '2030-01-01T00:00:00Z' }); });
  const shared = await f.service.run('alice', connection.id, { requestId: 'run4', expectedRevision: 4 }) as any;
  assert.equal(shared.conflicts[0].reason, 'delete_requires_review'); assert.equal(f.deletes, 0);
});

test('changing the connected account stops import before a schedule write', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  const original = f.google.listEvents.bind(f.google);
  f.google.listEvents = async input => { const result = await original(input); f.google.accountRef = 'google:other'; return result; };
  const result = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
  assert.equal(result.conflicts[0].reason, 'provider_unavailable');
  assert.equal((await f.planning.read('alice')).items.size, 0);
});

test('simultaneous edits, shared changes and deletion without opt-in remain conflicts', async () => {
  const f = fixture(); f.events.set('external', event('external', 9));
  const { connection } = await f.service.connect('alice', { calendarId: 'cal' });
  await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 });
  const mapping = (await f.sync.read('alice')).connections[0].mappings[0];
  await f.planning.transaction('alice', state => { const before = state.items.get(mapping.itemId)!; state.items.set(before.id, { ...before, revision: 2, title: 'local' }); });
  f.events.set('external', { ...event('external', 10), etag: 'e2' });
  const second = await f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }) as any;
  assert.equal(second.conflicts[0].reason, 'both_changed');
  assert.equal((await f.planning.read('alice')).items.get(mapping.itemId)?.title, 'local');
  await f.planning.transaction('alice', state => { state.items.delete(mapping.itemId); });
  f.events.set('external', event('external', 9));
  const third = await f.service.run('alice', connection.id, { requestId: 'run3', expectedRevision: 3 }) as any;
  assert.equal(third.conflicts[0].reason, 'delete_not_enabled'); assert.equal(f.deletes, 0);
});

test('unknown write outcome blocks automatic replay and another user cannot access the connection', async () => {
  const f = fixture();
  await f.planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', exportItemIds: ['local'] });
  f.failInsert();
  const result = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
  assert.equal(result.conflicts[0].reason, 'outcome_unknown'); assert.equal(result.connection.status, 'review_required');
  await assert.rejects(f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }));
  await assert.rejects(f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }));
  assert.equal(f.inserts, 1); assert.deepEqual(await f.service.list('bob'), { connections: [] });
});

test('a successful external write followed by a local commit failure is not replayed', async () => {
  const f = fixture();
  await f.planning.transaction('alice', state => { state.items.set('local', item('local', 12)); });
  const { connection } = await f.service.connect('alice', { calendarId: 'cal', exportItemIds: ['local'] });
  const insert = f.google.insertEvent.bind(f.google);
  f.google.insertEvent = async input => { const value = await insert(input); f.google.accountRef = 'google:other'; return value; };
  const result = await f.service.run('alice', connection.id, { requestId: 'run1', expectedRevision: 1 }) as any;
  assert.equal(result.conflicts[0].reason, 'outcome_unknown'); assert.equal(result.connection.status, 'review_required');
  assert.equal(f.inserts, 1); assert.equal(f.events.size, 1);
  await assert.rejects(f.service.run('alice', connection.id, { requestId: 'run2', expectedRevision: 2 }));
});
