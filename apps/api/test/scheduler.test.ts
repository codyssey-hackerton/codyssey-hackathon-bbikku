import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSchedule } from '@pikku/domain';
import {
  buildReviewEvents, defaultReviewSchedule, startReviewScheduler,
  type ReviewBoss, type ReviewSchedulerRuntime, type TriggerEvent,
} from '../src/scheduler.ts';

type Entry = { userId: string; reviewSchedule: ReviewSchedule };

function entry(overrides: Partial<ReviewSchedule> = {}, userId = 'synthetic-user'): Entry {
  return {
    userId,
    reviewSchedule: {
      revision: 0,
      timezone: 'UTC',
      evening: { enabled: false, localTime: null },
      morning: { enabled: false, localTime: null },
      ...overrides,
    },
  };
}

const enabled = (localTime: string) => ({ enabled: true, localTime });
const byReason = (events: ReturnType<typeof buildReviewEvents>) =>
  Object.fromEntries(events.map(event => [event.reason, event]));

test('default review schedule is disabled with no implicit 21:00', () => {
  const schedule = defaultReviewSchedule('Asia/Seoul');
  assert.deepEqual(schedule, {
    revision: 0,
    timezone: 'Asia/Seoul',
    evening: { enabled: false, localTime: null },
    morning: { enabled: false, localTime: null },
  });
  assert.deepEqual(buildReviewEvents({ userId: 'synthetic-user', reviewSchedule: schedule }, new Date('2026-10-31T12:00:00.000Z')), []);
});

test('disabled reasons produce no event even when a valid time is retained', () => {
  const schedule = entry({
    evening: { enabled: false, localTime: '21:00' },
    morning: { enabled: false, localTime: '08:00' },
  });
  assert.deepEqual(buildReviewEvents(schedule, new Date('2026-10-31T10:00:00.000Z')), []);

  schedule.reviewSchedule.morning = enabled('08:00');
  const events = buildReviewEvents(schedule, new Date('2026-10-31T10:00:00.000Z'));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'morning_review');
  assert.equal(events[0].scheduledFor, '2026-11-01T08:00:00.000Z');
});

test('only the next occurrence is created when a schedule is enabled after its time', () => {
  const schedule = entry({ evening: enabled('10:00'), morning: enabled('10:15') });
  const now = new Date('2026-10-31T10:30:00.000Z');
  const events = buildReviewEvents(schedule, now);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map(event => [event.reason, event.scheduledFor]).sort(),
    [
      ['evening_plan', '2026-11-01T10:00:00.000Z'],
      ['morning_review', '2026-11-01T10:15:00.000Z'],
    ],
  );
  assert.ok(events.every(event => Date.parse(event.scheduledFor) >= now.getTime()));
});

test('an occurrence exactly at now is included, but one millisecond in the past is not', () => {
  const schedule = entry({ morning: enabled('10:00') });
  const atTime = buildReviewEvents(schedule, new Date('2026-10-31T10:00:00.000Z'));
  const afterTime = buildReviewEvents(schedule, new Date('2026-10-31T10:00:00.001Z'));
  const beforeTime = buildReviewEvents(schedule, new Date('2026-10-31T09:59:59.999Z'));
  assert.equal(atTime.length, 1);
  assert.equal(beforeTime.length, 1);
  assert.equal(afterTime.length, 1);
  assert.equal(atTime[0].scheduledFor, '2026-10-31T10:00:00.000Z');
  assert.equal(beforeTime[0].scheduledFor, '2026-10-31T10:00:00.000Z');
  assert.equal(afterTime[0].scheduledFor, '2026-11-01T10:00:00.000Z');
});

test('UTC midnight and year crossing use the scheduled local date for each reason', () => {
  const schedule = entry({ revision: 7, evening: enabled('23:45'), morning: enabled('00:00') });
  const events = buildReviewEvents(schedule, new Date('2026-12-31T23:30:00.000Z'));
  assert.equal(events.length, 2);
  const actual = byReason(events);
  assert.deepEqual(
    [actual.evening_plan.scheduledFor, actual.evening_plan.targetDate],
    ['2026-12-31T23:45:00.000Z', '2027-01-01'],
  );
  assert.deepEqual(
    [actual.morning_review.scheduledFor, actual.morning_review.targetDate],
    ['2027-01-01T00:00:00.000Z', '2027-01-01'],
  );
  for (const event of events) {
    assert.equal(event.userId, 'synthetic-user');
    assert.equal(event.timezone, 'UTC');
    assert.equal(event.sourceRevision, 7);
    assert.ok(typeof event.id === 'string' && event.id.length > 0);
    assert.ok(typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0);
  }
});

