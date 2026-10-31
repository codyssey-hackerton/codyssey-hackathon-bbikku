import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

type Credential = { version: 1; clientId: string; senderAddress: string; subject: string; refreshToken: string };
type Cli = {
  REDIRECT_URI: string;
  SCOPES: string[];
  CREDENTIAL_PATH: string;
  createAuthorizationRequest(clientId: string): { url: string; state: string; codeVerifier: string };
  parseCallback(request: { method: string; url: string; host: string }, state: string): { kind: string; code?: string };
  createCallbackHandler(state: string, finish: (error?: Error, code?: string) => void): RequestListener;
  exchangeCode(options: { clientId: string; clientSecret: string; code: string; codeVerifier: string; fetcher: typeof fetch }): Promise<Credential>;
  saveCredential(credential: Credential, path: string): Promise<void>;
};
const script = new URL('../../../scripts/connect-calendar.mjs', import.meta.url);
const cli = await import(script.href) as Cli;
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const credential: Credential = { version: 1, clientId: 'synthetic-client', senderAddress: 'sender@example.com', subject: 'synthetic-subject', refreshToken: 'synthetic-refresh' };
const token = { access_token: 'synthetic-access', token_type: 'Bearer', refresh_token: credential.refreshToken, scope: scopes.join(' ') };
const identity = { email: credential.senderAddress, email_verified: true, sub: credential.subject };
const generic = /^Error: CALENDAR_OAUTH_UNAVAILABLE$/;
const options = { clientId: credential.clientId, clientSecret: 'synthetic-secret', code: 'synthetic-code', codeVerifier: 'synthetic-verifier' };

test('requests only the four calendar scopes with a fixed web redirect, random state and PKCE S256', () => {
  const first = cli.createAuthorizationRequest(credential.clientId);
  const second = cli.createAuthorizationRequest(credential.clientId);
  const url = new URL(first.url);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.codeVerifier, second.codeVerifier);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), credential.clientId);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/oauth/google/callback');
  assert.equal(url.searchParams.get('scope'), scopes.join(' '));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), first.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.codeVerifier).digest('base64url'));
  assert.ok(!first.url.includes(options.clientSecret));
  assert.throws(() => cli.createAuthorizationRequest('bad\nclient'), generic);
});

test('callback accepts only exact host, path, one state, and one code', () => {
  const { state } = cli.createAuthorizationRequest(credential.clientId);
  const query = new URLSearchParams({ state, code: 'synthetic-code' }).toString();
  const request = { method: 'GET', host: '127.0.0.1:53682', url: `/oauth/google/callback?${query}` };
  assert.deepEqual(cli.parseCallback(request, state), { kind: 'code', code: 'synthetic-code' });
  for (const invalid of [
    { ...request, method: 'POST' }, { ...request, host: 'localhost:53682' },
    { ...request, url: `//evil.example/oauth/google/callback?${query}` },
    { ...request, url: `/oauth/google/other/../callback?${query}` },
    { ...request, url: `/oauth/google/callback/?${query}` },
    { ...request, url: `/oauth/google/callback?${query}#fragment` },
    { ...request, url: `/oauth/google/callback?${query}&state=${state}` },
    { ...request, url: `/oauth/google/callback?${query}&code=second` },
    { ...request, url: `/oauth/google/callback?${query}&error=denied` },
    { ...request, url: '/oauth/google/callback?state=wrong&code=synthetic-code' },
  ]) assert.deepEqual(cli.parseCallback(invalid, state), { kind: 'invalid' });
  assert.deepEqual(cli.parseCallback({ ...request, url: `/oauth/google/callback?state=${state}&error=access_denied` }, state), { kind: 'denied' });
});

