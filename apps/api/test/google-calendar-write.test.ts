import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getCalendarWriteConnection } from '../src/google-calendar-write.ts';

const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret' };
const scopes = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const calendarId = 'calendar@example.test', eventId = '0123456789abc';
const event = { id: eventId, etag: '"etag-v1"', status: 'confirmed', summary: '합성 일정', organizer: { self: true },
  start: { dateTime: '2026-11-02T09:00:00Z' }, end: { dateTime: '2026-11-02T10:00:00Z' }, extendedProperties: { private: { pIKKU: 'binding-1', foreign: 'preserved' } } };
const write = { title: '합성 일정', timeSlot: { startsAt: '2026-11-02T09:00:00Z', endsAt: '2026-11-02T10:00:00Z', timezone: 'UTC' },
  description: '합성 설명', privateProperties: { pIKKU: 'binding-1' } };
async function setup(t: TestContext, provider: (url: URL, init: RequestInit) => Promise<Response> | Response, identity = 'synthetic-subject', userId = 'alice') {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-gcal-write-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'calendar-write-connection.json');
  await writeFile(path, JSON.stringify({ version: 1, clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, senderAddress: 'test@example.test', subject: 'synthetic-subject', refreshToken: 'synthetic-refresh' }), { mode: 0o600 });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); assert.equal(init.redirect, 'error');
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: scopes });
    if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: 'test@example.test', email_verified: true, sub: identity });
    assert.equal(url.origin, 'https://www.googleapis.com');
    return provider(url, init);
  };
  const connection = await getCalendarWriteConnection({ env, credentialPath: path, fetcher, userId });
  assert.ok(connection); return connection;
}
const rejectsCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

test('calendar roles and incremental event pages preserve tombstones and unsupported events', async t => {
  const urls: URL[] = [];
  const connection = await setup(t, url => {
    urls.push(url);
    if (url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: calendarId, summary: '합성', accessRole: 'writer' }] });
    if (!url.searchParams.has('pageToken')) return Response.json({ items: [event, { id: 'deleted', status: 'cancelled' }], nextPageToken: 'page2' });
    return Response.json({ items: [{ ...event, id: 'recurring', recurringEventId: 'series', start: { date: '2026-11-02' }, end: { date: '2026-11-03' }, attendees: [{ self: false }] }], nextSyncToken: 'sync-next' });
  });
  assert.equal(connection.userId, 'alice'); assert.equal(connection.accountLabel, 'test@example.test'); assert.match(connection.accountRef, /^google:[a-f0-9]{64}$/);
  assert.deepEqual(await connection.listCalendars(), { calendars: [{ id: calendarId, summary: '합성', accessRole: 'writer' }] });
  const first = await connection.listEvents({ calendarId, syncToken: 'sync-old' });
  assert.equal(first.nextPageToken, 'page2'); assert.equal(first.nextSyncToken, undefined);
  assert.equal(first.events[0]!.timeSlot?.timezone, 'UTC'); assert.equal(first.events[0]!.unsupported.shared, false);
  assert.deepEqual(first.events[0]!.privateProperties, { pIKKU: 'binding-1' });
  assert.deepEqual({ status: first.events[1]!.status, timeSlot: first.events[1]!.timeSlot }, { status: 'cancelled', timeSlot: null });
  const second = await connection.listEvents({ calendarId, syncToken: 'sync-old', pageToken: first.nextPageToken });
  assert.equal(second.nextSyncToken, 'sync-next'); assert.equal(second.events[0]!.unsupported.recurring, true);
  assert.equal(second.events[0]!.unsupported.allDay, true); assert.equal(second.events[0]!.unsupported.shared, true);
  for (const url of urls.slice(1)) {
    assert.equal(url.searchParams.get('syncToken'), 'sync-old'); assert.equal(url.searchParams.get('showDeleted'), 'true');
    assert.equal(url.searchParams.get('singleEvents'), 'false'); assert.equal(url.searchParams.get('timeZone'), 'UTC');
  }
});

