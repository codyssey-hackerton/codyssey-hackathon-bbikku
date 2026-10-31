import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../src/api/http';
import { createWeatherClient } from '../src/weather/client';
import { isTravelFresh } from '../src/travel/client';

const place = { id: 'p', name: '도착', address: '', roadAddress: '', latitude: 37.5, longitude: 127.1 };
const appointmentAt = '2026-11-02T10:35:00+09:00';
const forecast = { provider: 'open-meteo', timezone: 'Asia/Seoul', forecastTime: '2026-11-02T10:00:00+09:00', temperatureC: -2.1,
  apparentTemperatureC: null, precipitationMm: 0, precipitationProbabilityPercent: 30, windSpeedKmh: 3.5,
  fetchedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-01T00:05:00Z', remainingTtlMs: 300_000, sourceUrl: 'https://open-meteo.com/', licenseUrl: 'https://open-meteo.com/en/licence' };
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_response';
function stub(result: unknown): ApiClient { return { get: async <T>() => ({} as T), post: async <T>() => result as T }; }

test('날씨 요청은 선택한 좌표와 약속 시각만 전송하고 0·null을 구분한다', async () => {
  const calls: any[] = [];
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(...args: any[]) => { calls.push(args); return forecast as T; } };
  const result = await createWeatherClient(api).forecast(place, appointmentAt);
  assert.equal(result.apparentTemperatureC, null); assert.equal(result.precipitationMm, 0);
  assert.deepEqual(calls[0], ['/v1/weather/forecast', { destination: { latitude: 37.5, longitude: 127.1 }, appointmentAt }, { idempotencyKey: '' }]);
});

test('예보 시각·제공자·수치·링크·유효기간이 잘못되면 표시하지 않는다', async () => {
  for (const bad of [{ ...forecast, provider: 'other' }, { ...forecast, sourceUrl: 'https://example.test/' },
    { ...forecast, forecastTime: '2026-11-02T09:00:00+09:00' }, { ...forecast, precipitationProbabilityPercent: 101 },
    { ...forecast, precipitationMm: -1 }, { ...forecast, temperatureC: '0' }, { ...forecast, expiresAt: '2026-11-01T00:06:00Z' },
    { ...forecast, remainingTtlMs: 300_001 }, { ...forecast, remainingTtlMs: -1 }]) {
    await assert.rejects(createWeatherClient(stub(bad)).forecast(place, appointmentAt), invalid);
  }
});

test('캐시 잔여 유효기간에서 요청 지연을 차감하고 만료된 응답을 숨긴다', async t => {
  let now = 10; t.mock.method(performance, 'now', () => now); let resolve!: (value: unknown) => void;
  const pending = new Promise<any>((done) => { resolve = done; });
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>() => pending as Promise<T> };
  const request = createWeatherClient(api).forecast(place, appointmentAt); now += 1_000;
  resolve({ ...forecast, remainingTtlMs: 1_000 });
  await assert.rejects(request, (error: unknown) => error instanceof ApiError && error.code === 'expired');
});

test('날씨 잔여시간은 기기 절대시각과 무관하게 경과시간으로 줄어든다', async t => {
  let elapsed = 100; t.mock.method(performance, 'now', () => elapsed);
  let deviceTime = Date.now() - 3_600_000; t.mock.method(Date, 'now', () => deviceTime);
  const data = await createWeatherClient(stub({ ...forecast, remainingTtlMs: 1_000 })).forecast(place, appointmentAt);
  deviceTime += 7_200_000; elapsed += 999; assert.equal(isTravelFresh(data.freshness), true);
  elapsed += 1; assert.equal(isTravelFresh(data.freshness), false);
});
