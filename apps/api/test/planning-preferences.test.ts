import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import type { MemoryFact } from '@pikku/domain';
import type { ModelPort } from '../src/agent.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';
import { buildApp } from '../src/app.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const now = '2030-01-01T00:00:00.000Z';
const preferences = { version: 1, goals: ['work', 'health'], timing: { preparationMinutes: 0, travelEstimateMinutes: 35, bufferMinutes: null },
  preferredPeriod: 'morning', onboardingStatus: 'completed' };
const skipped = { version: 1, goals: [], timing: { preparationMinutes: null, travelEstimateMinutes: null, bufferMinutes: null },
  preferredPeriod: null, onboardingStatus: 'skipped' };
const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (user: string, key: string) => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const payload = (requestId: string, expectedContextRevision: number, value: MemoryFact['value']) =>
  ({ requestId, expectedContextRevision, kind: 'preference' as const, key: 'planning_preferences', value, validUntil: null });

test('profile preference uses existing owner-scoped memory and concurrent revision checks', async t => {
  const store = new MemoryPlanningStore(); const app = buildApp({ sessions, store, clock: () => new Date(now) }); t.after(() => app.close());
  const write = (user: string, key: string, body: object) => app.inject({ method: 'POST', url: '/v1/memory', headers: headers(user, key), payload: body });
  const first = await write('alice', 'first', payload('first', 0, preferences));
  assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().data.contextRevision, 1);
  assert.equal(first.json().data.fact.source.ref, 'alice'); assert.equal(first.json().data.fact.validUntil, null);
  const replay = await write('alice', 'first', payload('retry', 0, preferences)); assert.deepEqual(replay.json(), first.json());
  const [one, two] = await Promise.all([
    write('alice', 'a', payload('a', 1, { ...preferences, preferredPeriod: 'afternoon' })),
    write('alice', 'b', payload('b', 1, { ...preferences, preferredPeriod: 'unknown' })),
  ]);
  assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409]);
  const winner = [one, two].find(response => response.statusCode === 200)!;
  assert.equal(winner.json().data.contextRevision, 2); assert.equal(winner.json().data.fact.revision, 2);
  assert.equal((await store.read('alice')).facts.size, 1);
  const bobBefore = await app.inject({ method: 'GET', url: `/v1/memory?at=${encodeURIComponent(now)}`, headers: headers('bob', 'get') });
  assert.deepEqual(bobBefore.json().data, { facts: [], contextRevision: 0 });
  const bob = await write('bob', 'skip', payload('skip', 0, skipped));
  assert.equal(bob.statusCode, 200); assert.deepEqual(bob.json().data.fact.value, skipped);
  assert.equal((await store.read('alice')).contextRevision, 2);
  assert.equal((await store.read('bob')).contextRevision, 1);
});

test('actual agent runner reads the scoped fact and rejects answers from stale preference snapshots', async () => {
  const store = new MemoryPlanningStore(); const planning = new PlanningService(store, () => new Date(now));
  await planning.saveMemory('alice', { ...payload('a', 0, preferences) });
  await planning.saveMemory('alice', { expectedContextRevision: 1, kind: 'situation', key: 'planning_preferences', value: 'not a preference', validUntil: '2030-01-02T00:00:00Z' });
  await planning.saveMemory('bob', { ...payload('b', 0, skipped) });
  const seen: Array<{ userId: string; result: any }> = [];
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'read_memory', input: { keys: ['planning_preferences'], at: input.context.now } };
    seen.push({ userId: input.userId, result: input.observations[0]!.result });
    return { kind: 'answer', text: '선호를 확인했습니다.' };
  } };
  const runner = new PlanningAgentRunner(planning, model);
  const run = async (userId: string) => runner.prepare({ userId, requestId: 'request', conversationId: null, message: '계획을 도와줘', timezone: 'UTC', history: [] });
  assert.equal((await runner.finish(await run('alice'))).kind, 'reply');
  assert.equal((await runner.finish(await run('bob'))).kind, 'reply');
  assert.equal(seen[0]!.result.contextRevision, 2); assert.equal(seen[0]!.result.facts.length, 2);
  const userFact = seen[0]!.result.facts.find((fact: any) => fact.kind === 'preference');
  assert.deepEqual(userFact.value, preferences); assert.equal(userFact.source.type, 'user'); assert.equal(userFact.source.ref, 'alice');
  assert.deepEqual(seen[1]!.result.facts.map((fact: any) => fact.value), [skipped]);
  const pending = await run('alice');
  await planning.saveMemory('alice', { ...payload('update', 2, skipped) });
  const stale = await runner.finish(pending);
  assert.equal(stale.kind, 'failure'); if (stale.kind === 'failure') assert.equal(stale.code, 'stale_snapshot');
  const beforeRecord = await planning.listMemory('alice', '2029-12-31T23:59:59.999Z');
  assert.equal(beforeRecord.facts.length, 0);
});

test('isolated PostgreSQL persists profile and serializes concurrent writes across instances', { skip: !process.env.PIKKU_TEST_DATABASE_URL }, async () => {
  const url = process.env.PIKKU_TEST_DATABASE_URL!;
  const schema = `preferences_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool1 = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  let pool2: pg.Pool | undefined;
  try {
    const first = new PlanningService(new PostgresPlanningStore(pool1), () => new Date(now));
    await (first.store as PostgresPlanningStore).migrate();
    await first.saveMemory('alice', { ...payload('first', 0, preferences) });
    await pool1.end();
    pool2 = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const store = new PostgresPlanningStore(pool2); const a = new PlanningService(store, () => new Date(now));
    const b = new PlanningService(new PostgresPlanningStore(pool2), () => new Date(now));
    assert.deepEqual((await a.listMemory('alice', now)).facts[0]!.value, preferences);
    assert.deepEqual((await a.listMemory('bob', now)).facts, []);
    const outcomes = await Promise.allSettled([
      a.saveMemory('alice', { ...payload('a', 1, skipped) }),
      b.saveMemory('alice', { ...payload('b', 1, { ...preferences, preferredPeriod: 'afternoon' }) }),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected'); assert.equal(rejected.reason.code, 'conflict');
    const current = await a.listMemory('alice', now);
    assert.equal(current.contextRevision, 2); assert.equal(current.facts.length, 1); assert.equal(current.facts[0]!.revision, 2);
    let observed: any;
    const runner = new PlanningAgentRunner(b, { async decide(input) {
      if (!input.observations.length) return { kind: 'tool_call', name: 'read_memory', input: { keys: ['planning_preferences'], at: input.context.now } };
      observed = input.observations[0]!.result; return { kind: 'answer', text: '확인' };
    } });
    const prepared = await runner.prepare({ userId: 'alice', requestId: 'pg', conversationId: null, message: '계획', timezone: 'UTC', history: [] });
    assert.equal((await runner.finish(prepared)).kind, 'reply');
    assert.deepEqual(observed.facts[0].value, current.facts[0]!.value);
  } finally {
    if (!pool1.ended) await pool1.end(); if (pool2) await pool2.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
