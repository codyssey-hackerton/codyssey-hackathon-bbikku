import { createHash } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { parseOffsetDateTime } from '@pikku/domain';
import type { AgentResult, ReviewSchedule } from '@pikku/domain';

export type { ReviewSchedule } from '@pikku/domain';

export interface TriggerEvent {
  id: string;
  userId: string;
  reason: 'evening_plan' | 'morning_review' | 'schedule_changed' | 'checkin_changed';
  scheduledFor: string;
  timezone: string;
  targetDate: string;
  idempotencyKey: string;
  sourceRevision?: number;
}

export interface ReviewSchedulerRuntime {
  /** updatedAt is the DB timestamp of this revision, never the lookup time. */
  listReviewSchedules(): Promise<Array<{ userId: string; reviewSchedule: ReviewSchedule; updatedAt?: string }>>;
  /** Must atomically check current settings and claim the durable idempotency key. */
  runScheduledReview(event: TriggerEvent): Promise<{ status: 'completed' | 'skipped' | 'failed'; result?: AgentResult }>;
  /** Store a revision-specific audit without consuming the occurrence's execution key. */
  recordSkipped?(event: TriggerEvent, reason: 'late' | 'stale'): Promise<void>;
}

type ScheduledReason = Extract<TriggerEvent['reason'], 'evening_plan' | 'morning_review'>;
type ScheduleEntry = { userId: string; reviewSchedule: ReviewSchedule; updatedAt?: string };
type ReviewJob = TriggerEvent & { reason: ScheduledReason; sourceRevision: number };
type WorkOutput = { status: 'completed' | 'skipped'; reason?: 'late' | 'stale' | 'invalid' };

/** Narrow pg-boss surface, injectable in tests; queue uniqueness is not the durable ledger. */
export interface ReviewBoss {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  createQueue(name: string): Promise<void>;
  findJobs(name: string, options: { key: string; limit: 1 }): Promise<unknown[]>;
  insert(name: string, jobs: Array<{
    id: string; data: object; singletonKey: string; startAfter: Date;
    retryLimit: number; retryDelay: number; retryBackoff: boolean;
  }>): Promise<unknown>;
  work(name: string, options: { batchSize: 1 }, handler: (jobs: Array<{ data: unknown }>) => Promise<WorkOutput>): Promise<unknown>;
}

export interface ReviewSchedulerOptions {
  connectionString: string;
  runtime: ReviewSchedulerRuntime;
  now?: () => Date;
  onError?: (error: Error) => void;
  reconcileIntervalMs?: number;
  /** Inject a timer in tests; returns a cancellation function. */
  createInterval?: (callback: () => void, milliseconds: number) => () => void;
  /** Test injection; production uses a new pg-boss instance for connectionString. */
  boss?: ReviewBoss;
}

