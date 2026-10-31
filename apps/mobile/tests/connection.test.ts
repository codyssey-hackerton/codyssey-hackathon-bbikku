import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiBaseUrl } from '../src/api/connection';
import { ApiError, createApiClient } from '../src/api/http';
import { createMutationMachine, type Mutation } from '../src/api/mutation';
import { createOperationGuard } from '../src/api/operationGuard';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('equivalent URL spellings normalize to the URL actually used by the client', async () => {
  const equivalents = ['http://localhost:3001', '  HTTP://LOCALHOST:3001////  ', 'http://localhost:03001/'];
  assert.deepEqual(equivalents.map(normalizeApiBaseUrl), equivalents.map(() => 'http://localhost:3001'));
  assert.equal(normalizeApiBaseUrl('HTTP://EXAMPLE.TEST:080/api/./v1/../'), 'http://example.test/api');
  assert.equal(normalizeApiBaseUrl('https://EXAMPLE.TEST:443/'), 'https://example.test');
  assert.equal(normalizeApiBaseUrl('http://[2001:DB8::1]:80/api/'), 'http://[2001:db8::1]/api');
  const seen: string[] = [];
  const api = createApiClient({ baseUrl: ' HTTP://LOCALHOST:03001/// ', getSessionToken: () => 'dev',
    fetcher: async (input) => { seen.push(String(input)); return new Response(JSON.stringify({ requestId: 'r', data: [] })); } });
  await api.get('/v1/proposals');
  assert.deepEqual(seen, ['http://localhost:3001/v1/proposals']);
});

test('meaningful connection differences stay different and unsafe base URLs are rejected', () => {
  assert.notEqual(normalizeApiBaseUrl('http://localhost:3001'), normalizeApiBaseUrl('http://127.0.0.1:3001'));
  assert.notEqual(normalizeApiBaseUrl('http://localhost'), normalizeApiBaseUrl('https://localhost'));
  assert.notEqual(normalizeApiBaseUrl('https://example.test/API'), normalizeApiBaseUrl('https://example.test/api'));
  assert.notEqual(normalizeApiBaseUrl('https://example.test/a%2Fb'), normalizeApiBaseUrl('https://example.test/a/b'));
  for (const invalid of ['ftp://host', 'http://', 'http://user:pass@host', 'http://host/?secret=x', 'http://host/#frag', 'http://host:65536', 'http://host:bad', 'http://host\\@evil.test', 'http://space host']) {
    assert.equal(normalizeApiBaseUrl(invalid), null, invalid);
  }
});

test('all pending and uncertain mutations block connection changes until their result is known', async () => {
  const guard = createOperationGuard();
  const first = {};
  const second = {};
  let attempts = 0;
  const machine = createMutationMachine({
    execute: async (_op: Mutation<{ title: string }>) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError('timeout', 'timeout', true);
      if (attempts === 2) throw new ApiError('unauthenticated', 'expired', false, 401);
      return { ok: true };
    },
    changed: (state) => guard.update(first, state),
  });
  machine.submit({ title: 'original' });
  assert.equal(guard.hasUnresolved(), true);
  await tick();
  assert.equal(guard.hasUnresolved(), true);
  machine.retry();
  await tick();
  assert.equal(guard.hasUnresolved(), true);
  guard.update(second, { status: 'pending' });
  machine.retry();
  await tick();
  assert.equal(machine.getState().status, 'success');
  assert.equal(guard.hasUnresolved(), true);
  guard.clear(second);
  assert.equal(guard.hasUnresolved(), false);
  guard.update(first, { status: 'error', error: new Error('validation'), uncertain: false });
  assert.equal(guard.hasUnresolved(), false);
});
