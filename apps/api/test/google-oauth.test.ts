import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createGoogleOAuth } from '../src/google-oauth.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const calendarScope = 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const sendScope = 'openid email https://www.googleapis.com/auth/gmail.send';
const readScope = 'openid email https://www.googleapis.com/auth/gmail.readonly';
const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };

test('authenticated OAuth state is one-use, time-limited and isolates Google accounts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-oauth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-31T00:00:00Z'); let exchanges = 0;
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    PIKKU_GOOGLE_USER_CREDENTIAL_DIR: dir, PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.test/v1/google/oauth/callback' };
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') { exchanges++; assert.ok(body.get('code_verifier')); assert.equal(body.get('redirect_uri'), env.PIKKU_GOOGLE_OAUTH_REDIRECT_URI); }
      const code = body.get('code') ?? (body.get('refresh_token') ?? '').replace('synthetic-refresh-', '');
      return Response.json({ access_token: code, refresh_token: 'synthetic-refresh-'+code, token_type: 'Bearer',
        scope: code.includes('calendar') ? calendarScope : code.includes('send') ? sendScope : readScope });
    }
    if (String(input).includes('/calendar/v3/users/me/calendarList')) return Response.json({ items: [] });
    const header = (init?.headers as Record<string, string>).Authorization;
    const alice = header.includes('alice');
    return Response.json({ email: alice ? 'alice@example.test' : 'bob@example.test', email_verified: true, sub: alice ? 'alice-subject' : 'bob-subject' });
  };
  const oauth = createGoogleOAuth({ env, fetcher, clock: () => now });
  const store = new MemoryPlanningStore(); Object.defineProperty(store, 'durable', { value: true });
  const app = buildApp({ sessions, store, googleOAuth: oauth }); t.after(() => app.close());
  async function start(user: string, kind: string) {
    const r = await app.inject({ method: 'POST', url: '/v1/google/oauth/start', headers: { authorization: `Bearer ${user}` }, payload: { kind } });
    assert.equal(r.statusCode, 200); const url = new URL(r.json().data.authorizationUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const completionSecret = r.json().data.completionSecret; assert.match(completionSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!url.toString().includes(completionSecret));
    return { state: url.searchParams.get('state')!, completionSecret };
  }
  async function callback(state: string, code: string) {
    return app.inject({ method: 'GET', url: `/v1/google/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}` });
  }
  async function complete(user: string, completionSecret: string, confirmationCode: string) {
    return app.inject({ method: 'POST', url: '/v1/google/oauth/complete', headers: { authorization: `Bearer ${user}` }, payload: { completionSecret, confirmationCode } });
  }
  const first = await start('alice', 'calendar');
  const result = await callback(first.state, 'alice-calendar'); assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.ok(!result.body.includes('alice-calendar'));
  const confirmationCode = result.body.match(/[A-Za-z0-9_-]{43}/)?.[0]; assert.ok(confirmationCode);
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await complete('bob', first.completionSecret, confirmationCode)).statusCode, 400);
  assert.equal((await complete('alice', 'a'.repeat(43), confirmationCode)).statusCode, 400);
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await complete('alice', first.completionSecret, confirmationCode)).statusCode, 200);
  assert.equal((await complete('alice', first.completionSecret, confirmationCode)).statusCode, 400);
  assert.equal((await callback(first.state, 'alice-calendar')).statusCode, 400); assert.equal(exchanges, 1);
  for (const [user, expected] of [['alice','available'], ['bob','not_configured']]) {
    const r = await app.inject({ method: 'GET', url: '/v1/calendar-connection', headers: { authorization: `Bearer ${user}` } });
    assert.equal(r.json().data.status, expected);
    if (user === 'bob') assert.ok(!r.body.includes('alice@example.test'));
  }
  const calendarList = await app.inject({ method: 'GET', url: '/v1/calendar/calendars', headers: { authorization: 'Bearer alice' } });
  assert.equal(calendarList.statusCode, 200); assert.deepEqual(calendarList.json().data.calendars, []);
  const expired = await start('bob', 'calendar'); now += 600_001;
  assert.equal((await callback(expired.state, 'bob-calendar')).statusCode, 400); assert.equal(exchanges, 1);
  const denied = await start('bob', 'calendar');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/google/oauth/callback?state=${denied.state}&error=access_denied` })).statusCode, 400);
  assert.equal((await callback(denied.state, 'bob-calendar')).statusCode, 400); assert.equal(exchanges, 1);
  const send = await start('alice','gmail_send'); const sent = await callback(send.state, 'alice-send'); assert.equal(sent.statusCode, 200);
  assert.equal((await complete('alice', send.completionSecret, sent.body.match(/[A-Za-z0-9_-]{43}/)![0])).statusCode, 200);
  const wrongRead = await start('alice','gmail_read'); assert.equal((await callback(wrongRead.state, 'bob-read')).statusCode, 400);
  const read = await start('alice','gmail_read'); const readCallback = await callback(read.state, 'alice-read'); assert.equal(readCallback.statusCode, 200);
  assert.equal((await complete('alice', read.completionSecret, readCallback.body.match(/[A-Za-z0-9_-]{43}/)![0])).statusCode, 200);
  const mine = await app.inject({ method: 'GET', url: '/v1/email-reply-connection', headers: { authorization: 'Bearer alice' } });
  const theirs = await app.inject({ method: 'GET', url: '/v1/email-reply-connection', headers: { authorization: 'Bearer bob' } });
  assert.equal(mine.json().data.status, 'available'); assert.equal(theirs.json().data.status, 'not_configured');
  const dirs = await readdir(dir); assert.equal(dirs.length, 1); assert.match(dirs[0], /^[0-9a-f]{64}$/);
  assert.equal((await stat(join(dir, dirs[0]))).mode & 0o777, 0o700);
  for (const file of await readdir(join(dir, dirs[0]))) assert.equal((await stat(join(dir, dirs[0], file))).mode & 0o777, 0o600);
  const legacy = await oauth.connections('alice'); assert.ok(legacy.calendarConnection && legacy.gmailContact);
  const fallbackApp = buildApp({ sessions, store, googleOAuth: oauth, calendarConnection: legacy.calendarConnection, gmailContact: legacy.gmailContact });
  t.after(() => fallbackApp.close());
  await writeFile(join(dir, dirs[0], 'calendar-connection.json'), '{invalid');
  await writeFile(join(dir, dirs[0], 'gmail-connection.json'), '{invalid');
  for (const route of ['/v1/calendar-connection','/v1/email-connection','/v1/email-reply-connection']) {
    const r = await fallbackApp.inject({ method: 'GET', url: route, headers: { authorization: 'Bearer alice' } });
    assert.equal(r.json().data.status, 'not_configured');
  }
  const automatic = await start('alice', 'calendar');
  const poll = (user: string, completionSecret: string, cancel = false) => app.inject({ method: 'POST',
    url: '/v1/google/oauth/complete', headers: { authorization: `Bearer ${user}` },
    payload: { completionSecret, ...(cancel ? { cancel: true } : {}) } });
  const waiting = await poll('alice', automatic.completionSecret);
  assert.deepEqual(waiting.json().data, { status: 'pending' }); assert.equal(waiting.headers['cache-control'], 'no-store');
  assert.equal((await poll('bob', automatic.completionSecret)).statusCode, 400);
  assert.equal((await poll('alice', 'z'.repeat(43))).statusCode, 400);
  assert.equal((await callback(automatic.state, 'alice-calendar')).statusCode, 200);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => poll('alice', automatic.completionSecret)));
  assert.ok(concurrent.every(response => response.statusCode === 200));
  assert.deepEqual(concurrent.map(response => response.json().data), Array(5).fill({ status: 'completed' }));
  assert.deepEqual((await poll('alice', automatic.completionSecret)).json().data, { status: 'completed' });
  const cancelled = await start('alice', 'calendar');
  assert.equal((await poll('bob', cancelled.completionSecret, true)).statusCode, 400);
  assert.equal((await poll('alice', cancelled.completionSecret, true)).json().data.status, 'cancelled');
  assert.equal((await poll('alice', cancelled.completionSecret)).statusCode, 400);
  assert.equal((await callback(cancelled.state, 'alice-calendar')).statusCode, 400);
  const autoExpired = await start('alice', 'calendar');
  now += 10 * 60_000;
  assert.equal((await poll('alice', autoExpired.completionSecret)).statusCode, 400);
});

test('unconfigured OAuth cannot start and the callback never exposes provider data', async t => {
  const oauth = createGoogleOAuth({ env: {} }); const app = buildApp({ sessions, googleOAuth: oauth }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/google/oauth/start', payload: { kind: 'calendar' } })).statusCode, 401);
  const start = await app.inject({ method: 'POST', url: '/v1/google/oauth/start', headers: { authorization: 'Bearer alice' }, payload: { kind: 'calendar' } });
  assert.equal(start.statusCode, 503); assert.equal(start.json().error.code, 'not_configured');
  const result = await app.inject({ method: 'GET', url: '/v1/google/oauth/callback?state=bad&code=secret-code' });
  assert.equal(result.statusCode, 400); assert.ok(!result.body.includes('secret-code'));
});

test('legacy owner can connect reply reading and another user cannot borrow its send credential', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pikku-oauth-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const users = join(root, 'users'); await import('node:fs/promises').then(fs => fs.mkdir(users, { mode: 0o700 }));
  const legacy = join(root, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ version: 1, clientId: 'synthetic-client', senderAddress: 'alice@example.test', subject: 'alice-subject', refreshToken: 'synthetic-send' }), { mode: 0o600 });
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    PIKKU_GOOGLE_USER_CREDENTIAL_DIR: users, PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.test/v1/google/oauth/callback' };
  const fetcher: typeof fetch = async url => String(url).includes('oauth2.googleapis.com')
    ? Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-read', token_type: 'Bearer', scope: readScope })
    : Response.json({ email: 'alice@example.test', email_verified: true, sub: 'alice-subject' });
  const oauth = createGoogleOAuth({ env, fetcher, legacyGmail: { userId: 'alice', credentialPath: legacy } });
  const first = await oauth.start('alice','gmail_read'); assert.ok(first);
  const code = await oauth.callback(new URL(first.authorizationUrl).searchParams.get('state')!, 'synthetic-code'); assert.ok(code);
  const [connected, next] = await Promise.all([oauth.complete('alice', first.completionSecret, code), oauth.start('alice','gmail_read')]);
  assert.equal(connected, true); assert.ok(next);
  assert.equal((await oauth.connections('alice')).gmailReplyConnection?.userId, 'alice');
  const other = await oauth.start('bob','gmail_read'); assert.ok(other);
  assert.equal(await oauth.callback(new URL(other.authorizationUrl).searchParams.get('state')!, 'synthetic-code'), undefined);
  assert.equal((await oauth.connections('bob')).gmailReplyConnection, undefined);
});
