import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient } from '../src/api/http';
import { createAuthClient } from '../src/auth/client';
import { createRoutineClient, validPeriod } from '../src/routines/client';

const url = () => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
  nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;

test('public authentication omits bearer and cookies, validates OAuth URL, and uses one completion request', async () => {
  const requests: any[] = [];
  const auth = createAuthClient('https://example.test', async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ requestId: 'r', data: requests.length === 1 ? { authorizationUrl: url(), completionSecret: 'x'.repeat(43) } :
      { sessionToken: 'token', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'member:synthetic', email: 'a@example.test', displayName: 'A' } } });
  });
  const start = await auth.start(); const result = await auth.complete(start.completionSecret, 'z'.repeat(43));
  assert.equal(result.member.id, 'member:synthetic'); assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.headers.Authorization, undefined); }
});

test('public authentication rejects an untrusted URL and nonlocal plaintext server', async () => {
  const invalid = createAuthClient('https://example.test', async () => Response.json({ requestId: 'r', data: { authorizationUrl: url().replace('accounts.google.com', 'attacker.test'), completionSecret: 'x'.repeat(43) } }));
  await assert.rejects(invalid.start(), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  const insecure = createAuthClient('http://example.test', async () => { throw new Error('must not call'); });
  await assert.rejects(insecure.start(), (error: unknown) => error instanceof ApiError && error.code === 'invalid_configuration');
});

test('routine PATCH uses common bearer and idempotency headers; date window is inclusive and bounded', async () => {
  let request: any;
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'synthetic', fetcher: async (input, init) => {
    request = { input: String(input), ...init }; return Response.json({ requestId: 'r', data: { routine: { id: 'r/1', revision: 2, title: 'walk', weekdays: [1, 3], timezone: 'Asia/Seoul', startDate: '2026-11-01', localTime: '09:00', durationMinutes: 30, active: true } } });
  } });
  await createRoutineClient(api).update({ requestId: 'request-1', idempotencyKey: 'key-1', input: { id: 'r/1', expectedRevision: 1, changes: { weekdays: [1, 3] } } });
  assert.equal(request.method, 'PATCH'); assert.equal(new URL(request.input).pathname, '/v1/routines/r%2F1');
  assert.equal(request.headers.Authorization, 'Bearer synthetic'); assert.equal(request.headers['Idempotency-Key'], 'key-1');
  assert.deepEqual(JSON.parse(request.body), { requestId: 'request-1', expectedRevision: 1, weekdays: [1, 3] });
  assert.equal(validPeriod('2026-11-01', '2026-12-01'), true); assert.equal(validPeriod('2026-11-01', '2026-12-02'), false);
  assert.equal(validPeriod('2026-02-30', '2026-03-01'), false);
});
