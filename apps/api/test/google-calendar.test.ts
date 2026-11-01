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

test('overlapping source events are imported without changing their source', async t => {
  const other = { ...event, id: 'event-2', etag: 'etag-2', start: { dateTime: '2026-11-01T09:30:00Z' }, end: { dateTime: '2026-11-01T10:30:00Z' } };
  const connection = await setup(t, () => Response.json({ timeZone: 'UTC', items: [event, other] }));
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const result = await service.importSelected({ userId: 'local-developer', ...query,
    selectedEvents: [{ id: event.id, etag: event.etag }, { id: other.id, etag: other.etag }], expectedScheduleRevision: 0 });
  const state = await store.read('local-developer'); assert.equal(result.items.length, 2); assert.equal(state.items.size, 2); assert.equal(state.scheduleRevision, 1);
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

test('automatic import skips a moved recurring occurrence, imports only new events and replays unchanged', async t => {
  let instanceId = 'instance-1';
  const other = { ...event, id: 'new-event', etag: 'new-etag' };
  const connection = await setup(t, () => Response.json({ timeZone: 'UTC', items: [
    { ...event, id: instanceId, recurringEventId: 'series', originalStartTime: { dateTime: event.start.dateTime } }, other,
  ] }));
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const first = await service.importSelected({ userId: 'local-developer', ...query, selectedEvents: [{ id: instanceId, etag: event.etag }], expectedScheduleRevision: 0 });
  await store.transaction('local-developer', state => {
    const item = state.items.get(first.items[0].id)!;
    item.timeSlot = { startsAt: '2026-12-01T09:00:00Z', endsAt: '2026-12-01T10:00:00Z', timezone: 'UTC' };
    state.scheduleRevision++;
  });
  instanceId = 'changed-instance-id';
  const app = buildApp({ store, calendarConnection: connection, sessions: { async resolve() { return { userId: 'local-developer' }; } } });
  t.after(() => app.close());
  const payload = { requestId: 'auto-partial', ...query, expectedAccountRef: connection.accountRef, skipExisting: true, expectedScheduleRevision: 2,
    selectedEvents: [{ id: instanceId, etag: event.etag }, { id: other.id, etag: other.etag }] };
  const send = () => app.inject({ method: 'POST', url: '/v1/calendar/import', headers: { authorization: 'Bearer local', 'idempotency-key': 'auto-partial' }, payload });
  const result = await send(); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().data.scheduleRevision, 3); assert.equal(result.json().data.items.length, 1);
  assert.equal(result.json().data.items[0].sourceRefs[0].externalEventId, other.id);
  const replay = await send(); assert.deepEqual(replay.json().data, result.json().data);
  const state = await store.read('local-developer'); assert.equal(state.items.size, 2);
  assert.equal(state.items.get(first.items[0].id)!.timeSlot!.startsAt, '2026-12-01T09:00:00Z');
});

test('automatic import of only duplicates leaves revision unchanged and replays the empty result', async t => {
  const connection = await setup(t); const store = new MemoryPlanningStore();
  const service = new CalendarImportService(store, connection);
  await service.importSelected({ userId: 'local-developer', ...query, selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 });
  const app = buildApp({ store, calendarConnection: connection, sessions: { async resolve() { return { userId: 'local-developer' }; } } });
  t.after(() => app.close());
  const payload = { requestId: 'auto-existing', ...query, expectedAccountRef: connection.accountRef, skipExisting: true,
    expectedScheduleRevision: 1, selectedEvents: [{ id: event.id, etag: event.etag }] };
  const send = () => app.inject({ method: 'POST', url: '/v1/calendar/import', headers: { authorization: 'Bearer local', 'idempotency-key': 'auto-existing' }, payload });
  const result = await send(); assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().data, { items: [], scheduleRevision: 1 });
  const replay = await send(); assert.deepEqual(replay.json().data, result.json().data);
  const state = await store.read('local-developer'); assert.equal(state.items.size, 1); assert.equal(state.scheduleRevision, 1);
  await assert.rejects(service.importSelected({ userId: 'local-developer', ...payload, expectedScheduleRevision: 0 }), (error: any) => error.code === 'conflict');
  await assert.rejects(service.importSelected({ userId: 'local-developer', ...payload, skipExisting: false }), (error: any) => error.code === 'conflict');
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

test('expanded recurrence and all-day transparent events import with exclusive local-day boundaries', async t => {
  const allDay = { ...event, id: 'holiday', summary: '종일 일정', description: '일정 메모', transparency: 'transparent',
    start: { date: '2026-03-08' }, end: { date: '2026-03-09' } };
  const occurrence = { ...event, id: 'occurrence-1', recurringEventId: 'series-1', originalStartTime: { dateTime: '2026-03-09T09:00:00-04:00' },
    start: { dateTime: '2026-03-09T10:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-03-09T11:00:00-04:00' } };
  const connection = await setup(t, () => Response.json({ timeZone: 'America/New_York', items: [allDay, occurrence, { id: 'cancelled', status: 'cancelled' }] }));
  const period = { calendarId: query.calendarId, from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' };
  const listed = await connection.resolveEvents(period);
  assert.equal(listed.unsupportedCount, 0); assert.equal(listed.events.length, 2);
  const day = listed.events[0]!;
  assert.equal(day.startsAt, '2026-03-08T05:00:00.000Z'); assert.equal(day.endsAt, '2026-03-09T04:00:00.000Z');
  assert.equal(Date.parse(day.endsAt) - Date.parse(day.startsAt), 23 * 60 * 60 * 1000);
  assert.equal(day.allDay, true); assert.equal(day.blocksTime, false); assert.equal(day.notes, '일정 메모');
  assert.equal(listed.events[1]!.occurrenceKey, JSON.stringify(['series-1', occurrence.originalStartTime.dateTime]));
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  const result = await service.importSelected({ userId: 'local-developer', ...period, expectedScheduleRevision: 0,
    selectedEvents: listed.events.map(({ id, etag }) => ({ id, etag })) });
  assert.equal(result.items[0]!.allDay, true); assert.equal(result.items[0]!.blocksTime, false); assert.equal(result.items[0]!.notes, '일정 메모');
  assert.equal(result.items[1]!.sourceRefs[0]!.externalEventId, 'occurrence-1');
  assert.equal(result.items[1]!.sourceRefs[0]!.occurrenceKey, listed.events[1]!.occurrenceKey);
});

test('a changed recurrence instance ID cannot create a duplicate original occurrence', async t => {
  let instanceId = 'instance-1';
  const connection = await setup(t, () => Response.json({ timeZone: 'UTC', items: [{ ...event, id: instanceId, recurringEventId: 'series',
    originalStartTime: { dateTime: '2026-11-01T09:00:00Z' } }] }));
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  await service.importSelected({ userId: 'local-developer', ...query, selectedEvents: [{ id: instanceId, etag: event.etag }], expectedScheduleRevision: 0 });
  instanceId = 'instance-2';
  await assert.rejects(service.importSelected({ userId: 'local-developer', ...query, selectedEvents: [{ id: instanceId, etag: event.etag }], expectedScheduleRevision: 1 }), (error: any) => error.code === 'conflict');
  assert.equal((await store.read('local-developer')).items.size, 1);
});

test('all-day dates follow calendar timezone across fall DST and skipped midnight', async t => {
  const values = [
    { zone: 'America/New_York', start: '2026-11-01', end: '2026-11-02', expectedStart: '2026-11-01T04:00:00.000Z', expectedEnd: '2026-11-02T05:00:00.000Z' },
    { zone: 'America/Sao_Paulo', start: '2018-11-04', end: '2018-11-05', expectedStart: '2018-11-04T03:00:00.000Z', expectedEnd: '2018-11-05T02:00:00.000Z' },
  ];
  for (const value of values) {
    const connection = await setup(t, () => Response.json({ timeZone: value.zone, items: [{ ...event,
      start: { date: value.start }, end: { date: value.end } }] }));
    const result = await connection.listEvents(query); assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.startsAt, value.expectedStart); assert.equal(result.events[0]!.endsAt, value.expectedEnd);
  }
});

test('an expected Google account mismatch fails before reading or importing events', async t => {
  let reads = 0;
  const connection = await setup(t, () => { reads++; return Response.json({ timeZone: 'UTC', items: [event] }); });
  const store = new MemoryPlanningStore(); const service = new CalendarImportService(store, connection);
  await assert.rejects(service.importSelected({ userId: 'local-developer', ...query, expectedAccountRef: 'different-account',
    selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision: 0 }), (error: any) => error.code === 'conflict');
  assert.equal(reads, 0); assert.equal((await store.read('local-developer')).items.size, 0);
});

test('HTTP import rechecks the selected account and schedule snapshot after provider preparation', async t => {
  const store = new MemoryPlanningStore();
  let enter!: () => void, release!: () => void;
  let entered: Promise<void>, gate: Promise<void>;
  const resetGate = () => { entered = new Promise(resolve => { enter = resolve; }); gate = new Promise(resolve => { release = resolve; }); };
  const source = { id: event.id, etag: event.etag, title: event.summary, startsAt: event.start.dateTime, endsAt: event.end.dateTime,
    timezone: 'UTC', involvement: 'personal' as const };
  const first = { userId: 'alice', accountRef: 'google:account-a', accountLabel: 'account-a@example.test',
    async resolveEvents() { enter(); await gate; return { events: [source], unsupportedCount: 0 }; } };
  const second = { ...first, accountRef: 'google:account-b' };
  let selected = first;
  const oauth: any = { async connections(userId: string) { return userId === 'alice' ? { calendarConnection: selected } : {}; } };
  const app = buildApp({ store, googleOAuth: oauth, sessions: { async resolve(token) { return token === 'alice' ? { userId: 'alice' } : null; } } });
  t.after(() => app.close());
  const send = (key: string, expectedScheduleRevision: number) => app.inject({ method: 'POST', url: '/v1/calendar/import',
    headers: { authorization: 'Bearer alice', 'idempotency-key': key }, payload: { requestId: key, ...query, expectedAccountRef: 'google:account-a',
      selectedEvents: [{ id: event.id, etag: event.etag }], expectedScheduleRevision } });

  resetGate(); const accountChange = send('account-change', 0); await entered!; selected = second; release();
  const switched = await accountChange; assert.equal(switched.statusCode, 409, switched.body);
  assert.equal((await store.read('alice')).items.size, 0);

  selected = first; resetGate(); const scheduleChange = send('schedule-change', 0); await entered!;
  await store.transaction('alice', state => { state.scheduleRevision++; }); release();
  const stale = await scheduleChange; assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((await store.read('alice')).items.size, 0);

  resetGate(); const unchanged = send('unchanged-account', 1); await entered!; release();
  const success = await unchanged; assert.equal(success.statusCode, 200, success.body);
  const state = await store.read('alice'); assert.equal(state.items.size, 1); assert.equal(state.scheduleRevision, 2);
  assert.equal([...state.items.values()][0]!.sourceRefs[0]!.accountRef, 'google:account-a');
});
