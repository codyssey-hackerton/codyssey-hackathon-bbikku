import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/api/http';
import { createPreparationClient, parseMinutes } from '../src/preparation/client';
import { createMutationMachine, type Mutation } from '../src/api/mutation';
import type { PreparationProposalInput } from '../src/preparation/client';

const input: PreparationProposalInput = { targetId: 'event', expectedTargetRevision: 2, expectedScheduleRevision: 3, timezone: 'Asia/Seoul', preparationMinutes: 0, travelMinutes: 10, bufferMinutes: 5 };
const op: Mutation<PreparationProposalInput> = { input, requestId: 'request', idempotencyKey: 'key' };
const proposal = { kind: 'proposal', message: '제안 생성', proposalIds: ['p1'] };

test('posts contract and unwraps HTTP data.result', async () => {
  const requests: any[] = [];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'token', fetcher: async (url, init) => {
    requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
    return Response.json({ requestId: 'response', data: { result: proposal } });
  } });
  assert.deepEqual(await createPreparationClient(api).create(op), proposal);
  assert.deepEqual(requests, [{ url: 'http://localhost:3001/v1/preparation-proposals', method: 'POST', body: { requestId: 'request', ...input }, key: 'key' }]);
});

test('rejects malformed responses as uncertain and retries with identical body and key', async () => {
  const requests: any[] = [];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'token', fetcher: async (_url, init) => {
    requests.push({ body: String(init?.body), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
    return Response.json({ requestId: 'response', data: requests.length === 1 ? { result: { ...proposal, proposalIds: [] } } : { result: proposal } });
  } });
  const machine = createMutationMachine({ execute: createPreparationClient(api).create, changed() {} });
  machine.submit(input); await new Promise(resolve => setImmediate(resolve));
  const state = machine.getState(); assert.equal(state.status, 'error');
  if (state.status === 'error') { assert.equal(state.uncertain, true); assert.ok(state.error instanceof ApiError); }
  machine.retry(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(machine.getState().status, 'success'); assert.deepEqual(requests[1], requests[0]);
});

test('minute parser requires a nonnegative safe integer number of milliseconds', () => {
  for (const bad of ['', ' ', '-1', 'NaN', 'Infinity', '1e999', '0x10', '0.00001', '150119987580']) {
    assert.equal(parseMinutes(bad), null, bad);
  }
  for (const [value, expected] of [['0', 0], [' 2.5 ', 2.5], ['0.1', 0.1], ['0.00005', 0.00005], ['149999999999', 149999999999]] as const) {
    assert.equal(parseMinutes(value), expected, value);
  }
});
