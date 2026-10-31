import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGoogleOAuth } from '../src/google-oauth.ts';
import { getContactsConnection } from '../src/google-contacts.ts';

const contactsScope = 'openid email https://www.googleapis.com/auth/contacts.readonly';
const envBase = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret' };
const credentials = { version: 1, clientId: envBase.PIKKU_GOOGLE_OAUTH_CLIENT_ID, senderAddress: 'alice@example.test', subject: 'alice-subject', refreshToken: 'synthetic-refresh' };

test('contacts OAuth isolates users and scope, preserves existing files, and rejects partial consent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-oauth-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...envBase, PIKKU_GOOGLE_USER_CREDENTIAL_DIR: directory, PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.test/v1/google/oauth/callback' };
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', scope: code === 'partial' ? 'openid email' : contactsScope });
    }
    assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ email: 'alice@example.test', email_verified: true, sub: 'alice-subject' });
  };
  const oauth = createGoogleOAuth({ env, fetcher });
  const begin = async () => {
    const start = await oauth.start('alice', 'contacts'); assert.ok(start);
    const url = new URL(start.authorizationUrl);
    assert.equal(url.searchParams.get('scope'), contactsScope);
    return { start, state: url.searchParams.get('state')! };
  };
  const partial = await begin(); assert.equal(await oauth.callback(partial.state, 'partial'), undefined);
  assert.deepEqual(await readdir(directory), []);
  const first = await begin(); const confirmation = await oauth.callback(first.state, 'complete'); assert.ok(confirmation);
  assert.equal(await oauth.complete('bob', first.start.completionSecret, confirmation), false);
  assert.equal(await oauth.complete('alice', first.start.completionSecret, confirmation), true);
  const userDir = join(directory, createHash('sha256').update('alice').digest('hex'));
  assert.deepEqual(await readdir(userDir), ['contacts-connection.json']);
  assert.equal((await stat(userDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(userDir, 'contacts-connection.json'))).mode & 0o777, 0o600);
  const connection = (await oauth.connections('alice')).contactsConnection;
  assert.equal(connection?.userId, 'alice'); assert.equal(connection?.accountLabel, 'alice@example.test');
  assert.equal((await oauth.connections('bob')).contactsConnection, undefined);
  const otherPath = join(userDir, 'calendar-connection.json'); await writeFile(otherPath, 'unchanged', { mode: 0o600 });
  const next = await begin(); assert.equal(await oauth.callback(next.state, 'partial'), undefined);
  assert.deepEqual((await readdir(userDir)).sort(), ['calendar-connection.json', 'contacts-connection.json']);
  assert.equal(await readFile(otherPath, 'utf8'), 'unchanged');
  assert.equal((await oauth.connections('alice')).contactsConnection?.userId, 'alice');
});

test('name search warms up first, returns only matching names and phone numbers, and caps results', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-search-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call'); });
  const queries: string[] = []; let warmupAt = 0; let searchAt = 0; let tokenCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') { tokenCalls++; return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: contactsScope }); }
    if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: credentials.senderAddress, email_verified: true, sub: credentials.subject });
    assert.equal(url.origin + url.pathname, 'https://people.googleapis.com/v1/people:searchContacts');
    assert.equal(url.searchParams.get('readMask'), 'names,phoneNumbers'); assert.equal(url.searchParams.get('pageSize'), '30');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-access');
    const query = url.searchParams.get('query')!; queries.push(query);
    if (!query) { warmupAt = Date.now(); return Response.json({ results: [{ person: { names: [{ displayName: 'warmup must not appear' }] } }] }); }
    searchAt = Date.now();
    const matching = { person: { resourceName: 'people/private-id', names: [{ displayName: '김민수' }],
      phoneNumbers: [{ value: '010-1234-5678', canonicalForm: '+821012345678', formattedType: '휴대전화' }, { value: '010 2345 6789', type: 'work' }], emailAddresses: [{ value: 'never-return@example.test' }] } };
    return Response.json({ results: [matching, { person: { names: [{ displayName: '다른 이름' }], phoneNumbers: [{ value: '+821011111111' }] } },
      ...Array.from({ length: 28 }, () => ({ person: {} }))] });
  };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  await assert.rejects(connection.searchContacts({ query: '  ' }), (e: any) => e.code === 'invalid_request');
  assert.equal(tokenCalls, 0);
  const result = await connection.searchContacts({ query: '김' });
  assert.deepEqual(queries, ['', '김']); assert.ok(searchAt - warmupAt >= 4900);
  assert.deepEqual(result, { contacts: [{ id: 'contact-0', displayName: '김민수', phoneNumbers: [
    { label: '휴대전화', number: '+821012345678' }, { label: 'work', number: '+821023456789' }] }], truncated: true });
  assert.equal(network.mock.callCount(), 0);
});

