import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.ts';
import { createGoogleOAuth } from '../src/google-oauth.ts';
import { createMemberAuth } from '../src/member-auth.ts';
import { registerMemberAuthRoutes } from '../src/member-auth-routes.ts';

const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
  PIKKU_GOOGLE_OAUTH_REDIRECT_URI: 'https://example.test/v1/google/oauth/callback' };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signed(payload: object, corrupt = false, algorithm = 'RS256') {
  const data = `${encoded({ alg: algorithm, typ: 'JWT', kid: 'synthetic' })}.${encoded(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url');
  return `${data}.${corrupt ? `${signature.slice(0, -4)}abcd` : signature}`;
}

// Test double for session behavior; PostgreSQL SQL and transactions are checked separately.
function memoryPool() {
  const members = new Map<string, { id: string; email: string; display_name: string }>();
  const sessions = new Map<string, { memberId: string; expires: number; revoked: boolean }>();
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO pikku_members_v1')) {
      const [id, subject, email, display] = values as string[];
      const old = members.get(subject!); const member = { id: old?.id ?? id!, email: email!, display_name: display! };
      members.set(subject!, member); return { rows: [member], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO pikku_member_sessions_v1')) {
      const [key, memberId, , expiry] = values as [string, string, Date, Date];
      sessions.set(key, { memberId, expires: expiry.getTime(), revoked: false }); return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT m.id')) {
      const session = sessions.get(values[0] as string);
      const member = session && !session.revoked && session.expires > (values[1] as Date).getTime()
        ? [...members.values()].find(value => value.id === session.memberId) : undefined;
      return { rows: member ? [member] : [], rowCount: member ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE pikku_member_sessions_v1')) {
      const session = sessions.get(values[0] as string);
      if (!session || session.revoked || session.expires <= (values[1] as Date).getTime()) return { rows: [], rowCount: 0 };
      session.revoked = true; return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  return { pool, members, sessions };
}

test('Google login verifies actual signed ID tokens, binds both secrets, and issues separate revocable sessions', async t => {
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', async () => ({ certs: { synthetic: publicKey }, format: 'PEM' as never }));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const db = memoryPool(); let current = Date.now(); let expectedNonce = ''; let expectedChallenge = '';
  let claims: Record<string, unknown> = {}; let corrupt = false; let algorithm = 'RS256'; let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), expectedChallenge);
    const seconds = Math.floor(Date.now() / 1000);
    return Response.json({ id_token: signed({ iss: 'https://accounts.google.com', aud: env.PIKKU_GOOGLE_OAUTH_CLIENT_ID,
      sub: 'synthetic-google-subject', email: 'person@example.test', email_verified: true, name: '합성 회원',
      nonce: expectedNonce, iat: seconds - 1, exp: seconds + 600, ...claims }, corrupt, algorithm) });
  };
  const auth = createMemberAuth({ pool: db.pool, env, fetcher, clock: () => new Date(current) });
  function start() {
    const result = auth.start()!; const url = new URL(result.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('scope'), 'openid email profile'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const state = url.searchParams.get('state')!; assert.match(state, /^member_[A-Za-z0-9_-]{43}$/);
    expectedNonce = url.searchParams.get('nonce')!; expectedChallenge = url.searchParams.get('code_challenge')!;
    assert.ok(!result.authorizationUrl.includes(result.completionSecret));
    return { ...result, state };
  }
  for (const invalid of [
    { claims: {}, corrupt: true }, { claims: {}, algorithm: 'none' }, { claims: { aud: 'wrong-client' } }, { claims: { iss: 'https://other.test' } },
    { claims: { nonce: 'wrong' } }, { claims: { email_verified: false } }, { claims: { sub: '' } },
    { claims: { exp: Math.floor(Date.now() / 1000) - 1 } },
  ]) {
    claims = invalid.claims; corrupt = invalid.corrupt ?? false; algorithm = invalid.algorithm ?? 'RS256';
    const flow = start(); assert.equal(await auth.callback(flow.state, 'synthetic-code'), undefined);
    assert.equal(await auth.callback(flow.state, 'synthetic-code'), undefined);
  }
  assert.equal(db.members.size, 0); assert.equal(db.sessions.size, 0);
  claims = {}; corrupt = false; algorithm = 'RS256';
  const flow = start(); assert.equal(auth.ownsState(flow.state), true); assert.equal(auth.ownsState('other'), false);
  const confirmationCode = await auth.callback(flow.state, 'synthetic-code'); assert.ok(confirmationCode);
  assert.equal(await auth.complete('a'.repeat(43), confirmationCode), null);
  const results = await Promise.all([auth.complete(flow.completionSecret, confirmationCode), auth.complete(flow.completionSecret, confirmationCode)]);
  const result = results.find(value => value !== null)!; assert.equal(results.filter(Boolean).length, 1);
  assert.match(result.member.id, /^member:/); assert.equal(result.member.email, 'person@example.test');
  assert.equal(Date.parse(result.expiresAt) - current, 7 * 86_400_000);
  assert.equal(db.sessions.has(result.sessionToken), false); assert.ok(db.sessions.has(createHash('sha256').update(result.sessionToken).digest('hex')));
  assert.deepEqual(await auth.resolve(result.sessionToken), { userId: result.member.id });
  assert.equal(await auth.me('unrelated'), null);
  const legacy = createGoogleOAuth({ env: {} }); let legacyCalls = 0;
  t.mock.method(legacy, 'callback', async () => { legacyCalls++; return 'b'.repeat(43); });
  const app = buildApp({ memberAuth: auth, memberAllowLocalInsecure: true, googleOAuth: legacy,
    sessions: { async resolve(value) { return value === 'preview-test' ? { userId: 'team-preview' } : null; } } });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${result.sessionToken}` };
  const profile = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
  assert.equal(profile.statusCode, 200); assert.deepEqual(profile.json().data.member, result.member);
  const loggedOut = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers, payload: {} });
  assert.equal(loggedOut.statusCode, 200); assert.equal(loggedOut.json().data.status, 'logged_out');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers })).statusCode, 401);
  assert.equal(await auth.logout(result.sessionToken), false);
  assert.equal(await auth.resolve(result.sessionToken), null);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: 'Bearer preview-test' } })).statusCode, 200);
  const started = await app.inject({ method: 'POST', url: '/v1/auth/google/start', payload: {} });
  assert.equal(started.statusCode, 200, started.body);
  const startedData = started.json().data; const browser = new URL(startedData.authorizationUrl);
  expectedNonce = browser.searchParams.get('nonce')!; expectedChallenge = browser.searchParams.get('code_challenge')!;
  const callback = await app.inject({ method: 'GET', url: `/v1/google/oauth/callback?state=${browser.searchParams.get('state')}&code=synthetic-code` });
  assert.equal(callback.statusCode, 200, callback.body); assert.equal(callback.headers['cache-control'], 'no-store'); assert.equal(legacyCalls, 0);
  const browserCode = callback.body.match(/[A-Za-z0-9_-]{43}/)?.[0]; assert.ok(browserCode);
  const completed = await app.inject({ method: 'POST', url: '/v1/auth/google/complete', payload: { completionSecret: startedData.completionSecret, confirmationCode: browserCode } });
  assert.equal(completed.statusCode, 200, completed.body); assert.equal(completed.json().data.member.id, result.member.id);
  const memberSession = completed.json().data.sessionToken;
  assert.equal((await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: `Bearer ${memberSession}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/google/complete', payload: { completionSecret: startedData.completionSecret, confirmationCode: browserCode } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/google/oauth/callback?state=${'z'.repeat(43)}&code=synthetic-code` })).statusCode, 200);
  assert.equal(legacyCalls, 1);
  const firstFlow = start(); const firstTicket = await auth.callback(firstFlow.state, 'synthetic-code'); assert.ok(firstTicket);
  const secondFlow = start(); const secondTicket = await auth.callback(secondFlow.state, 'synthetic-code'); assert.ok(secondTicket);
  assert.equal(await auth.complete(firstFlow.completionSecret, secondTicket), null);
  assert.equal(await auth.complete(secondFlow.completionSecret, firstTicket), null);
  assert.ok(await auth.complete(firstFlow.completionSecret, firstTicket));
  assert.ok(await auth.complete(secondFlow.completionSecret, secondTicket));
  const ticketFlow = start(); const oldTicket = await auth.callback(ticketFlow.state, 'synthetic-code'); assert.ok(oldTicket);
  current += 10 * 60_000; assert.equal(await auth.complete(ticketFlow.completionSecret, oldTicket), null);
  current = Date.now();
  const second = start(); const ticket = await auth.callback(second.state, 'synthetic-code'); assert.ok(ticket);
  const again = await auth.complete(second.completionSecret, ticket); assert.equal(again!.member.id, result.member.id);
  current += 7 * 86_400_000; assert.equal(await auth.resolve(again!.sessionToken), null);
  const expiring = start(); current += 10 * 60_000; assert.equal(await auth.callback(expiring.state, 'synthetic-code'), undefined);
  assert.equal(network.mock.callCount(), 0); assert.ok(requests >= 9);
});

