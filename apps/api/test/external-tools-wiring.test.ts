import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { buildReviewEvents } from '../src/scheduler.ts';

test('chat and scheduler bind external tools to each actor and each run', async () => {
  const now = new Date('2030-01-01T09:00:00Z');
  const store = new MemoryPlanningStore();
  const observed: Array<{ userId: string; name: string; result: any; scheduled: boolean }> = [];
  let calendarCalls = 0, travelCalls = 0, subwayCalls = 0;
  const model: ModelPort = { async decide(input) {
    assert.ok(['search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals', 'list_calendars', 'read_calendar_events', 'list_contact_requests', 'read_contact_replies'].every(name => input.tools.some(tool => tool.name === name)));
    if (input.observations.length) {
      const observation = input.observations.at(-1)!;
      observed.push({ userId: input.userId, name: observation.name, result: observation.result, scheduled: !!input.context.triggerEvent });
      return { kind: 'answer', text: '확인했습니다.' };
    }
    if (input.context.triggerEvent || input.message === '장소') return { kind: 'tool_call', name: 'search_places', input: { query: '합성장소' } };
    if (input.message === '이동') return { kind: 'tool_call', name: 'estimate_travel', input: { originPlaceId: 'place-1', destinationPlaceId: 'place-1', mode: 'walk' } };
    if (input.message === '지하철') return { kind: 'tool_call', name: 'get_subway_arrivals', input: { stationName: '서울' } };
    return { kind: 'tool_call', name: 'list_calendars', input: {} };
  } };
  const calendarConnection = { userId: 'alice', accountRef: 'synthetic-account', accountLabel: 'alice@example.test',
    async listCalendars() { calendarCalls++; return { calendars: [{ id: 'calendar-1', summary: '합성' }] }; },
    async listEvents() { return { events: [], unsupportedCount: 0 }; }, async resolveEvents() { return { events: [], unsupportedCount: 0 }; } };
  const app = buildApp({ model, store, clock: () => now, calendarConnection,
    sessions: { async resolve(token) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } },
    placesConfigured: true, places: { async search() { return { ok: true as const, places: [{ id: 'place-1', name: '합성장소', address: '', roadAddress: '', longitude: 127, latitude: 37 }] }; } },
    travelConfigured: true, travel: { async estimate() { travelCalls++; return { ok: false as const, error: 'unavailable' as const }; } },
    subwayConfigured: false, subway: { async arrivals() { subwayCalls++; return { ok: false as const, error: 'unavailable' as const }; } } });
  const chat = async (userId: string, message: string, key: string) => app.inject({ method: 'POST', url: '/v1/chat',
    headers: { authorization: `Bearer ${userId}`, 'idempotency-key': key }, payload: { requestId: key, conversationId: null, message, timezone: 'UTC' } });
  try {
    for (const [user, text, key] of [['alice','달력','one'],['bob','달력','two'],['alice','장소','three'],['alice','이동','four'],['alice','지하철','five']]) {
      const response = await chat(user, text, key); assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(observed[0].result.ok, true); assert.equal(observed[1].result.error, 'not_configured');
    const aliceConversations = [...(await store.read('alice')).conversations.values()];
    const calendarTurn = aliceConversations.find(value => value.turns[0]?.content === '달력')?.turns[1];
    assert.equal(calendarTurn?.externalExpiresAt, '2030-01-01T09:05:00.000Z');
    assert.equal(calendarCalls, 1); assert.equal(observed[2].result.ok, true);
    assert.equal(observed[3].result.error, 'place_not_found'); assert.equal(travelCalls, 0);
    assert.equal(observed[4].result.error, 'not_configured'); assert.equal(subwayCalls, 0);
    const planning = new PlanningService(store, () => now);
    await planning.saveReviewSchedule('alice', { expectedRevision: 0, timezone: 'UTC',
      morning: { enabled: true, localTime: '09:00' }, evening: { enabled: false, localTime: null } });
    const event = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0]!, now)[0]!;
    assert.equal((await app.reviewRuntime.runScheduledReview(event)).status, 'completed');
    assert.equal(observed.at(-1)?.name, 'search_places'); assert.equal(observed.at(-1)?.scheduled, true);
  } finally { await app.close(); }
});

test('scheduler retries rather than completing after external information expires', async () => {
  let current = new Date('2030-01-01T09:00:00Z'), expireOnce = true;
  const store = new MemoryPlanningStore();
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'search_places', input: { query: '합성' } };
    if (expireOnce) { current = new Date(current.getTime() + 300_001); expireOnce = false; }
    return { kind: 'answer', text: '확인했습니다.' };
  } };
  const app = buildApp({ store, model, clock: () => current, placesConfigured: true,
    places: { async search() { return { ok: true as const, places: [{ id: 'place-1', name: '합성', address: '', roadAddress: '', longitude: 127, latitude: 37 }] }; } } });
  try {
    const planning = new PlanningService(store, () => current);
    await planning.saveReviewSchedule('alice', { expectedRevision: 0, timezone: 'UTC',
      morning: { enabled: true, localTime: '09:00' }, evening: { enabled: false, localTime: null } });
    const event = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0]!, current)[0]!;
    const first = await app.reviewRuntime.runScheduledReview(event);
    assert.equal(first.status, 'failed'); assert.equal(first.result?.kind, 'failure');
    if (first.result?.kind === 'failure') assert.equal(first.result.code, 'external_data_expired');
    const retried = await app.reviewRuntime.runScheduledReview(event);
    assert.equal(retried.status, 'completed');
  } finally { await app.close(); }
});
