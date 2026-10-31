import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';
import { buildReviewEvents } from '../src/scheduler.ts';

const now = new Date('2030-01-01T09:00:00Z');
const sessions = { async resolve(token: string) { return ['local-developer', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (user: string, key: string) => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const chat = { conversationId: null, message: '일정을 확인해줘', timezone: 'UTC' };
const calendar = { userId: 'local-developer', accountRef: 'synthetic-account-secret', accountLabel: 'synthetic@example.test',
  async listCalendars() { return { calendars: [] }; }, async listEvents() { return { events: [], unsupportedCount: 0 }; },
  async resolveEvents() { return { events: [], unsupportedCount: 0 }; } } as const;

test('chat and scheduler receive the same server-scoped capability snapshot', async () => {
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const seen: Parameters<ModelPort['decide']>[0][] = [];
  const model: ModelPort = { async decide(input) { seen.push(structuredClone(input)); return { kind: 'answer', text: '확인했습니다.' }; } };
  const app = buildApp({ sessions, store, model, clock: () => now, calendarConnection: calendar,
    gmailContact: { userId: 'local-developer', senderAddress: 'synthetic@example.test', async dispatch() { throw new Error('unexpected'); } },
    places: { async search() { throw new Error('unexpected'); } }, placesConfigured: true,
    travel: { async estimate() { throw new Error('unexpected'); } }, travelConfigured: true, schedulerStatus: () => 'available' });
  try {
    const payload = { ...chat, requestId: 'chat' };
    const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('local-developer', 'chat'), payload });
    assert.equal(response.statusCode, 200, response.body);
    const rejected = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('local-developer', 'spoof'),
      payload: { ...payload, requestId: 'spoof', capabilities: { email: { status: 'configured' } } } });
    assert.equal(rejected.statusCode, 400); assert.equal(seen.length, 1);
    const service = new PlanningService(store, () => now);
    await service.saveReviewSchedule('local-developer', { expectedRevision: 0, timezone: 'UTC',
      morning: { enabled: true, localTime: '09:00' }, evening: { enabled: false, localTime: null } });
    const event = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0]!, now)[0]!;
    assert.equal((await app.reviewRuntime.runScheduledReview(event)).status, 'completed');
    assert.equal(seen.length, 2);
    const expected = {
      calendar: { status: 'configured', access: 'app' }, email: { status: 'configured', access: 'app' },
      emailReplies: { status: 'not_configured', access: 'app' }, phone: { status: 'not_configured', access: 'app' },
      places: { status: 'configured', access: 'app' }, travelTime: { status: 'configured', access: 'app',
        modes: ['walk', 'transit', 'car'], scheduledDeparture: 'unsupported' }, scheduler: { status: 'configured', access: 'app' },
    };
    assert.deepEqual(seen[0]!.context.capabilities, expected);
    assert.deepEqual(seen[1]!.context.capabilities, expected);
    assert.ok(!JSON.stringify(seen.map(value => value.context)).includes('synthetic-account-secret'));
    const bob = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('bob', 'bob'), payload: { ...chat, requestId: 'bob' } });
    assert.equal(bob.statusCode, 200, bob.body);
    const bobCapabilities = seen[2]!.context.capabilities as typeof expected;
    assert.equal(bobCapabilities.calendar.status, 'not_configured'); assert.equal(bobCapabilities.email.status, 'not_configured');
  } finally { await app.close(); }
});

test('adapter presence alone does not claim a configured route or travel time', async () => {
  let seen: Record<string, unknown> | undefined;
  const app = buildApp({ sessions, model: { async decide(input) { seen = input.context; return { kind: 'answer', text: '확인했습니다.' }; } },
    places: { async search() { throw new Error('unexpected'); } }, travel: { async estimate() { throw new Error('unexpected'); } } });
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/chat', headers: headers('bob', 'chat'), payload: { ...chat, requestId: 'chat' } });
    assert.equal(result.statusCode, 200, result.body);
    const values = seen?.capabilities as { places: { status: string }; travelTime: { status: string; scheduledDeparture: string } };
    assert.equal(values.places.status, 'not_configured'); assert.equal(values.travelTime.status, 'not_configured');
    assert.equal(values.travelTime.scheduledDeparture, 'unsupported');
  } finally { await app.close(); }
});
