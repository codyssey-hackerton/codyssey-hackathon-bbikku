import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKakaoTravel, type TravelMode } from '../src/kakao-travel.ts';

const key = 'synthetic-travel-key';
const now = Date.parse('2026-10-31T00:00:00.000Z');
const points = { origin: { longitude: 127.111, latitude: 37.394 }, destination: { longitude: 127.126, latitude: 37.419 } };
const modes: TravelMode[] = ['walk', 'transit', 'car'];
const bodies = {
  walk: { status: 'OK', route: { properties: { totalTime: 61 } } },
  transit: { status: 'OK', routes: [{ properties: { totalTime: 120 } }] },
  car: { routes: [{ result_code: 0, summary: { duration: 121 } }] },
};

test('each selected mode uses its documented endpoint, input and duration field', async () => {
  for (const mode of modes) {
    let calls = 0;
    const adapter = createKakaoTravel({ apiKey: key, clock: () => now, fetch: async (input, init) => {
      calls++; const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, mode === 'car' ? 'https://apis-navi.kakaomobility.com/v1/directions' : `https://dapi.kakao.com/v2/routing/${mode === 'walk' ? 'walk' : 'publictraffic'}`);
      if (mode === 'car') {
        assert.equal(url.searchParams.get('origin'), '127.111,37.394');
        assert.equal(url.searchParams.get('destination'), '127.126,37.419');
        assert.equal(url.searchParams.get('summary'), 'true');
      } else {
        assert.deepEqual([...url.searchParams.entries()], [['start_x', '127.111'], ['start_y', '37.394'], ['end_x', '127.126'], ['end_y', '37.419']]);
      }
      assert.equal(url.toString().includes(key), false);
      assert.deepEqual(init?.headers, { Authorization: `KakaoAK ${key}` });
      assert.equal(init?.redirect, 'error'); assert.ok(init?.signal instanceof AbortSignal);
      return Response.json(bodies[mode]);
    } });
    assert.deepEqual(await adapter.estimate({ ...points, mode }), { ok: true, durationMinutes: mode === 'car' ? 3 : 2,
      provider: 'kakao', fetchedAt: '2026-10-31T00:00:00.000Z', expiresAt: '2026-10-31T00:05:00.000Z' });
    assert.equal(calls, 1);
  }
});

test('invalid coordinates, unsupported mode and departure time do not trigger a request', async () => {
  let calls = 0;
  const adapter = createKakaoTravel({ apiKey: key, fetch: async () => { calls++; throw new Error('unexpected request'); } });
  for (const input of [null, {}, { ...points, mode: 'walk', origin: { longitude: NaN, latitude: 1 } },
    { ...points, mode: 'walk', destination: { longitude: 181, latitude: 0 } }, { ...points, mode: 'walk', origin: { longitude: 1, latitude: -91 } }]) {
    assert.deepEqual(await adapter.estimate(input), { ok: false, error: 'invalid_request' });
  }
  for (const input of [{ ...points, mode: 'bicycle' }, { ...points, mode: 'walk', departureAt: '2026-11-01T00:00:00Z' }]) {
    assert.deepEqual(await adapter.estimate(input), { ok: false, error: 'unsupported' });
  }
  assert.deepEqual(await createKakaoTravel({ fetch: async () => { calls++; throw new Error(); } }).estimate({ ...points, mode: 'walk' }), { ok: false, error: 'not_configured' });
  assert.equal(calls, 0);
});

test('only valid successful provider results become an estimate', async () => {
  const cases: Array<[TravelMode, unknown, string]> = [
    ['walk', { status: 'ROUTE_RESULT_NOT_FOUND' }, 'no_route'], ['transit', { status: 'NO_RESULTS' }, 'no_route'],
    ['car', { routes: [{ result_code: 1 }] }, 'no_route'], ['walk', { status: 'OTHER' }, 'unavailable'],
    ['walk', {}, 'invalid_response'], ['transit', { status: 'OK', routes: [] }, 'invalid_response'],
    ['car', { routes: [{ summary: { duration: 1 } }] }, 'invalid_response'],
    ...[-1, 1.5, '61', null, Number.MAX_SAFE_INTEGER].map(value => ['walk', { status: 'OK', route: { properties: { totalTime: value } } }, 'invalid_response'] as [TravelMode, unknown, string]),
  ];
  for (const [mode, body, error] of cases) {
    const result = await createKakaoTravel({ apiKey: key, fetch: async () => Response.json(body) }).estimate({ ...points, mode });
    assert.deepEqual(result, { ok: false, error });
  }
});

test('provider HTTP, network and invalid JSON errors never expose the key', async () => {
  const fetchers: Array<[typeof fetch, string]> = [
    [async () => new Response(key, { status: 403 }), 'unavailable'],
    [async () => { throw new Error(key); }, 'unavailable'],
    [async () => new Response(key), 'invalid_response'],
  ];
  for (const [fetch, error] of fetchers) {
    const result = await createKakaoTravel({ apiKey: key, fetch }).estimate({ ...points, mode: 'walk' });
    assert.deepEqual(result, { ok: false, error }); assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test('timeout aborts and covers both request and body parsing', async () => {
  let signal: AbortSignal | undefined;
  const pending: typeof fetch = async (_input, init) => { signal = init?.signal ?? undefined; return await new Promise<Response>(() => {}); };
  assert.deepEqual(await createKakaoTravel({ apiKey: key, fetch: pending, timeoutMs: 10 }).estimate({ ...points, mode: 'walk' }), { ok: false, error: 'timeout' });
  assert.equal(signal?.aborted, true);
  const slow: typeof fetch = async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response;
  assert.deepEqual(await createKakaoTravel({ apiKey: key, fetch: slow, timeoutMs: 10 }).estimate({ ...points, mode: 'car' }), { ok: false, error: 'timeout' });
});