test('Seoul midnight crossing is based on local dates rather than UTC dates', () => {
  const schedule = entry({ timezone: 'Asia/Seoul', evening: enabled('23:59'), morning: enabled('00:05') });
  const events = buildReviewEvents(schedule, new Date('2026-12-31T14:59:00.000Z'));
  assert.equal(events.length, 2);
  const actual = byReason(events);
  assert.deepEqual(
    [actual.evening_plan.scheduledFor, actual.evening_plan.targetDate, actual.evening_plan.timezone],
    ['2026-12-31T14:59:00.000Z', '2027-01-01', 'Asia/Seoul'],
  );
  assert.deepEqual(
    [actual.morning_review.scheduledFor, actual.morning_review.targetDate, actual.morning_review.timezone],
    ['2026-12-31T15:05:00.000Z', '2027-01-01', 'Asia/Seoul'],
  );
});

test('identity is stable across repeated calculations and schedule revisions', () => {
  const now = new Date('2026-10-31T09:00:00.000Z');
  const first = entry({ revision: 1, morning: enabled('10:00') });
  const changed = entry({ revision: 2, morning: enabled('10:00') });
  const original = buildReviewEvents(first, now);
  const repeated = buildReviewEvents(first, new Date('2026-10-31T09:30:00.000Z'));
  const revised = buildReviewEvents(changed, now);
  assert.equal(original.length, 1);
  assert.equal(repeated.length, 1);
  assert.equal(revised.length, 1);
  assert.equal(original[0].scheduledFor, revised[0].scheduledFor);
  assert.equal(original[0].idempotencyKey, repeated[0].idempotencyKey);
  assert.equal(original[0].idempotencyKey, revised[0].idempotencyKey);
  assert.equal(original[0].id, repeated[0].id);
  assert.equal(original[0].id, revised[0].id);
  assert.equal(original[0].sourceRevision, 1);
  assert.equal(revised[0].sourceRevision, 2);
});

test('identity distinguishes user, reason and scheduled instant', () => {
  const now = new Date('2026-10-31T09:00:00.000Z');
  const both = buildReviewEvents(entry({ evening: enabled('10:00'), morning: enabled('10:00') }, 'user-a'), now);
  const otherUser = buildReviewEvents(entry({ morning: enabled('10:00') }, 'user-b'), now);
  const otherInstant = buildReviewEvents(entry({ morning: enabled('10:01') }, 'user-a'), now);
  assert.equal(both.length, 2);
  assert.equal(otherUser.length, 1);
  assert.equal(otherInstant.length, 1);
  const events = [...both, ...otherUser, ...otherInstant];
  assert.equal(new Set(events.map(event => event.idempotencyKey)).size, 4);
  assert.equal(new Set(events.map(event => event.id)).size, 4);
});

test('the same user, reason and instant retain identity when timezone changes', () => {
  const now = new Date('2026-10-31T09:00:00.000Z');
  const utc = buildReviewEvents(entry({ morning: enabled('10:00') }), now);
  const seoul = buildReviewEvents(entry({ timezone: 'Asia/Seoul', morning: enabled('19:00') }), now);
  assert.equal(utc.length, 1);
  assert.equal(seoul.length, 1);
  assert.equal(utc[0].scheduledFor, '2026-10-31T10:00:00.000Z');
  assert.equal(seoul[0].scheduledFor, utc[0].scheduledFor);
  assert.equal(seoul[0].idempotencyKey, utc[0].idempotencyKey);
  assert.equal(seoul[0].id, utc[0].id);
});

