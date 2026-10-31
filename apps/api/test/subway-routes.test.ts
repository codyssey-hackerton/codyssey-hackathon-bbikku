import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { SubwayResult } from '../src/seoul-subway.ts';

const sessions = { async resolve(token: string) { return token === 'synthetic' ? { userId: 'alice' } : null; } };
const headers = { authorization: 'Bearer synthetic' };
const body = { stationName: '서울역' };
const success = { ok: true as const, provider: 'seoul' as const, stationName: '서울역', fetchedAt: '2030-01-01T00:00:00.000Z', arrivals: [{
  lineId: '1001', direction: '상행', destination: '청량리', arrivalSeconds: 60, message: '1분', detailMessage: '전역 출발', observedAt: '2029-12-31T23:59:30.000Z', stale: false, staleInMs: 90_000,
}] };

test('subway route authenticates, validates station, and exposes only safe data', async () => {
  let calls = 0;
  const app = buildApp({ sessions, subway: { async arrivals(input) { calls++; assert.deepEqual(input, body); return success; } } });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/subway/arrivals', payload: body })).statusCode, 401);
    for (const payload of [{ stationName: '' }, { stationName: '../secret' }, { stationName: 'a?b' }, { stationName: 'a\nb' },
      { stationName: '역'.repeat(81) }, { ...body, extra: 'x' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/subway/arrivals', headers, payload })).statusCode, 400);
    }
    const result = await app.inject({ method: 'POST', url: '/v1/subway/arrivals', headers, payload: { stationName: ' 서울역 ' } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data, { provider: 'seoul', stationName: success.stationName, fetchedAt: success.fetchedAt, arrivals: success.arrivals });
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('subway errors have separate sanitized codes', async () => {
  const cases: Array<[Extract<SubwayResult, { ok: false }>['error'], number]> = [
    ['invalid_request', 400], ['not_configured', 503], ['timeout', 504], ['unavailable', 503], ['invalid_response', 502], ['rate_limited', 429],
  ];
  for (const [error, status] of cases) {
    const app = buildApp({ sessions, subway: { async arrivals() { return { ok: false as const, error }; } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/subway/arrivals', headers, payload: body });
      assert.equal(response.statusCode, status); assert.equal(response.json().error.code, error);
      assert.deepEqual(Object.keys(response.json().error).sort(), ['code', 'message', 'retryable']);
    } finally { await app.close(); }
  }
});

test('missing subway adapter returns not_configured', async () => {
  const app = buildApp({ sessions });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/subway/arrivals', headers, payload: body });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'not_configured');
  } finally { await app.close(); }
});