test('loopback handler rejects incorrect state and never echoes secrets', async t => {
  const { state } = cli.createAuthorizationRequest(credential.clientId);
  const finishes: (string | undefined)[] = [];
  const server = createServer(cli.createCallbackHandler(state, (_error, code) => finishes.push(code)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (path: string) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, headers: { Host: '127.0.0.1:53682' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal((await request('/oauth/google/callback?state=wrong&code=synthetic-code')).status, 400);
  assert.deepEqual(finishes, []);
  const result = await request(`/oauth/google/callback?state=${state}&code=synthetic-code`);
  assert.equal(result.status, 200);
  assert.ok(!result.body.includes('synthetic-code'));
  assert.deepEqual(finishes, ['synthetic-code']);
});

test('exchanges using only mocked endpoints and returns verified minimal identity', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), options.clientId);
      assert.equal(body.get('client_secret'), options.clientSecret);
      assert.equal(body.get('code'), options.code);
      assert.equal(body.get('code_verifier'), options.codeVerifier);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), cli.REDIRECT_URI);
      return Response.json({ ...token, scope: scopes.join(' ').replace('email', 'https://www.googleapis.com/auth/userinfo.email') });
    }
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer synthetic-access' });
    return Response.json(identity);
  };
  assert.deepEqual(await cli.exchangeCode({ ...options, fetcher }), credential);
  assert.deepEqual(calls, ['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo']);
});

test('rejects missing grants, invalid tokens and unverified identity without exposing provider errors', async () => {
  const badTokens: unknown[] = [
    ...scopes.map(scope => ({ ...token, scope: scopes.filter(item => item !== scope).join(' ') })),
    { ...token, refresh_token: undefined }, { ...token, access_token: 'bad\r\nheader' },
    { ...token, token_type: 'bearer' }, { ...token, scope: undefined },
  ];
  for (const bad of badTokens) {
    let calls = 0;
    await assert.rejects(cli.exchangeCode({ ...options, fetcher: async () => { calls++; return Response.json(bad); } }), generic);
    assert.equal(calls, 1);
  }
  for (const info of [
    { ...identity, email_verified: false }, { ...identity, email_verified: 'true' },
    { ...identity, sub: '' }, { ...identity, sub: 'x'.repeat(256) },
    { ...identity, email: 'sender@example.com\r\nInjected: x' },
  ]) {
    let calls = 0;
    await assert.rejects(cli.exchangeCode({ ...options, fetcher: async () => Response.json(++calls === 1 ? token : info) }), generic);
    assert.equal(calls, 2);
  }
  await assert.rejects(cli.exchangeCode({ ...options, fetcher: async () => { throw new Error('synthetic-provider-secret'); } }), generic);
  await assert.rejects(cli.exchangeCode({ ...options, fetcher: async () => new Response('synthetic-provider-secret', { status: 400 }) }), generic);
});

test('writes only the credential atomically in a private directory and preserves existing content on failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pikku-calendar-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'private');
  const path = join(dir, 'connection.json');
  await cli.saveCredential({ ...credential, access_token: 'extra', client_secret: 'extra' } as Credential, path);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), credential);
  assert.deepEqual(await readdir(dir), ['connection.json']);
  await assert.rejects(cli.saveCredential({ ...credential, subject: '' }, path), generic);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), credential);
  await chmod(dir, 0o755);
  await assert.rejects(cli.saveCredential(credential, path), generic);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), credential);
  await chmod(dir, 0o700);
  const link = join(root, 'link');
  await symlink(dir, link);
  await assert.rejects(cli.saveCredential(credential, join(link, 'other.json')), generic);
  const nested = join(root, 'nested');
  await mkdir(nested, { mode: 0o700 });
  await mkdir(join(nested, 'target'), { mode: 0o700 });
  await assert.rejects(cli.saveCredential(credential, join(nested, 'target')), generic);
  assert.deepEqual(await readdir(nested), ['target']);
  assert.ok(cli.CREDENTIAL_PATH.endsWith('/.local/calendar-connection.json'));
});

test('plain node CLI loads without tsx and fails safely without configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-calendar-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--env-file-if-exists=.env.local', fileURLToPath(script)], { cwd: dir, env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr.trim(), /^(?:\.env\.local not found\. Continuing without it\.\n)?Calendar 연결 실패\. OAuth 설정과 동의 상태를 확인하세요\.$/);
  assert.deepEqual(await readdir(dir), []);
});