test('member routes require TLS, sanitize errors, guard sessions, and limit repeated public attempts', async t => {
  const db = memoryPool(); const auth = createMemberAuth({ pool: db.pool, env });
  const app = Fastify(); registerMemberAuthRoutes(app, auth); t.after(() => app.close());
  const insecure = await app.inject({ method: 'POST', url: '/v1/auth/google/start', payload: {} });
  assert.equal(insecure.statusCode, 403); assert.equal(insecure.headers['cache-control'], 'no-store');
  const local = Fastify(); const guard = registerMemberAuthRoutes(local, auth, { allowLocalInsecure: true });
  local.get('/v1/google/oauth/callback', { onRequest: guard }, async () => ({ ok: true })); t.after(() => local.close());
  const first = await local.inject({ method: 'POST', url: '/v1/auth/google/start', payload: {} });
  assert.equal(first.statusCode, 200); assert.ok(first.json().data.completionSecret); assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal((await local.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode, 401);
  assert.equal((await local.inject({ method: 'POST', url: '/v1/auth/logout', payload: {} })).statusCode, 401);
  const invalid = await local.inject({ method: 'POST', url: '/v1/auth/google/complete', payload: { completionSecret: 'bad', confirmationCode: 'bad' } });
  assert.equal(invalid.statusCode, 400); assert.doesNotMatch(invalid.body, /synthetic-secret/);
  for (let i = 0; i < 18; i++) await local.inject({ method: 'POST', url: '/v1/auth/google/start', payload: {} });
  assert.equal((await local.inject({ method: 'GET', url: '/v1/google/oauth/callback' })).statusCode, 429);
});
