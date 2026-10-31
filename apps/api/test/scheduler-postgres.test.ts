import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { buildReviewEvents, defaultReviewSchedule, startReviewScheduler } from '../src/scheduler.ts';
import type { ReviewSchedulerRuntime, TriggerEvent } from '../src/scheduler.ts';

const url = process.env.PIKKU_TEST_DATABASE_URL;
const queue = 'pikku-review-v1';

async function eventually<T>(check: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for the pg-boss job');
}

test('PostgreSQL queue persists work, re-delivers the same identity, and records late skips', { skip: !url, timeout: 45_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_sched_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const boss = new PgBoss({ connectionString: url, schema });
  const actual = new Date();
  const scheduledAt = new Date(Math.floor(actual.getTime() / 60_000) * 60_000);
  const hhmm = `${String(scheduledAt.getUTCHours()).padStart(2, '0')}:${String(scheduledAt.getUTCMinutes()).padStart(2, '0')}`;
  const reviewSchedule = { ...defaultReviewSchedule('UTC'), revision: 1, morning: { enabled: true, localTime: hhmm } };
  const owner = randomUUID();
  const entry = { userId: owner, reviewSchedule };
  let clock = scheduledAt;
  const seen = new Set<string>();
  let calls = 0;
  let agentRuns = 0;
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [entry]; },
    async runScheduledReview(event) {
      calls++;
      if (seen.has(event.idempotencyKey)) return { status: 'skipped' };
      seen.add(event.idempotencyKey);
      agentRuns++;
      return { status: 'completed' };
    },
  };
  const scheduler = await startReviewScheduler({ connectionString: url, runtime, boss, now: () => clock });
  try {
    const event = buildReviewEvents(entry, scheduledAt)[0]!;
    const first = await eventually(async () => {
      const jobs = await boss.findJobs<TriggerEvent>(queue, { data: { id: event.id } });
      return jobs.find(job => job.state === 'completed');
    });
    assert.equal(first.data.idempotencyKey, event.idempotencyKey);
    assert.deepEqual(first.output, { status: 'completed' });
    assert.equal(agentRuns, 1);

    await boss.upsert(queue, event, {
      singletonKey: `${event.idempotencyKey}:${event.sourceRevision}`,
      startAfter: new Date(0), retryLimit: 1, retryDelay: 1, retryBackoff: false,
    });
    await eventually(async () => calls >= 2 ? true : undefined);
    assert.equal(agentRuns, 1, 'runtime durable-claim boundary suppresses a duplicate');

    // A separately queued past event is retained but must not invoke the Agent.
    clock = new Date(scheduledAt.getTime() + 60 * 60 * 1000 + 1);
    const lateOwner = randomUUID();
    const lateEntry = { userId: lateOwner, reviewSchedule };
    const lateEvent = buildReviewEvents(lateEntry, scheduledAt)[0]!;
    const originalList = runtime.listReviewSchedules;
    runtime.listReviewSchedules = async () => [...await originalList(), lateEntry];
    await boss.upsert(queue, lateEvent, {
      singletonKey: `${lateEvent.idempotencyKey}:${lateEvent.sourceRevision}`,
      startAfter: new Date(0), retryLimit: 1, retryDelay: 1, retryBackoff: false,
    });
    const late = await eventually(async () => {
      const jobs = await boss.findJobs<TriggerEvent>(queue, { data: { id: lateEvent.id } });
      return jobs.find(job => job.state === 'completed');
    });
    assert.deepEqual(late.output, { status: 'skipped', reason: 'late' });
    assert.equal(agentRuns, 1);
  } finally {
    await scheduler.stop();
  }
});

test('PostgreSQL reconciliation recovers a committed setting that became due between polls', { skip: !url, timeout: 30_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_sched_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const boss = new PgBoss({ connectionString: url, schema });
  const actual = new Date();
  const due = new Date(Math.floor(actual.getTime() / 60_000) * 60_000);
  const hhmm = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
  const userId = randomUUID();
  let entries = [{ userId, reviewSchedule: defaultReviewSchedule('UTC'), updatedAt: new Date(due.getTime() - 60_000).toISOString() }];
  const received: TriggerEvent[] = [];
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return entries; },
    async runScheduledReview(event) { received.push(event); return { status: 'completed' }; },
  };
  const scheduler = await startReviewScheduler({ connectionString: url, runtime, boss, now: () => new Date(due.getTime() + 10_000) });
  try {
    entries = [{ userId, reviewSchedule: { ...defaultReviewSchedule('UTC'), revision: 1, morning: { enabled: true, localTime: hhmm } },
      updatedAt: new Date(due.getTime() - 10_000).toISOString() }];
    await scheduler.reconcile();
    await eventually(async () => received.length ? true : undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.scheduledFor, due.toISOString());
    assert.equal(received[0]!.sourceRevision, 1);
  } finally {
    await scheduler.stop();
  }
});

