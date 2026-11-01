import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalTools } from '../src/external-tools.ts';
import { createKakaoPlaces } from '../src/kakao-places.ts';
import { createKakaoTravel } from '../src/kakao-travel.ts';
import { createOpenMeteo } from '../src/open-meteo.ts';
import { createSeoulSubway } from '../src/seoul-subway.ts';
import type { ReadTool } from '../src/agent.ts';

const base = Date.parse('2026-11-01T00:00:00Z');
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const placeA = { id: 'station-a', place_name: '서울역', address_name: '서울 중구', road_address_name: '서울로 1', x: '126.97', y: '37.55' };
const placeB = { id: 'station-b', place_name: '강남역', address_name: '서울 강남구', road_address_name: '강남대로 1', x: '127.03', y: '37.49' };
const tool = (tools: ReadTool[], name: string) => { const result = tools.find(item => item.name === name); assert.ok(result); return result; };

test('scoped geo tools call existing adapters and return bounded untrusted observations', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const request = new URL(String(url)); calls.push(request.pathname);
    if (request.pathname === '/v2/local/search/keyword.json') return reply({ documents: [placeA, placeB] });
    if (request.pathname === '/v1/directions') {
      assert.equal(request.searchParams.get('origin'), '126.97,37.55');
      assert.equal(request.searchParams.get('destination'), '127.03,37.49');
      return reply({ routes: [{ result_code: 0, summary: { duration: 840 } }] });
    }
    if (request.hostname === 'api.open-meteo.com') {
      assert.equal(request.searchParams.get('latitude'), '37.49'); assert.equal(request.searchParams.get('longitude'), '127.03');
      return reply({ timezone: 'Asia/Seoul', utc_offset_seconds: 32400, hourly: { time: ['2026-11-01T12:00'],
        temperature_2m: [12], apparent_temperature: [10], precipitation: [0], precipitation_probability: [20], wind_speed_10m: [5] } });
    }
    if (request.hostname === 'swopenapi.seoul.go.kr') return reply({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [{ subwayId: '1001', updnLine: '상행', trainLineNm: '시청행', barvlDt: '90', arvlMsg2: '1분', arvlMsg3: '전역', recptnDt: '2026-11-01 09:00:00' }] });
    throw new Error('unexpected request');
  };
  const tools = createExternalTools('alice', { clock: () => new Date(base), travelMode: 'car', places: createKakaoPlaces({ apiKey: 'synthetic-key', fetch: fetcher }),
    travel: createKakaoTravel({ apiKey: 'synthetic-key', fetch: fetcher, clock: () => base }),
    weather: createOpenMeteo({ fetch: fetcher, clock: () => base }),
    subway: createSeoulSubway({ apiKey: 'syntheticKey', fetch: fetcher, clock: () => base }) });
  assert.deepEqual(tools.map(item => item.name), ['get_current_location', 'search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals']);
  const found: any = await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  assert.equal(found.ok, true); assert.equal(found.data.requiresSelection, true); assert.equal(found.data.untrusted, true);
  assert.equal(found.provider, 'kakao'); assert.equal(Date.parse(found.expiresAt) - Date.parse(found.fetchedAt), 300_000);
  assert.equal(found.data.places[0].id, 'station-a');
  assert.ok(!JSON.stringify(found).includes('latitude') && !JSON.stringify(found).includes('synthetic'));
  const travel: any = await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-b', mode: 'car' }, 'alice');
  assert.equal(travel.ok, true); assert.equal(travel.data.durationMinutes, 14); assert.equal(travel.data.scheduledDeparture, 'unsupported');
  assert.equal(travel.data.destinationName, '강남역'); assert.equal(travel.data.destinationAddress, '강남대로 1');
  assert.deepEqual(await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-b', mode: 'car', destinationName: '변조' }, 'alice'), { ok: false, error: 'invalid_request' });
  assert.equal(Date.parse(travel.expiresAt) - Date.parse(travel.fetchedAt), 300_000);
  const weather: any = await tool(tools, 'get_weather').run({ placeId: 'station-b', at: '2026-11-01T12:15:00+09:00' }, 'alice');
  assert.equal(weather.ok, true); assert.equal(weather.data.precipitationBasis, 'preceding_hour'); assert.equal(weather.data.precipitationMm, 0);
  assert.equal(weather.data.sourceUrl, 'https://open-meteo.com/'); assert.equal(weather.data.untrusted, true);
  const subway: any = await tool(tools, 'get_subway_arrivals').run({ stationName: '서울역' }, 'alice');
  assert.equal(subway.ok, true); assert.equal(subway.data.scope, 'station_only'); assert.equal(subway.data.arrivals[0].stale, false);
  assert.equal(Date.parse(subway.expiresAt) - Date.parse(subway.fetchedAt), 15_000);
  assert.equal(calls.length, 4);
});