test('refresh with missing scope or wrong identity never reaches People API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-scope-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  for (const mode of ['scope', 'identity'] as const) {
    let peopleCalls = 0;
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: mode === 'scope' ? 'openid email' : contactsScope });
      if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: 'bob@example.test', email_verified: true, sub: 'bob-subject' });
      peopleCalls++; throw new Error('Unexpected People API call');
    };
    const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
    await assert.rejects(connection.searchContacts({ query: '김' }), (e: any) => e.code === 'provider_unavailable');
    assert.equal(peopleCalls, 0);
  }
});

test('abort stops a signal-ignoring upstream and no late response starts another request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-cancel-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  let release!: (response: Response) => void; let entered!: () => void; let calls = 0; let upstreamSignal: AbortSignal | undefined;
  const waiting = new Promise<Response>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetcher: typeof fetch = async (_input, init) => { calls++; upstreamSignal = init?.signal ?? undefined; entered(); return waiting; };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  const controller = new AbortController();
  const pending = connection.searchContacts({ query: '김' }, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, (e: any) => e.code === 'provider_unavailable');
  assert.equal(upstreamSignal?.aborted, true);
  release(Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: contactsScope }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('token and identity payloads are bounded before People requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-bounds-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  for (const oversized of ['token', 'identity']) {
    let peopleCalls = 0;
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: contactsScope, padding: oversized === 'token' ? 'x'.repeat(70_000) : '' });
      if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: credentials.senderAddress, email_verified: true, sub: credentials.subject, padding: oversized === 'identity' ? 'x'.repeat(70_000) : '' });
      peopleCalls++; throw new Error('Unexpected People API call');
    };
    const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
    await assert.rejects(connection.searchContacts({ query: '김' }), (e: any) => e.code === 'provider_unavailable');
    assert.equal(peopleCalls, 0);
  }
});

test('a contact with more than 20 numbers reports truncation', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-truncated-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: contactsScope });
    if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: credentials.senderAddress, email_verified: true, sub: credentials.subject });
    if (!url.searchParams.get('query')) return Response.json({});
    return Response.json({ results: [{ person: { names: [{ displayName: '김민수' }], phoneNumbers: Array.from({ length: 21 }, (_, i) => ({ value: `+821000000${String(i).padStart(3, '0')}` })) } }] });
  };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  const result = await connection.searchContacts({ query: '김' });
  assert.equal(result.contacts[0]!.phoneNumbers.length, 20); assert.equal(result.truncated, true);
});

test('abort interrupts a stalled warmup body cancel without starting the search', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-warmup-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  let release!: () => void; let entered!: () => void; const queries: string[] = [];
  const cancelStarted = new Promise<void>(resolve => { entered = resolve; });
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', scope: contactsScope });
    if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ email: credentials.senderAddress, email_verified: true, sub: credentials.subject });
    queries.push(url.searchParams.get('query')!);
    return new Response(new ReadableStream({ cancel() { entered(); return stalled; } }));
  };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  const controller = new AbortController(); const pending = connection.searchContacts({ query: '김' }, { signal: controller.signal });
  await cancelStarted; controller.abort(); await assert.rejects(pending, (e: any) => e.code === 'provider_unavailable');
  release(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(queries, ['']);
});

test('the whole search has a deadline even if fetch ignores abort', { timeout: 3000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-deadline-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal); let deadline = 0; let calls = 0;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { if (ms === 15_000) { deadline = ms; return originalTimeout(30); } return originalTimeout(ms); });
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const fetcher: typeof fetch = async () => { calls++; return new Promise<Response>(() => {}); };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  await assert.rejects(connection.searchContacts({ query: '김' }), (e: any) => e.code === 'provider_unavailable');
  assert.equal(deadline, 15_000); assert.equal(calls, 1);
});

test('abort interrupts a stalled token body and does not reach userinfo', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-contacts-token-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'contacts.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  let entered!: () => void; let calls = 0; const bodyStarted = new Promise<void>(resolve => { entered = resolve; });
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ pull() { entered(); return new Promise<void>(() => {}); } }));
  };
  const connection = await getContactsConnection({ env: envBase, credentialPath: path, userId: 'alice', fetcher }); assert.ok(connection);
  const controller = new AbortController(); const pending = connection.searchContacts({ query: '김' }, { signal: controller.signal });
  await bodyStarted; controller.abort(); await assert.rejects(pending, (e: any) => e.code === 'provider_unavailable');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});
