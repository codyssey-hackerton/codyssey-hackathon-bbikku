import { healthDayWindows } from './summary';
import type { HealthAccess, HealthAdapter, HealthAvailability, HealthPermission, HealthReadResult, HealthSelection, HealthWorkout } from './types';

type Permission = { accessType: 'read'; recordType: 'Steps' | 'ExerciseSession' };
type TimeRange = { operator: 'between'; startTime: string; endTime: string };
type NativeBridge = {
  apiLevel?: number;
  getSdkStatus(): Promise<number>;
  initialize(): Promise<boolean>;
  requestPermission(permissions: Permission[]): Promise<unknown[]>;
  getGrantedPermissions(): Promise<unknown[]>;
  aggregateRecord(request: { recordType: 'Steps'; timeRangeFilter: TimeRange }): Promise<unknown>;
  readRecords(recordType: 'ExerciseSession', options: { timeRangeFilter: TimeRange; pageSize: number; pageToken?: string }): Promise<unknown>;
  openHealthConnectSettings(): void | Promise<void>;
};

const source = 'health_connect' as const;
const stepsPermission: Permission = { accessType: 'read', recordType: 'Steps' };
const workoutPermission: Permission = { accessType: 'read', recordType: 'ExerciseSession' };
const pageSize = 100, maxPages = 5;
const missingNative = (error: unknown) => error instanceof Error && /doesn.t seem to be linked|not using Expo Go|TurboModuleRegistry|could not be found/i.test(error.message);
function loadHealthConnect(): NativeBridge {
  const module = require('react-native-health-connect') as Omit<NativeBridge, 'apiLevel'>;
  const { Platform } = require('react-native') as typeof import('react-native');
  return { ...module, apiLevel: Number(Platform.Version) };
}
function granted(values: unknown[], type: Permission['recordType']): boolean {
  return values.some(value => !!value && typeof value === 'object' && 'accessType' in value && value.accessType === 'read' &&
    'recordType' in value && value.recordType === type);
}
function selectedAccess(selection: HealthSelection, status: HealthPermission): HealthAccess {
  return { steps: selection.steps ? status : 'not_selected', workouts: selection.workouts ? status : 'not_selected' };
}
function ensureSelection(selection: HealthSelection) {
  if (!selection || typeof selection.steps !== 'boolean' || typeof selection.workouts !== 'boolean') throw new Error('HEALTH_INVALID_SELECTION');
}
const range = (startTime: string, endTime: string): TimeRange => ({ operator: 'between', startTime, endTime });