test('writes use deterministic IDs, no attendees or notifications, and conditional PATCH/delete', async t => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const connection = await setup(t, (url, init) => {
    calls.push({ url, init });
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(event, { status: init.method === 'POST' ? 201 : 200 });
  });
  await connection.insertEvent({ calendarId, eventId, event: write });
  await connection.updateEvent({ calendarId, eventId, etag: event.etag, event: write });
  await connection.deleteEvent({ calendarId, eventId, etag: event.etag });
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'PATCH', 'DELETE']);
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('sendUpdates'), 'none'); assert.ok(call.url.pathname.includes('calendar%40example.test'));
    if (call.init.body) {
      const body = JSON.parse(String(call.init.body)); assert.equal(body.attendees, undefined);
      assert.deepEqual(body.extendedProperties, { private: { pIKKU: 'binding-1' } });
      if (call.init.method === 'POST') assert.equal(body.id, eventId); else assert.equal(body.id, undefined);
    }
    if (call.init.method !== 'POST') assert.equal((call.init.headers as Record<string, string>)['If-Match'], event.etag);
  }
  await assert.rejects(() => connection.updateEvent({ calendarId, eventId, etag: '*', event: write }), rejectsCode('invalid_request'));
  await assert.rejects(() => connection.deleteEvent({ calendarId, eventId, etag: '"old",*' }), rejectsCode('invalid_request'));
  await assert.rejects(() => connection.insertEvent({ calendarId, eventId: undefined as unknown as string, event: write }), rejectsCode('invalid_request'));
  assert.equal(calls.length, 3);
});

test('sync expiry, conflicts and ambiguous writes are distinct and never retried', async t => {
  let status = 410, calls = 0; let broken = false;
  const connection = await setup(t, () => { calls++; if (broken) throw new Error('private network'); return new Response('private error', { status }); });
  await assert.rejects(() => connection.listEvents({ calendarId, syncToken: 'old' }), rejectsCode('sync_token_expired'));
  status = 412; await assert.rejects(() => connection.updateEvent({ calendarId, eventId, etag: event.etag, event: write }), rejectsCode('conflict'));
  status = 409; await assert.rejects(() => connection.insertEvent({ calendarId, eventId, event: write }), rejectsCode('conflict'));
  status = 503; await assert.rejects(() => connection.deleteEvent({ calendarId, eventId, etag: event.etag }), rejectsCode('outcome_unknown'));
  broken = true; await assert.rejects(() => connection.insertEvent({ calendarId, eventId, event: write }), rejectsCode('outcome_unknown'));
  assert.equal(calls, 5);
});

test('identity mismatch and malformed or mismatched provider responses fail closed', async t => {
  let calls = 0;
  const wrong = await setup(t, () => { calls++; return Response.json(event); }, 'different-subject');
  await assert.rejects(() => wrong.insertEvent({ calendarId, eventId, event: write }), rejectsCode('provider_unavailable'));
  assert.equal(calls, 0);
  const mismatched = await setup(t, () => { calls++; return Response.json({ ...event, id: 'different' }); });
  await assert.rejects(() => mismatched.getEvent({ calendarId, eventId }), rejectsCode('provider_unavailable'));
  await assert.rejects(() => mismatched.insertEvent({ calendarId, eventId, event: write }), rejectsCode('outcome_unknown'));
  const noToken = await setup(t, () => Response.json({ items: [] }));
  await assert.rejects(() => noToken.listEvents({ calendarId }), rejectsCode('provider_unavailable'));
  const invalidMarker = await setup(t, () => Response.json({ ...event, extendedProperties: { private: [] } }));
  await assert.rejects(() => invalidMarker.getEvent({ calendarId, eventId }), rejectsCode('provider_unavailable'));
});

test('member-scoped user identifiers remain intact', async t => {
  const member = 'member:12345678-1234-1234-1234-123456789abc';
  const connection = await setup(t, () => Response.json(event), 'synthetic-subject', member);
  assert.equal(connection.userId, member);
  assert.equal((await connection.getEvent({ calendarId, eventId })).id, eventId);
});
