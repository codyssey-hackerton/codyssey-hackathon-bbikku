import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getCalendarConnection } from '../src/google-calendar.ts';
import { CalendarImportService } from '../src/calendar-import.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { buildApp } from '../src/app.ts';

const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-id', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret' };
const query = { calendarId: 'synthetic-calendar', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
const event = { id: 'event-1', etag: 'etag-1', summary: '합성 일정', organizer: { self: true },
  start: { dateTime: '2026-11-01T09:00:00Z' }, end: { dateTime: '2026-11-01T10:00:00Z' } };
const scope = 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly';

async function setup(t: TestContext, eventPage: (url: URL) => Response = () => Response.json({ timeZone: 'UTC', items: [event] }), grantedScope = scope) {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-calendar-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'calendar.json');
  await writeFile(path, JSON.stringify({ version: 1, clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, senderAddress: 'test@example.com', subject: 'synthetic-subject', refreshToken: 'synthetic-refresh' }), { mode: 0o600 });
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-token', token_type: 'Bearer', scope: grantedScope });
    if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: 'test@example.com', email_verified: true, sub: 'synthetic-subject' });
    if (url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: query.calendarId, summary: '합성 캘린더', timeZone: 'UTC' }] });
    return eventPage(url);
  };
  const connection = await getCalendarConnection({ env, credentialPath: path, fetcher }); assert.ok(connection); return connection;
}

test('calendar read accepts readonly or events write grant but still requires list and identity scopes', async t => {
  const writeScope = scope.replace('calendar.events.readonly', 'calendar.events');
  for (const granted of [scope, writeScope]) {
    const connection = await setup(t, undefined, granted);
    assert.equal((await connection.listEvents(query)).events[0]?.id, event.id);
    assert.equal('insertEvent' in connection, false); assert.equal('updateEvent' in connection, false); assert.equal('deleteEvent' in connection, false);
  }
  for (const granted of [writeScope.replace('https://www.googleapis.com/auth/calendar.calendarlist.readonly', ''), writeScope.replace('openid', ''), writeScope.replace('email', ''),
    scope.replace('https://www.googleapis.com/auth/calendar.events.readonly', '')]) {
    const connection = await setup(t, undefined, granted);
    await assert.rejects(connection.listCalendars(), (error: any) => error.code === 'provider_unavailable');
  }
});

test('calendar pages are consumed and unsupported events are counted', async t => {
  const connection = await setup(t, url => url.searchParams.has('pageToken')
    ? Response.json({ timeZone: 'UTC', items: [event, { id: 'all-day', start: { date: '2026-11-01' } }] })
    : Response.json({ timeZone: 'UTC', items: [], nextPageToken: 'page-2' }));
  const result = await connection.listEvents(query);
  assert.deepEqual(result.events, [{ id: 'event-1', etag: 'etag-1', title: event.summary, startsAt: event.start.dateTime, endsAt: event.end.dateTime, timezone: 'UTC' }]);
  assert.equal(result.unsupportedCount, 1);
});

test('partial page failure is not returned as an empty success', async t => {
  const connection = await setup(t, url => url.searchParams.has('pageToken') ? new Response('', { status: 503 }) : Response.json({ items: [], nextPageToken: 'next' }));
  await assert.rejects(connection.listEvents(query), (error: any) => error.code === 'provider_unavailable');
});

test('selection etag, duplicate source, revision and conflicts are checked atomically', async t => {
  const connection = await setup(t); const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const input = { userId: 'local-developer', ...query, selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 };
  await assert.rejects(service.importSelected({ ...input, selectedEvents: [{ id: event.id, etag: 'old' }] }), (error: any) => error.code === 'conflict');
  assert.equal((await store.read(input.userId)).items.size, 0);
  const saved = await service.importSelected(input); assert.equal(saved.scheduleRevision, 1);
  assert.equal(saved.items[0].sourceRefs[0].externalEventId, event.id);
  assert.equal(saved.items[0].sourceRefs[0].sourceVersion, event.etag);
  await assert.rejects(service.importSelected({ ...input, expectedScheduleRevision: 1 }), (error: any) => error.code === 'conflict');
  await assert.rejects(service.importSelected(input), (error: any) => error.code === 'conflict');
  assert.equal((await store.read(input.userId)).items.size, 1);
});

