import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.ts';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { buildReviewEvents, defaultReviewSchedule, startReviewScheduler } from '../src/scheduler.ts';
import type { ReviewBoss, ReviewSchedule, ReviewSchedulerRuntime, TriggerEvent } from '../src/scheduler.ts';

type EnqueueJob = Parameters<ReviewBoss['insert']>[1][number];
type JobOptions = Omit<EnqueueJob, 'id' | 'data'>;

class FakeBoss implements ReviewBoss {
  readonly jobs = new Map<string, { event: TriggerEvent; options: JobOptions }>();
  readonly ids = new Set<string>();
  readonly writes: string[] = [];
  handler?: (jobs: Array<{ data: unknown }>) => Promise<{ status: 'completed' | 'skipped'; reason?: 'late' | 'stale' | 'invalid' }>;
  errorListener?: (error: Error) => void;
  started = false;
  stopped = false;
  async start() { this.started = true; }
  async stop() { this.stopped = true; }
  on(_event: 'error', listener: (error: Error) => void) { this.errorListener = listener; return this; }
  async createQueue(_name: string) {}
  async findJobs(_name: string, options: { key: string; limit: 1 }) {
    const job = this.jobs.get(options.key);
    return job ? [job] : [];
  }
  async insert(_name: string, jobs: EnqueueJob[]) {
    for (const { id, data, ...options } of jobs) {
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      this.writes.push(options.singletonKey);
      this.jobs.set(options.singletonKey, { event: structuredClone(data) as TriggerEvent, options });
    }
  }
  async work(_name: string, _options: { batchSize: 1 }, handler: NonNullable<FakeBoss['handler']>) { this.handler = handler; }
  async deliver(data: unknown) { assert.ok(this.handler); return this.handler([{ data }]); }
}

function enabled(revision = 1): ReviewSchedule {
  return { ...defaultReviewSchedule('UTC'), revision, morning: { enabled: true, localTime: '09:00' } };
}

function setup(schedule = enabled(), initialTime = '2026-11-01T08:00:00.000Z') {
  const boss = new FakeBoss();
  let now = new Date(initialTime);
  let settings = schedule;
  const calls: TriggerEvent[] = [];
  let behavior: ReviewSchedulerRuntime['runScheduledReview'] = async event => { calls.push(event); return { status: 'completed' }; };
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [{ userId: 'user-1', reviewSchedule: settings }]; },
    async runScheduledReview(event) { return behavior(event); },
  };
  return {
    boss, runtime, calls,
    clock: () => now,
    setTime(value: string) { now = new Date(value); },
    setSchedule(value: ReviewSchedule) { settings = value; },
    setBehavior(value: ReviewSchedulerRuntime['runScheduledReview']) { behavior = value; },
    async start() { return startReviewScheduler({ connectionString: 'postgres://fixture', runtime, boss, now: () => now }); },
    firstEvent() { const job = [...boss.jobs.values()][0]; assert.ok(job); return job.event; },
  };
}

test('starts disabled, then reconciles only the next occurrence after enabling', async () => {
  const env = setup(defaultReviewSchedule('UTC'), '2026-11-01T09:30:00.000Z');
  const scheduler = await env.start();
  assert.equal(env.boss.jobs.size, 0);
  env.setSchedule(enabled());
  await scheduler.reconcile();
  const event = env.firstEvent();
  assert.equal(event.scheduledFor, '2026-11-02T09:00:00.000Z');
  assert.equal(event.targetDate, '2026-11-02');
  assert.equal(event.sourceRevision, 1);
  await scheduler.stop();
  assert.equal(env.boss.stopped, true);
});

test('runs at the 60 minute boundary but skips a job delayed beyond it', async () => {
  const env = setup();
  const scheduler = await env.start();
  const event = env.firstEvent();
  env.setTime('2026-11-01T10:00:00.000Z');
  assert.deepEqual(await env.boss.deliver(event), { status: 'completed' });
  assert.equal(env.calls.length, 1);
  env.setTime('2026-11-01T10:00:00.001Z');
  assert.deepEqual(await env.boss.deliver(event), { status: 'skipped', reason: 'late' });
  assert.equal(env.calls.length, 1);
  await scheduler.stop();
});