test('fall-back duplicated wall time occurs only at its earlier instant', () => {
  const schedule = entry({ timezone: 'America/New_York', morning: enabled('01:30') });
  const before = buildReviewEvents(schedule, new Date('2026-10-31T06:00:00.000Z'));
  const exactlyEarlier = buildReviewEvents(schedule, new Date('2026-11-01T05:30:00.000Z'));
  const betweenDuplicates = buildReviewEvents(schedule, new Date('2026-11-01T06:15:00.000Z'));
  assert.equal(before.length, 1);
  assert.equal(exactlyEarlier.length, 1);
  assert.equal(betweenDuplicates.length, 1);
  assert.deepEqual([before[0].scheduledFor, before[0].targetDate], ['2026-11-01T05:30:00.000Z', '2026-11-01']);
  assert.equal(exactlyEarlier[0].scheduledFor, '2026-11-01T05:30:00.000Z');
  assert.deepEqual([betweenDuplicates[0].scheduledFor, betweenDuplicates[0].targetDate], ['2026-11-02T06:30:00.000Z', '2026-11-02']);
});

test('spring-forward missing wall time is skipped rather than shifted', () => {
  const schedule = entry({ timezone: 'America/New_York', morning: enabled('02:30') });
  for (const now of ['2026-03-07T08:00:00.000Z', '2026-03-08T06:30:00.000Z']) {
    const events = buildReviewEvents(schedule, new Date(now));
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].scheduledFor, events[0].targetDate], ['2026-03-09T06:30:00.000Z', '2026-03-09']);
  }
});

test('malformed local times and missing enabled times are rejected', () => {
  for (const localTime of ['', '9:00', '24:00', '12:60', '12:00:00', null]) {
    for (const reason of ['evening', 'morning'] as const) {
      const schedule = entry({ [reason]: { enabled: true, localTime } });
      assert.throws(() => buildReviewEvents(schedule, new Date('2026-10-31T09:00:00.000Z')), `${reason}: ${String(localTime)}`);
    }
  }
  const disabledInvalid = entry({ evening: { enabled: false, localTime: '25:00' } });
  assert.throws(() => buildReviewEvents(disabledInvalid, new Date('2026-10-31T09:00:00.000Z')));
});

test('invalid timezone, revision and current date are rejected', () => {
  const now = new Date('2026-10-31T09:00:00.000Z');
  for (const revision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildReviewEvents(entry({ revision, morning: enabled('10:00') }), now), `revision: ${revision}`);
  }
  assert.throws(() => buildReviewEvents(entry({ timezone: 'Not/A_Real_Time_Zone', morning: enabled('10:00') }), now));
  assert.throws(() => buildReviewEvents(entry({ morning: enabled('10:00') }), new Date(Number.NaN)));
});

type EnqueueJob = Parameters<ReviewBoss['insert']>[1][number];
type EnqueueOptions = Omit<EnqueueJob, 'id' | 'data'>;
type WorkHandler = Parameters<ReviewBoss['work']>[2];

// Records synthetic submissions and invokes the registered handler without a database.
class FakeBoss implements ReviewBoss {
  readonly jobs: Array<{ id: string; name: string; data: TriggerEvent; options: EnqueueOptions }> = [];
  private handler: WorkHandler | undefined;
  stopped = false;

  async start() {}
  async stop() { this.stopped = true; }
  on(_event: 'error', _listener: (error: Error) => void) { return this; }
  async createQueue(_name: string) {}
  async findJobs(name: string, options: { key: string; limit: 1 }) {
    return this.jobs.filter(job => job.name === name && job.options.singletonKey === options.key).slice(0, options.limit);
  }
  async insert(name: string, jobs: EnqueueJob[]) {
    for (const { id, data, ...options } of jobs) {
      if (!this.jobs.some(job => job.id === id)) this.jobs.push({ id, name, data: structuredClone(data) as TriggerEvent, options: structuredClone(options) });
    }
  }
  async work(_name: string, _options: { batchSize: 1 }, handler: WorkHandler) {
    this.handler = handler;
  }
  async deliver(data: unknown) {
    assert.ok(this.handler, 'worker was not registered');
    return this.handler([{ data: structuredClone(data) }]);
  }
}

