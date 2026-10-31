import type { HealthReadResult, HealthSelection, HealthSignal, HealthSummary, HealthWorkout } from './types';

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = (value: string): number => {
  const parsed = typeof value === 'string' && instantPattern.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error('INVALID_HEALTH_TIME');
  return parsed;
};
const dayMs = 86_400_000;
const signalTtlMs = 5 * 60_000;
type HealthDayWindow = { date: string; startAt: string; endAt: string };

export function healthDayWindows(input: { now: string; timezone: string }): HealthDayWindow[] {
  const now = instant(input.now);
  if (!input.timezone || /^[+-]/.test(input.timezone)) throw new Error('INVALID_HEALTH_TIMEZONE');
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (value: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  const today = localDate(now);
  const anchor = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(anchor)) throw new Error('INVALID_HEALTH_TIME');
  const dates = Array.from({ length: 7 }, (_, index) => new Date(anchor - (6 - index) * dayMs).toISOString().slice(0, 10));
  // Binary search the first instant of each civil date; days can be 23 or 25 hours.
  const startOfDay = (date: string) => {
    const center = Date.parse(`${date}T00:00:00.000Z`);
    let low = center - 2 * dayMs; let high = center + 2 * dayMs;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDate(middle) < date) low = middle + 1; else high = middle;
    }
    if (localDate(low) !== date) throw new Error('INVALID_HEALTH_DATE');
    return low;
  };
  const starts = dates.map(startOfDay);
  return dates.map((date, index) => ({ date, startAt: new Date(starts[index]!).toISOString(),
    endAt: new Date(index === 6 ? now : starts[index + 1]!).toISOString() }));
}

export function summarizeHealth(result: HealthReadResult, input: { now: string; timezone: string; selection: HealthSelection; calculatedAt?: string }): HealthSummary {
  const now = instant(input.now); const synced = instant(result.lastSyncedAt);
  const calculatedAt = input.calculatedAt === undefined ? now : instant(input.calculatedAt);
  const windows = healthDayWindows(input);
  if (result.timezone !== input.timezone || result.selection.steps !== input.selection.steps || result.selection.workouts !== input.selection.workouts) {
    throw new Error('HEALTH_CONTEXT_CHANGED');
  }
  const dateSet = new Set(windows.map(window => window.date));
  const steps = new Map<string, number | null>(); let incomplete = result.status === 'partial';
  if (input.selection.steps) for (const row of result.stepsByDay) {
    if (!dateSet.has(row.date)) continue;
    const count = row.steps === null ? null : Number.isSafeInteger(row.steps) && row.steps >= 0 ? row.steps : null;
    if (row.steps !== null && count === null) incomplete = true;
    if (steps.has(row.date) && steps.get(row.date) !== count) { steps.set(row.date, null); incomplete = true; }
    else if (!steps.has(row.date)) steps.set(row.date, count);
  }
  const unique = new Map<string, HealthWorkout>(); const conflicts = new Set<string>(); let workoutIncomplete = false;
  if (input.selection.workouts && result.workoutsAvailability === 'available') for (const workout of result.workouts) {
    try {
      if (workout.source !== result.source || typeof workout.id !== 'string' || !workout.id.trim() ||
          (workout.kind !== null && typeof workout.kind !== 'string')) throw new Error('INVALID_HEALTH_WORKOUT');
      const start = instant(workout.startAt); const end = instant(workout.endAt);
      if (end <= start) throw new Error('INVALID_HEALTH_WORKOUT');
      if (end <= instant(windows[0]!.startAt) || start >= now) continue;
      const key = JSON.stringify([workout.source, workout.id]); const previous = unique.get(key);
      if (conflicts.has(key)) continue;
      if (previous && (previous.startAt !== workout.startAt || previous.endAt !== workout.endAt || previous.kind !== workout.kind)) {
        unique.delete(key); conflicts.add(key); incomplete = true; workoutIncomplete = true;
      } else if (!previous) unique.set(key, { source: workout.source, id: workout.id, startAt: workout.startAt, endAt: workout.endAt, kind: workout.kind });
    } catch { incomplete = true; workoutIncomplete = true; }
  }
  const workouts = [...unique.values()].sort((a, b) => instant(a.startAt) - instant(b.startAt));
  const workoutKnown = input.selection.workouts && result.workoutsAvailability === 'available' && result.status !== 'no_data_or_access' && !result.truncated && !workoutIncomplete;
  const days = windows.map(window => {
    let exerciseMinutes: number | null = null;
    if (workoutKnown) {
      const start = instant(window.startAt); const end = instant(window.endAt);
      const intervals = workouts.map(workout => [Math.max(start, instant(workout.startAt)), Math.min(end, instant(workout.endAt))] as const)
        .filter(([from, to]) => from < to).sort((a, b) => a[0] - b[0]);
      let total = 0; let from = 0; let to = 0;
      for (const [nextFrom, nextTo] of intervals) {
        if (nextFrom > to) { total += to - from; from = nextFrom; to = nextTo; }
        else to = Math.max(to, nextTo);
      }
      exerciseMinutes = (total + to - from) / 60_000;
    }
    return { date: window.date, steps: input.selection.steps ? steps.get(window.date) ?? null : null, exerciseMinutes };
  });
  const stale = calculatedAt < now || synced > calculatedAt || calculatedAt >= synced + signalTtlMs;
  const signals: HealthSignal[] = [];
  if (!stale && result.status === 'ok' && !result.truncated && !incomplete) {
    const countedDays = days.filter(day => day.steps !== null);
    const common = { source: result.source, calculatedAt: new Date(calculatedAt).toISOString(), expiresAt: new Date(synced + signalTtlMs).toISOString() };
    if (input.selection.steps && countedDays.length) signals.push({ ...common, kind: 'days_with_steps', value: countedDays.filter(day => day.steps! > 0).length, sampleDays: countedDays.length });
    if (workoutKnown) signals.push({ ...common, kind: 'exercise_sessions', value: workouts.length, sampleDays: windows.length });
  }
  return { source: result.source, lastSyncedAt: result.lastSyncedAt, status: incomplete ? 'partial' : result.status, truncated: result.truncated,
    timezone: input.timezone, selection: { ...input.selection }, days, workouts, signals, stale };
}
