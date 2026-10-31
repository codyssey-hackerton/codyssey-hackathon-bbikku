export type HealthSource = 'apple_health' | 'health_connect';
export type HealthSelection = { steps: boolean; workouts: boolean };
export type HealthAvailability = { status: 'available' | 'unavailable' | 'unsupported'; source: HealthSource | null;
  reason?: 'needs_dev_build' | 'provider_missing_or_update_required' | 'unsupported' | 'error' };
export type HealthPermission = 'granted' | 'denied' | 'unknown' | 'unavailable' | 'unsupported' | 'not_selected';
export type HealthAccess = { steps: HealthPermission; workouts: HealthPermission };
export type HealthWorkout = { readonly source: HealthSource; readonly id: string; readonly startAt: string; readonly endAt: string; readonly kind: string | null };
export type HealthReadResult = { source: HealthSource; lastSyncedAt: string; timezone: string; selection: HealthSelection;
  status: 'ok' | 'partial' | 'no_data_or_access'; truncated: boolean;
  workoutsAvailability: 'available' | 'no_data_or_access' | 'not_selected';
  stepsByDay: ReadonlyArray<{ readonly date: string; readonly steps: number | null }>; workouts: ReadonlyArray<HealthWorkout> };
export type HealthAdapter = {
  availability(): Promise<HealthAvailability>;
  connect(selection: HealthSelection): Promise<HealthAccess>;
  read(input: { now: string; timezone: string; selection: HealthSelection }): Promise<HealthReadResult>;
  openSettings(): Promise<void>;
};
// exerciseMinutes는 운동 세션 start/end 구간의 합집합이며 일시정지를 포함한다. 실제 활동 시간으로 사용하지 않는다.
export type HealthDay = { date: string; steps: number | null; exerciseMinutes: number | null };
export type HealthSignal = { kind: 'days_with_steps' | 'exercise_sessions'; value: number; sampleDays: number;
  source: HealthSource; calculatedAt: string; expiresAt: string };
export type HealthSummary = { source: HealthSource; lastSyncedAt: string; status: HealthReadResult['status']; truncated: boolean;
  timezone: string; selection: HealthSelection; days: HealthDay[]; workouts: HealthWorkout[]; signals: HealthSignal[]; stale: boolean };
