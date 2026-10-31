import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGoogleOAuth } from '../src/google-oauth.ts';

const readScope = 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const writeScope = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

test('calendar write consent has separate scopes, credentials, owner and Google identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-gcal-oauth-write-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    PIKKU_GOOGLE_USER_CREDENTIAL_DIR: dir, PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.test/v1/google/oauth/callback' };
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return Response.json({ access_token: code, refresh_token: `refresh-${code}`, token_type: 'Bearer', scope: code === 'write-account' ? writeScope : readScope });
    }
    const token = (init?.headers as Record<string, string>).Authorization;
    return Response.json({ email: token.includes('write-account') ? 'write@example.test' : 'read@example.test', email_verified: true,
      sub: token.includes('write-account') ? 'write-subject' : 'read-subject' });
  };
  const oauth = createGoogleOAuth({ env, fetcher });
  async function begin(kind: 'calendar' | 'calendar_write', code: string) {
    const started = await oauth.start('alice', kind); assert.ok(started);
    const url = new URL(started.authorizationUrl);
    assert.equal(url.searchParams.get('scope'), kind === 'calendar_write' ? writeScope : readScope);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const confirmation = await oauth.callback(url.searchParams.get('state')!, code);
    return { started, confirmation };
  }
  const wrongScope = await begin('calendar_write', 'read-account');
  assert.equal(wrongScope.confirmation, undefined); assert.deepEqual(await readdir(dir), []);
  const read = await begin('calendar', 'read-account'); assert.ok(read.confirmation);
  assert.equal(await oauth.complete('alice', read.started.completionSecret, read.confirmation), true);
  const write = await begin('calendar_write', 'write-account'); assert.ok(write.confirmation);
  assert.equal(await oauth.complete('bob', write.started.completionSecret, write.confirmation), false);
  assert.equal(await oauth.complete('alice', write.started.completionSecret, write.confirmation), true);
  assert.equal(await oauth.complete('alice', write.started.completionSecret, write.confirmation), false);
  const folders = await readdir(dir); assert.equal(folders.length, 1);
  const files = await readdir(join(dir, folders[0]!));
  assert.deepEqual(files.sort(), ['calendar-connection.json', 'calendar-write-connection.json']);
  assert.equal((await stat(join(dir, folders[0]!, 'calendar-write-connection.json'))).mode & 0o777, 0o600);
  const alice = await oauth.connections('alice'), bob = await oauth.connections('bob');
  assert.ok(alice.calendarConnection); assert.ok(alice.calendarWriteConnection);
  assert.equal(alice.calendarWriteConnection.userId, 'alice'); assert.equal(alice.calendarWriteConnection.subject, 'write-subject');
  assert.notEqual(alice.calendarWriteConnection.subject, 'read-subject');
  assert.equal(bob.calendarWriteConnection, undefined);
});

test('same-user write credential supplies a read-only calendar port only when read credential is absent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-gcal-read-fallback-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const userDir = join(dir, createHash('sha256').update('alice').digest('hex')); await mkdir(userDir, { mode: 0o700 });
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    PIKKU_GOOGLE_USER_CREDENTIAL_DIR: dir, PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.test/v1/google/oauth/callback' };
  const credential = (subject: string) => JSON.stringify({ version: 1, clientId: 'synthetic-client', senderAddress: `${subject}@example.test`, subject, refreshToken: `refresh-${subject}` });
  const writePath = join(userDir, 'calendar-write-connection.json'), readPath = join(userDir, 'calendar-connection.json');
  const original = credential('write-subject'); await writeFile(writePath, original, { mode: 0o600 });
  const refreshes: string[] = []; let invalidReadScope = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      const refresh = new URLSearchParams(String(init?.body)).get('refresh_token')!; refreshes.push(refresh);
      return Response.json({ access_token: refresh, token_type: 'Bearer', scope: refresh === 'refresh-read-subject' ? (invalidReadScope ? 'openid email' : readScope) : writeScope });
    }
    if (url.hostname === 'openidconnect.googleapis.com') {
      const subject = (init?.headers as Record<string, string>).Authorization.replace('Bearer refresh-', '');
      return Response.json({ email: `${subject}@example.test`, email_verified: true, sub: subject });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: 'cal', summary: '합성 캘린더' }] });
    throw new Error('Unexpected synthetic request');
  };
  const oauth = createGoogleOAuth({ env, fetcher });
  const fallback = await oauth.connections('alice');
  assert.equal(fallback.calendarConnection?.userId, 'alice'); assert.equal(fallback.calendarConnection?.accountRef, 'google:write-subject');
  assert.equal((await fallback.calendarConnection!.listCalendars()).calendars[0]?.id, 'cal');
  assert.deepEqual(refreshes, ['refresh-write-subject']);
  assert.equal('insertEvent' in fallback.calendarConnection!, false); assert.equal('updateEvent' in fallback.calendarConnection!, false);
  assert.equal(await readFile(writePath, 'utf8'), original); assert.deepEqual(await readdir(userDir), ['calendar-write-connection.json']);
  assert.equal((await oauth.connections('bob')).calendarConnection, undefined);
  assert.equal((await createGoogleOAuth({ env: {}, fetcher }).connections('alice')).calendarConnection, undefined);

  await writeFile(readPath, credential('read-subject'), { mode: 0o600 });
  const preferred = await oauth.connections('alice'); assert.equal(preferred.calendarConnection?.accountRef, 'google:read-subject');
  await preferred.calendarConnection!.listCalendars(); assert.equal(refreshes.at(-1), 'refresh-read-subject');
  invalidReadScope = true;
  await assert.rejects(preferred.calendarConnection!.listCalendars(), (error: any) => error.code === 'provider_unavailable');
  assert.equal(refreshes.at(-1), 'refresh-read-subject');
  await writeFile(readPath, '{invalid', { mode: 0o600 });
  const invalid = await oauth.connections('alice');
  assert.equal(invalid.calendarConnection, undefined); assert.equal(invalid.blocked?.calendarConnection, true);
  assert.ok(invalid.calendarWriteConnection); assert.equal(await readFile(writePath, 'utf8'), original);
});