test('scope, invalid input and unconfigured providers fail without calling a provider', async () => {
  const tools = createExternalTools('alice', { travelMode: 'walk' });
  for (const [name, input] of [
    ['search_places', { query: '서울역' }], ['estimate_travel', { originPlaceId: 'a', destinationPlaceId: 'b', mode: 'walk' }],
    ['get_weather', { placeId: 'a', at: '2026-11-01T12:00:00+09:00' }], ['get_subway_arrivals', { stationName: '서울역' }],
  ] as const) {
    assert.deepEqual(await tool(tools, name).run(input, 'bob'), { ok: false, error: 'forbidden' });
    assert.deepEqual(await tool(tools, name).run(input, 'alice'), { ok: false, error: 'not_configured' });
  }
  assert.deepEqual(await tool(tools, 'search_places').run({ query: 'x'.repeat(101) }, 'alice'), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await tool(tools, 'get_subway_arrivals').run({ stationName: '../key' }, 'alice'), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await tool(tools, 'get_weather').run({ placeId: 'a', at: 'tomorrow' }, 'alice'), { ok: false, error: 'invalid_request' });
});

test('place IDs cannot be guessed, reused across runs, or used after expiry', async () => {
  let time = base, routeCalls = 0;
  const places = createKakaoPlaces({ apiKey: 'synthetic-key', fetch: async () => reply({ documents: [placeA] }) });
  const travel = createKakaoTravel({ apiKey: 'synthetic-key', fetch: async () => { routeCalls++; return reply({ routes: [{ result_code: 0, summary: { duration: 60 } }] }); }, clock: () => time });
  const options = { places, travel, travelMode: 'car' as const, clock: () => new Date(time) };
  const first = createExternalTools('alice', options), second = createExternalTools('alice', options);
  const args = { originPlaceId: 'station-a', destinationPlaceId: 'station-a', mode: 'car' };
  assert.deepEqual(await tool(first, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_not_found' });
  await tool(first, 'search_places').run({ query: '서울역' }, 'alice');
  assert.deepEqual(await tool(second, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_not_found' });
  time -= 1;
  assert.deepEqual(await tool(first, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_expired' });
  time = base;
  time += 300_000;
  assert.deepEqual(await tool(first, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_expired' });
  assert.equal(routeCalls, 0);
});

test('provider errors and missing freshness are sanitized rather than fabricated', async () => {
  const places = createKakaoPlaces({ apiKey: 'synthetic-key', fetch: async () => reply({ documents: [placeA] }) });
  const travel: any = { async estimate() { return { ok: true, provider: 'kakao', durationMinutes: 12, fetchedAt: new Date(base).toISOString() }; } };
  const weather: any = { async forecast() { throw new Error('private-secret'); } };
  const subway: any = { async arrivals() { return { ok: false, error: 'timeout' }; } };
  const tools = createExternalTools('alice', { places, travel, weather, subway, travelMode: 'walk', clock: () => new Date(base) });
  await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  assert.deepEqual(await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-a', mode: 'walk' }, 'alice'), { ok: false, error: 'invalid_response' });
  assert.deepEqual(await tool(tools, 'get_weather').run({ placeId: 'station-a', at: '2026-11-01T12:00:00+09:00' }, 'alice'), { ok: false, error: 'unavailable' });
  assert.deepEqual(await tool(tools, 'get_subway_arrivals').run({ stationName: '서울역' }, 'alice'), { ok: false, error: 'timeout' });
});

const gps = { latitude: 37.12345, longitude: 127.12345, accuracyMeters: 12, capturedAt: new Date(base - 60_000).toISOString() };

test('current location is opt-in, validated, scoped, and ephemeral without disclosing coordinates', async () => {
  const none = createExternalTools('alice', { clock: () => new Date(base) });
  assert.deepEqual(await tool(none, 'get_current_location').run({}, 'alice'), { ok: false, error: 'not_shared' });
  assert.deepEqual(await tool(none, 'get_current_location').run({}, 'bob'), { ok: false, error: 'forbidden' });
  const options = { currentLocation: gps, clock: () => new Date(base) };
  const first = createExternalTools('alice', options), second = createExternalTools('alice', options);
  assert.deepEqual(await tool(first, 'get_current_location').run({ extra: true }, 'alice'), { ok: false, error: 'invalid_request' });
  const result: any = await tool(first, 'get_current_location').run({}, 'alice');
  const other: any = await tool(second, 'get_current_location').run({}, 'alice');
  assert.equal(result.ok, true); assert.equal(result.provider, 'device'); assert.equal(result.data.label, '현재 위치');
  assert.equal(result.data.accuracyMeters, 12); assert.equal(result.data.capturedAt, gps.capturedAt);
  assert.equal(Date.parse(result.expiresAt), base + 240_000);
  assert.notEqual(result.data.placeId, other.data.placeId);
  assert.doesNotMatch(JSON.stringify(result), /37\.12345|127\.12345|latitude|longitude/);
  assert.deepEqual(await tool(second, 'estimate_travel').run({ originPlaceId: result.data.placeId, destinationPlaceId: result.data.placeId, mode: 'walk' }, 'alice'), { ok: false, error: 'mode_required' });
  const fresh = createExternalTools('alice', { currentLocation: { ...gps, capturedAt: new Date(base + 15_000).toISOString() }, clock: () => new Date(base) });
  const future: any = await tool(fresh, 'get_current_location').run({}, 'alice'); assert.equal(future.ok, true); assert.equal(Date.parse(future.expiresAt), base + 300_000);
  for (const bad of [{ ...gps, latitude: 91 }, { ...gps, longitude: -181 }, { ...gps, accuracyMeters: 0 }, { ...gps, accuracyMeters: 1001 },
    { ...gps, capturedAt: new Date(base + 15_001).toISOString() }, { ...gps, capturedAt: 'invalid' }]) {
    const invalid = createExternalTools('alice', { currentLocation: bad, clock: () => new Date(base) });
    assert.deepEqual(await tool(invalid, 'get_current_location').run({}, 'alice'), { ok: false, error: 'invalid_location' });
  }
  const stale = createExternalTools('alice', { currentLocation: { ...gps, capturedAt: new Date(base - 300_000).toISOString() }, clock: () => new Date(base) });
  assert.deepEqual(await tool(stale, 'get_current_location').run({}, 'alice'), { ok: false, error: 'location_expired' });
});

test('travel requires the selected mode and caps validity to both places and location', async () => {
  let time = base; let calls = 0;
  const places = createKakaoPlaces({ apiKey: 'synthetic-key', fetch: async () => reply({ documents: [placeA] }) });
  const travel = createKakaoTravel({ apiKey: 'synthetic-key', fetch: async (url) => {
    calls++; const request = new URL(String(url));
    assert.equal(request.searchParams.get('start_x'), String(gps.longitude)); assert.equal(request.searchParams.get('start_y'), String(gps.latitude));
    return reply({ status: 'OK', route: { properties: { totalTime: 120 } } });
  }, clock: () => time });
  const input = { originPlaceId: 'a', destinationPlaceId: 'b', mode: 'walk' };
  assert.deepEqual(await tool(createExternalTools('alice', { travel }), 'estimate_travel').run(input, 'alice'), { ok: false, error: 'mode_required' });
  const tools = createExternalTools('alice', { currentLocation: gps, travelMode: 'walk', places, travel, clock: () => new Date(time) });
  const location: any = await tool(tools, 'get_current_location').run({}, 'alice');
  await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  const args = { originPlaceId: location.data.placeId, destinationPlaceId: 'station-a', mode: 'walk' };
  assert.deepEqual(await tool(tools, 'estimate_travel').run({ ...args, mode: 'car' }, 'alice'), { ok: false, error: 'mode_mismatch' });
  assert.equal(calls, 0);
  time += 30_000;
  const result: any = await tool(tools, 'estimate_travel').run(args, 'alice');
  assert.equal(result.ok, true); assert.equal(result.data.mode, 'walk'); assert.equal(result.data.basis, 'current_time');
  assert.equal(result.data.scheduledDeparture, 'unsupported'); assert.equal(Date.parse(result.expiresAt), base + 240_000);
  assert.doesNotMatch(JSON.stringify(result), /37\.12345|127\.12345|latitude|longitude/);
  const other = createExternalTools('alice', { currentLocation: gps, travelMode: 'walk', places, travel, clock: () => new Date(time) });
  await tool(other, 'search_places').run({ query: '서울역' }, 'alice');
  assert.deepEqual(await tool(other, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_not_found' });
  time = base + 240_000;
  assert.deepEqual(await tool(tools, 'estimate_travel').run(args, 'alice'), { ok: false, error: 'place_expired' });
  assert.equal(calls, 1);
});

test('location expires while route is running and provider cannot replace its opaque ID', async () => {
  let time = base, locationId = '';
  const places: any = { async search() { return { ok: true, places: [{ id: locationId, name: '충돌', address: '', roadAddress: '', latitude: gps.latitude, longitude: gps.longitude }] }; } };
  const travel: any = { async estimate() { time = base + 240_000; return { ok: true, provider: 'kakao', durationMinutes: 10,
    fetchedAt: new Date(base).toISOString(), expiresAt: new Date(base + 300_000).toISOString() }; } };
  const tools = createExternalTools('alice', { currentLocation: gps, travelMode: 'walk', places, travel, clock: () => new Date(time) });
  const location: any = await tool(tools, 'get_current_location').run({}, 'alice'); locationId = location.data.placeId;
  assert.deepEqual(await tool(tools, 'search_places').run({ query: '장소' }, 'alice'), { ok: false, error: 'invalid_response' });
  assert.deepEqual(await tool(tools, 'estimate_travel').run({ originPlaceId: locationId, destinationPlaceId: locationId, mode: 'walk' }, 'alice'), { ok: false, error: 'place_expired' });
});

test('travel expiry is bounded by the earliest manual place and provider result', async () => {
  let time = base, providerTtl = 300_000;
  const places = createKakaoPlaces({ apiKey: 'synthetic-key', fetch: async () => reply({ documents: [placeA] }) });
  const travel: any = { async estimate() { return { ok: true, provider: 'kakao', durationMinutes: 5,
    fetchedAt: new Date(time).toISOString(), expiresAt: new Date(time + providerTtl).toISOString() }; } };
  const tools = createExternalTools('alice', { places, travel, travelMode: 'walk',
    currentLocation: { ...gps, capturedAt: new Date(base + 60_000).toISOString() }, clock: () => new Date(time) });
  await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  time += 60_000;
  const location: any = await tool(tools, 'get_current_location').run({}, 'alice');
  const result: any = await tool(tools, 'estimate_travel').run({ originPlaceId: location.data.placeId, destinationPlaceId: 'station-a', mode: 'walk' }, 'alice');
  assert.equal(result.ok, true); assert.equal(Date.parse(result.expiresAt), base + 300_000);
  providerTtl = 30_000;
  const shorter: any = await tool(tools, 'estimate_travel').run({ originPlaceId: location.data.placeId, destinationPlaceId: 'station-a', mode: 'walk' }, 'alice');
  assert.equal(shorter.ok, true); assert.equal(Date.parse(shorter.expiresAt), time + 30_000);
});

test('travel destination uses stored address when the road address is absent', async () => {
  const places = createKakaoPlaces({ apiKey: 'synthetic-key', fetch: async () => reply({ documents: [{ ...placeA, road_address_name: '' }] }) });
  const travel: any = { async estimate() { return { ok: true, provider: 'kakao', durationMinutes: 5,
    fetchedAt: new Date(base).toISOString(), expiresAt: new Date(base + 300_000).toISOString() }; } };
  const tools = createExternalTools('alice', { places, travel, travelMode: 'walk', clock: () => new Date(base) });
  await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  const result: any = await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-a', mode: 'walk' }, 'alice');
  assert.equal(result.ok, true); assert.equal(result.data.destinationName, '서울역'); assert.equal(result.data.destinationAddress, '서울 중구');
});
