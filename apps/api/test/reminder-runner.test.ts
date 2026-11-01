import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { buildApp } from '../src/app.ts';
import { createExternalTools } from '../src/external-tools.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { locationAvailable } from '../src/device-context.ts';
import { createResponsesModel } from '../src/model.ts';

const base = Date.parse('2030-01-02T00:00:00Z');
const fields = { kind: 'event' as const, title: '합성 약속', timeSlot: { startsAt: '2030-01-02T12:00:00.123456+09:00',
  endsAt: '2030-01-02T13:00:00.123456+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null,
  flexibility: 'flexible' as const, involvement: 'personal' as const, completion: 'pending' as const };
const device = { currentLocation: { latitude: 37.123456, longitude: 127.123456, accuracyMeters: 10,
  capturedAt: '2030-01-01T23:59:00Z' }, travelMode: 'car' as const, notificationSupport: 'device' as const };
const output = (observations: any[], name: string) => observations.find(value => value.name === name)?.result;
const places: any = { async search() { return { ok: true, places: [{ id: 'destination', name: '합성 목적지',
  address: '서울 중구 1', roadAddress: '서울로 1', latitude: 37.5, longitude: 127.5 }] }; } };
const travel: any = { async estimate(value: any) { assert.equal(value.origin.latitude, device.currentLocation.latitude);
  return { ok: true, provider: 'kakao', durationMinutes: 20, fetchedAt: new Date(base).toISOString(), expiresAt: new Date(base + 300_000).toISOString() }; } };

async function setup(location?: string) {
  const store = new MemoryPlanningStore(); let time = base;
  const clock = () => new Date(time);
  const planning = new PlanningService(store, clock);
  const item = (await planning.command('alice', { expectedScheduleRevision: 0,
    changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: { ...fields, ...(location ? { location } : {}) } }] } })).items[0]!;
  return { store, planning, clock, item, setTime(value: number) { time = value; } };
}
const request = (itemId: string, expectedRevision: number, basis: 'event_start' | 'departure' = 'event_start') => ({
  kind: 'reminder_request' as const, text: '확인해 주세요', itemId, expectedRevision, minutesBefore: 10, basis,
  ...(basis === 'departure' ? { destinationPlaceId: 'destination' } : {}),
});

test('HTTP GPS-to-ETA candidate is calculated from the observed route and does not persist coordinates', async t => {
  const env = await setup();
  const seen: unknown[] = [];
  const model: ModelPort = { async decide(input) {
    seen.push({ context: input.context, observations: input.observations });
    const observations = input.observations;
    if (!observations.length) return { kind: 'tool_call', name: 'get_current_location', input: {} };
    if (observations.length === 1) return { kind: 'tool_call', name: 'search_places', input: { query: '목적지' } };
    if (observations.length === 2) return { kind: 'tool_call', name: 'estimate_travel', input: {
      originPlaceId: (output(observations, 'get_current_location') as any).data.placeId, destinationPlaceId: 'destination', mode: 'car' } };
    return request(env.item.id, env.item.revision, 'departure');
  } };
  const app = buildApp({ store: env.store, clock: env.clock, model, places, travel, placesConfigured: true, travelConfigured: true,
    sessions: { async resolve(token) { return token === 'alice' ? { userId: token } : null; } }, onChatMetrics() {} });
  t.after(() => app.close());
  const before = await env.store.read('alice');
  const payload = { requestId: 'r1', conversationId: null, message: '출발 10분 전에 알림 해줘', timezone: 'Asia/Seoul',
    entryContext: { kind: 'item', id: env.item.id, expectedRevision: env.item.revision }, deviceContext: device };
  const send = (body: typeof payload) => app.inject({ method: 'POST', url: '/v1/chat',
    headers: { authorization: 'Bearer alice', 'idempotency-key': 'r1' }, payload: body });
  const response = await send(payload);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json().data.result;
  assert.equal(result.kind, 'reminder_request', response.body);
  assert.equal(result.reminder.departureAt, '2030-01-02T02:40:00.123456Z');
  assert.equal(result.reminder.reminderAt, '2030-01-02T02:30:00.123456Z');
  assert.equal(result.reminder.expiresAt, '2030-01-02T00:04:00.000Z');
  assert.deepEqual(result.reminder.travel, { mode: 'car', durationMinutes: 20, provider: 'kakao', basis: 'current_time',
    destinationName: '합성 목적지', destinationAddress: '서울로 1' });
  const calls = seen.length;
  assert.deepEqual((await send(payload)).json(), response.json());
  const different = await send({ ...payload, deviceContext: { ...device, currentLocation: { ...device.currentLocation, latitude: 37.2 } } });
  assert.equal(different.statusCode, 409);
  assert.equal(different.json().error.code, 'idempotency_conflict');
  assert.equal(seen.length, calls);
  const state = await env.store.read('alice');
  assert.deepEqual([...state.items], [...before.items]);
  assert.equal(state.scheduleRevision, before.scheduleRevision);
  for (const value of [seen, response.json(), [...state.conversations], [...state.idempotency]]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('37.123456'), false);
    assert.equal(serialized.includes('127.123456'), false);
  }
});

