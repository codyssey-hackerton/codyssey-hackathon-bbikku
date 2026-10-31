import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { WeatherResult } from '../src/open-meteo.ts';

const sessions = { async resolve(token: string) { return token === 'synthetic' ? { userId: 'alice' } : null; } };
const headers = { authorization: 'Bearer synthetic' };
const body = { destination: { latitude: 37.5, longitude: 127 }, appointmentAt: '2030-01-01T15:30:00+09:00' };
const forecast = { provider: 'open-meteo' as const, timezone: 'Asia/Seoul' as const, forecastTime: '2030-01-01T15:00:00+09:00',
  temperatureC: 2, apparentTemperatureC: null, precipitationMm: 0, precipitationProbabilityPercent: 30, windSpeedKmh: 12,
  fetchedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z', sourceUrl: 'https://open-meteo.com/' as const, licenseUrl: 'https://open-meteo.com/en/licence' as const };

test('weather route requires authentication, validates request, and returns the provider forecast', async () => {
  let calls = 0;
  let now = Date.parse(forecast.fetchedAt);
  const app = buildApp({ sessions, clock: () => new Date(now), weather: { async forecast(input) { calls++; assert.deepEqual(input, body); return { ok: true as const, forecast }; } } });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/weather/forecast', payload: body })).statusCode, 401);
    for (const payload of [{ ...body, extra: 1 }, { ...body, destination: { ...body.destination, extra: 1 } },
      { ...body, destination: { latitude: 91, longitude: 127 } }, { ...body, appointmentAt: 'invalid' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/weather/forecast', headers, payload })).statusCode, 400);
    }
    const result = await app.inject({ method: 'POST', url: '/v1/weather/forecast', headers, payload: body });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json().data, { ...forecast, remainingTtlMs: 300_000 }); assert.equal(calls, 1);
    now += 299_000;
    const cached = await app.inject({ method: 'POST', url: '/v1/weather/forecast', headers, payload: body });
    assert.equal(cached.json().data.remainingTtlMs, 1_000);
    now += 2_000;
    const expired = await app.inject({ method: 'POST', url: '/v1/weather/forecast', headers, payload: body });
    assert.equal(expired.json().data.remainingTtlMs, 0);
  } finally { await app.close(); }
});

test('weather route distinguishes errors without leaking provider details', async () => {
  const cases: Array<[Extract<WeatherResult, { ok: false }>['error'], number]> = [
    ['invalid_request', 400], ['unsupported_range', 422], ['timeout', 504], ['unavailable', 503], ['invalid_response', 502],
  ];
  for (const [error, status] of cases) {
    const app = buildApp({ sessions, weather: { async forecast() { return { ok: false as const, error }; } } });
    try {
      const result = await app.inject({ method: 'POST', url: '/v1/weather/forecast', headers, payload: body });
      assert.equal(result.statusCode, status); assert.equal(result.json().error.code, error);
      assert.deepEqual(Object.keys(result.json().error).sort(), ['code', 'message', 'retryable']);
    } finally { await app.close(); }
  }
});
