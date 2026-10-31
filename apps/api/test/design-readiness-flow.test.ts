import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { createMemberAuth } from '../src/member-auth.ts';
import { MemberAuthStore } from '../src/member-auth-store.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { createRoutineService } from '../src/routine-service.ts';
import { PostgresCalendarSyncStore } from '../src/calendar-sync-store.ts';
import { CalendarSyncService } from '../src/calendar-sync.ts';
import type { GoogleCalendarEvent, GoogleCalendarEventWrite, getCalendarWriteConnection } from '../src/google-calendar-write.ts';

type CalendarPort = NonNullable<Awaited<ReturnType<typeof getCalendarWriteConnection>>>;
const now = new Date('2030-01-01T00:00:00.000Z');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const range = '/v1/schedule?from=2030-01-07T00%3A00%3A00Z&to=2030-01-10T00%3A00%3A00Z&timezone=UTC';

// This test creates its own disposable cluster and never uses a configured database URL.
test('synthetic member completes routine, check-in and selected calendar export without crossing user boundaries',
  { skip: process.env.PIKKU_DESIGN_READINESS_ISOLATED_PG !== '1', timeout: 30_000 }, async t => {
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
    const directory = await mkdtemp(join(tmpdir(), 'pikku-design-readiness-'));
    const listener = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'synthetic', password: 'synthetic-only-password',
      persistent: false, authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
    let started = false; let pool: pg.Pool | undefined; let app: ReturnType<typeof buildApp> | undefined;
    t.after(async () => {
      await app?.close(); await pool?.end(); if (started) await postgres.stop();
      await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0);
    });
    process.umask(0o077);
    await postgres.initialise(); await postgres.start(); started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'synthetic', password: 'synthetic-only-password', database: 'postgres',
      options: '-c statement_timeout=4000' });
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const memberAuth = createMemberAuth({ pool, env: {}, clock: () => now }); await memberAuth.migrate();
    const members = new MemberAuthStore(pool); const ownerToken = token(), otherToken = token();
    const expires = new Date(now.getTime() + 7 * 86_400_000);
    const owner = await members.createSession({ subject: 'synthetic-subject-owner', email: 'owner@example.test', displayName: '합성 회원' }, hash(ownerToken), now, expires);
    const other = await members.createSession({ subject: 'synthetic-subject-other', email: 'other@example.test', displayName: '다른 합성 회원' }, hash(otherToken), now, expires);
    assert.notEqual(owner.id, other.id); assert.deepEqual(await memberAuth.resolve(ownerToken), { userId: owner.id });
    const planning = new PlanningService(store, () => now);
    const routines = createRoutineService({ pool, store, planning, clock: () => now }); await routines.migrate();
    const syncStore = new PostgresCalendarSyncStore(pool); await syncStore.migrate();
    const events = new Map<string, GoogleCalendarEvent>(); let inserts = 0;
    const calendar: CalendarPort = {
      userId: owner.id, subject: 'synthetic-subject-owner', accountLabel: '합성 계정', accountRef: 'google:synthetic-owner',
      async listCalendars() { return { calendars: [{ id: 'synthetic-calendar', summary: '합성 캘린더', accessRole: 'owner' as const }] }; },
      async listEvents() { return { events: [...events.values()].map(event => structuredClone(event)), nextSyncToken: 'synthetic-sync-token' }; },
      async getEvent({ eventId }) { const event = events.get(eventId); if (!event) throw { code: 'not_found' }; return structuredClone(event); },
      async insertEvent({ calendarId, eventId, event }: { calendarId: string; eventId: string; event: GoogleCalendarEventWrite }) {
        assert.equal(calendarId, 'synthetic-calendar'); inserts++;
        const created: GoogleCalendarEvent = { id: eventId, etag: 'synthetic-etag', status: 'confirmed', title: event.title, description: null,
          timeSlot: event.timeSlot, unsupported: { allDay: false, recurring: false, shared: false, other: false }, privateProperties: event.privateProperties };
        events.set(eventId, structuredClone(created)); return created;
      },
      async updateEvent() { throw new Error('Unexpected update'); },
      async deleteEvent() { throw new Error('Unexpected delete'); },
    };
    const calendarSync = new CalendarSyncService(store, syncStore, async userId => userId === owner.id ? calendar : undefined);
    app = buildApp({ store, memberAuth, memberAllowLocalInsecure: true, routineService: routines, calendarSync, clock: () => now });
    const get = (url: string, bearer = ownerToken) => app!.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
    const post = (url: string, payload: object, key: string, bearer = ownerToken) => app!.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key }, payload });
    const ok = (response: { statusCode: number; body: string; json(): any }) => { assert.equal(response.statusCode, 200, response.body); return response.json().data; };

    assert.deepEqual(ok(await get('/v1/auth/me')).member, owner);
    const created = ok(await post('/v1/routines', { requestId: 'create-routine', title: '합성 루틴', weekdays: [1, 2], timezone: 'UTC',
      startDate: '2030-01-07', localTime: '09:00', durationMinutes: 30 }, 'create-routine'));
    assert.ok(created.routine.id);
    const generated = ok(await post('/v1/routines/materialize', { requestId: 'materialize', fromDate: '2030-01-07', toDate: '2030-01-08' }, 'materialize'));
    assert.equal(generated.createdCount, 2); assert.deepEqual(generated.conflicts, []);
    const schedule = ok(await get(range)); assert.equal(schedule.items.length, 2);
    const occurrence = schedule.items.find((item: { sourceRefs: { provider: string }[] }) => item.sourceRefs.some(ref => ref.provider === 'routine'));
    assert.ok(occurrence); assert.equal(occurrence.completion, 'pending');
    const checked = ok(await post(`/v1/schedule/${occurrence.id}/checkin`, { requestId: 'checkin', expectedRevision: occurrence.revision, completion: 'completed' }, 'checkin'));
    assert.equal(checked.item.completion, 'completed');
    assert.equal(ok(await get(range)).items.find((item: { id: string }) => item.id === occurrence.id).completion, 'completed');

    const connected = ok(await post('/v1/calendar-sync/connect', { requestId: 'connect', calendarId: 'synthetic-calendar' }, 'connect'));
    const connection = connected.connection; assert.equal(connection.pendingExportCount, 0); assert.equal(inserts, 0);
    const event = { kind: 'event', title: '합성 개인 일정', timeSlot: { startsAt: '2030-01-09T15:00:00Z', endsAt: '2030-01-09T16:00:00Z', timezone: 'UTC' },
      durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' };
    const added = ok(await post('/v1/schedule/commands', { requestId: 'personal-event', expectedScheduleRevision: checked.scheduleRevision,
      changeSet: { changes: [{ changeId: 'new-event', operation: 'create', after: event }] } }, 'personal-event'));
    const itemId = added.items[0].id;
    const beforeSelection = ok(await post(`/v1/calendar-sync/${connection.id}/run`, { requestId: 'unselected', expectedRevision: connection.revision }, 'unselected'));
    assert.equal(beforeSelection.exported, 0); assert.equal(inserts, 0);
    const selected = ok(await post(`/v1/calendar-sync/${connection.id}/exports`, { requestId: 'select', expectedRevision: beforeSelection.connection.revision, exportItemIds: [itemId] }, 'select'));
    assert.equal(selected.connection.pendingExportCount, 1); assert.equal(inserts, 0);
    assert.deepEqual(ok(await get('/v1/routines', otherToken)).routines, []);
    assert.deepEqual(ok(await get(range, otherToken)).items, []);
    assert.deepEqual(ok(await get('/v1/calendar-sync', otherToken)).connections, []);
    assert.equal((await post(`/v1/schedule/${occurrence.id}/checkin`, { requestId: 'other-checkin', expectedRevision: checked.item.revision, completion: 'completed' }, 'other-checkin', otherToken)).statusCode, 404);
    assert.equal((await post(`/v1/calendar-sync/${connection.id}/exports`, { requestId: 'other-select', expectedRevision: selected.connection.revision, exportItemIds: [itemId] }, 'other-select', otherToken)).statusCode, 404);

    const runBody = { requestId: 'sync', expectedRevision: selected.connection.revision };
    const run = await post(`/v1/calendar-sync/${connection.id}/run`, runBody, 'sync');
    if (run.statusCode !== 200) {
      const state = await syncStore.read(owner.id);
      assert.equal(run.statusCode, 200, `${run.body}; synthetic inserts=${inserts}; active=${!!state.connections[0]?.activeRun}; operation=${state.operations[0]?.state}`);
    }
    const synced = ok(run);
    assert.equal(synced.exported, 1); assert.equal(synced.imported, 0); assert.deepEqual(synced.conflicts, []);
    assert.equal(synced.connection.pendingExportCount, 0); assert.equal(inserts, 1); assert.equal(events.size, 1);
    const remote = [...events.values()][0]!; assert.equal(remote.title, event.title); assert.deepEqual(remote.timeSlot, event.timeSlot);
    const operation = ok(await get('/v1/calendar-sync/operations/sync')).operation;
    assert.equal(operation.state, 'completed'); assert.deepEqual(operation.result, synced);
    assert.equal((await get('/v1/calendar-sync/operations/sync', otherToken)).statusCode, 404);
    const persisted = await syncStore.read(owner.id);
    assert.equal(persisted.connections[0]!.activeRun, null); assert.equal(persisted.operations.find(entry => entry.id === 'sync')?.state, 'completed');
    assert.deepEqual((await post(`/v1/calendar-sync/${connection.id}/run`, runBody, 'sync')).json(), run.json()); assert.equal(inserts, 1);
    const afterSync = ok(await get(range));
    assert.equal(afterSync.items.find((item: { id: string }) => item.id === occurrence.id).completion, 'completed');
    assert.ok(afterSync.items.find((item: { id: string }) => item.id === itemId).sourceRefs.some((ref: { provider: string }) => ref.provider === 'google_calendar'));
    assert.deepEqual(ok(await post('/v1/auth/logout', {}, 'logout')).status, 'logged_out');
    assert.equal((await get('/v1/auth/me')).statusCode, 401); assert.equal((await get(range)).statusCode, 401);
    assert.equal((await post(`/v1/calendar-sync/${connection.id}/run`, runBody, 'after-logout')).statusCode, 401); assert.equal(inserts, 1);
    assert.equal((await get('/v1/auth/me', otherToken)).statusCode, 200);
  });
