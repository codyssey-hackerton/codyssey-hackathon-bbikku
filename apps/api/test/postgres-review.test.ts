import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import type { UserPlanningState } from '../src/planning-store.ts';
import { buildReviewEvents } from '../src/scheduler.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
async function isolatedSchema(): Promise<string> {
  const schema = `pikku_review_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
  return schema;
}
function poolFor(schema: string): pg.Pool { return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 }); }
function dueAfterNow(): Date { return new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 120_000); }
function time(date: Date): string { return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`; }
const headers = (key: string) => ({ authorization: 'Bearer test', 'idempotency-key': key });
const scheduleBody = (revision: number, due: Date, enabled = true) => ({ requestId: `setting-${revision}`, expectedRevision: revision, timezone: 'UTC',
  morning: { enabled, localTime: time(due) }, evening: { enabled: false, localTime: null } });
const task = { kind: 'task', title: '자동 검토 제안', timeSlot: null, durationMinutes: 30, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const proposal = { kind: 'proposal', reason: '검토 제안', changeSet: { changes: [{ changeId: 'review-task', operation: 'create', after: task }] }, evidenceRefs: [] };

test('a scheduled proposal and event ledger survive pool restart and deduplicate the same occurrence', { skip: !connectionString }, async () => {
  const schema = await isolatedSchema(); const userId = `review-${randomUUID()}`;
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  const due = dueAfterNow(); let current = new Date(due.getTime() - 60_000); let calls = 0;
  const model: ModelPort = { async decide(input) {
    calls++; const trigger = input.context.triggerEvent as { reason: string; targetDate: string; userId?: string };
    assert.equal(trigger.reason, 'morning_review'); assert.equal(trigger.userId, undefined);
    return proposal;
  } };
  let pool1: pg.Pool | undefined = poolFor(schema); let pool2: pg.Pool | undefined;
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined;
  try {
    const store1 = new PostgresPlanningStore(pool1); await store1.migrate();
    app1 = buildApp({ sessions, model, store: store1, clock: () => current });
    const written = await app1.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('setting'), payload: scheduleBody(0, due) });
    assert.equal(written.statusCode, 200, written.body);
    const entries = await app1.reviewRuntime.listReviewSchedules();
    assert.equal(entries.length, 1);
    assert.ok(entries[0].updatedAt && Number.isFinite(Date.parse(entries[0].updatedAt)));
    assert.ok(Date.parse(entries[0].updatedAt!) <= due.getTime());
    const unrelated = await app1.inject({ method: 'POST', url: '/v1/memory', headers: headers('memory'), payload: { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'study', value: true, validUntil: null } });
    assert.equal(unrelated.statusCode, 200, unrelated.body);
    assert.equal((await app1.reviewRuntime.listReviewSchedules())[0].updatedAt, entries[0].updatedAt);
    const event = buildReviewEvents(entries[0], current).find(value => value.reason === 'morning_review')!;
    current = new Date(Date.parse(event.scheduledFor) + 1000);
    const first = await app1.reviewRuntime.runScheduledReview(event);
    assert.equal(first.status, 'completed'); assert.equal(first.result?.kind, 'proposal');
    const proposalId = first.result?.kind === 'proposal' ? first.result.proposalIds[0] : '';
    const before = await store1.read(userId);
    assert.equal(before.proposals.size, 1); assert.equal(before.scheduleRevision, 0); assert.equal(before.items.size, 0);
    assert.equal((before.reviewLedger.get(event.idempotencyKey) as { status: string }).status, 'completed');
    await app1.close(); app1 = undefined; await pool1.end(); pool1 = undefined;

    pool2 = poolFor(schema); const store2 = new PostgresPlanningStore(pool2); await store2.migrate();
    app2 = buildApp({ sessions, model, store: store2, clock: () => current });
    const replay = await app2.reviewRuntime.runScheduledReview(event);
    assert.deepEqual(replay, first); assert.equal(calls, 1);
    assert.equal((await store2.read(userId)).proposals.size, 1);
    const changed = await app2.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('setting-2'), payload: scheduleBody(1, due) });
    assert.equal(changed.statusCode, 200, changed.body);
    const revised = buildReviewEvents((await app2.reviewRuntime.listReviewSchedules())[0], new Date(event.scheduledFor))[0];
    assert.equal(revised.idempotencyKey, event.idempotencyKey); assert.equal(revised.sourceRevision, 2);
    assert.deepEqual(await app2.reviewRuntime.runScheduledReview(revised), first);
    assert.equal((await app2.reviewRuntime.runScheduledReview(event)).status, 'skipped');
    assert.equal(calls, 1);
    const disabled = await app2.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('setting-3'), payload: scheduleBody(2, due, false) });
    assert.equal(disabled.statusCode, 200);
    assert.equal((await app2.reviewRuntime.runScheduledReview(revised)).status, 'skipped');
    const after = await store2.read(userId);
    assert.equal(after.proposals.size, 1); assert.equal(after.proposals.get(proposalId)?.status, 'pending');
    assert.equal(after.scheduleRevision, 0); assert.equal(calls, 1);
  } finally { if (app1) await app1.close(); if (app2) await app2.close(); if (pool1) await pool1.end(); if (pool2) await pool2.end(); }
});

