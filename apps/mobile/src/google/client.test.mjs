import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleClient } from './client.ts';

test('service polling uses the secret in the POST body and rejects unknown completion states', async () => {
  const secret = 's'.repeat(43), calls = [];
  const api = { async post(path, body) {
    calls.push({ path, body });
    return body.cancel ? { status: 'cancelled' } : calls.length === 1 ? { status: 'pending' } :
      calls.length === 2 ? { status: 'completed' } : { status: 'unexpected' };
  } };
  const client = createGoogleClient(api);
  assert.equal(await client.poll(secret), 'pending');
  assert.equal(await client.poll(secret), 'completed');
  await assert.rejects(client.poll(secret), error => error.code === 'invalid_response');
  await client.cancel(secret);
  assert.ok(calls.every(call => !call.path.includes(secret)));
  assert.deepEqual(calls.at(-1).body, { completionSecret: secret, cancel: true });
});
