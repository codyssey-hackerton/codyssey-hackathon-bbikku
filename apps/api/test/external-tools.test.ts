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

test('four scoped geo tools call existing adapters and return bounded untrusted observations', async () => {
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
  const tools = createExternalTools('alice', { clock: () => new Date(base), places: createKakaoPlaces({ apiKey: 'synthetic-key', fetch: fetcher }),
    travel: createKakaoTravel({ apiKey: 'synthetic-key', fetch: fetcher, clock: () => base }),
    weather: createOpenMeteo({ fetch: fetcher, clock: () => base }),
    subway: createSeoulSubway({ apiKey: 'syntheticKey', fetch: fetcher, clock: () => base }) });
  assert.deepEqual(tools.map(item => item.name), ['search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals']);
  const found: any = await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  assert.equal(found.ok, true); assert.equal(found.data.requiresSelection, true); assert.equal(found.data.untrusted, true);
  assert.equal(found.provider, 'kakao'); assert.equal(Date.parse(found.expiresAt) - Date.parse(found.fetchedAt), 300_000);
  assert.equal(found.data.places[0].id, 'station-a');
  assert.ok(!JSON.stringify(found).includes('latitude') && !JSON.stringify(found).includes('synthetic'));
  const travel: any = await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-b', mode: 'car' }, 'alice');
  assert.equal(travel.ok, true); assert.equal(travel.data.durationMinutes, 14); assert.equal(travel.data.scheduledDeparture, 'unsupported');
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
  const tools = createExternalTools('alice');
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
  const options = { places, travel, clock: () => new Date(time) };
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
  const tools = createExternalTools('alice', { places, travel, weather, subway, clock: () => new Date(base) });
  await tool(tools, 'search_places').run({ query: '서울역' }, 'alice');
  assert.deepEqual(await tool(tools, 'estimate_travel').run({ originPlaceId: 'station-a', destinationPlaceId: 'station-a', mode: 'walk' }, 'alice'), { ok: false, error: 'invalid_response' });
  assert.deepEqual(await tool(tools, 'get_weather').run({ placeId: 'station-a', at: '2026-11-01T12:00:00+09:00' }, 'alice'), { ok: false, error: 'unavailable' });
  assert.deepEqual(await tool(tools, 'get_subway_arrivals').run({ stationName: '서울역' }, 'alice'), { ok: false, error: 'timeout' });
});