export interface ReviewScheduler {
  /** Call after a review schedule is committed, so changes are scheduled promptly. */
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

const QUEUE = 'pikku-review-v1';
const MAX_DELAY_MS = 60 * 60 * 1000;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

type CivilDate = { year: number; month: number; day: number };
type CivilMinute = CivilDate & { hour: number; minute: number };

function formatter(timezone: string): Intl.DateTimeFormat {
  if (typeof timezone !== 'string' || !timezone.trim() || /^[+-]/.test(timezone)) throw new Error('Invalid timezone');
  let result = formatters.get(timezone);
  if (!result) {
    try {
      result = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      result.format(0);
    } catch {
      throw new Error('Invalid timezone');
    }
    formatters.set(timezone, result);
  }
  return result;
}

function civilParts(date: Date, timezone: string): CivilMinute {
  const fields = formatter(timezone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(fields.find(part => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

function utcMillis(date: CivilDate, hour = 0, minute = 0): number {
  const result = new Date(0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  result.setUTCHours(hour, minute, 0, 0);
  return result.getTime();
}

function addDays(date: CivilDate, days: number): CivilDate {
  const result = new Date(utcMillis(date) + days * 86_400_000);
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

function dateString(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

// Repeated DST wall times choose the earlier occurrence; nonexistent times are skipped.
function localInstant(date: CivilDate, hhmm: string, timezone: string): Date | null {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const nominal = utcMillis(date, hour, minute);
  const offsets = new Set<number>();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = nominal + hours * 3_600_000;
    const local = civilParts(new Date(sample), timezone);
    offsets.add(utcMillis(local, local.hour, local.minute) - sample);
  }
  const matches = [...offsets].map(offset => nominal - offset).filter(candidate => {
    const p = civilParts(new Date(candidate), timezone);
    return p.year === date.year && p.month === date.month && p.day === date.day && p.hour === hour && p.minute === minute;
  });
  return matches.length ? new Date(Math.min(...matches)) : null;
}

function validateSchedule(schedule: ReviewSchedule): void {
  if (!schedule || typeof schedule !== 'object' || !Number.isSafeInteger(schedule.revision) || schedule.revision < 0) {
    throw new Error('Invalid review schedule revision');
  }
  formatter(schedule.timezone);
  for (const setting of [schedule.evening, schedule.morning]) {
    if (!setting || typeof setting.enabled !== 'boolean' ||
      (setting.localTime !== null && (typeof setting.localTime !== 'string' || !HH_MM.test(setting.localTime))) ||
      (setting.enabled && setting.localTime === null)) throw new Error('Invalid review schedule time');
  }
}

export function defaultReviewSchedule(timezone: string): ReviewSchedule {
  formatter(timezone);
  return { revision: 0, timezone, evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } };
}

/** Returns the next eligible occurrence, without inventing retroactive activation. */
export function buildReviewEvents(entry: ScheduleEntry, now: Date): TriggerEvent[] {
  if (!entry || typeof entry.userId !== 'string' || !entry.userId.trim()) throw new Error('Invalid schedule owner');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid current time');
  const schedule = entry.reviewSchedule;
  validateSchedule(schedule);
  const current = civilParts(now, schedule.timezone);
  const events: ReviewJob[] = [];
  for (const [reason, setting] of [['evening_plan', schedule.evening], ['morning_review', schedule.morning]] as const) {
    if (!setting.enabled || setting.localTime === null) continue;
    for (let day = 0; day < 8; day++) {
      const localDate = addDays(current, day);
      const due = localInstant(localDate, setting.localTime, schedule.timezone);
      if (!due || due.getTime() < now.getTime()) continue;
      const scheduledFor = due.toISOString();
      const identity = createHash('sha256').update(JSON.stringify([entry.userId, reason, scheduledFor])).digest('hex');
      events.push({
        id: identity, userId: entry.userId, reason, scheduledFor, timezone: schedule.timezone,
        targetDate: dateString(reason === 'evening_plan' ? addDays(localDate, 1) : localDate),
        idempotencyKey: `scheduled:${identity}`, sourceRevision: schedule.revision,
      });
      break;
    }
  }
  return events;
}

// Only recover an occurrence that was already enabled when it came due.
// Old records without an authoritative modification time are not backfilled.
function missedReviewEvents(entry: ScheduleEntry, now: Date): TriggerEvent[] {
  if (entry.updatedAt === undefined) return [];
  const updated = parseOffsetDateTime(entry.updatedAt);
  if (updated === null) throw new Error('Invalid review schedule update time');
  const start = Math.max(now.getTime() - MAX_DELAY_MS, updated);
  if (start >= now.getTime()) return [];
  return buildReviewEvents(entry, new Date(start)).filter(event => Date.parse(event.scheduledFor) < now.getTime());
}

function currentTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid current time');
  return value;
}

function isReviewJob(value: unknown): value is ReviewJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<ReviewJob>;
  return typeof job.id === 'string' && typeof job.userId === 'string' && !!job.userId.trim() &&
    (job.reason === 'evening_plan' || job.reason === 'morning_review') &&
    typeof job.scheduledFor === 'string' && Number.isFinite(Date.parse(job.scheduledFor)) &&
    typeof job.timezone === 'string' && typeof job.targetDate === 'string' &&
    typeof job.idempotencyKey === 'string' && Number.isSafeInteger(job.sourceRevision) && job.sourceRevision! >= 0;
}

function sameOccurrence(a: TriggerEvent, b: TriggerEvent): boolean {
  return a.id === b.id && a.userId === b.userId && a.reason === b.reason && a.scheduledFor === b.scheduledFor &&
    a.timezone === b.timezone && a.targetDate === b.targetDate && a.idempotencyKey === b.idempotencyKey && a.sourceRevision === b.sourceRevision;
}

/**
 * Starts one owned pg-boss instance. The runtime owns authentication, durable
 * deduplication/claim, current-state atomic checks, and the actual Agent call.
 */
export async function startReviewScheduler(options: ReviewSchedulerOptions): Promise<ReviewScheduler> {
  if (!options || typeof options.connectionString !== 'string' || !options.connectionString.trim()) {
    throw new Error('PIKKU_DATABASE_URL is required for the enabled scheduler');
  }
  if (!options.runtime || typeof options.runtime.listReviewSchedules !== 'function' || typeof options.runtime.runScheduledReview !== 'function') {
    throw new Error('Review scheduler runtime is required');
  }
  const clock = options.now ?? (() => new Date());
  const intervalMs = options.reconcileIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error('Invalid review scheduler reconciliation interval');
  const boss: ReviewBoss = options.boss ?? new PgBoss(options.connectionString);
  const report = (message: string) => {
    if (options.onError) {
      try { options.onError(new Error(message)); return; } catch { /* avoid an unhandled timer rejection */ }
    }
    process.emitWarning(message);
  };
  boss.on('error', () => report('Review scheduler queue error'));
  let started = false;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let cancelInterval: (() => void) | undefined;
  let periodicInFlight = false;
  let stopPromise: Promise<void> | undefined;
  const recoveredOccurrences = new Map<string, number>();

  const queueKey = (event: TriggerEvent) => `${event.idempotencyKey}:${event.sourceRevision}`;
  const enqueue = async (event: TriggerEvent) => {
    const key = queueKey(event);
    // Old versions used random job IDs. Preserve any existing job and its retry delay.
    if ((await boss.findJobs(QUEUE, { key, limit: 1 })).length) return;
    const hash = createHash('sha256').update(key).digest('hex');
    const variant = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    // PostgreSQL rejects a second concurrent insert with the same ID without
    // updating a queued, retrying, active, or completed job.
    await boss.insert(QUEUE, [{
      id, data: event, singletonKey: key, startAfter: new Date(event.scheduledFor),
      retryLimit: 5, retryDelay: 30, retryBackoff: true,
    }]);
  };
  const schedules = async (): Promise<ScheduleEntry[]> => {
    const entries = await options.runtime.listReviewSchedules();
    if (!Array.isArray(entries)) throw new Error('Invalid review schedule list');
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.userId !== 'string' || !entry.userId.trim() || seen.has(entry.userId)) throw new Error('Invalid or duplicate schedule owner');
      seen.add(entry.userId);
      validateSchedule(entry.reviewSchedule);
      if (entry.updatedAt !== undefined && parseOffsetDateTime(entry.updatedAt) === null) throw new Error('Invalid review schedule update time');
    }
    return entries;
  };
  const reconcile = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Review scheduler is stopped'));
    const task = tail.then(async () => {
      try {
        const entries = await schedules();
        const now = currentTime(clock);
        for (const [key, expiresAt] of recoveredOccurrences) if (expiresAt < now.getTime()) recoveredOccurrences.delete(key);
        for (const entry of entries) {
          const events = [...missedReviewEvents(entry, now), ...buildReviewEvents(entry, now)];
          for (const event of events) {
            const due = Date.parse(event.scheduledFor);
            const key = queueKey(event);
            if (due <= now.getTime() && recoveredOccurrences.has(key)) continue;
            await enqueue(event);
            if (due <= now.getTime()) recoveredOccurrences.set(key, due + MAX_DELAY_MS);
          }
        }
      } catch {
        throw new Error('Review schedule reconciliation failed');
      }
    });
    tail = task.catch(() => {});
    return task;
  };
  const handle = async (value: unknown): Promise<WorkOutput> => {
    if (!isReviewJob(value)) return { status: 'skipped', reason: 'invalid' };
    const now = currentTime(clock);
    const dueMs = Date.parse(value.scheduledFor);
    recoveredOccurrences.set(queueKey(value), dueMs + MAX_DELAY_MS);
    let entries: ScheduleEntry[];
    try { entries = await schedules(); } catch { throw new Error('Review schedule lookup failed'); }
    const entry = entries.find(item => item.userId === value.userId);
    if (entry) {
      // Queue the following occurrence before invoking the Agent, even if it fails.
      const afterThisJob = new Date(Math.max(now.getTime(), dueMs + 1));
      const next = buildReviewEvents(entry, afterThisJob).find(event => event.reason === value.reason);
      if (next) {
        try { await enqueue(next); } catch { throw new Error('Review queue scheduling failed'); }
      }
    }
    const skip = async (reason: 'late' | 'stale'): Promise<WorkOutput> => {
      if (options.runtime.recordSkipped) {
        try { await options.runtime.recordSkipped(value, reason); } catch { throw new Error('Review skip recording failed'); }
      }
      return { status: 'skipped', reason };
    };
    if (!entry) return skip('stale');
    const scheduled = buildReviewEvents(entry, new Date(dueMs)).find(event => event.reason === value.reason);
    if (!scheduled || !sameOccurrence(scheduled, value)) return skip('stale');
    if (now.getTime() < dueMs) throw new Error('Review job delivered before its scheduled time');
    if (now.getTime() - dueMs > MAX_DELAY_MS) return skip('late');
    let outcome: Awaited<ReturnType<ReviewSchedulerRuntime['runScheduledReview']>>;
    try { outcome = await options.runtime.runScheduledReview(value); } catch { throw new Error('Scheduled review failed'); }
    if (!outcome || outcome.status === 'failed') throw new Error('Scheduled review failed');
    if (outcome.status !== 'completed' && outcome.status !== 'skipped') throw new Error('Invalid scheduled review outcome');
    return { status: outcome.status };
  };

  try {
    await boss.start();
    started = true;
    await boss.createQueue(QUEUE);
    await boss.work(QUEUE, { batchSize: 1 }, async jobs => jobs.length === 1 ? handle(jobs[0]!.data) : { status: 'skipped', reason: 'invalid' });
    await reconcile();
    const createInterval = options.createInterval ?? ((callback, milliseconds) => {
      const timer = setInterval(callback, milliseconds);
      timer.unref();
      return () => clearInterval(timer);
    });
    cancelInterval = createInterval(() => {
      if (closed || periodicInFlight) return;
      periodicInFlight = true;
      void reconcile().catch(() => report('Review schedule reconciliation failed')).finally(() => { periodicInFlight = false; });
    }, intervalMs);
  } catch {
    if (started) {
      try { await boss.stop(); } catch { /* preserve the sanitized startup error */ }
    }
    throw new Error('Review scheduler failed to start');
  }
  return {
    reconcile,
    stop() {
      if (!stopPromise) {
        closed = true;
        cancelInterval?.();
        stopPromise = (async () => { await tail; await boss.stop(); })();
      }
      return stopPromise;
    },
  };
}