test('a disabled or revised setting makes queued work stale before Agent invocation', async () => {
  const env = setup();
  const scheduler = await env.start();
  const event = env.firstEvent();
  env.setTime('2026-11-01T09:00:00.000Z');
  env.setSchedule({ ...enabled(2), morning: { enabled: false, localTime: null } });
  assert.deepEqual(await env.boss.deliver(event), { status: 'skipped', reason: 'stale' });
  assert.equal(env.calls.length, 0);
  await scheduler.stop();
});

test('stale skip audit does not consume a newer revision of the same occurrence', async () => {
  const env = setup();
  const audits: Array<{ event: TriggerEvent; reason: 'late' | 'stale' }> = [];
  env.runtime.recordSkipped = async (event, reason) => { audits.push({ event: structuredClone(event), reason }); };
  const scheduler = await env.start();
  try {
    const old = env.firstEvent();
    env.setSchedule(enabled(2));
    await scheduler.reconcile();
    const current = [...env.boss.jobs.values()].find(job => job.event.sourceRevision === 2)?.event;
    assert.ok(current);
    assert.equal(old.idempotencyKey, current.idempotencyKey);
    env.setTime('2026-11-01T09:00:00.000Z');
    assert.deepEqual(await env.boss.deliver(old), { status: 'skipped', reason: 'stale' });
    assert.equal(audits[0]?.event.sourceRevision, 1);
    assert.equal(audits[0]?.reason, 'stale');
    assert.deepEqual(await env.boss.deliver(current), { status: 'completed' });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0]?.sourceRevision, 2);
    assert.deepEqual(await env.boss.deliver(old), { status: 'skipped', reason: 'stale' });
    assert.equal(env.calls.length, 1, 'a later stale audit must not change the completed result');
  } finally { await scheduler.stop(); }
});

test('skip audit failure throws a sanitized error for retry with the same event', async () => {
  const env = setup();
  const received: Array<{ event: TriggerEvent; reason: 'late' | 'stale' }> = [];
  env.runtime.recordSkipped = async (event, reason) => {
    received.push({ event: structuredClone(event), reason });
    if (received.length === 1) throw new Error('sensitive DB details');
  };
  const scheduler = await env.start();
  try {
    const event = env.firstEvent();
    env.setTime('2026-11-01T10:00:00.001Z');
    await assert.rejects(env.boss.deliver(event), /^Error: Review skip recording failed$/);
    assert.deepEqual(await env.boss.deliver(event), { status: 'skipped', reason: 'late' });
    assert.deepEqual(received[0], received[1]);
    assert.equal(env.calls.length, 0);
  } finally { await scheduler.stop(); }
});

test('failed runtime outcomes throw for retry with the unchanged event identity', async () => {
  const env = setup();
  const received: TriggerEvent[] = [];
  env.setBehavior(async event => { received.push(structuredClone(event)); return { status: received.length === 1 ? 'failed' : 'completed' }; });
  const scheduler = await env.start();
  const event = env.firstEvent();
  env.setTime('2026-11-01T09:00:00.000Z');
  await assert.rejects(env.boss.deliver(event), /Scheduled review failed/);
  assert.deepEqual(await env.boss.deliver(event), { status: 'completed' });
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
  await scheduler.stop();
});

