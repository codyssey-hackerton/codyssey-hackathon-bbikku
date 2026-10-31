import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createKakaoPlaces } from '../src/kakao-places.ts';

const sessions = { async resolve(token: string) { return token === 'synthetic-session' ? { userId: 'user' } : null; } };
const headers = { authorization: 'Bearer synthetic-session' };

test('authenticated place search uses a server-side adapter and returns only normalized places', async () => {
  let calls = 0; const key = 'synthetic-rest-key';
  const places = createKakaoPlaces({ apiKey: key, fetch: async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://dapi.kakao.com/v2/local/search/keyword.json');
    assert.equal(url.searchParams.get('query'), '서울역');
    assert.equal(new Headers(init?.headers).get('authorization'), `KakaoAK ${key}`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ documents: [{ id: 'place-1', place_name: '서울역', address_name: '서울 중구', road_address_name: '',
      x: '126.9706', y: '37.5547', phone: 'not returned', place_url: 'https://example.test/private-extra' }] });
  } });
  const app = buildApp({ sessions, places });
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/v1/places/search?query=서울역' });
    assert.equal(unauthorized.statusCode, 401); assert.equal(calls, 0);
    const result = await app.inject({ method: 'GET', url: `/v1/places/search?query=${encodeURIComponent(' 서울역 ')}`, headers });
    assert.equal(result.statusCode, 200); assert.ok(result.json().requestId);
    assert.deepEqual(result.json().data, { places: [{ id: 'place-1', name: '서울역', address: '서울 중구', roadAddress: '', longitude: 126.9706, latitude: 37.5547 }] });
    assert.equal(calls, 1); assert.ok(!result.body.includes(key));
    const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers });
    assert.equal(capabilities.json().data.storage.durable, false);
    assert.equal(capabilities.json().data.integrations.travel, 'not_configured');
    assert.equal('places' in capabilities.json().data.integrations, false);
  } finally { await app.close(); }
});

test('invalid queries are rejected before the provider and a missing key is not configured', async () => {
  let calls = 0;
  const places = createKakaoPlaces({ fetch: async () => { calls++; throw new Error('unexpected provider call'); } });
  const app = buildApp({ sessions, places });
  try {
    for (const url of ['/v1/places/search', '/v1/places/search?query=%20%20', `/v1/places/search?query=${'x'.repeat(101)}`,
      '/v1/places/search?query=station&extra=1', '/v1/places/search?query=one&query=two']) {
      const result = await app.inject({ method: 'GET', url, headers });
      assert.equal(result.statusCode, 400, url); assert.equal(result.json().error.code, 'invalid_request');
    }
    const unconfigured = await app.inject({ method: 'GET', url: '/v1/places/search?query=station', headers });
    assert.equal(unconfigured.statusCode, 503); assert.equal(unconfigured.json().error.code, 'not_configured');
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('upstream failure classes use the standard sanitized error envelope', async () => {
  for (const kind of ['timeout', 'unavailable', 'invalid_response'] as const) {
    const app = buildApp({ sessions, places: { search: async () => ({ ok: false, error: kind }) } });
    try {
      const result = await app.inject({ method: 'GET', url: '/v1/places/search?query=station', headers });
      assert.equal(result.statusCode, 503); assert.equal(result.json().error.code, 'provider_unavailable');
      assert.equal(result.json().error.retryable, true);
      assert.deepEqual(Object.keys(result.json().error).sort(), ['code', 'message', 'retryable']);
    } finally { await app.close(); }
  }
  const noAdapter = buildApp({ sessions });
  try {
    const result = await noAdapter.inject({ method: 'GET', url: '/v1/places/search?query=station', headers });
    assert.equal(result.statusCode, 503); assert.equal(result.json().error.code, 'not_configured');
  } finally { await noAdapter.close(); }
  const failingAdapter = buildApp({ sessions, places: { search: async () => { throw new Error('synthetic-secret-provider-message'); } } });
  try {
    const result = await failingAdapter.inject({ method: 'GET', url: '/v1/places/search?query=station', headers });
    assert.equal(result.statusCode, 500); assert.ok(!result.body.includes('synthetic-secret-provider-message'));
  } finally { await failingAdapter.close(); }
});
