import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../src/api/http';
import { createSubwayClient } from '../src/subway/client';

const row = { lineId: '1002', direction: '상행', destination: '종착', arrivalSeconds: 0, message: '도착', detailMessage: '', observedAt: '2026-11-01T00:00:00Z', stale: false, staleInMs: 10_000 };
const result = { provider: 'seoul', stationName: '테스트역', fetchedAt: '2026-11-01T00:00:10Z', arrivals: [row] };
function stub(data: unknown): ApiClient { return { get: async <T>() => ({} as T), post: async <T>() => data as T }; }

test('사용자가 입력한 역만 조회하고 빈 결과와 0초를 보존한다', async () => {
  const calls: any[] = [];
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(...args: any[]) => { calls.push(args); return result as T; } };
  const response = await createSubwayClient(api).arrivals(' 테스트역 ');
  assert.equal(response.arrivals[0].arrivalSeconds, 0);
  assert.deepEqual(calls[0], ['/v1/subway/arrivals', { stationName: '테스트역' }, { idempotencyKey: '' }]);
  assert.deepEqual((await createSubwayClient(stub({ ...result, arrivals: [] })).arrivals('테스트역')).arrivals, []);
});

test('다른 역, 잘못된 도착 시각과 숫자 또는 형식은 거절한다', async () => {
  for (const data of [{ ...result, stationName: '다른 역' }, { ...result, provider: 'other' },
    { ...result, arrivals: [{ ...row, arrivalSeconds: -1 }] }, { ...result, arrivals: [{ ...row, observedAt: 'bad' }] },
    { ...result, arrivals: [{ ...row, stale: 'false' }] }, { ...result, arrivals: [{ ...row, stale: false, staleInMs: 0 }] },
    { ...result, arrivals: [{ ...row, staleInMs: -1 }] }]) {
    await assert.rejects(createSubwayClient(stub(data)).arrivals('테스트역'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
  await assert.rejects(createSubwayClient(stub(result)).arrivals('../key'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_request');
});

test('지연된 조회는 15초 화면 수명에 반영된다', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now); let resolve!: (value: unknown) => void;
  const pending = new Promise<any>((done) => { resolve = done; });
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>() => pending as Promise<T> };
  const request = createSubwayClient(api).arrivals('테스트역'); now = 15_000; resolve(result);
  await assert.rejects(request, (error: unknown) => error instanceof ApiError && error.code === 'expired');
});