test('restart preserves a legacy retry delay while a new revision can still be scheduled', async () => {
  const boss = new FakeBoss();
  const due = new Date('2026-11-01T09:00:00.000Z');
  const backoff = new Date('2026-11-01T09:05:00.000Z');
  let schedule = enabled(1);
  const old = buildReviewEvents({ userId: 'user-1', reviewSchedule: schedule }, due)[0]!;
  const oldKey = `${old.idempotencyKey}:${old.sourceRevision}`;
  boss.jobs.set(oldKey, { event: old, options: { singletonKey: oldKey, startAfter: backoff, retryLimit: 5, retryDelay: 30, retryBackoff: true } });
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [{ userId: 'user-1', reviewSchedule: schedule, updatedAt: '2026-11-01T08:59:00.000Z' }]; },
    async runScheduledReview() { assert.fail('reconciliation must not run the Agent'); },
  };
  const options = { connectionString: 'postgres://fixture', runtime, boss, now: () => new Date('2026-11-01T09:01:00.000Z') };
  const first = await startReviewScheduler(options);
  assert.equal(boss.jobs.get(oldKey)?.options.startAfter.toISOString(), backoff.toISOString());
  assert.equal(boss.writes.includes(oldKey), false);
  await first.stop();
  const second = await startReviewScheduler(options);
  try {
    assert.equal(boss.jobs.get(oldKey)?.options.startAfter.toISOString(), backoff.toISOString());
    assert.equal(boss.writes.includes(oldKey), false);
    schedule = enabled(2);
    await second.reconcile();
    const current = [...boss.jobs.values()].find(job => job.event.sourceRevision === 2 && job.event.scheduledFor === due.toISOString())?.event;
    assert.ok(current);
    assert.equal(current.idempotencyKey, old.idempotencyKey);
    assert.equal(boss.jobs.get(oldKey)?.options.startAfter.toISOString(), backoff.toISOString());
  } finally { await second.stop(); }
});

test('redelivery relies on the runtime durable claim, not queue uniqueness', async () => {
  const env = setup();
  const claimed = new Set<string>();
  let agentRuns = 0;
  env.setBehavior(async event => {
    if (claimed.has(event.idempotencyKey)) return { status: 'skipped' };
    claimed.add(event.idempotencyKey);
    agentRuns++;
    return { status: 'completed' };
  });
  const scheduler = await env.start();
  const event = env.firstEvent();
  env.setTime('2026-11-01T09:00:00.000Z');
  assert.deepEqual(await env.boss.deliver(event), { status: 'completed' });
  assert.deepEqual(await env.boss.deliver(event), { status: 'skipped' });
  assert.equal(agentRuns, 1);
  await scheduler.stop();
});

test('redelivery invokes the real review runtime once with an in-memory ledger', async () => {
  let now = new Date('2030-01-01T08:59:00.000Z');
  let modelCalls = 0;
  const store = new MemoryPlanningStore();
  const service = new PlanningService(store, () => now);
  const app = buildApp({ store, clock: () => now, sessions: { async resolve(token) { return token === 'user-1' ? { userId: token } : null; } }, model: { async decide() {
    modelCalls++; return { kind: 'answer', text: '일정을 확인했습니다.' };
  } } });
  const boss = new FakeBoss();
  await service.saveReviewSchedule('user-1', { expectedRevision: 0, timezone: 'UTC',
    morning: { enabled: true, localTime: '09:00' }, evening: { enabled: false, localTime: null } });
  const scheduler = await startReviewScheduler({ connectionString: 'postgres://fixture', boss, runtime: app.reviewRuntime, now: () => now });
  try {
    const event = [...boss.jobs.values()][0]!.event;
    now = new Date(event.scheduledFor);
    assert.deepEqual(await boss.deliver(event), { status: 'completed' });
    assert.deepEqual(await boss.deliver(event), { status: 'completed' });
    assert.equal(modelCalls, 1);
    assert.equal((await store.read('user-1')).reviewLedger.size, 1);
    const digest = await app.inject({ method: 'GET', url: '/v1/review-digests', headers: { authorization: 'Bearer user-1' } });
    assert.equal(digest.statusCode, 200);
    assert.equal(digest.json().data.digests[0].message, '일정을 확인했습니다.');
    assert.equal(digest.json().data.digests[0].reason, 'morning_review');
  } finally { await scheduler.stop(); await app.close(); }
});

test('empty database URL fails explicitly and a stopped scheduler cannot reconcile', async () => {
  const env = setup();
  await assert.rejects(startReviewScheduler({ connectionString: '', runtime: env.runtime, boss: env.boss }), /PIKKU_DATABASE_URL/);
  assert.equal(env.boss.started, false);
  const scheduler = await env.start();
  await scheduler.stop();
  await scheduler.stop();
  await assert.rejects(scheduler.reconcile(), /stopped/);
});

