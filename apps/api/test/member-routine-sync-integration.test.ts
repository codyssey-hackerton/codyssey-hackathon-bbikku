import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { MemberAuth } from '../src/member-auth.ts';

test('configured web origins can preflight an authenticated routine PATCH', async t => {
  const app = buildApp({ webOrigins: ['https://pikku.test'] });
  t.after(() => app.close());
  const response = await app.inject({ method: 'OPTIONS', url: '/v1/routines/example', headers: {
    origin: 'https://pikku.test', 'access-control-request-method': 'PATCH',
    'access-control-request-headers': 'Authorization,Content-Type,Idempotency-Key',
  } });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'https://pikku.test');
  assert.ok(String(response.headers['access-control-allow-methods']).split(',').map(value => value.trim()).includes('PATCH'));
});

test('new public login and protected feature routes report unavailable storage without exposing another user', async t => {
  const app = buildApp({ sessions: { async resolve(token) { return token === 'preview' ? { userId: 'preview-user' } : null; } } });
  t.after(() => app.close());
  for (const path of ['/v1/auth/google/start', '/v1/auth/google/complete']) {
    const response = await app.inject({ method: 'POST', url: path, payload: {} });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'not_configured');
  }
  for (const url of ['/v1/routines', '/v1/calendar-sync', '/v1/calendar-sync/calendars']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer preview' } });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'not_configured');
  }
  const write = await app.inject({ method: 'GET', url: '/v1/calendar-write-connection', headers: { authorization: 'Bearer preview' } });
  assert.equal(write.statusCode, 200); assert.deepEqual(write.json().data, { status: 'not_configured', accountLabel: null });
});

test('member store failure preserves an existing preview session and fails closed for other tokens', async t => {
  const memberAuth = { async resolve() { throw new Error('private database failure'); }, ownsState() { return false; } } as unknown as MemberAuth;
  const app = buildApp({ memberAuth, sessions: { async resolve(token) { return token === 'preview' ? { userId: 'preview-user' } : null; } } });
  t.after(() => app.close());
  const known = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: 'Bearer preview' } });
  assert.equal(known.statusCode, 200);
  const unknown = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: 'Bearer unknown' } });
  assert.equal(unknown.statusCode, 503); assert.equal(unknown.json().error.code, 'provider_unavailable');
  assert.ok(!unknown.body.includes('private database failure'));
});
