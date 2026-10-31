import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GMAIL_SCOPE, getGmailConnection, readGmailCredential, type GmailCredential } from '../src/gmail-connection.ts';

type CliModule = {
  REDIRECT_URI: string;
  createAuthorizationRequest(clientId: string): { url: string; state: string; codeVerifier: string };
  parseCallback(request: { method: string; url: string; host: string }, state: string): { kind: string; code?: string };
  createCallbackHandler(state: string, finish: (error?: Error, code?: string) => void): RequestListener;
  exchangeCode(options: { clientId: string; clientSecret: string; code: string; codeVerifier: string; fetcher: typeof fetch }): Promise<GmailCredential>;
  saveCredential(credential: GmailCredential, path: string): Promise<void>;
};
const cli = await import(new URL('../../../scripts/connect-gmail.mjs', import.meta.url).href) as CliModule;
const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client-id', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-client-secret' };
const credential: GmailCredential = { version: 1, clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, senderAddress: 'sender@example.com', subject: 'synthetic-subject', refreshToken: 'synthetic-refresh-token' };
const scope = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SCOPE}`;
const token = { access_token: 'synthetic-access-token', token_type: 'Bearer', scope };
const identity = { email: credential.senderAddress, email_verified: true, sub: credential.subject };
const approved = { recipient: 'recipient@example.com', subject: '일정 조정', message: '합성 메시지', executionKey: 'synthetic-execution' };
const failed = { status: 'failed', providerOperationId: null };

async function fixture(t: TestContext, value: unknown = credential): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-gmail-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'connection.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test('returns no connection for unconfigured development and rejects incomplete or unsafe configuration', async t => {
  const path = await fixture(t);
  const absent = join(path, '..', 'absent.json');
  assert.equal(await getGmailConnection({ env: {}, credentialPath: absent }), undefined);
  assert.equal(await getGmailConnection({ env, credentialPath: absent }), undefined);
  await assert.rejects(getGmailConnection({ env: { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'only-id' }, credentialPath: absent }), /GMAIL_CONNECTION_UNAVAILABLE/);
  await assert.rejects(getGmailConnection({ env: {}, credentialPath: path }), /GMAIL_CONNECTION_UNAVAILABLE/);
  await assert.rejects(getGmailConnection({ env: { ...env, PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'other-client' }, credentialPath: path }), /GMAIL_CONNECTION_UNAVAILABLE/);
  await chmod(path, 0o644);
  await assert.rejects(getGmailConnection({ env, credentialPath: path }), /GMAIL_CONNECTION_UNAVAILABLE/);
  await chmod(path, 0o600);
  const link = join(path, '..', 'link.json');
  await symlink(path, link);
  await assert.rejects(getGmailConnection({ env, credentialPath: link }), /GMAIL_CONNECTION_UNAVAILABLE/);
  await writeFile(path, '{broken json');
  await assert.rejects(getGmailConnection({ env, credentialPath: path }), /GMAIL_CONNECTION_UNAVAILABLE/);
});

test('refreshes and checks the stored Google account and scopes before each Gmail dispatch', async t => {
  const path = await fixture(t);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'error');
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
      assert.equal(body.get('client_secret'), env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET);
      assert.equal(body.get('refresh_token'), credential.refreshToken);
      return Response.json(token);
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.deepEqual(init?.headers, { Authorization: 'Bearer synthetic-access-token' });
      return Response.json(identity);
    }
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
    assert.ok(Buffer.from(raw, 'base64url').toString().startsWith(`From: ${credential.senderAddress}\r\n`));
    return Response.json({ id: 'synthetic-message-id' });
  };
  const connection = await getGmailConnection({ env, credentialPath: path, fetcher });
  assert.ok(connection);
  assert.equal(connection.userId, 'local-developer');
  assert.equal(connection.senderAddress, credential.senderAddress);
  assert.deepEqual(calls, []);
  assert.deepEqual(await connection.dispatch(approved), { status: 'submitted', providerOperationId: 'synthetic-message-id' });
  assert.deepEqual(await connection.dispatch(approved), { status: 'submitted', providerOperationId: 'synthetic-message-id' });
  assert.deepEqual(calls, [
    'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  ]);
});

test('token, scope, account and connection changes fail before Gmail and expose no provider error', async t => {
  const path = await fixture(t);
  const cases: { token?: unknown; info?: unknown; error?: boolean; replace?: GmailCredential }[] = [
    { error: true },
    { token: { ...token, scope: 'openid email' } },
    { token: { ...token, scope: GMAIL_SCOPE } },
    { token: { access_token: token.access_token, token_type: 'Bearer' } },
    { token: { ...token, access_token: 'invalid\r\nheader' } },
    { token: { ...token, refresh_token: 'rotated-refresh-token' } },
    { info: { ...identity, email_verified: false } },
    { info: { ...identity, email_verified: 'true' } },
    { info: { ...identity, sub: 'other-subject' } },
    { info: { ...identity, email: 'other@example.com' } },
    { info: { ...identity, email: 'sender@example.com\r\nBcc: other@example.com' } },
    { replace: { ...credential, refreshToken: 'changed-refresh-token' } },
  ];
  for (const scenario of cases) {
    await writeFile(path, JSON.stringify(credential));
    let gmailCalls = 0;
    const fetcher: typeof fetch = async url => {
      if (scenario.error) throw new Error('synthetic-secret-token');
      if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json(scenario.token ?? token);
      if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
        if (scenario.replace) await writeFile(path, JSON.stringify(scenario.replace));
        return Response.json(scenario.info ?? identity);
      }
      gmailCalls++;
      return Response.json({ id: 'unexpected' });
    };
    const connection = await getGmailConnection({ env, credentialPath: path, fetcher });
    assert.ok(connection);
    const result = await connection.dispatch(approved);
    assert.deepEqual(result, failed);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(gmailCalls, 0);
  }
  await writeFile(path, JSON.stringify(credential));
  const connection = await getGmailConnection({ env, credentialPath: path, fetcher: async () => { throw new Error('unexpected'); } });
  assert.ok(connection);
  await writeFile(path, JSON.stringify({ ...credential, subject: 'reconnected-other-account' }));
  assert.deepEqual(await connection.dispatch(approved), failed);
});

test('abort propagates through delayed refresh and userinfo and prevents Gmail dispatch', async t => {
  const path = await fixture(t);
  for (const delayed of ['token', 'userinfo']) {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const controller = new AbortController();
    const fetcher: typeof fetch = async (url, init) => {
      const endpoint = String(url);
      calls.push(endpoint);
      const isToken = endpoint === 'https://oauth2.googleapis.com/token';
      const isUserInfo = endpoint === 'https://openidconnect.googleapis.com/v1/userinfo';
      if ((delayed === 'token' && isToken) || (delayed === 'userinfo' && isUserInfo)) {
        entered(); await waiting; assert.equal(init?.signal?.aborted, true);
      }
      if (isToken) return Response.json(token);
      if (isUserInfo) return Response.json(identity);
      return Response.json({ id: 'unexpected' });
    };
    const connection = await getGmailConnection({ env, credentialPath: path, fetcher });
    assert.ok(connection);
    const pending = connection.dispatch(approved, controller.signal);
    await started;
    controller.abort();
    release();
    assert.deepEqual(await pending, failed);
    assert.ok(!calls.includes('https://gmail.googleapis.com/gmail/v1/users/me/messages/send'));
  }
});

test('authorization URL uses the exact web redirect, random state and S256 PKCE without a client secret', () => {
  const first = cli.createAuthorizationRequest(env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
  const second = cli.createAuthorizationRequest(env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.codeVerifier, second.codeVerifier);
  const url = new URL(first.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/oauth/google/callback');
  assert.equal(url.searchParams.get('scope'), `openid email ${GMAIL_SCOPE}`);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), first.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.codeVerifier).digest('base64url'));
  assert.ok(!first.url.includes(env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET));
});

test('callback requires exact host, path, one valid state and one authorization code', () => {
  const { state } = cli.createAuthorizationRequest(env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
  const query = new URLSearchParams({ state, code: 'synthetic-code' }).toString();
  const request = { method: 'GET', host: '127.0.0.1:53682', url: `/oauth/google/callback?${query}` };
  assert.deepEqual(cli.parseCallback(request, state), { kind: 'code', code: 'synthetic-code' });
  for (const invalid of [
    { ...request, method: 'POST' }, { ...request, host: 'localhost:53682' }, { ...request, url: `//other.example/oauth/google/callback?${query}` },
    { ...request, url: `/oauth/google/callback/extra?${query}` }, { ...request, url: `/oauth/google/callback?${query}&state=${state}` },
    { ...request, url: `/oauth/google/other/../callback?${query}` }, { ...request, url: `/oauth/google/callback?${query}#fragment` },
    { ...request, url: '/oauth/google/callback?state=wrong&code=synthetic-code' },
    { ...request, url: `/oauth/google/callback?${query}&code=second` },
  ]) assert.deepEqual(cli.parseCallback(invalid, state), { kind: 'invalid' });
  assert.deepEqual(cli.parseCallback({ ...request, url: `/oauth/google/callback?state=${state}&error=access_denied` }, state), { kind: 'denied' });
});

