import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { buildReviewEvents, defaultReviewSchedule, startReviewScheduler } from '../src/scheduler.ts';
import type { ReviewBoss, ReviewScheduler, ReviewSchedulerRuntime, TriggerEvent } from '../src/scheduler.ts';

const url = process.env.PIKKU_TEST_DATABASE_URL;
const queue = 'pikku-review-v1';

function entryAt(due: Date) {
  const localTime = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
  return {
    userId: randomUUID(),
    reviewSchedule: { ...defaultReviewSchedule('UTC'), revision: 1, morning: { enabled: true, localTime } },
    updatedAt: new Date(due.getTime() - 60_000).toISOString(),
  };
}

test('PostgreSQL restart preserves a legacy retry and does not run it early', { skip: !url, timeout: 30_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_restart_${randomUUID().replaceAll('-', '')}`;
  const due = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const entry = entryAt(due);
  const event = buildReviewEvents(entry, due)[0]!;
  const controlEntry = entryAt(due);
  const controlEvent = buildReviewEvents(controlEntry, due)[0]!;
  const singletonKey = `${event.idempotencyKey}:${event.sourceRevision}`;
  const legacyId = randomUUID();
  const future = new Date(Date.now() + 5 * 60_000);
  const before = new PgBoss({ connectionString: url, schema });
  before.on('error', () => {});
  await before.start();
  try {
    await before.createQueue(queue);
    // The old scheduler used a random pg-boss id together with a singleton key.
    assert.equal(await before.send(queue, event, { id: legacyId, singletonKey, retryLimit: 5, retryDelay: 300 }), legacyId);
    const claimed = await before.fetch<TriggerEvent>(queue);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.id, legacyId);
    await before.fail(queue, claimed[0]!, { message: 'synthetic previous failure' });
    const updated = await before.update(queue, undefined, { id: legacyId, startAfter: future });
    assert.equal(updated.updated, 1);
    const jobs = await before.findJobs<TriggerEvent>(queue, { data: { id: event.id, sourceRevision: event.sourceRevision } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, 'retry');
    assert.equal(jobs[0]!.singletonKey, singletonKey);
    assert.equal(jobs[0]!.startAfter.getTime(), future.getTime());
  } finally {
    await before.stop();
  }

  const runs: TriggerEvent[] = [];
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [entry, controlEntry]; },
    async runScheduledReview(job) { runs.push(job); return { status: 'completed' }; },
  };
  const after = new PgBoss({ connectionString: url, schema });
  const scheduler = await startReviewScheduler({
    connectionString: url, runtime, boss: after, now: () => new Date(due.getTime() + 60_000),
  });
  try {
    // A second eligible occurrence proves that startup catch-up actually ran.
    const deadline = Date.now() + 10_000;
    while (!runs.some(job => job.id === controlEvent.id) && Date.now() < deadline) await delay(100);
    assert.ok(runs.some(job => job.id === controlEvent.id), 'startup catch-up must run the control occurrence');
    // Also allow another normal polling interval to catch an early retry.
    await delay(2_500);
    const jobs = await after.findJobs<TriggerEvent>(queue, { data: { id: event.id, sourceRevision: event.sourceRevision } });
    assert.deepEqual({
      count: jobs.length,
      id: jobs[0]?.id,
      state: jobs[0]?.state,
      singletonKey: jobs[0]?.singletonKey,
      startAfter: jobs[0]?.startAfter.getTime(),
      runs: runs.filter(job => job.id === event.id).length,
      controlRuns: runs.filter(job => job.id === controlEvent.id).length,
    }, {
      count: 1,
      id: legacyId,
      state: 'retry',
      singletonKey,
      startAfter: future.getTime(),
      runs: 0,
      controlRuns: 1,
    });
  } finally {
    await scheduler.stop();
  }
});

test('PostgreSQL concurrent schedulers enqueue one job for an occurrence revision', { skip: !url, timeout: 30_000 }, async () => {
  assert.ok(url);
  const schema = `pikku_sched_race_${randomUUID().replaceAll('-', '')}`;
  const due = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 10 * 60_000);
  const entry = entryAt(due);
  const event = buildReviewEvents(entry, new Date(due.getTime() - 60_000))[0]!;
  const setup = new PgBoss({ connectionString: url, schema });
  setup.on('error', () => {});
  await setup.start();
  try {
    await setup.createQueue(queue);
  } finally {
    await setup.stop();
  }

  let arrived = 0;
  let release!: () => void;
  const bothReady = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() {
      if (++arrived === 2) release();
      await Promise.race([
        bothReady,
        delay(5_000, undefined, { ref: false }).then(() => { throw new Error('Second scheduler did not arrive'); }),
      ]);
      return [entry];
    },
    async runScheduledReview() { runs++; return { status: 'completed' }; },
  };
  const bosses = [new PgBoss({ connectionString: url, schema }), new PgBoss({ connectionString: url, schema })];
  const singletonKey = `${event.idempotencyKey}:${event.sourceRevision}`;
  let lookups = 0;
  let releaseLookups!: () => void;
  const bothLooked = new Promise<void>(resolve => { releaseLookups = resolve; });
  const gateLookup = (boss: PgBoss): ReviewBoss => new Proxy(boss, {
    get(target, property) {
      if (property === 'findJobs') return async (name: string, options: { key: string; limit: 1 }) => {
        const found = await target.findJobs(name, options);
        if (options.key === singletonKey) {
          assert.equal(found.length, 0, 'both instances must see an empty queue before insertion');
          if (++lookups === 2) releaseLookups();
          await Promise.race([
            bothLooked,
            delay(5_000, undefined, { ref: false }).then(() => { throw new Error('Second queue lookup did not arrive'); }),
          ]);
        }
        return found;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const schedulers: ReviewScheduler[] = [];
  try {
    const results = await Promise.allSettled(bosses.map(boss => startReviewScheduler({
      connectionString: url, runtime, boss: gateLookup(boss), now: () => new Date(due.getTime() - 60_000),
    }).then(scheduler => { schedulers.push(scheduler); return scheduler; })));
    assert.ok(results.every(result => result.status === 'fulfilled'), 'both schedulers must start');
    assert.equal(arrived, 2);
    assert.equal(lookups, 2);
    const jobs = await bosses[0]!.findJobs<TriggerEvent>(queue, { data: { id: event.id, sourceRevision: event.sourceRevision } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, 'created');
    assert.equal(jobs[0]!.data.scheduledFor, due.toISOString());
    assert.equal(jobs[0]!.startAfter.getTime(), due.getTime());
    assert.equal(runs, 0);
  } finally {
    await Promise.all(schedulers.map(scheduler => scheduler.stop()));
  }
});
