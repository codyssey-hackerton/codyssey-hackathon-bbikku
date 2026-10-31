import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { TravelResult } from '../src/kakao-travel.ts';

const sessions = { async resolve(token: string) { return token === 'synthetic' ? { userId: 'alice' } : null; } };
const headers = { authorization: 'Bearer synthetic' };
const body = { origin: { longitude: 127.1, latitude: 37.3 }, destination: { longitude: 127.2, latitude: 37.4 }, mode: 'walk' };

test('travel route is authenticated, read-only, strict and does not infer future travel', async () => {
  let calls = 0;
  const app = buildApp({ sessions, travel: { async estimate(input) {
    calls++; assert.deepEqual(input, body);
    return { ok: true as const, durationMinutes: 2, provider: 'kakao' as const, fetchedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z' };
  } }, travelConfigured: true });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/travel/estimate', payload: body })).statusCode, 401);
    const result = await app.inject({ method: 'POST', url: '/v1/travel/estimate', headers, payload: body });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data, { durationMinutes: 2, provider: 'kakao', fetchedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z', mode: 'walk' });
    for (const payload of [{ ...body, requestId: 'extra' }, { ...body, origin: { ...body.origin, extra: 1 } },
      { ...body, origin: { ...body.origin, latitude: 91 } }, { ...body, mode: 1 }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/travel/estimate', headers, payload })).statusCode, 400);
    }
    for (const payload of [{ ...body, mode: 'bicycle' }, { ...body, departureAt: '2030-01-02T00:00:00Z' }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/travel/estimate', headers, payload });
      assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'unsupported');
    }
    assert.equal(calls, 1);
    const capabilities = (await app.inject({ method: 'GET', url: '/v1/capabilities', headers })).json().data.integrations;
    assert.equal(capabilities.travel, 'available'); assert.deepEqual(Object.keys(capabilities).sort(), ['calendar', 'email', 'phone', 'travel']);
  } finally { await app.close(); }
});

test('travel capability requires both adapter and explicit server configuration', async () => {
  for (const options of [{}, { travelConfigured: true }, { travel: { async estimate() { throw new Error('unexpected'); } } }]) {
    const app = buildApp({ sessions, ...options });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/capabilities', headers });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.integrations.travel, 'not_configured');
    } finally { await app.close(); }
  }
});

test('travel provider errors use sanitized status and no fallback', async () => {
  const cases: Array<{ error: Extract<TravelResult, { ok: false }>['error']; status: number; code: string }> = [
    { error: 'invalid_request', status: 400, code: 'invalid_request' }, { error: 'unsupported', status: 422, code: 'unsupported' },
    { error: 'no_route', status: 404, code: 'no_route' }, { error: 'not_configured', status: 503, code: 'not_configured' },
    ...(['timeout', 'unavailable', 'invalid_response'] as const).map(error => ({ error, status: 503, code: 'provider_unavailable' })),
  ];
  for (const item of cases) {
    let calls = 0;
    const app = buildApp({ sessions, travel: { async estimate() { calls++; return { ok: false as const, error: item.error }; } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/travel/estimate', headers, payload: body });
      assert.equal(response.statusCode, item.status); assert.equal(response.json().error.code, item.code); assert.equal(calls, 1);
      assert.deepEqual(Object.keys(response.json().error).sort(), ['code', 'message', 'retryable']);
    } finally { await app.close(); }
  }
});
