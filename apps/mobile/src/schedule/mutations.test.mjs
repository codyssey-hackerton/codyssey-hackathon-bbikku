import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createMutationMachine } from '../api/mutation.ts';
import { createScheduleClient } from './client.ts';

const fields = {
  kind: 'event', title: '회의',
  timeSlot: { startsAt: '2026-10-31T09:00:00+09:00', endsAt: '2026-10-31T10:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending',
};
const item = { id: '약속 / #1', revision: 3, ...fields, sourceRefs: [] };
const commandInput = {
  expectedScheduleRevision: 9,
  changeSet: { changes: [{ changeId: 'change-1', operation: 'update', targetId: item.id, expectedRevision: item.revision, after: fields }] },
};
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function setup(fetcher) {
  return createScheduleClient(createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-token', fetcher }));
}

test('command and checkin send v1 bodies, encoded IDs, and separate idempotency headers', async () => {
  const calls = [];
  const client = setup(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({ requestId: 'r1', data: { outcome: 'applied', items: [item], deletedIds: [], scheduleRevision: 10 } });
    return json({ requestId: 'r2', data: { item: { ...item, revision: 4, completion: 'unknown' }, scheduleRevision: 11 } });
  });
  await client.command({ input: commandInput, requestId: 'r1', idempotencyKey: 'key1' });
  await client.checkin({ input: { id: item.id, expectedRevision: 3, completion: 'unknown' }, requestId: 'r2', idempotencyKey: 'key2' });
  assert.equal(calls[0].url, 'https://mock.invalid/v1/schedule/commands');
  assert.deepEqual(JSON.parse(calls[0].options.body), { requestId: 'r1', ...commandInput });
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'key1');
  assert.equal(calls[1].url, `https://mock.invalid/v1/schedule/${encodeURIComponent(item.id)}/checkin`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { requestId: 'r2', expectedRevision: 3, completion: 'unknown' });
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'key2');
});

test('uncertain checkin retry retains the original path, revision, body and key after selection changes', async () => {
  const calls = [];
  let successes = 0;
  const client = setup(async (url, options) => {
    calls.push({ url, body: options.body, key: options.headers['Idempotency-Key'] });
    if (calls.length === 1) throw new Error('offline');
    return json({ requestId: 'server', data: { item: { ...item, completion: 'completed' }, scheduleRevision: 10 } });
  });
  const machine = createMutationMachine({ execute: (op) => client.checkin(op), changed: () => {}, succeeded: () => { successes += 1; } });
  const selected = { id: item.id, expectedRevision: 3, completion: 'completed' };
  machine.submit(selected);
  await nextTick();
  assert.equal(machine.getState().status, 'error');
  assert.equal(machine.getState().uncertain, true);
  selected.id = 'different item';
  selected.expectedRevision = 99;
  selected.completion = 'unknown';
  machine.reset();
  machine.submit(selected);
  assert.equal(machine.getState().status, 'error');
  machine.retry();
  await nextTick();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(successes, 1);
  assert.equal(machine.getState().status, 'success');
});

test('confirmed contact_required retry is identical; reset allows a new edited operation', async () => {
  const calls = [];
  let successes = 0;
  const client = setup(async (url, options) => {
    calls.push({ url, body: options.body, key: options.headers['Idempotency-Key'] });
    if (calls.length <= 2) return json({ requestId: 'r', error: { code: 'contact_required', message: 'contact', retryable: false } }, 409);
    return json({ requestId: 'r', data: { outcome: 'applied', items: [item], deletedIds: [], scheduleRevision: 10 } });
  });
  const machine = createMutationMachine({ execute: (op) => client.command(op), changed: () => {}, succeeded: () => { successes += 1; } });
  const input = JSON.parse(JSON.stringify(commandInput));
  machine.submit(input);
  await nextTick();
  assert.equal(machine.getState().uncertain, false);
  assert.equal(machine.getState().error.code, 'contact_required');
  input.expectedScheduleRevision = 123;
  input.changeSet.changes[0].after.title = '폼에서 바뀐 제목';
  machine.retry();
  await nextTick();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(successes, 0);
  machine.reset();
  machine.submit(input);
  await nextTick();
  assert.notEqual(calls[2].key, calls[0].key);
  assert.equal(JSON.parse(calls[2].body).expectedScheduleRevision, 123);
  assert.equal(successes, 1);
});

test('create payload and malformed success results do not imply success', async () => {
  const calls = [];
  let successes = 0;
  const client = setup(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return json({ requestId: 'r', data: { outcome: 'applied', items: [], deletedIds: [], scheduleRevision: -1 } });
  });
  const machine = createMutationMachine({ execute: (op) => client.command(op), changed: () => {}, succeeded: () => { successes += 1; } });
  const input = { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create-1', operation: 'create', after: fields }] } };
  machine.submit(input);
  await nextTick();
  assert.deepEqual({ ...calls[0].body, requestId: undefined }, { requestId: undefined, ...input });
  assert.equal(machine.getState().status, 'error');
  assert.equal(machine.getState().uncertain, true);
  assert.equal(successes, 0);
});

test('conflict, missing information, unconfigured service and incorrect checkin result are not successes', async () => {
  for (const [code, status] of [['conflict', 409], ['missing_information', 422], ['not_configured', 503]]) {
    const client = setup(async () => json({ requestId: 'r', error: { code, message: 'failure', retryable: false } }, status));
    await assert.rejects(client.command({ input: commandInput, requestId: 'r', idempotencyKey: 'k' }), (error) => error.code === code);
  }
  const client = setup(async () => json({ requestId: 'r', data: { item: { ...item, id: 'other', completion: 'incomplete' }, scheduleRevision: 10 } }));
  await assert.rejects(client.checkin({ input: { id: item.id, expectedRevision: 3, completion: 'incomplete' }, requestId: 'r', idempotencyKey: 'k' }),
    (error) => error.code === 'invalid_response');
});
