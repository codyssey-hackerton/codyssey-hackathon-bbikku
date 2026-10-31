import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/http';
import { createMutationMachine } from '../src/api/mutation';
import { createReviewClient } from '../src/review/client';
import { draftFrom, parseReviewDraft } from '../src/review/form';

const initial = { revision: 0, timezone: 'UTC', evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } };
const input = { expectedRevision: 0, timezone: 'Asia/Seoul', evening: { enabled: true, localTime: '21:30' }, morning: { enabled: false, localTime: null } };
const saved = { revision: 1, timezone: input.timezone, evening: input.evening, morning: input.morning };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const envelope = (data: unknown) => ({ requestId: 'response', data });

function mock(handler: (url: string, options: RequestInit, count: number) => Promise<Response> | Response) {
  const calls: { url: string; options: RequestInit }[] = [];
  const api = createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'session',
    fetcher: async (url, options) => { calls.push({ url: String(url), options: options! }); return handler(String(url), options!, calls.length); } });
  return { client: createReviewClient(api), calls };
}

async function waitFor(machine: ReturnType<typeof createMutationMachine<any, any>>, status: string) {
  for (let i = 0; i < 100; i += 1) {
    if (machine.getState().status === status) return machine.getState();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`mutation did not reach ${status}`);
}

test('review defaults remain disabled and saving sends revision, request ID and distinct idempotency key', async () => {
  const { client, calls } = mock((_url, options) => options.method === 'GET'
    ? json(envelope({ reviewSchedule: initial })) : json(envelope({ reviewSchedule: saved })));
  assert.deepEqual(await client.get(), initial);
  assert.deepEqual(await client.save({ input, requestId: 'request-1', idempotencyKey: 'key-1' }), saved);
  assert.equal(new URL(calls[0].url).pathname, '/v1/review-schedule');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), { requestId: 'request-1', ...input });
  assert.equal((calls[1].options.headers as Record<string, string>)['Idempotency-Key'], 'key-1');
});

test('draft validates timezone and HH:mm while retaining nullable and disabled values', () => {
  assert.deepEqual(parseReviewDraft(draftFrom(initial), 0), { ok: true, input: { expectedRevision: 0, timezone: 'UTC', evening: initial.evening, morning: initial.morning } });
  const draft = draftFrom(initial);
  draft.evening.enabled = true;
  assert.equal(parseReviewDraft(draft, 0).ok, false);
  for (const invalid of ['9:00', '24:00', '12:60', '00:00:00']) {
    draft.evening.localTime = invalid;
    assert.equal(parseReviewDraft(draft, 0).ok, false, invalid);
  }
  draft.evening.localTime = '23:59';
  draft.timezone = '+09:00';
  assert.equal(parseReviewDraft(draft, 0).ok, false);
  draft.timezone = 'Asia/Seoul';
  assert.equal(parseReviewDraft(draft, 0).ok, true);
  draft.evening.enabled = false;
  const parsed = parseReviewDraft(draft, 0);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.input.evening, { enabled: false, localTime: '23:59' });
});

test('malformed defaults or write acknowledgments never imply success', async () => {
  for (const bad of [
    { ...initial, revision: -1 },
    { ...initial, evening: { enabled: true, localTime: null } },
    { ...initial, morning: { enabled: false, localTime: '24:00' } },
  ]) {
    const { client } = mock(() => json(envelope({ reviewSchedule: bad })));
    await assert.rejects(client.get(), (error: any) => error.code === 'invalid_response');
  }
  for (const bad of [{ ...saved, revision: 2 }, { ...saved, evening: { enabled: false, localTime: '21:30' } }]) {
    const { client } = mock(() => json(envelope({ reviewSchedule: bad })));
    await assert.rejects(client.save({ input, requestId: 'r', idempotencyKey: 'k' }), (error: any) => error.code === 'invalid_response');
  }
});

test('capabilities are reported separately and unknown status is not treated as available', async () => {
  const data = { storage: { mode: 'postgres', durable: true }, model: { status: 'degraded' }, scheduler: { status: 'not_configured' } };
  const { client, calls } = mock(() => json(envelope(data)));
  assert.deepEqual(await client.capabilities(), { storage: data.storage, model: 'degraded', scheduler: 'not_configured' });
  assert.equal(new URL(calls[0].url).pathname, '/v1/capabilities');
  const invalid = mock(() => json(envelope({ ...data, scheduler: { status: 'maybe' } })));
  await assert.rejects(invalid.client.capabilities(), (error: any) => error.code === 'invalid_response');
});

test('an uncertain save retries the original revision, body and key even after the caller edits the draft', async () => {
  const original = structuredClone(input);
  const { client, calls } = mock((_url, _options, count) => {
    if (count === 1) throw new Error('offline');
    return json(envelope({ reviewSchedule: saved }));
  });
  const machine = createMutationMachine({ execute: (operation) => client.save(operation), changed: () => {} });
  machine.submit(original);
  const failed = await waitFor(machine, 'error');
  assert.equal(failed.status === 'error' && failed.uncertain, true);
  original.expectedRevision = 99;
  original.evening.localTime = '08:00';
  machine.reset();
  assert.equal(machine.getState().status, 'error');
  machine.retry();
  await waitFor(machine, 'success');
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal((calls[0].options.headers as Record<string, string>)['Idempotency-Key'], (calls[1].options.headers as Record<string, string>)['Idempotency-Key']);
  assert.deepEqual(JSON.parse(String(calls[1].options.body)).evening, input.evening);
});