test('late scheduled events skip and model-wait setting changes cannot save a proposal', { skip: !connectionString }, async () => {
  const schema = await isolatedSchema(); const userId = `review-${randomUUID()}`;
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  const due = dueAfterNow(); let current = new Date(due.getTime() - 60_000); let calls = 0;
  let started!: () => void; let release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async decide() { calls++; started(); await gate; return proposal; } };
  const pool = poolFor(schema); const store = new PostgresPlanningStore(pool); let app: ReturnType<typeof buildApp> | undefined;
  try {
    await store.migrate(); app = buildApp({ sessions, model, store, clock: () => current });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('setting'), payload: scheduleBody(0, due) })).statusCode, 200);
    const event = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], current)[0];
    current = new Date(Date.parse(event.scheduledFor) + 60 * 60_000 + 1);
    assert.equal((await app.reviewRuntime.runScheduledReview(event)).status, 'skipped'); assert.equal(calls, 0);
    // Use the next occurrence and the same currently enabled settings for a separate in-flight attempt.
    const next = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], current)[0];
    current = new Date(Date.parse(next.scheduledFor) + 1000);
    const pending = app.reviewRuntime.runScheduledReview(next); await startedPromise;
    const disabled = await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('disable'), payload: scheduleBody(1, due, false) });
    assert.equal(disabled.statusCode, 200, disabled.body);
    release();
    assert.equal((await pending).status, 'skipped');
    const state = await store.read(userId);
    assert.equal(state.proposals.size, 0); assert.equal(state.scheduleRevision, 0); assert.equal(calls, 1);
  } finally { release(); if (app) await app.close(); await pool.end(); }
});

test('a stale revision skip is separately audited and cannot block the current revision occurrence', { skip: !connectionString }, async () => {
  const schema = await isolatedSchema(); const userId = `review-${randomUUID()}`; const due = dueAfterNow();
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let current = new Date(due.getTime() - 60_000); let calls = 0;
  const pool = poolFor(schema); const store = new PostgresPlanningStore(pool); let app: ReturnType<typeof buildApp> | undefined;
  try {
    await store.migrate(); app = buildApp({ sessions, store, clock: () => current, model: { async decide() { calls++; return proposal; } } });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('one'), payload: scheduleBody(0, due) })).statusCode, 200);
    const old = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], current)[0];
    assert.equal((await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('two'), payload: scheduleBody(1, due) })).statusCode, 200);
    const fresh = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], new Date(old.scheduledFor))[0];
    assert.equal(old.idempotencyKey, fresh.idempotencyKey);
    current = new Date(Date.parse(old.scheduledFor) + 1000);
    assert.equal((await app.reviewRuntime.runScheduledReview(old)).status, 'skipped');
    await app.reviewRuntime.recordSkipped(old, 'stale');
    assert.equal((await app.reviewRuntime.runScheduledReview(fresh)).status, 'completed');
    await app.reviewRuntime.recordSkipped(old, 'stale');
    const state = await store.read(userId);
    assert.equal(state.proposals.size, 1); assert.equal(calls, 1);
    assert.equal((state.reviewLedger.get(fresh.idempotencyKey) as { status: string }).status, 'completed');
    const audit = state.reviewLedger.get(JSON.stringify(['skip', old.idempotencyKey, old.sourceRevision, 'stale'])) as { status: string };
    assert.equal(audit.status, 'skipped');
  } finally { if (app) await app.close(); await pool.end(); }
});