test('loopback callback rejects a bad state and never echoes an authorization code', async t => {
  const { state } = cli.createAuthorizationRequest(env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
  const finishes: (string | undefined)[] = [];
  const server = createServer(cli.createCallbackHandler(state, (_error, code) => { finishes.push(code); }));
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
  const good = await request(`/oauth/google/callback?state=${state}&code=synthetic-code`);
  assert.equal(good.status, 200);
  assert.ok(!good.body.includes('synthetic-code'));
  assert.deepEqual(finishes, ['synthetic-code']);
});

test('code exchange stores only verified credentials in a private file and keeps provider errors generic', async t => {
  const path = await fixture(t);
  const flow = cli.createAuthorizationRequest(env.PIKKU_GOOGLE_OAUTH_CLIENT_ID);
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), cli.REDIRECT_URI);
      assert.equal(body.get('code_verifier'), flow.codeVerifier);
      return Response.json({ ...token, refresh_token: credential.refreshToken });
    }
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json(identity);
  };
  const result = await cli.exchangeCode({ clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET,
    code: 'synthetic-code', codeVerifier: flow.codeVerifier, fetcher });
  assert.deepEqual(result, credential);
  assert.equal(calls, 2);
  await cli.saveCredential({ ...result, access_token: 'unexpected-access-token', client_secret: env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET } as GmailCredential, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readGmailCredential(path), credential);
  const stored = await readFile(path, 'utf8');
  assert.ok(!stored.includes('access-token'));
  assert.ok(!stored.includes(env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET));
  for (const response of [Response.json({ ...token, scope: 'openid email', refresh_token: credential.refreshToken }), Response.json(token)]) {
    await assert.rejects(cli.exchangeCode({ clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET,
      code: 'synthetic-code', codeVerifier: flow.codeVerifier, fetcher: async () => response }), /GMAIL_OAUTH_UNAVAILABLE/);
    assert.deepEqual(await readGmailCredential(path), credential);
  }
  await assert.rejects(cli.exchangeCode({ clientId: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET,
    code: 'synthetic-code', codeVerifier: flow.codeVerifier, fetcher: async () => { throw new Error('secret from provider'); } }), /^Error: GMAIL_OAUTH_UNAVAILABLE$/);
});