// The optional loader keeps SDK behavior testable without a native module or health data.
export function createHealthAdapter(loadNative: () => NativeBridge = loadHealthConnect): HealthAdapter {
  async function inspect(): Promise<{ availability: HealthAvailability; native?: NativeBridge }> {
    let native: NativeBridge;
    try { native = loadNative(); } catch { return { availability: { status: 'unavailable', source, reason: 'needs_dev_build' } }; }
    if (native.apiLevel !== undefined && Number.isFinite(native.apiLevel) && native.apiLevel < 28) {
      return { availability: { status: 'unsupported', source, reason: 'unsupported' } };
    }
    try {
      const status = await native.getSdkStatus();
      if (status === 3) return { availability: { status: 'available', source }, native };
      if (status === 2) return { availability: { status: 'unavailable', source, reason: 'provider_missing_or_update_required' } };
      return { availability: { status: 'unavailable', source, reason: 'error' } };
    } catch (error) {
      return { availability: { status: 'unavailable', source, reason: missingNative(error) ? 'needs_dev_build' : 'error' } };
    }
  }
  async function ready(): Promise<NativeBridge> {
    const result = await inspect();
    if (!result.native) throw new Error('HEALTH_UNAVAILABLE');
    try { if (!await result.native.initialize()) throw new Error(); } catch { throw new Error('HEALTH_UNAVAILABLE'); }
    return result.native;
  }
  return {
    async availability() { return (await inspect()).availability; },
    async connect(selection) {
      ensureSelection(selection);
      if (!selection.steps && !selection.workouts) return selectedAccess(selection, 'not_selected');
      const inspected = await inspect();
      if (!inspected.native) return selectedAccess(selection, inspected.availability.status === 'unsupported' ? 'unsupported' : 'unavailable');
      try {
        if (!await inspected.native.initialize()) return selectedAccess(selection, 'unavailable');
        const requested: Permission[] = [];
        if (selection.steps) requested.push(stepsPermission);
        if (selection.workouts) requested.push(workoutPermission);
        const result = await inspected.native.requestPermission(requested);
        if (!Array.isArray(result)) return selectedAccess(selection, 'unavailable');
        return { steps: !selection.steps ? 'not_selected' : granted(result, 'Steps') ? 'granted' : 'denied',
          workouts: !selection.workouts ? 'not_selected' : granted(result, 'ExerciseSession') ? 'granted' : 'denied' };
      } catch { return selectedAccess(selection, 'unavailable'); }
    },
    async read(input): Promise<HealthReadResult> {
      ensureSelection(input.selection);
      const selection = { ...input.selection };
      const windows = healthDayWindows(input);
      const stepsByDay = windows.map(window => ({ date: window.date, steps: null as number | null }));
      const empty = (): HealthReadResult => ({ source, lastSyncedAt: new Date().toISOString(), timezone: input.timezone, selection,
        status: 'no_data_or_access', truncated: false, workoutsAvailability: selection.workouts ? 'no_data_or_access' : 'not_selected', stepsByDay, workouts: [] });
      if (!selection.steps && !selection.workouts) return empty();
      const native = await ready();
      let permissions: unknown[];
      try { permissions = await native.getGrantedPermissions(); if (!Array.isArray(permissions)) throw new Error(); }
      catch { throw new Error('HEALTH_READ_FAILED'); }
      const canSteps = selection.steps && granted(permissions, 'Steps');
      const canWorkouts = selection.workouts && granted(permissions, 'ExerciseSession');
      let partial = false, truncated = false, workoutsKnown = false, workoutsInvalid = false;
      const workouts = new Map<string, HealthWorkout>(), conflicted = new Set<string>();
      if (canSteps) for (const [index, window] of windows.entries()) {
        if (Date.parse(window.startAt) >= Date.parse(window.endAt)) continue;
        try {
          const response = await native.aggregateRecord({ recordType: 'Steps', timeRangeFilter: range(window.startAt, window.endAt) });
          if (!response || typeof response !== 'object' || !('COUNT_TOTAL' in response) || !('dataOrigins' in response) ||
              !Array.isArray(response.dataOrigins) || !response.dataOrigins.every(value => typeof value === 'string') ||
              typeof response.COUNT_TOTAL !== 'number' || !Number.isSafeInteger(response.COUNT_TOTAL) || response.COUNT_TOTAL < 0) throw new Error();
          if (response.dataOrigins.length) stepsByDay[index]!.steps = response.COUNT_TOTAL;
        } catch { partial = true; }
      }
      if (canWorkouts) {
        try {
          let pageToken: string | undefined;
          const seenTokens = new Set<string>();
          const start = Date.parse(windows[0]!.startAt), end = Date.parse(input.now);
          for (let page = 0; page < maxPages; page++) {
            const response = await native.readRecords('ExerciseSession', { timeRangeFilter: range(windows[0]!.startAt, input.now),
              pageSize, ...(pageToken ? { pageToken } : {}) });
            if (!response || typeof response !== 'object' || !('records' in response) || !Array.isArray(response.records) ||
                ('pageToken' in response && response.pageToken != null && typeof response.pageToken !== 'string')) throw new Error();
            if (response.records.length > pageSize) { truncated = true; partial = true; }
            for (const record of response.records.slice(0, pageSize)) {
              if (!record || typeof record !== 'object' || !record.metadata || typeof record.metadata.id !== 'string' ||
                  !record.metadata.id.trim() || record.metadata.id.length > 200 || typeof record.startTime !== 'string' ||
                  typeof record.endTime !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(record.startTime) ||
                  !/(?:Z|[+-]\d{2}:\d{2})$/.test(record.endTime)) { partial = true; workoutsInvalid = true; continue; }
              const from = Date.parse(record.startTime), to = Date.parse(record.endTime);
              if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) { partial = true; workoutsInvalid = true; continue; }
              if (to <= start || from >= end) continue;
              const workout: HealthWorkout = { source, id: record.metadata.id, startAt: record.startTime, endAt: record.endTime,
                kind: Number.isSafeInteger(record.exerciseType) && record.exerciseType >= 0 ? String(record.exerciseType) : null };
              const previous = workouts.get(workout.id);
              if (conflicted.has(workout.id)) continue;
              if (previous && JSON.stringify(previous) !== JSON.stringify(workout)) {
                workouts.delete(workout.id); conflicted.add(workout.id); partial = true; workoutsInvalid = true;
              } else workouts.set(workout.id, workout);
            }
            const next = 'pageToken' in response && typeof response.pageToken === 'string' ? response.pageToken : undefined;
            if (!next) { workoutsKnown = true; break; }
            if (seenTokens.has(next)) { partial = true; truncated = true; break; }
            seenTokens.add(next); pageToken = next;
            if (page === maxPages - 1) truncated = true;
          }
          if (truncated) workoutsKnown = true;
        } catch { partial = true; }
      }
      const hasSteps = stepsByDay.some(day => day.steps !== null);
      const hasKnown = hasSteps || workoutsKnown;
      if ((selection.steps && !canSteps && hasKnown) || (selection.workouts && !canWorkouts && hasKnown) ||
          (selection.steps && canSteps && !hasSteps && workoutsKnown)) partial = true;
      return { source, lastSyncedAt: new Date().toISOString(), timezone: input.timezone, selection,
        status: partial && hasKnown ? 'partial' : hasKnown ? 'ok' : partial ? 'partial' : 'no_data_or_access', truncated,
        workoutsAvailability: !selection.workouts ? 'not_selected' : workoutsKnown && !workoutsInvalid ? 'available' : 'no_data_or_access',
        stepsByDay, workouts: [...workouts.values()] };
    },
    async openSettings() {
      const result = await inspect();
      if (!result.native) throw new Error('HEALTH_UNAVAILABLE');
      try { await result.native.openHealthConnectSettings(); } catch { throw new Error('HEALTH_SETTINGS_FAILED'); }
    },
  };
}
