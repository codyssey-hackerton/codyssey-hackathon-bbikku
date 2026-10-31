import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKakaoPlaces } from '../src/kakao-places.ts';

const apiKey = 'synthetic-kakao-key';
const place = { id: '123', place_name: '서울역', address_name: '서울 용산구', road_address_name: '', x: '126.9706', y: '37.5547' };
const stub = (body: unknown): typeof fetch => async () => Response.json(body);

test('keyword search sends the key only in the authorization header and maps the first page', async () => {
  const adapter = createKakaoPlaces({ apiKey, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://dapi.kakao.com/v2/local/search/keyword.json');
    assert.equal(url.searchParams.get('query'), '서울역');
    assert.equal(url.toString().includes(apiKey), false);
    assert.deepEqual(init?.headers, { Authorization: `KakaoAK ${apiKey}` });
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ documents: [place] });
  } });
  assert.deepEqual(await adapter.search(' 서울역 '), { ok: true, places: [{ id: '123', name: '서울역', address: '서울 용산구', roadAddress: '', longitude: 126.9706, latitude: 37.5547 }] });
  assert.deepEqual(await createKakaoPlaces({ apiKey, fetch: stub({ documents: [] }) }).search('서울'), { ok: true, places: [] });
});

test('rejects invalid input and missing configuration without contacting Kakao', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected'); };
  const adapter = createKakaoPlaces({ apiKey, fetch: fetcher });
  for (const input of [null, {}, ['서울'], '', '   ', '가'.repeat(101), `장소 ${apiKey}`]) {
    assert.deepEqual(await adapter.search(input), { ok: false, error: 'invalid_query' });
  }
  assert.deepEqual(await createKakaoPlaces({ fetch: fetcher }).search('서울'), { ok: false, error: 'not_configured' });
  assert.deepEqual(await createKakaoPlaces({ apiKey: ' ', fetch: fetcher }).search('서울'), { ok: false, error: 'not_configured' });
  assert.equal(calls, 0);
});

test('rejects malformed shapes, invalid coordinates, and provider fields containing the key', async () => {
  const invalid = [null, {}, { documents: {} }, { documents: Array(16).fill(place) },
    { documents: [null] }, { documents: [{ ...place, id: '' }] }, { documents: [{ ...place, place_name: apiKey }] },
    ...['', ' ', 'NaN', 'Infinity', '181', '0x10'].map(x => ({ documents: [{ ...place, x }] })),
    ...['91', '-91', 37].map(y => ({ documents: [{ ...place, y }] }))];
  for (const body of invalid) {
    const result = await createKakaoPlaces({ apiKey, fetch: stub(body) }).search('서울');
    assert.deepEqual(result, { ok: false, error: 'invalid_response' });
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  }
});

test('provider errors and malformed JSON do not expose response or exception contents', async () => {
  for (const fetcher of [async () => { throw new Error(apiKey); }, async () => new Response(apiKey, { status: 401 })] satisfies Array<typeof fetch>) {
    assert.deepEqual(await createKakaoPlaces({ apiKey, fetch: fetcher }).search('서울'), { ok: false, error: 'unavailable' });
  }
  assert.deepEqual(await createKakaoPlaces({ apiKey, fetch: async () => new Response(apiKey) }).search('서울'), { ok: false, error: 'invalid_response' });
});

test('timeout aborts the request and ignores a fetch or body that never completes', async () => {
  let signal: AbortSignal | undefined;
  const pending: typeof fetch = async (_input, init) => { signal = init?.signal ?? undefined; return await new Promise<Response>(() => {}); };
  assert.deepEqual(await createKakaoPlaces({ apiKey, fetch: pending, timeoutMs: 10 }).search('서울'), { ok: false, error: 'timeout' });
  assert.equal(signal?.aborted, true);
  const slowBody: typeof fetch = async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response;
  assert.deepEqual(await createKakaoPlaces({ apiKey, fetch: slowBody, timeoutMs: 10 }).search('서울'), { ok: false, error: 'timeout' });
});