test('a revision change during the model wait allows the newer revision to run the same occurrence', { skip: !connectionString, timeout: 15_000 }, async () => {
  const schema = await isolatedSchema(); const userId = `review-${randomUUID()}`; const due = dueAfterNow();
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let current = new Date(due.getTime() - 60_000); let calls = 0; let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async decide() { calls++; if (calls === 1) { start(); await gate; } return proposal; } };
  const pool = poolFor(schema); const store = new PostgresPlanningStore(pool); let app: ReturnType<typeof buildApp> | undefined;
  try {
    await store.migrate(); app = buildApp({ sessions, model, store, clock: () => current });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('one'), payload: scheduleBody(0, due) })).statusCode, 200);
    const old = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], current)[0];
    current = new Date(Date.parse(old.scheduledFor) + 1000);
    const pending = app.reviewRuntime.runScheduledReview(old); await started;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('two'), payload: scheduleBody(1, due) })).statusCode, 200);
    const fresh = buildReviewEvents((await app.reviewRuntime.listReviewSchedules())[0], new Date(old.scheduledFor))[0];
    assert.equal(fresh.idempotencyKey, old.idempotencyKey);
    release();
    assert.equal((await pending).status, 'skipped');
    const completed = await app.reviewRuntime.runScheduledReview(fresh);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(await app.reviewRuntime.runScheduledReview(fresh), completed);
    const state = await store.read(userId);
    assert.equal(state.proposals.size, 1); assert.equal(state.scheduleRevision, 0); assert.equal(calls, 2);
    assert.equal((state.reviewLedger.get(JSON.stringify(['skip', old.idempotencyKey, old.sourceRevision, 'stale'])) as { status: string }).status, 'skipped');
  } finally { release(); if (app) await app.close(); await pool.end(); }
});

test('a stale occurrence found at the claim guard does not reserve the key as completed', { skip: !connectionString, timeout: 15_000 }, async () => {
  let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  class GateClaimStore extends PostgresPlanningStore {
    gateNext = false;
    override async transaction<T>(userId: string, apply: (state: UserPlanningState) => T): Promise<T> {
      if (this.gateNext) { this.gateNext = false; start(); await gate; }
      return super.transaction(userId, apply);
    }
  }
  const schema = await isolatedSchema(); const userId = `review-${randomUUID()}`; const due = dueAfterNow();
  const sessions = { async resolve(token: string) { return token === 'test' ? { userId } : null; } };
  let current = new Date(due.getTime() - 60_000); let calls = 0;
  const pool = poolFor(schema); const gated = new GateClaimStore(pool); const second = new PostgresPlanningStore(pool);
  let app1: ReturnType<typeof buildApp> | undefined; let app2: ReturnType<typeof buildApp> | undefined;
  try {
    await gated.migrate(); const model: ModelPort = { async decide() { calls++; return proposal; } };
    app1 = buildApp({ sessions, model, store: gated, clock: () => current });
    app2 = buildApp({ sessions, model, store: second, clock: () => current });
    assert.equal((await app1.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('one'), payload: scheduleBody(0, due) })).statusCode, 200);
    const old = buildReviewEvents((await app1.reviewRuntime.listReviewSchedules())[0], current)[0];
    current = new Date(Date.parse(old.scheduledFor) + 1000);
    gated.gateNext = true;
    const pending = app1.reviewRuntime.runScheduledReview(old); await started;
    assert.equal((await app2.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('two'), payload: scheduleBody(1, due) })).statusCode, 200);
    const fresh = buildReviewEvents((await app2.reviewRuntime.listReviewSchedules())[0], new Date(old.scheduledFor))[0];
    release();
    assert.equal((await pending).status, 'skipped');
    assert.equal((await app2.reviewRuntime.runScheduledReview(fresh)).status, 'completed');
    assert.equal(calls, 1);
    assert.equal((await second.read(userId)).proposals.size, 1);
  } finally { release(); if (app1) await app1.close(); if (app2) await app2.close(); await pool.end(); }
});
