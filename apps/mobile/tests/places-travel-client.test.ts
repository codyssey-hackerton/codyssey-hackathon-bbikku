import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../src/api/http';
import { createPlacesClient } from '../src/places/client';
import { createTravelClient, isTravelFresh } from '../src/travel/client';

const origin = { id: '1', name: '출발', address: '', roadAddress: '출발 주소', longitude: 127.1, latitude: 37.4 };
const destination = { id: '2', name: '도착', address: '도착 주소', roadAddress: '', longitude: 127.2, latitude: 37.5 };
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_response';
function stub(result: unknown): ApiClient { return { get: async <T>() => result as T, post: async <T>() => result as T }; }

test('장소 검색은 입력을 인코딩하고 유효한 장소 목록만 수용한다', async () => {
  const calls: string[] = [];
  const api: ApiClient = { get: async <T>(path: string) => { calls.push(path); return { places: [origin] } as T; }, post: async <T>() => ({} as T) };
  assert.deepEqual(await createPlacesClient(api).search(' 출발 & 도착 '), [origin]);
  assert.deepEqual(calls, [`/v1/places/search?query=${encodeURIComponent('출발 & 도착')}`]);
  await assert.rejects(createPlacesClient(api).search('   '));
  for (const places of [[{ ...origin, latitude: 91 }], [origin, origin], [{ ...origin, longitude: NaN }], Array(16).fill(origin)]) {
    await assert.rejects(createPlacesClient(stub({ places })).search('출발'), invalid);
  }
  assert.deepEqual(await createPlacesClient(stub({ places: [] })).search('출발'), []);
});

test('경로 요청은 선택 수단과 좌표만 전송하고 결과의 수단과 유효기간을 검증한다', async () => {
  const base = Date.now(); const fetchedAt = new Date(base).toISOString(); const expiresAt = new Date(base + 300_000).toISOString();
  const calls: any[] = []; const result = { durationMinutes: 24, provider: 'kakao', fetchedAt, expiresAt, mode: 'transit' };
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(...args: any[]) => { calls.push(args); return result as T; } };
  const response = await createTravelClient(api).estimate(origin, destination, 'transit');
  assert.equal(Date.parse(response.expiresAt), Date.parse(fetchedAt) + 300_000);
  assert.deepEqual(calls[0], ['/v1/travel/estimate', { origin: { longitude: origin.longitude, latitude: origin.latitude },
    destination: { longitude: destination.longitude, latitude: destination.latitude }, mode: 'transit' }, { idempotencyKey: '' }]);
  for (const bad of [{ ...result, mode: 'car' }, { ...result, provider: 'other' }, { ...result, durationMinutes: -1 },
    { ...result, durationMinutes: 0.00001 }, { ...result, expiresAt: fetchedAt }, { ...result, fetchedAt: 'bad' },
    { ...result, expiresAt: new Date(base + 300_001).toISOString() }]) {
    await assert.rejects(createTravelClient(stub(bad)).estimate(origin, destination, 'transit'), invalid);
  }
});

test('기기 시계가 서버보다 앞서거나 뒤처져도 요청 시작 후 단조 경과시간으로 만료한다', async t => {
  const serverTime = Date.now(); let monotonic = 1_000;
  t.mock.method(performance, 'now', () => monotonic);
  const result = { durationMinutes: 24, provider: 'kakao', fetchedAt: new Date(serverTime).toISOString(), expiresAt: new Date(serverTime + 300_000).toISOString(), mode: 'walk' };
  let localTime = serverTime - 3_600_000; t.mock.method(Date, 'now', () => localTime);
  const client = createTravelClient(stub(result)); const first = await client.estimate(origin, destination, 'walk');
  assert.equal(isTravelFresh(first.freshness), true);
  localTime = serverTime + 3_600_000; monotonic += 299_999; assert.equal(isTravelFresh(first.freshness), true);
  monotonic += 1; assert.equal(isTravelFresh(first.freshness), false);
  const second = await client.estimate(origin, destination, 'walk'); assert.equal(isTravelFresh(second.freshness), true);
});

test('응답 지연은 요청 시작부터 유효기간을 차감하고 이미 만료된 응답을 거절한다', async t => {
  let monotonic = 100; t.mock.method(performance, 'now', () => monotonic);
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((done) => { resolve = done; });
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>() => pending as Promise<T> };
  const request = createTravelClient(api).estimate(origin, destination, 'walk');
  monotonic += 300_000;
  resolve({ durationMinutes: 10, provider: 'kakao', fetchedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:05:00Z', mode: 'walk' });
  await assert.rejects(request, (error: unknown) => error instanceof ApiError && error.code === 'expired');
});

test('지연된 응답은 남은 시간만 사용할 수 있다', async t => {
  let monotonic = 100; t.mock.method(performance, 'now', () => monotonic);
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((done) => { resolve = done; });
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>() => pending as Promise<T> };
  const request = createTravelClient(api).estimate(origin, destination, 'walk'); monotonic += 240_000;
  resolve({ durationMinutes: 10, provider: 'kakao', fetchedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:05:00Z', mode: 'walk' });
  const result = await request; monotonic += 59_999; assert.equal(isTravelFresh(result.freshness), true);
  monotonic += 1; assert.equal(isTravelFresh(result.freshness), false);
});
