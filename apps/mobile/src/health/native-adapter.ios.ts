import type { HealthAccess, HealthAdapter, HealthSelection, HealthWorkout } from './types';
import { healthDayWindows } from './summary';

type HealthKit = typeof import('@kingstinct/react-native-healthkit');
const stepsType = 'HKQuantityTypeIdentifierStepCount' as const;
const workoutType = 'HKWorkoutTypeIdentifier' as const;
const unavailable = () => new Error('HEALTH_UNAVAILABLE');
const validSelection = (value: HealthSelection) => value && typeof value.steps === 'boolean' && typeof value.workouts === 'boolean';

export function createHealthAdapter(loadHealthKit: () => Promise<HealthKit> = () => import('@kingstinct/react-native-healthkit')): HealthAdapter {
  let native: Promise<HealthKit> | undefined;
  let requested: HealthSelection = { steps: false, workouts: false };
  let generation = 0;
  const load = () => native ??= loadHealthKit();
  const availability: HealthAdapter['availability'] = async () => {
    try {
      const api = await load();
      return await api.isHealthDataAvailable()
        ? { status: 'available', source: 'apple_health' }
        : { status: 'unavailable', source: 'apple_health' };
    } catch { return { status: 'unavailable', source: 'apple_health', reason: 'needs_dev_build' }; }
  };
  return {
    availability,
    async connect(selection): Promise<HealthAccess> {
      if (!validSelection(selection)) throw unavailable();
      selection = { ...selection };
      const current = ++generation;
      const result: HealthAccess = { steps: selection.steps ? 'unknown' : 'not_selected', workouts: selection.workouts ? 'unknown' : 'not_selected' };
      if (!selection.steps && !selection.workouts) { requested = { steps: false, workouts: false }; return result; }
      requested = { steps: false, workouts: false };
      try {
        if ((await availability()).status !== 'available') return { steps: selection.steps ? 'unavailable' : 'not_selected', workouts: selection.workouts ? 'unavailable' : 'not_selected' };
        const api = await load();
        if (current !== generation) return result;
        const toRead = [...(selection.steps ? [stepsType] : []), ...(selection.workouts ? [workoutType] : [])];
        if (await api.requestAuthorization({ toRead }) && current === generation) requested = { ...selection };
        return result;
      } catch { return { steps: selection.steps ? 'unavailable' : 'not_selected', workouts: selection.workouts ? 'unavailable' : 'not_selected' }; }
    },
    async read(input) {
      if (!input || !validSelection(input.selection)) throw unavailable();
      const selection = { ...input.selection };
      const windows = healthDayWindows(input);
      const start = Date.parse(windows[0]!.startAt), end = Date.parse(input.now);
      const current = generation;
      if ((selection.steps || selection.workouts) && (selection.steps !== requested.steps || selection.workouts !== requested.workouts)) throw unavailable();
      const stepsByDay = windows.map(window => ({ date: window.date, steps: null as number | null }));
      let workouts: HealthWorkout[] = [];
      let workoutsAvailability: 'available' | 'no_data_or_access' | 'not_selected' = selection.workouts ? 'no_data_or_access' : 'not_selected';
      let truncated = false;
      try {
        if (selection.steps || selection.workouts) {
          const api = await load();
          if (!api.isHealthDataAvailable()) throw unavailable();
          if (current !== generation) throw unavailable();
          if (selection.steps) {
            try {
            // Native HealthKit partitions daily intervals in the device timezone.
            if (Intl.DateTimeFormat().resolvedOptions().timeZone !== input.timezone) throw unavailable();
            const stats = await api.queryStatisticsCollectionForQuantity(stepsType, ['cumulativeSum'], new Date(start), { day: 1 },
              { filter: { date: { startDate: new Date(start), endDate: new Date(end), strictEndDate: true } }, unit: 'count' });
            if (current !== generation) throw unavailable();
            if (!Array.isArray(stats) || stats.length > 8) throw unavailable();
            const seen = new Set<number>();
            for (const stat of stats) {
              if (!stat || !(stat.startDate instanceof Date) || !(stat.endDate instanceof Date)) throw unavailable();
              const from = stat.startDate.getTime(), to = stat.endDate.getTime();
              if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw unavailable();
              const index = windows.findIndex(window => Date.parse(window.startAt) === from);
              if (index < 0 || seen.has(index)) throw unavailable();
              seen.add(index);
              const windowEnd = Date.parse(windows[index]!.endAt);
              if (index < 6 ? to !== windowEnd : to < windowEnd || to - from > 27 * 3_600_000) throw unavailable();
              if (stat.sumQuantity !== undefined && stat.sumQuantity !== null) {
                const count = stat.sumQuantity.quantity;
                if (stat.sumQuantity.unit !== 'count' || !Number.isSafeInteger(count) || count < 0) throw unavailable();
                stepsByDay[index]!.steps = count;
              }
            }
            } catch {
              for (const day of stepsByDay) day.steps = null;
            }
          }
          if (current !== generation) throw unavailable();
          if (selection.workouts) {
            const samples = await api.queryWorkoutSamples({ limit: 501, ascending: false,
              filter: { date: { startDate: new Date(start), endDate: new Date(end), strictEndDate: true } } });
            if (!Array.isArray(samples) || samples.length > 501) throw unavailable();
            truncated = samples.length > 500;
            const unique = new Map<string, { value: HealthWorkout; sourceId: string }>();
            try {
              if (current !== generation) throw unavailable();
              for (const sample of samples.slice(0, 500)) {
                const from = sample.startDate, to = sample.endDate;
                const sourceId = sample.sourceRevision?.source?.bundleIdentifier;
                if (typeof sample.uuid !== 'string' || !sample.uuid.trim() || sample.uuid.length > 200 || typeof sourceId !== 'string' || !sourceId.trim() ||
                    !(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
                    from.getTime() >= to.getTime() || to.getTime() > end ||
                    !Number.isSafeInteger(sample.workoutActivityType) || sample.workoutActivityType < 0) throw unavailable();
                if (to.getTime() <= start || from.getTime() >= end) continue;
                const kind = api.WorkoutActivityType[sample.workoutActivityType];
                const value: HealthWorkout = { source: 'apple_health', id: sample.uuid, startAt: from.toISOString(), endAt: to.toISOString(),
                  kind: typeof kind === 'string' ? kind : null };
                const previous = unique.get(value.id);
                if (previous && (previous.sourceId !== sourceId || JSON.stringify(previous.value) !== JSON.stringify(value))) throw unavailable();
                unique.set(value.id, { value, sourceId });
              }
            } finally {
              for (const sample of samples) { try { sample.dispose(); } catch { /* release best effort */ } }
            }
            workouts = [...unique.values()].map(entry => entry.value);
            if (workouts.length && !truncated) workoutsAvailability = 'available';
          }
        }
      } catch { throw unavailable(); }
      if (current !== generation) throw unavailable();
      const hasData = stepsByDay.some(row => row.steps !== null) || workouts.length > 0;
      const partial = truncated || (selection.steps && stepsByDay.some(row => row.steps === null)) || (selection.workouts && workoutsAvailability !== 'available');
      return { source: 'apple_health', lastSyncedAt: new Date().toISOString(), timezone: input.timezone, selection,
        status: hasData ? partial ? 'partial' : 'ok' : 'no_data_or_access', truncated, workoutsAvailability, stepsByDay, workouts };
    },
    async openSettings() {
      try {
        const { Linking } = await import('react-native');
        await Linking.openSettings();
      } catch { throw unavailable(); }
    },
  };
}
