import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createScheduleClient, ScheduleResponseError } from './client.ts';

const query = {
  from: '2026-10-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z',
  timezone: 'Asia/Seoul', includeUnscheduled: true,
};
const event = {
  id: 'event-1', revision: 1, kind: 'event', title: '회의',
  timeSlot: { startsAt: '2026-10-31T09:00:00+09:00', endsAt: '2026-10-31T10:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal',
  completion: 'pending', sourceRefs: [],
};
const task = { ...event, id: 'task-1', kind: 'task', title: '정리', timeSlot: null, durationMinutes: 30 };

function apiWith(payload, status = 200) {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-token',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { client: createScheduleClient(api), calls };
}

test('shared API mock fetch unwraps data and sends all encoded query parameters', async () => {
  const { client, calls } = apiWith({ requestId: 'request-1', data: { items: [event, task], scheduleRevision: 4 } });
  const result = await client.list(query);
  assert.equal(result.scheduleRevision, 4);
  assert.deepEqual(result.items, [event, task]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/schedule');
  for (const [key, value] of Object.entries(query)) assert.equal(url.searchParams.get(key), String(value));
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
});

test('empty success and server errors stay distinct', async () => {
  const empty = apiWith({ requestId: 'empty', data: { items: [], scheduleRevision: 0 } });
  assert.deepEqual(await empty.client.list(query), { items: [], scheduleRevision: 0 });
  for (const code of ['not_configured', 'not_implemented', 'unauthenticated']) {
    const status = code === 'unauthenticated' ? 401 : code === 'not_implemented' ? 501 : 503;
    const { client } = apiWith({ requestId: 'failure', error: { code, message: 'failure', retryable: false } }, status);
    await assert.rejects(client.list(query), (error) => error.code === code);
  }
});

test('malformed payloads, timestamps and query-inconsistent items are rejected', async () => {
  const badItems = [
    { ...event, revision: 0 },
    { ...event, timeSlot: null },
    { ...task, durationMinutes: 0 },
    { ...event, timeSlot: { ...event.timeSlot, startsAt: '2026-02-31T09:00:00+09:00' } },
    { ...event, timeSlot: { ...event.timeSlot, startsAt: '2026-10-31T09:00:00' } },
    { ...event, deadline: '2026-10-31T09:30:00+09:00' },
    { ...event, sourceRefs: [{}] },
    { ...event, timeSlot: { ...event.timeSlot, startsAt: query.to, endsAt: '2026-11-01T11:00:00+09:00' } },
  ];
  for (const item of badItems) {
    const { client } = apiWith({ requestId: 'bad', data: { items: [item], scheduleRevision: 0 } });
    await assert.rejects(client.list(query), ScheduleResponseError);
  }
  for (const data of [{}, { items: [], scheduleRevision: -1 }, { items: null, scheduleRevision: 0 }]) {
    await assert.rejects(apiWith({ requestId: 'bad', data }).client.list(query), ScheduleResponseError);
  }
  const unscheduled = apiWith({ requestId: 'bad', data: { items: [task], scheduleRevision: 1 } });
  await assert.rejects(unscheduled.client.list({ ...query, includeUnscheduled: false }), ScheduleResponseError);
});

test('an invalid success envelope is rejected by the shared API client', async () => {
  const { client } = apiWith({ items: [], scheduleRevision: 0 });
  await assert.rejects(client.list(query), (error) => error.code === 'invalid_response');
});
