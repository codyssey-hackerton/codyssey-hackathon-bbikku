import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeoulSubway } from '../src/seoul-subway.ts';

const base = Date.parse('2030-01-01T03:00:00.000Z');
const row = { subwayId: '1002', updnLine: '내선', trainLineNm: '성수행', barvlDt: '180',
  recptnDt: '2030-01-01 11:59:00', arvlMsg2: '3분 후', arvlMsg3: '전역 출발' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (rows: unknown[] = [row]) => response({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: rows });

test('returns station arrivals with elapsed seconds, Seoul timestamp and bounded cache', async () => {
  let now = base; let calls = 0;
  const subway = createSeoulSubway({ apiKey: 'syntheticKey', clock: () => now, fetch: async (url, options) => {
    calls++; const u = new URL(String(url));
    assert.equal(u.protocol, 'https:'); assert.equal(u.hostname, 'swopenapi.seoul.go.kr');
    assert.match(u.pathname, /realtimeStationArrival\/0\/99\//); assert.match(u.pathname, /%EC%84%9C%EC%9A%B8$/);
    assert.equal(options?.redirect, 'error'); return ok();
  } });
  const first = await subway.arrivals({ stationName: ' 서울 ' });
  assert.deepEqual(first, { ok: true, provider: 'seoul', stationName: '서울', fetchedAt: '2030-01-01T03:00:00.000Z', arrivals: [{
    lineId: '1002', direction: '내선', destination: '성수행', arrivalSeconds: 120, message: '3분 후', detailMessage: '전역 출발',
    observedAt: '2030-01-01T02:59:00.000Z', stale: false, staleInMs: 60_000,
  }] });
  now += 14_000;
  const cached = await subway.arrivals({ stationName: '서울' });
  assert.equal(calls, 1);
  assert.equal(cached.ok && cached.arrivals[0].arrivalSeconds, 106);
  assert.equal(cached.ok && cached.arrivals[0].staleInMs, 46_000);
  assert.equal(cached.ok && cached.fetchedAt, '2030-01-01T03:00:00.000Z');
  now += 50_000;
  const refreshed = await subway.arrivals({ stationName: '서울' });
  assert.equal(calls, 2); assert.equal(refreshed.ok && refreshed.arrivals[0].arrivalSeconds, 56);
  assert.equal(refreshed.ok && refreshed.arrivals[0].stale, true);
  assert.equal(refreshed.ok && refreshed.arrivals[0].staleInMs, 0);
  now += 100_000;
  const expired = await subway.arrivals({ stationName: '서울' });
  assert.equal(expired.ok && expired.arrivals[0].arrivalSeconds, 0);
});

test('staleness becomes true exactly at 120 seconds and stays bounded for future source times', async () => {
  let now = base + 59_999;
  const subway = createSeoulSubway({ apiKey: 'syntheticKey', clock: () => now, fetch: async () => ok() });
  const before = await subway.arrivals({ stationName: '서울' });
  assert.equal(before.ok && before.arrivals[0].stale, false);
  assert.equal(before.ok && before.arrivals[0].staleInMs, 1);
  now++;
  const at = await subway.arrivals({ stationName: '서울' });
  assert.equal(at.ok && at.arrivals[0].stale, true);
  assert.equal(at.ok && at.arrivals[0].staleInMs, 0);
  const future = createSeoulSubway({ apiKey: 'syntheticKey', clock: () => base,
    fetch: async () => ok([{ ...row, recptnDt: '2030-01-01 12:00:20' }]) });
  const result = await future.arrivals({ stationName: '서울' });
  assert.equal(result.ok && result.arrivals[0].staleInMs, 120_000);
});

test('transport is HTTPS by default and HTTP only when explicitly selected', async () => {
  const protocols: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url)); protocols.push(parsed.protocol);
    assert.equal(parsed.hostname, 'swopenapi.seoul.go.kr');
    assert.equal(options?.redirect, 'error'); return ok();
  };
  await createSeoulSubway({ apiKey: 'syntheticKey', clock: () => base, fetch: fetcher }).arrivals({ stationName: '서울' });
  await createSeoulSubway({ apiKey: 'syntheticKey', clock: () => base, fetch: fetcher, transport: 'http' }).arrivals({ stationName: '서울' });
  const invalid = createSeoulSubway({ apiKey: 'syntheticKey', fetch: fetcher, transport: 'ftp' });
  assert.deepEqual(await invalid.arrivals({ stationName: '서울' }), { ok: false, error: 'not_configured' });
  assert.deepEqual(protocols, ['https:', 'http:']);
  let calls = 0;
  const failedHttps = createSeoulSubway({ apiKey: 'syntheticKey', fetch: async () => { calls++; throw new Error('network'); } });
  assert.deepEqual(await failedHttps.arrivals({ stationName: '서울' }), { ok: false, error: 'unavailable' });
  assert.equal(calls, 1);
});