test('explicit reminder requires an owned observed/selected item and rejects negative, form, or past cases', async () => {
  const env = await setup();
  let decision = request(env.item.id, env.item.revision);
  const model: ModelPort = { async decide() { return decision; } };
  const runner = new PlanningAgentRunner(env.planning, model);
  const input = { userId: 'alice', requestId: 'r', conversationId: null, history: [], timezone: 'Asia/Seoul',
    message: '일정 10분 전에 알림 해줘', entryContext: { kind: 'item' as const, id: env.item.id, expectedRevision: env.item.revision } };
  const result = await runner.finish(await runner.prepare(input));
  assert.equal(result.kind, 'reminder_request');
  if (result.kind === 'reminder_request') assert.equal(result.reminder.reminderAt, '2030-01-02T02:50:00.123456Z');
  for (const message of ['고마워', '알림 하지 마', '알림 설정하지 말아줘', '알려주지 마', '알림 보내지 마', '알림 꺼줘', '알림 없이 진행해줘', '안 알려줘도 돼']) {
    assert.equal((await runner.finish(await runner.prepare({ ...input, message }))).kind, 'failure');
  }
  assert.equal((await runner.finish(await runner.prepare({ ...input, entryContext: undefined }))).kind, 'failure');
  assert.equal((await runner.finish(await runner.prepare({ ...input, entryContext: { kind: 'form', draft: { kind: 'event', fields: {} } } }))).kind, 'failure');
  decision = request('other-users-item', 1);
  assert.equal((await runner.finish(await runner.prepare({ ...input, entryContext: undefined }))).kind, 'failure');
  decision = request(env.item.id, env.item.revision);
  env.setTime(Date.parse('2030-01-02T02:55:00Z'));
  assert.equal((await runner.finish(await runner.prepare(input))).kind, 'failure');
});

test('departure candidate requires GPS origin, explicit matching mode and fresh route', async () => {
  for (const variant of ['no_mode', 'wrong_origin', 'wrong_destination', 'missing_destination_address', 'expired'] as const) {
    const env = await setup();
    const model: ModelPort = { async decide(input) {
      if (!input.observations.length) return { kind: 'tool_call', name: 'get_current_location', input: {} };
      if (input.observations.length === 1) return { kind: 'tool_call', name: 'search_places', input: { query: '목적지' } };
      if (input.observations.length === 2) return { kind: 'tool_call', name: 'estimate_travel', input: {
        originPlaceId: variant === 'wrong_origin' ? 'destination' : (output(input.observations, 'get_current_location') as any).data.placeId,
        destinationPlaceId: 'destination', mode: 'car' } };
      return { ...request(env.item.id, env.item.revision, 'departure'), ...(variant === 'wrong_destination' ? { destinationPlaceId: 'other' } : {}) };
    } };
    const noAddress: any = { async search() { return { ok: true, places: [{ id: 'destination', name: '목적지',
      address: '', roadAddress: '', latitude: 37.5, longitude: 127.5 }] }; } };
    const runner = new PlanningAgentRunner(env.planning, model, undefined, async (userId, deviceContext) =>
      createExternalTools(userId, { places: variant === 'missing_destination_address' ? noAddress : places, travel,
        currentLocation: deviceContext?.currentLocation, travelMode: deviceContext?.travelMode, clock: env.clock }));
    const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, history: [],
      timezone: 'Asia/Seoul', message: '출발 전 알림 해줘', entryContext: { kind: 'item', id: env.item.id, expectedRevision: env.item.revision },
      deviceContext: variant === 'no_mode' ? { currentLocation: device.currentLocation } : device });
    if (variant === 'expired') env.setTime(base + 240_000);
    assert.equal((await runner.finish(prepared)).kind, 'failure', variant);
  }
});

