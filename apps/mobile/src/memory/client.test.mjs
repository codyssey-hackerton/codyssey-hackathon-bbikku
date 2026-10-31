import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createMutationMachine } from '../api/mutation.ts';
import { createMemoryClient, isOffsetTimestamp } from './client.ts';

const at = '2026-10-31T15:00:00+09:00';
const fact = {
  id: 'memory-1', revision: 1, kind: 'preference', key: '공부 시간대', value: '오전',
  source: { type: 'user', ref: 'user-1' }, recordedAt: '2026-10-31T10:00:00+09:00', validUntil: null,
};
const situation = { ...fact, id: 'memory-2', kind: 'situation', key: '컨디션', value: { rest: true }, validUntil: '2026-11-01T18:00:00+09:00' };

function mockApi(handler) {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-token',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
  });
  return { client: createMemoryClient(api), calls };
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function waitFor(machine, status) {
  for (let count = 0; count < 100; count += 1) {
    if (machine.getState().status === status) return machine.getState();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`mutation did not reach ${status}`);
}

test('GET sends an encoded offset timestamp and unwraps the server revision', async () => {
  const { client, calls } = mockApi(() => response({ requestId: 'read-1', data: { facts: [fact, situation], contextRevision: 12 } }));
  assert.deepEqual(await client.list(at), { facts: [fact, situation], contextRevision: 12 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/memory');
  assert.equal(url.searchParams.get('at'), at);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
});

test('POST sends the mutation request ID, idempotency key, exact JSON and server revision', async () => {
  const input = { expectedContextRevision: 12, kind: 'situation', key: situation.key, value: situation.value, validUntil: situation.validUntil };
  const { client, calls } = mockApi(() => response({ requestId: 'response-1', data: { fact: situation, contextRevision: 13 } }));
  assert.deepEqual(await client.save({ input, requestId: 'request-1', idempotencyKey: 'key-1' }), { fact: situation, contextRevision: 13 });
  assert.equal(new URL(calls[0].url).pathname, '/v1/memory');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'key-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { requestId: 'request-1', ...input });
});

test('empty success remains distinct from not configured, unimplemented, and conflict responses', async () => {
  const empty = mockApi(() => response({ requestId: 'read-1', data: { facts: [], contextRevision: 0 } }));
  assert.deepEqual(await empty.client.list(at), { facts: [], contextRevision: 0 });
  for (const [code, status] of [['not_configured', 503], ['not_implemented', 501], ['conflict', 409]]) {
    const { client } = mockApi(() => response({ requestId: 'error-1', error: { code, message: 'test', retryable: false } }, status));
    await assert.rejects(client.list(at), (error) => error.code === code);
  }
});

test('invalid or expired server facts and mismatched write acknowledgments are rejected', async () => {
  const badFacts = [
    { ...fact, revision: 0 },
    { ...fact, source: { type: 'guessed', ref: 'x' } },
    { ...fact, recordedAt: '2026-02-31T10:00:00+09:00' },
    { ...fact, recordedAt: '2026-10-31T10:00:00' },
    { ...situation, validUntil: null },
    { ...situation, validUntil: at },
  ];
  for (const item of badFacts) {
    const { client } = mockApi(() => response({ requestId: 'read-1', data: { facts: [item], contextRevision: 1 } }));
    await assert.rejects(client.list(at), (error) => error.code === 'invalid_response');
  }
  const input = { expectedContextRevision: 1, kind: 'preference', key: fact.key, value: fact.value, validUntil: null };
  for (const data of [
    { fact, contextRevision: 1 },
    { fact: { ...fact, source: { type: 'derived', ref: 'x' } }, contextRevision: 2 },
    { fact: { ...fact, value: '오후' }, contextRevision: 2 },
    { fact: { ...fact, validUntil: '2026-11-01T10:00:00Z' }, contextRevision: 2 },
  ]) {
    const { client } = mockApi(() => response({ requestId: 'write-1', data }));
    await assert.rejects(client.save({ input, requestId: 'r', idempotencyKey: 'k' }), (error) => error.code === 'invalid_response');
  }
});

test('timestamps require real calendar dates and an explicit offset', () => {
  for (const value of [at, '2028-02-29T10:00:00Z', '2026-11-01T18:00+09:00']) assert.equal(isOffsetTimestamp(value), true, value);
  for (const value of ['2027-02-29T10:00:00Z', '2026-10-31T15:00:00', '2026-10-31T25:00:00Z', '2026-10-31T15:00:00+24:00', '']) {
    assert.equal(isOffsetTimestamp(value), false, value);
  }
});

for (const firstFailure of ['network', 'conflict']) {
  test(`${firstFailure} retry keeps the initial path, body, request ID and key after the draft changes`, async () => {
    const input = { expectedContextRevision: 12, kind: 'situation', key: situation.key, value: { rest: true }, validUntil: situation.validUntil };
    const { client, calls } = mockApi((_url, _options, count) => {
      if (count === 1 && firstFailure === 'network') throw new Error('offline');
      if (count === 1) return response({ requestId: 'failure', error: { code: 'conflict', message: 'conflict', retryable: false } }, 409);
      return response({ requestId: 'ok', data: { fact: situation, contextRevision: 13 } });
    });
    const machine = createMutationMachine({ execute: (operation) => client.save(operation), changed: () => {} });
    machine.submit(input);
    const failed = await waitFor(machine, 'error');
    assert.equal(failed.uncertain, firstFailure === 'network');
    input.expectedContextRevision = 99;
    input.key = 'changed';
    input.value.rest = false;
    input.validUntil = '2030-01-01T00:00:00Z';
    if (failed.uncertain) {
      machine.reset();
      assert.equal(machine.getState().status, 'error');
    }
    machine.retry();
    await waitFor(machine, 'success');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, calls[1].url);
    assert.equal(calls[0].options.body, calls[1].options.body);
    assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
    assert.deepEqual(JSON.parse(calls[1].options.body).value, { rest: true });
    assert.equal(JSON.parse(calls[1].options.body).expectedContextRevision, 12);
  });
}
