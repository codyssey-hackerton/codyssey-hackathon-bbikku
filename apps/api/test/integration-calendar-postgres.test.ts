import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { getCalendarConnection } from '../src/google-calendar.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
test('calendar HTTP import commits and replays across PostgreSQL store restart', { skip: !connectionString }, async () => {
  const schema = `pikku_calendar_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
  const dir = await mkdtemp(join(tmpdir(), 'pikku-calendar-pg-test-'));
  const apps: ReturnType<typeof buildApp>[] = [];
  try {
    const path = join(dir, 'calendar.json');
    await writeFile(path, JSON.stringify({ version: 1, clientId: 'synthetic-id', senderAddress: 'test@example.com',
      subject: 'synthetic-subject', refreshToken: 'synthetic-refresh' }), { mode: 0o600 });
    let eventReads = 0;
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-token', token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly' });
      if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: 'test@example.com', email_verified: true, sub: 'synthetic-subject' });
      if (url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: 'calendar', summary: 'Calendar', timeZone: 'UTC' }] });
      eventReads++;
      return Response.json({ timeZone: 'UTC', items: [{ id: 'event', etag: 'etag', summary: 'Synthetic event', organizer: { self: true },
        start: { dateTime: '2026-11-01T09:00:00Z' }, end: { dateTime: '2026-11-01T10:00:00Z' } }] });
    };
    const calendarConnection = await getCalendarConnection({ env: { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-id',
      PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret' }, credentialPath: path, fetcher });
    assert.ok(calendarConnection);
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const build = (current: PostgresPlanningStore) => {
      const app = buildApp({ store: current, calendarConnection, sessions: { resolve: async () => ({ userId: 'local-developer' }) } });
      apps.push(app); return app;
    };
    const payload = { requestId: 'request', calendarId: 'calendar', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z',
      selectedEvents: [{ id: 'event', etag: 'etag' }], expectedScheduleRevision: 0 };
    const send = (app: ReturnType<typeof buildApp>) => app.inject({ method: 'POST', url: '/v1/calendar/import',
      headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'key' }, payload });
    const first = await send(build(store)); assert.equal(first.statusCode, 200); assert.equal(first.json().data.items.length, 1);
    const readsAfterFirst = eventReads;
    const restarted = new PostgresPlanningStore(pool);
    const replay = await send(build(restarted));
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), first.json());
    assert.equal(eventReads, readsAfterFirst);
    const state = await restarted.read('local-developer');
    assert.equal(state.items.size, 1); assert.equal(state.scheduleRevision, 1);
  } finally {
    await Promise.all(apps.map(app => app.close()));
    await pool.end(); await rm(dir, { recursive: true, force: true });
  }
});