test('initial and changed reconciliation enqueue future occurrences only', async t => {
  let current = new Date('2026-10-31T10:30:00.000Z');
  let currentEntry = entry({ revision: 1, morning: enabled('10:00') });
  const boss = new FakeBoss();
  const runtime: ReviewSchedulerRuntime = {
    async listReviewSchedules() { return [currentEntry]; },
    async runScheduledReview() { assert.fail('reconciliation must not execute a review'); },
  };
  const scheduler = await startReviewScheduler({
    connectionString: 'postgresql://synthetic.invalid/scheduler', boss, runtime, now: () => current,
  });
  t.after(() => scheduler.stop());

  assert.equal(boss.jobs.length, 1);
  const first = boss.jobs[0];
  assert.equal(first.data.scheduledFor, '2026-11-01T10:00:00.000Z');
  assert.equal(first.options.startAfter.toISOString(), first.data.scheduledFor);
  assert.ok(first.options.startAfter.getTime() >= current.getTime());

  current = new Date('2026-10-31T10:31:00.000Z');
  currentEntry = entry({ revision: 2, morning: enabled('10:00') });
  await scheduler.reconcile();
  assert.equal(boss.jobs.length, 2);
  const revised = boss.jobs[1];
  assert.equal(revised.data.scheduledFor, first.data.scheduledFor);
  assert.equal(revised.data.idempotencyKey, first.data.idempotencyKey);
  assert.equal(revised.data.sourceRevision, 2);
  assert.ok(revised.options.startAfter.getTime() >= current.getTime());

  currentEntry = entry({ revision: 3, morning: enabled('10:15') });
  await scheduler.reconcile();
  assert.equal(boss.jobs.length, 3);
  const changed = boss.jobs[2];
  assert.equal(changed.data.scheduledFor, '2026-11-01T10:15:00.000Z');
  assert.equal(changed.options.startAfter.toISOString(), changed.data.scheduledFor);
  assert.ok(changed.options.startAfter.getTime() >= current.getTime());
});

test('worker runs queued reviews only from their due time through 60 minutes late', async () => {
  const delays = [
    { ms: -1, status: 'not_run', calls: 0 },
    { ms: 0, status: 'completed', calls: 1 },
    { ms: 59 * 60_000 + 59_999, status: 'completed', calls: 1 },
    { ms: 60 * 60_000, status: 'completed', calls: 1 },
    { ms: 60 * 60_000 + 1, status: 'skipped', calls: 0 },
  ] as const;

  for (const scenario of delays) {
    let current = new Date('2026-10-31T09:00:00.000Z');
    const schedule = entry({ revision: 4, morning: enabled('10:00') });
    const boss = new FakeBoss();
    const executed: TriggerEvent[] = [];
    const runtime: ReviewSchedulerRuntime = {
      async listReviewSchedules() { return [schedule]; },
      async runScheduledReview(event) { executed.push(event); return { status: 'completed' }; },
    };
    const scheduler = await startReviewScheduler({
      connectionString: 'postgresql://synthetic.invalid/scheduler', boss, runtime, now: () => current,
    });
    try {
      assert.equal(boss.jobs.length, 1);
      const queued = boss.jobs[0].data;
      assert.equal(queued.scheduledFor, '2026-10-31T10:00:00.000Z');
      current = new Date(Date.parse(queued.scheduledFor) + scenario.ms);
      if (scenario.status === 'not_run') {
        const result = await boss.deliver(queued).then(value => value.status, () => 'rejected');
        assert.ok(result === 'skipped' || result === 'rejected', `delay: ${scenario.ms}ms`);
      } else {
        const result = await boss.deliver(queued);
        assert.equal(result.status, scenario.status, `delay: ${scenario.ms}ms`);
        if (scenario.status === 'skipped') assert.equal(result.reason, 'late');
      }
      assert.equal(executed.length, scenario.calls, `delay: ${scenario.ms}ms`);
      if (scenario.calls) assert.deepEqual(executed[0], queued);
      assert.equal(boss.jobs.length, 2);
      assert.equal(boss.jobs[1].data.scheduledFor, '2026-11-01T10:00:00.000Z');
      assert.ok(boss.jobs.slice(1).every(job => job.options.startAfter.getTime() >= current.getTime()));
    } finally {
      await scheduler.stop();
    }
    assert.equal(boss.stopped, true);
  }
});
