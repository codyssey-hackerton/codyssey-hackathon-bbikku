import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthClient } from './client.ts';

test('login polling keeps the secret in the POST body and accepts only bound completion results', async () => {
  const secret = 's'.repeat(43), calls = [];
  const result = { sessionToken: 't'.repeat(43), expiresAt: '2030-01-01T00:00:00Z',
    member: { id: 'member', email: 'synthetic@example.test', displayName: '회원' } };
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    const data = body.cancel ? { status: 'cancelled' } : calls.length === 1 ? { status: 'pending' } : { status: 'completed', ...result };
    return Response.json({ requestId: 'r', data });
  };
  const client = createAuthClient('https://api.example.test', fetcher);
  assert.deepEqual(await client.poll(secret), { status: 'pending' });
  assert.deepEqual(await client.poll(secret), { status: 'completed', result });
  await client.cancel(secret);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.url.includes(secret)));
  assert.deepEqual(calls.map(call => call.body), [{ completionSecret: secret }, { completionSecret: secret }, { completionSecret: secret, cancel: true }]);
  await assert.rejects(client.poll('invalid'), error => error.code === 'invalid_request');
});
