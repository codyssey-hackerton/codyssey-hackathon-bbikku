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
import type { GoogleCalendarEvent, GoogleCalendarEventWrite, getCalendarWriteConnection } from '../src/google-calendar-write.ts';

type Google = NonNullable<Awaited<ReturnType<typeof getCalendarWriteConnection>>>;
const slot = (hour: number) => ({ startsAt: `2030-01-01T${String(hour).padStart(2, '0')}:00:00Z`, endsAt: `2030-01-01T${String(hour + 1).padStart(2, '0')}:00:00Z`, timezone: 'UTC' });
const event = (id: string, hour: number): GoogleCalendarEvent => ({ id, etag: 'e1', status: 'confirmed', title: id, description: null,
  timeSlot: slot(hour), unsupported: { allDay: false, recurring: false, shared: false, other: false }, privateProperties: {} });
const item = (id: string, hour: number): ScheduleItem => ({ id, revision: 1, sourceRefs: [], kind: 'event', title: id, timeSlot: slot(hour),
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'unknown' });
function fixture(planning: PlanningStore = new MemoryPlanningStore(), sync: CalendarSyncStore = new MemoryCalendarSyncStore()) {
  const events = new Map<string, GoogleCalendarEvent>();
  let inserts = 0, deletes = 0, failInsert = false, expire = false;
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
      const before = events.get(input.eventId)!; assert.equal(before.etag, input.etag);
      const after = { ...before, etag: 'e2', title: input.event.title, timeSlot: input.event.timeSlot, privateProperties: input.event.privateProperties };
      events.set(input.eventId, after); return structuredClone(after);
    },
    async deleteEvent(input: { eventId: string; etag: string }) { assert.equal(events.get(input.eventId)?.etag, input.etag); deletes++; events.delete(input.eventId); },
  } as Google;
  const service = new CalendarSyncService(planning, sync, async userId => userId === 'alice' ? google : undefined);
  return { planning, sync, events, google, service, get inserts() { return inserts; }, get deletes() { return deletes; },
    failInsert() { failInsert = true; }, expire() { expire = true; } };
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
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
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
