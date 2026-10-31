import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient } from '../src/api/http';

test('phone credentials never leave over remote plain HTTP', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls += 1; return Response.json({ requestId: 'r', data: {} }); };
  const body = { requestId: 'r', accountSid: 'synthetic', authToken: 'synthetic', fromNumber: '+12025550100' };
  const remote = createApiClient({ baseUrl: 'http://192.0.2.1:3001', getSessionToken: () => 'synthetic', fetcher });
  await assert.rejects(remote.post('/v1/phone-connection', body, { idempotencyKey: 'k' }),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_configuration');
  assert.equal(calls, 0);
  for (const baseUrl of ['https://api.example.test', 'http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001']) {
    const api = createApiClient({ baseUrl, getSessionToken: () => 'synthetic', fetcher });
    await api.post('/v1/phone-connection', body, { idempotencyKey: 'k' });
  }
  assert.equal(calls, 4);
});
