import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenMeteo } from '../src/open-meteo.ts';

const base = Date.parse('2030-01-01T00:00:00Z');
const input = { destination: { latitude: 37.5, longitude: 127 }, appointmentAt: '2030-01-01T15:30:00+09:00' };
const data = () => ({ timezone: 'Asia/Seoul', utc_offset_seconds: 32400, hourly: {
  time: ['2030-01-01T15:00'], temperature_2m: [2.1], apparent_temperature: [-1.2], precipitation: [0],
  precipitation_probability: [30], wind_speed_10m: [12.5],
} });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('requests one Seoul day and returns the appointment hour with source and units', async () => {
  let calls = 0;
  const weather = createOpenMeteo({ clock: () => base, fetch: async url => {
    calls++;
    const query = new URL(String(url));
    assert.equal(query.origin, 'https://api.open-meteo.com');
    assert.equal(query.pathname, '/v1/forecast');
    assert.equal(query.searchParams.get('latitude'), '37.5'); assert.equal(query.searchParams.get('longitude'), '127');
    assert.equal(query.searchParams.get('timezone'), 'Asia/Seoul');
    assert.equal(query.searchParams.get('start_date'), '2030-01-01'); assert.equal(query.searchParams.get('end_date'), '2030-01-01');
    assert.equal(query.searchParams.get('hourly'), 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m');
    return json(data());
  } });
  const result = await weather.forecast(input);
  assert.deepEqual(result, { ok: true, forecast: { provider: 'open-meteo', timezone: 'Asia/Seoul', forecastTime: '2030-01-01T15:00:00+09:00',
    temperatureC: 2.1, apparentTemperatureC: -1.2, precipitationMm: 0, precipitationProbabilityPercent: 30, windSpeedKmh: 12.5,
    fetchedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z', sourceUrl: 'https://open-meteo.com/', licenseUrl: 'https://open-meteo.com/en/licence' } });
  assert.equal(calls, 1);
});

test('reuses concurrent and cached requests, expires cache and preserves null', async () => {
  let now = base, calls = 0;
  const value = data(); value.hourly.precipitation_probability = [null as unknown as number];
  const weather = createOpenMeteo({ clock: () => now, fetch: async () => { calls++; return json(value); } });
  const [a, b] = await Promise.all([weather.forecast(input), weather.forecast(input)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.ok(a.ok); assert.equal(a.forecast.precipitationProbabilityPercent, null);
  assert.deepEqual(await weather.forecast({ ...input, appointmentAt: '2030-01-01T06:45:00Z' }), a); assert.equal(calls, 1);
  now += 300_000;
  assert.equal((await weather.forecast(input)).ok, true); assert.equal(calls, 2);
});

test('rejects invalid and unsupported requests before any network call', async () => {
  let calls = 0;
  const weather = createOpenMeteo({ clock: () => base, fetch: async () => { calls++; return json(data()); } });
  for (const value of [{ ...input, appointmentAt: 'not-a-date' }, { ...input, appointmentAt: '2030-02-30T00:00:00+09:00' },
    { ...input, appointmentAt: '2030-01-01T15:00:00' }, { ...input, destination: { latitude: 91, longitude: 0 } }]) {
    assert.deepEqual(await weather.forecast(value), { ok: false, error: 'invalid_request' });
  }
  for (const date of ['2029-12-31T23:59:59Z', '2030-01-17T00:00:00+09:00']) {
    assert.deepEqual(await weather.forecast({ ...input, appointmentAt: date }), { ok: false, error: 'unsupported_range' });
  }
  assert.equal(calls, 0);
});

test('distinguishes absent forecasts, malformed data and provider failure', async () => {
  const missing = data(); missing.hourly.time = ['2030-01-01T16:00'];
  const allNull = data(); for (const key of ['temperature_2m', 'apparent_temperature', 'precipitation', 'precipitation_probability', 'wind_speed_10m'] as const) allNull.hourly[key] = [null as unknown as number];
  const invalid = data(); invalid.hourly.precipitation_probability = [101];
  const cases: Array<[unknown, string]> = [[missing, 'unsupported_range'], [allNull, 'unsupported_range'], [invalid, 'invalid_response'],
    [{ ...data(), timezone: 'UTC' }, 'invalid_response'], [{ ...data(), hourly: { time: ['2030-01-01T15:00'] } }, 'invalid_response']];
  for (const [payload, error] of cases) {
    assert.deepEqual(await createOpenMeteo({ clock: () => base, fetch: async () => json(payload) }).forecast(input), { ok: false, error });
  }
  assert.deepEqual(await createOpenMeteo({ clock: () => base, fetch: async () => json({}, 429) }).forecast(input), { ok: false, error: 'unavailable' });
});

test('timeout is bounded even when the provider ignores abort', async () => {
  const weather = createOpenMeteo({ clock: () => base, timeoutMs: 5, fetch: async () => new Promise(() => {}) });
  assert.deepEqual(await weather.forecast(input), { ok: false, error: 'timeout' });
});