test('empty results differ from provider failures and invalid responses', async () => {
  for (const [body, expected] of [
    [{ errorMessage: { code: 'INFO-200' } }, 'empty'],
    [{ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [] }, 'empty'],
    [{ RESULT: { CODE: 'INFO-200' } }, 'empty'],
    [{ errorMessage: { code: 'INFO-100', message: 'syntheticKey' } }, 'unavailable'],
    [{ errorMessage: { code: 'ERROR-500' } }, 'unavailable'],
    [{ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [{ ...row, recptnDt: '2030-02-31 12:00:00' }] }, 'invalid_response'],
    [{ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [{ ...row, barvlDt: '-1' }] }, 'invalid_response'],
    [{ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [{ ...row, recptnDt: '2030-01-01 12:01:00' }] }, 'invalid_response'],
    [{ errorMessage: { code: 'INFO-000' } }, 'invalid_response'],
  ] as const) {
    const subway = createSeoulSubway({ apiKey: 'syntheticKey', clock: () => base, fetch: async () => response(body) });
    const result = await subway.arrivals({ stationName: '서울' });
    if (expected === 'empty') assert.deepEqual(result.ok && result.arrivals, []);
    else assert.deepEqual(result, { ok: false, error: expected });
    assert.doesNotMatch(JSON.stringify(result), /syntheticKey/);
  }
});

test('invalid input and missing key never call upstream', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return ok(); };
  const subway = createSeoulSubway({ apiKey: 'syntheticKey', fetch: fetcher });
  for (const stationName of ['', '  ', '../서울', '서울?key=x', 'a'.repeat(81)]) {
    assert.deepEqual(await subway.arrivals({ stationName }), { ok: false, error: 'invalid_request' });
  }
  assert.deepEqual(await createSeoulSubway({ fetch: fetcher }).arrivals({ stationName: '서울' }), { ok: false, error: 'not_configured' });
  assert.equal(calls, 0);
});

test('concurrent requests coalesce and local rate cap limits distinct stations', async () => {
  let calls = 0; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const subway = createSeoulSubway({ apiKey: 'syntheticKey', clock: () => base, fetch: async () => { calls++; await wait; return ok(); } });
  const first = subway.arrivals({ stationName: '서울' });
  const second = subway.arrivals({ stationName: '서울' });
  release(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  for (let i = 0; i < 19; i++) assert.equal((await subway.arrivals({ stationName: `역${i}` })).ok, true);
  assert.deepEqual(await subway.arrivals({ stationName: '초과역' }), { ok: false, error: 'rate_limited' });
  assert.equal(calls, 20);
});

test('timeouts and provider failures are sanitized without leaking URLs or keys', async () => {
  const network = createSeoulSubway({ apiKey: 'syntheticKey', fetch: async () => { throw new Error('https://example/syntheticKey'); } });
  assert.deepEqual(await network.arrivals({ stationName: '서울' }), { ok: false, error: 'unavailable' });
  const http = createSeoulSubway({ apiKey: 'syntheticKey', fetch: async () => response({}, 500) });
  assert.deepEqual(await http.arrivals({ stationName: '서울' }), { ok: false, error: 'unavailable' });
  const slow = createSeoulSubway({ apiKey: 'syntheticKey', timeoutMs: 10, fetch: async () => new Promise<Response>(() => {}) });
  assert.deepEqual(await slow.arrivals({ stationName: '서울' }), { ok: false, error: 'timeout' });
  const bad = createSeoulSubway({ apiKey: 'syntheticKey', fetch: async () => new Response('not-json') });
  assert.deepEqual(await bad.arrivals({ stationName: '서울' }), { ok: false, error: 'invalid_response' });
});
