import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.ts';
import { teamPreviewSessions } from '../src/auth.ts';
import { resolveGoogleConnectionOwner } from '../src/google-connection-owner.ts';
import { getGmailConnection } from '../src/gmail-connection.ts';
import { getGmailReplyConnection } from '../src/gmail-reply-connection.ts';
import { getCalendarConnection } from '../src/google-calendar.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const members = [{ userId: 'member-a', token: 'a'.repeat(40) }, { userId: 'member-b', token: 'b'.repeat(40) }];
const config = { developmentAuth: false, previewAuth: true, previewMembers: members, credentialDirectory: '/private/synthetic' };

test('only a configured registered preview member can own a Google connection', () => {
  assert.equal(resolveGoogleConnectionOwner({ ...config, configuredUserId: 'member-a' }), 'member-a');
  assert.equal(resolveGoogleConnectionOwner(config), undefined);
  assert.equal(resolveGoogleConnectionOwner({ ...config, developmentAuth: true, configuredUserId: 'member-a' }), 'local-developer');
  assert.equal(resolveGoogleConnectionOwner({ ...config, previewAuth: false, configuredUserId: 'member-a' }), undefined);
  for (const input of [
    { ...config, configuredUserId: '' }, { ...config, configuredUserId: 'member-c' },
    { ...config, configuredUserId: ' member-a' }, { ...config, configuredUserId: 'member-a', previewMembers: undefined },
    { ...config, configuredUserId: 'member-a', credentialDirectory: '' },
    { ...config, configuredUserId: 'member-a', previewMembers: [members[0], members[0]] },
  ]) assert.throws(() => resolveGoogleConnectionOwner(input), /GOOGLE_CONNECTION_OWNER_INVALID/);
});

test('three Google connections belong to the selected member and are unavailable to another member', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-google-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credential.json');
  await writeFile(path, JSON.stringify({ version: 1, clientId: 'synthetic-client', senderAddress: 'sender@example.test', subject: 'synthetic-subject', refreshToken: 'synthetic-token' }), { mode: 0o600 });
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret' };
  const userId = resolveGoogleConnectionOwner({ ...config, configuredUserId: 'member-a' }); assert.ok(userId);
  const gmailContact = await getGmailConnection({ env, credentialPath: path, userId });
  const gmailReplyConnection = await getGmailReplyConnection({ env, credentialPath: path, sendCredentialPath: path, userId });
  const calendarConnection = await getCalendarConnection({ env, credentialPath: path, userId });
  assert.equal(gmailContact?.userId, userId); assert.equal(gmailReplyConnection?.userId, userId); assert.equal(calendarConnection?.userId, userId);
  const store = new MemoryPlanningStore();
  Object.defineProperty(store, 'durable', { value: true });
  const app = buildApp({ store, gmailContact, gmailReplyConnection, calendarConnection,
    sessions: teamPreviewSessions(members, '2099-01-01T00:00:00Z') });
  t.after(() => app.close());
  for (const [token, expected] of [[members[0].token, 'available'], [members[1].token, 'not_configured']]) {
    for (const route of ['/v1/calendar-connection', '/v1/email-connection', '/v1/email-reply-connection']) {
      const response = await app.inject({ method: 'GET', url: route, headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 200); assert.equal(response.json().data.status, expected);
      if (expected === 'not_configured') assert.ok(!response.body.includes('sender@example.test'));
    }
  }
  const forbidden = await app.inject({ method: 'GET', url: '/v1/calendar/calendars', headers: { authorization: `Bearer ${members[1].token}` } });
  assert.equal(forbidden.statusCode, 503);
});

test('production server loads credentials only for the configured member and rejects an unknown owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-google-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memberPath = join(dir, 'members.json');
  await writeFile(memberPath, JSON.stringify(members), { mode: 0o600 });
  const credential = JSON.stringify({ version: 1, clientId: 'synthetic-client', senderAddress: 'sender@example.test', subject: 'synthetic-subject', refreshToken: 'synthetic-token' });
  for (const name of ['gmail-connection.json', 'gmail-replies-connection.json', 'calendar-connection.json']) await writeFile(join(dir, name), credential, { mode: 0o600 });
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const address = portServer.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const baseEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    PIKKU_TEAM_PREVIEW: 'true', PIKKU_PREVIEW_MEMBERS_FILE: memberPath, PIKKU_PREVIEW_EXPIRES_AT: '2099-01-01T00:00:00Z',
    PIKKU_GOOGLE_CREDENTIAL_DIR: dir, PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    SEOUL_SUBWAY_API_KEY: 'synthetic-subway-key', SEOUL_SUBWAY_TRANSPORT: 'invalid' };
  const start = (owner: string) => spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...baseEnv, PIKKU_GOOGLE_CONNECTION_USER_ID: owner }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const child = start('member-a');
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; if (ready) break; } catch { /* startup */ }
      if (child.exitCode !== null) throw new Error('preview server exited during startup');
      await delay(100);
    }
    assert.equal(ready, true);
    for (const [token, expected] of [[members[0].token, 'available'], [members[1].token, 'not_configured']]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/calendar-connection`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await response.json()).data.status, expected);
    }
    const subway = await fetch(`http://127.0.0.1:${port}/v1/subway/arrivals`, { method: 'POST',
      headers: { authorization: `Bearer ${members[0].token}`, 'content-type': 'application/json' }, body: JSON.stringify({ stationName: '서울역' }) });
    assert.equal(subway.status, 503); assert.equal((await subway.json()).error.code, 'not_configured');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  const invalid = start('not-a-member'); let stderr = '';
  invalid.stderr?.on('data', data => { stderr += String(data); });
  const [code] = await once(invalid, 'exit');
  assert.notEqual(code, 0); assert.match(stderr, /GOOGLE_CONNECTION_OWNER_INVALID/);
  assert.doesNotMatch(stderr, /synthetic-secret|synthetic-token|not-a-member/);
});