test('PostgreSQL retries a failed review with the original occurrence identity', { skip: !url, timeout: 30_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_sched_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const boss = new PgBoss({ connectionString: url, schema });
  const now = new Date();
  const due = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const hhmm = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
  const entry = { userId: randomUUID(), reviewSchedule: { ...defaultReviewSchedule('UTC'), revision: 1, morning: { enabled: true, localTime: hhmm } } };
  const received: TriggerEvent[] = [];
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [entry]; },
    async runScheduledReview(event) { received.push(event); return { status: received.length === 1 ? 'failed' : 'completed' }; },
  };
  const scheduler = await startReviewScheduler({ connectionString: url, runtime, boss, now: () => due });
  try {
    const event = buildReviewEvents(entry, due)[0]!;
    const retry = await eventually(async () => {
      const jobs = await boss.findJobs<TriggerEvent>(queue, { data: { id: event.id } });
      return jobs.find(job => job.state === 'retry');
    });
    assert.equal(retry.data.idempotencyKey, event.idempotencyKey);
    // Move only this isolated test job forward instead of waiting for retry backoff.
    await boss.update(queue, undefined, { id: retry.id, startAfter: new Date(0) });
    await eventually(async () => received.length >= 2 ? true : undefined);
    assert.deepEqual(received[0], received[1]);
  } finally {
    await scheduler.stop();
  }
});

test('PostgreSQL retries failed stale-audit storage without blocking the newer revision', { skip: !url, timeout: 30_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_sched_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const boss = new PgBoss({ connectionString: url, schema });
  const now = new Date();
  const due = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const hhmm = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
  const setting = { ...defaultReviewSchedule('UTC'), revision: 2, morning: { enabled: true, localTime: hhmm } };
  const entry = { userId: randomUUID(), reviewSchedule: setting };
  const audits: Array<{ revision: number | undefined; reason: string }> = [];
  const received: TriggerEvent[] = [];
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [entry]; },
    async runScheduledReview(event) { received.push(event); return { status: 'completed' }; },
    async recordSkipped(event, reason) {
      audits.push({ revision: event.sourceRevision, reason });
      if (audits.length === 1) throw new Error('synthetic audit storage outage');
    },
  };
  const scheduler = await startReviewScheduler({ connectionString: url, runtime, boss, now: () => new Date(due.getTime() + 60_000) });
  try {
    const old = buildReviewEvents({ ...entry, reviewSchedule: { ...setting, revision: 1 } }, due)[0]!;
    const current = buildReviewEvents(entry, due)[0]!;
    assert.equal(old.idempotencyKey, current.idempotencyKey);
    await boss.upsert(queue, old, { singletonKey: `${old.idempotencyKey}:${old.sourceRevision}`, startAfter: new Date(0), retryLimit: 2, retryDelay: 1, retryBackoff: false });
    const retry = await eventually(async () => {
      const jobs = await boss.findJobs<TriggerEvent>(queue, { data: { id: old.id, sourceRevision: 1 } });
      return jobs.find(job => job.state === 'retry');
    });
    await boss.update(queue, undefined, { id: retry.id, startAfter: new Date(0) });
    const stale = await eventually(async () => {
      const jobs = await boss.findJobs<TriggerEvent>(queue, { data: { id: old.id, sourceRevision: 1 } });
      return jobs.find(job => job.state === 'completed');
    });
    assert.deepEqual(stale.output, { status: 'skipped', reason: 'stale' });
    assert.deepEqual(audits, [{ revision: 1, reason: 'stale' }, { revision: 1, reason: 'stale' }]);
    await boss.upsert(queue, current, { singletonKey: `${current.idempotencyKey}:${current.sourceRevision}`, startAfter: new Date(0), retryLimit: 1, retryDelay: 1, retryBackoff: false });
    await eventually(async () => received.length ? true : undefined);
    assert.equal(received[0]!.sourceRevision, 2);
    assert.equal(received[0]!.idempotencyKey, old.idempotencyKey);
  } finally { await scheduler.stop(); }
});
