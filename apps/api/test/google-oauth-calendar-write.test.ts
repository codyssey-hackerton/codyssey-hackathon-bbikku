import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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