test('location freshness boundaries reject old or far-future readings', () => {
  const current = new Date(base).toISOString();
  assert.equal(locationAvailable(device.currentLocation, current), true);
  assert.equal(locationAvailable({ ...device.currentLocation, capturedAt: new Date(base - 300_000).toISOString() }, current), false);
  assert.equal(locationAvailable({ ...device.currentLocation, capturedAt: new Date(base + 15_000).toISOString() }, current), true);
  assert.equal(locationAvailable({ ...device.currentLocation, capturedAt: new Date(base + 15_001).toISOString() }, current), false);
  assert.equal(locationAvailable({ ...device.currentLocation, accuracyMeters: 1001 }, current), false);
});

test('the registered native model accepts a reminder decision and the GPS read tool schema', async () => {
  const expected = request('item', 1, 'departure');
  let calls = 0;
  const model = createResponsesModel('synthetic', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].name, 'get_current_location');
    calls++;
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] });
  });
  const tools = createExternalTools('alice').filter(tool => tool.name === 'get_current_location');
  const { z } = await import('zod');
  const result = await model.decide({ userId: 'alice', message: '알림 해줘', context: {}, observations: [],
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) })) });
  assert.deepEqual(result, expected);
  assert.equal(calls, 1);
});

test('an item changed after model preparation cannot produce a reminder candidate', async () => {
  const env = await setup();
  const runner = new PlanningAgentRunner(env.planning, { async decide() { return request(env.item.id, env.item.revision); } });
  const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, history: [],
    timezone: 'Asia/Seoul', message: '10분 전 알림 해줘',
    entryContext: { kind: 'item', id: env.item.id, expectedRevision: env.item.revision } });
  await env.planning.checkin('alice', env.item.id, { expectedRevision: env.item.revision, completion: 'completed' });
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.code, 'stale_snapshot');
});

test('departure candidate exposes the actual destination alongside a different appointment location', async () => {
  const env = await setup('서울역');
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'get_current_location', input: {} };
    if (input.observations.length === 1) return { kind: 'tool_call', name: 'search_places', input: { query: '부산역' } };
    if (input.observations.length === 2) return { kind: 'tool_call', name: 'estimate_travel', input: {
      originPlaceId: (output(input.observations, 'get_current_location') as any).data.placeId, destinationPlaceId: 'destination', mode: 'car' } };
    return request(env.item.id, env.item.revision, 'departure');
  } };
  const otherPlace: any = { async search() { return { ok: true, places: [{ id: 'destination', name: '부산역',
    address: '부산 동구 1', roadAddress: '부산로 1', latitude: 35, longitude: 129 }] }; } };
  const runner = new PlanningAgentRunner(env.planning, model, undefined, async (userId, deviceContext) =>
    createExternalTools(userId, { places: otherPlace, travel, currentLocation: deviceContext?.currentLocation, travelMode: deviceContext?.travelMode, clock: env.clock }));
  const prepared = await runner.prepare({ userId: 'alice', requestId: 'r', conversationId: null, history: [],
    timezone: 'Asia/Seoul', message: '출발 10분 전 알림 해줘',
    entryContext: { kind: 'item', id: env.item.id, expectedRevision: env.item.revision }, deviceContext: device });
  const result = await runner.finish(prepared);
  assert.equal(result.kind, 'reminder_request');
  if (result.kind === 'reminder_request') {
    assert.equal(result.reminder.appointmentLocation, '서울역');
    assert.equal(result.reminder.travel?.destinationName, '부산역');
    assert.equal(result.reminder.travel?.destinationAddress, '부산로 1');
  }
});
