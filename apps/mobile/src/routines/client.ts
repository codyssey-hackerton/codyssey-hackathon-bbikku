import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/mutation';

export type Routine = { id: string; revision: number; title: string; weekdays: number[]; timezone: string; startDate: string; localTime: string; durationMinutes: number; active: boolean };
export type RoutineInput = Pick<Routine, 'title' | 'weekdays' | 'timezone' | 'startDate' | 'localTime' | 'durationMinutes'>;
export type RoutineUpdate = { id: string; expectedRevision: number; changes: Partial<RoutineInput & { active: boolean }> };
export type MaterializeInput = { fromDate: string; toDate: string };
export type MaterializeResult = { createdCount: number; existingCount: number; conflicts: { routineId: string; date: string; code: 'schedule_conflict' | 'invalid_local_time' }[]; scheduleRevision: number };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalid = () => new ApiError('invalid_response', '루틴 응답을 확인할 수 없습니다.');
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validPeriod(fromDate: string, toDate: string) {
  if (!validDate(fromDate) || !validDate(toDate)) return false;
  const days = (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000;
  return days >= 0 && days < 31;
}
function routine(value: unknown): Routine {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !integer(value.revision) || value.revision < 1 ||
      typeof value.title !== 'string' || !value.title.trim() || !Array.isArray(value.weekdays) || !value.weekdays.length ||
      !value.weekdays.every((day: unknown, i: number, days: number[]) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7 && (i === 0 || days[i - 1]! < (day as number))) ||
      typeof value.timezone !== 'string' || !value.timezone || typeof value.startDate !== 'string' || !validDate(value.startDate) ||
      typeof value.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime) ||
      !integer(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440 || typeof value.active !== 'boolean') throw invalid();
  return value as Routine;
}
export function createRoutineClient(api: ApiClient) {
  return {
    async list(): Promise<Routine[]> {
      const data = await api.get<unknown>('/v1/routines');
      if (!record(data) || !Array.isArray(data.routines)) throw invalid();
      const routines = data.routines.map(routine);
      if (new Set(routines.map(item => item.id)).size !== routines.length) throw invalid();
      return routines;
    },
    async create(op: Mutation<RoutineInput>): Promise<Routine> {
      const data = await api.post<unknown>('/v1/routines', { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!record(data)) throw invalid(); return routine(data.routine);
    },
    async update(op: Mutation<RoutineUpdate>): Promise<Routine> {
      const { id, expectedRevision, changes } = op.input;
      if (!api.patch) throw new ApiError('not_implemented', '루틴 변경을 사용할 수 없습니다.');
      const data = await api.patch<unknown>(`/v1/routines/${encodeURIComponent(id)}`, { requestId: op.requestId, expectedRevision, ...changes }, { idempotencyKey: op.idempotencyKey });
      if (!record(data)) throw invalid(); return routine(data.routine);
    },
    async materialize(op: Mutation<MaterializeInput>): Promise<MaterializeResult> {
      const data = await api.post<unknown>('/v1/routines/materialize', { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!record(data) || !integer(data.createdCount) || !integer(data.existingCount) || !integer(data.scheduleRevision) || !Array.isArray(data.conflicts) ||
          !data.conflicts.every((item: unknown) => record(item) && typeof item.routineId === 'string' && !!item.routineId && typeof item.date === 'string' && validDate(item.date) && (item.code === 'schedule_conflict' || item.code === 'invalid_local_time'))) throw invalid();
      return data as MaterializeResult;
    },
  };
}