test('periodic reconciliation notices remote setting changes without calling the Agent', async () => {
  const env = setup(defaultReviewSchedule('UTC'));
  let tick: (() => void) | undefined;
  let cancelled = false;
  const errors: string[] = [];
  let failLookup = false;
  const originalList = env.runtime.listReviewSchedules;
  env.runtime.listReviewSchedules = async () => {
    if (failLookup) throw new Error('sensitive DB details');
    return originalList();
  };
  const scheduler = await startReviewScheduler({
    connectionString: 'postgres://fixture', runtime: env.runtime, boss: env.boss, now: env.clock,
    createInterval(callback, milliseconds) { assert.equal(milliseconds, 30_000); tick = callback; return () => { cancelled = true; }; },
    onError(error) { errors.push(error.message); },
  });
  assert.ok(tick);
  assert.equal(env.boss.jobs.size, 0);
  env.setSchedule(enabled());
  tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(env.boss.jobs.size, 1);
  assert.equal(env.calls.length, 0);

  failLookup = true;
  tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['Review schedule reconciliation failed']);
  env.boss.errorListener?.(new Error('sensitive queue details'));
  assert.deepEqual(errors, ['Review schedule reconciliation failed', 'Review scheduler queue error']);
  await scheduler.stop();
  assert.equal(cancelled, true);
  tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(errors.length, 2);
});

test('reconcile recovers only occurrences enabled before their time, once per process', async () => {
  for (const scenario of [
    { updatedAt: '2026-11-01T08:59:50.000Z', now: '2026-11-01T09:00:10.000Z', expected: 2 },
    { updatedAt: '2026-11-01T09:00:05.000Z', now: '2026-11-01T09:00:10.000Z', expected: 1 },
    { updatedAt: undefined, now: '2026-11-01T09:00:10.000Z', expected: 1 },
    { updatedAt: '2026-11-01T08:59:00.000Z', now: '2026-11-01T10:00:00.000Z', expected: 2 },
    { updatedAt: '2026-11-01T08:59:00.000Z', now: '2026-11-01T10:00:00.001Z', expected: 1 },
  ]) {
    const boss = new FakeBoss();
    let called = 0;
    const runtime: ReviewSchedulerRuntime = {
      async listReviewSchedules() { return [{ userId: 'u', reviewSchedule: enabled(), updatedAt: scenario.updatedAt }]; },
      async runScheduledReview() { called++; return { status: 'completed' }; },
    };
    const scheduler = await startReviewScheduler({ connectionString: 'postgres://fixture', runtime, boss, now: () => new Date(scenario.now) });
    try {
      assert.equal(boss.jobs.size, scenario.expected, JSON.stringify(scenario));
      assert.equal(called, 0);
      const dueKeys = [...boss.jobs.entries()].filter(([, job]) => job.event.scheduledFor === '2026-11-01T09:00:00.000Z').map(([key]) => key);
      await scheduler.reconcile();
      for (const key of dueKeys) assert.equal(boss.writes.filter(value => value === key).length, 1);
    } finally { await scheduler.stop(); }
  }
});

test('stop cancels the periodic timer and waits for an in-flight reconciliation', async () => {
  const env = setup();
  let tick: (() => void) | undefined;
  let cancelled = false;
  let release: (() => void) | undefined;
  let shouldBlock = false;
  const originalList = env.runtime.listReviewSchedules;
  env.runtime.listReviewSchedules = async () => {
    if (shouldBlock) await new Promise<void>(resolve => { release = resolve; });
    return originalList();
  };
  const scheduler = await startReviewScheduler({
    connectionString: 'postgres://fixture', runtime: env.runtime, boss: env.boss, now: env.clock,
    createInterval(callback) { tick = callback; return () => { cancelled = true; }; },
  });
  shouldBlock = true;
  assert.ok(tick);
  tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(release);
  const stopping = scheduler.stop();
  assert.equal(cancelled, true);
  assert.equal(env.boss.stopped, false);
  release();
  await stopping;
  assert.equal(env.boss.stopped, true);
});
