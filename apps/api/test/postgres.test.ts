import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
const fixed = '2026-10-31T12:00:00.000Z';
const task = { kind: 'task', title: '공부', timeSlot: null, durationMinutes: 60, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const slot = { startsAt: '2026-11-02T09:00+09:00', endsAt: '2026-11-02T10:00+09:00', timezone: 'Asia/Seoul' };
const headers = (key = 'key') => ({ authorization: 'Bearer test', 'idempotency-key': key });
const command = (id: string) => ({ requestId: id, expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: task }] } });
const chat = (id: string, conversationId: string | null, message = '제안') => ({ requestId: id, conversationId, message, timezone: 'Asia/Seoul' });
async function isolatedSchema(): Promise<string> {
  const schema = `pikku_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  return schema;
}
function poolFor(schema: string): pg.Pool { return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 }); }

test('PostgreSQL persists state, conversations, proposals, approvals and idempotency across pool restart', { skip: !connectionString }, async () => {
  const userId = `pikku-test-${randomUUID()}`;
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let itemId = ''; let observedHistory: unknown;
  const model: ModelPort = { async decide(input) {
    if (input.message === '다시') { observedHistory = input.context.history; return { kind: 'answer', text: '이전 대화를 확인했습니다.' }; }
    return { kind: 'proposal', reason: '공부 배치', changeSet: { changes: [{ changeId: 'place', operation: 'update', targetId: itemId, expectedRevision: 1, after: { ...task, timeSlot: slot } }] }, evidenceRefs: [] };
  } };
  const schema = await isolatedSchema();
  const pool1 = poolFor(schema); const store1 = new PostgresPlanningStore(pool1);
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined; let pool2: pg.Pool | undefined;
  try {
    await store1.migrate(); await store1.migrate();
    app1 = buildApp({ sessions, model, store: store1, clock: () => new Date(fixed) });
    const capabilities = await app1.inject({ method: 'GET', url: '/v1/capabilities', headers: headers() });
    assert.deepEqual(capabilities.json().data.storage, { mode: 'postgres', durable: true });
    const created = await app1.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('create'), payload: command('create') });
    assert.equal(created.statusCode, 200, created.body);
    itemId = created.json().data.items[0].id;
    const fact = await app1.inject({ method: 'POST', url: '/v1/memory', headers: headers('memory'), payload: { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'study', value: '오전', validUntil: null } });
    assert.equal(fact.statusCode, 200, fact.body);
    const review = await app1.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('review'), payload: { requestId: 'review', expectedRevision: 0, timezone: 'Asia/Seoul', evening: { enabled: true, localTime: '21:00' }, morning: { enabled: false, localTime: null } } });
    assert.equal(review.statusCode, 200, review.body);
    const response = await app1.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: chat('chat', null) });
    assert.equal(response.statusCode, 200, response.body);
    const conversationId = response.json().data.conversationId; const proposalId = response.json().data.result.proposalIds[0];
    await app1.close(); app1 = undefined; await pool1.end();

    pool2 = poolFor(schema); const store2 = new PostgresPlanningStore(pool2); await store2.migrate();
    app2 = buildApp({ sessions, model, store: store2, clock: () => new Date(fixed) });
    const replay = await app2.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('create'), payload: command('retry') });
    assert.deepEqual(replay.json(), created.json());
    const memory = await app2.inject({ method: 'GET', url: `/v1/memory?at=${encodeURIComponent(fixed)}`, headers: headers() });
    assert.equal(memory.json().data.facts[0].value, '오전');
    const restoredReview = await app2.inject({ method: 'GET', url: '/v1/review-schedule', headers: headers() });
    assert.equal(restoredReview.json().data.reviewSchedule.evening.localTime, '21:00');
    const resumed = await app2.inject({ method: 'POST', url: '/v1/chat', headers: headers('resume'), payload: chat('resume', conversationId, '다시') });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((observedHistory as unknown[]).length, 2);
    const decision = await app2.inject({ method: 'POST', url: `/v1/proposals/${proposalId}/decision`, headers: headers('accept'), payload: { requestId: 'accept', proposalRevision: 1, decision: 'accept' } });
    assert.equal(decision.statusCode, 200, decision.body);
    assert.equal(decision.json().data.outcome, 'applied');
    const decisionReplay = await app2.inject({ method: 'POST', url: `/v1/proposals/${proposalId}/decision`, headers: headers('accept'), payload: { requestId: 'again', proposalRevision: 1, decision: 'accept' } });
    assert.deepEqual(decisionReplay.json(), decision.json());
    const state = await store2.read(userId);
    assert.equal(state.scheduleRevision, 2);
    assert.equal(state.items.get(itemId)?.timeSlot?.startsAt, slot.startsAt);
    assert.equal(state.approvals.length, 1);
  } finally {
    if (app1) await app1.close();
    if (app2) await app2.close();
    if (!pool1.ended) await pool1.end();
    if (pool2) await pool2.end();
  }
});

test('PostgreSQL serializes concurrent writes across instances without holding locks during model calls', { skip: !connectionString }, async () => {
  const userId = `pikku-test-${randomUUID()}`;
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let start!: () => void; let release!: () => void; let calls = 0;
  const started = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async decide() { calls++; start(); await gate; return { kind: 'answer', text: '확인했습니다.' }; } };
  const schema = await isolatedSchema();
  const pool = poolFor(schema); const store1 = new PostgresPlanningStore(pool); const store2 = new PostgresPlanningStore(pool);
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined;
  try {
    await store1.migrate();
    app1 = buildApp({ sessions, model, store: store1, clock: () => new Date(fixed) });
    app2 = buildApp({ sessions, model, store: store2, clock: () => new Date(fixed) });
    const [one, two] = await Promise.all([
      app1.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('one'), payload: command('one') }),
      app2.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('two'), payload: command('two') }),
    ]);
    assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409]);
    const pending = app1.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: chat('chat', null) }).then(response => response);
    await started;
    const duplicate = await app2.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: chat('retry', null) });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'operation_in_progress');
    const memory = await app2.inject({ method: 'POST', url: '/v1/memory', headers: headers('memory'), payload: { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'study', value: true, validUntil: null } });
    assert.equal(memory.statusCode, 200, memory.body);
    release();
    const first = await pending;
    assert.equal(first.statusCode, 200, first.body);
    const replay = await app2.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: chat('replay', null) });
    assert.deepEqual(replay.json(), first.json());
    assert.equal(calls, 1);
  } finally { release(); if (app1) await app1.close(); if (app2) await app2.close(); await pool.end(); }
});

test('a reply based on a read is not returned after another instance changes the snapshot', { skip: !connectionString, timeout: 15_000 }, async () => {
  const schema = await isolatedSchema(); const userId = `pikku-test-${randomUUID()}`;
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: { from: '2026-11-01T00:00Z', to: '2026-11-03T00:00Z', timezone: 'UTC' } };
    start(); await gate; return { kind: 'answer', text: '일정이 없습니다.' };
  } };
  const pool = poolFor(schema); const store1 = new PostgresPlanningStore(pool); const store2 = new PostgresPlanningStore(pool);
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined;
  try {
    await store1.migrate();
    app1 = buildApp({ sessions, model, store: store1, clock: () => new Date(fixed) });
    app2 = buildApp({ sessions, model, store: store2, clock: () => new Date(fixed) });
    const pending = app1.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: chat('chat', null) }).then(response => response);
    await started;
    const write = await app2.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('write'), payload: command('write') });
    assert.equal(write.statusCode, 200, write.body);
    release();
    const response = await pending;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.result.code, 'stale_snapshot');
    assert.equal(response.json().data.result.retryable, true);
  } finally { release(); if (app1) await app1.close(); if (app2) await app2.close(); await pool.end(); }
});