test('another user cannot import the local developer calendar', async t => {
  const connection = await setup(t); const service = new CalendarImportService(new MemoryPlanningStore(), connection);
  await assert.rejects(service.importSelected({ userId: 'other-user', ...query, selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 }), (error: any) => error.code === 'permission_denied');
});

test('overlapping selections fail together without saving either event', async t => {
  const other = { ...event, id: 'event-2', etag: 'etag-2', start: { dateTime: '2026-11-01T09:30:00Z' }, end: { dateTime: '2026-11-01T10:30:00Z' } };
  const connection = await setup(t, () => Response.json({ timeZone: 'UTC', items: [event, other] }));
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  await assert.rejects(service.importSelected({ userId: 'local-developer', ...query,
    selectedEvents: [{ id: event.id, etag: event.etag }, { id: other.id, etag: other.etag }], expectedScheduleRevision: 0 }), (error: any) => error.code === 'conflict');
  const state = await store.read('local-developer'); assert.equal(state.items.size, 0); assert.equal(state.scheduleRevision, 0);
});

test('recurring and partial-attendee events are reported as unsupported', async t => {
  const connection = await setup(t, url => {
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    return Response.json({ timeZone: 'UTC', items: [{ ...event, recurringEventId: 'series' }, { ...event, id: 'partial', attendeesOmitted: true }] });
  });
  const result = await connection.listEvents(query); assert.equal(result.events.length, 0); assert.equal(result.unsupportedCount, 2);
});

test('HTTP explicit selection imports once and rejects another user', async t => {
  const connection = await setup(t); const store = new MemoryPlanningStore();
  const app = buildApp({ store, calendarConnection: connection, sessions: { async resolve(value) { return value === 'local' ? { userId: 'local-developer' } : value === 'other' ? { userId: 'other-user' } : null; } } });
  t.after(() => app.close());
  const payload = { requestId: 'synthetic-request', ...query, selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 };
  const send = (auth: string) => app.inject({ method: 'POST', url: '/v1/calendar/import', headers: { authorization: `Bearer ${auth}`, 'idempotency-key': 'synthetic-key' }, payload });
  assert.equal((await send('other')).statusCode, 503);
  const first = await send('local'); assert.equal(first.statusCode, 200); assert.equal(first.json().data.items.length, 1);
  const replay = await send('local'); assert.equal(replay.statusCode, 200); assert.equal(replay.json().data.items[0].id, first.json().data.items[0].id);
  assert.equal((await store.read('local-developer')).items.size, 1);
});

test('prepared import cannot be forged and commits without another provider lookup', async t => {
  let allowLookup = true;
  const connection = await setup(t, () => { if (!allowLookup) throw new Error('unexpected provider lookup'); return Response.json({ timeZone: 'UTC', items: [event] }); });
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const input = { userId: 'local-developer', ...query, selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 };
  const prepared = await service.prepareSelected(input);
  input.selectedEvents[0].id = 'changed'; allowLookup = false;
  await assert.rejects(service.commitPrepared({}), (error: any) => error.code === 'invalid_request');
  await assert.rejects(new CalendarImportService(store, connection).commitPrepared(prepared), (error: any) => error.code === 'invalid_request');
  const result = await service.commitPrepared(prepared); assert.equal(result.items[0].sourceRefs[0].externalEventId, event.id);
  assert.equal(result.scheduleRevision, 1);
});

test('prepared import rechecks schedule revision at commit', async t => {
  const connection = await setup(t); const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const prepared = await service.prepareSelected({ userId: 'local-developer', ...query,
    selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 });
  await store.transaction('local-developer', state => { state.scheduleRevision++; });
  await assert.rejects(service.commitPrepared(prepared), (error: any) => error.code === 'conflict');
  assert.equal((await store.read('local-developer')).items.size, 0);
});
