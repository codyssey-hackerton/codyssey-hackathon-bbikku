import { ApiError, type ApiClient } from '../api/http';
import { isUncertainMutationError, type Mutation } from '../api/mutation';

export type SyncCalendar = { id: string; summary: string; accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader' };
export type SyncConnection = { id: string; calendarId: string; revision: number; allowDeletes: boolean; status: 'connected' | 'review_required'; pendingExportCount: number };
export type SyncConflict = { reason: string; itemId?: string; eventId?: string };
export type SyncResult = { connection: SyncConnection; imported: number; exported: number; deleted: number; unsupportedCount: number; conflicts: SyncConflict[] };
export type ConnectInput = { calendarId: string; allowDeletes: boolean; exportItemIds: string[] };
export type ChangeInput = { id: string; expectedRevision: number };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const invalid = () => new ApiError('invalid_response', '캘린더 동기화 응답을 확인할 수 없습니다.');
function connection(value: unknown): SyncConnection {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.calendarId) || !count(value.revision) || value.revision < 1 ||
    typeof value.allowDeletes !== 'boolean' || (value.status !== 'connected' && value.status !== 'review_required') || !count(value.pendingExportCount)) throw invalid();
  return value as SyncConnection;
}
function runResult(value: unknown): SyncResult {
  if (!record(value) || !count(value.imported) || !count(value.exported) || !count(value.deleted) || !count(value.unsupportedCount) || !Array.isArray(value.conflicts) ||
    !value.conflicts.every((item: unknown) => record(item) && nonempty(item.reason) && (item.itemId === undefined || nonempty(item.itemId)) && (item.eventId === undefined || nonempty(item.eventId)))) throw invalid();
  return { connection: connection(value.connection), imported: value.imported, exported: value.exported, deleted: value.deleted, unsupportedCount: value.unsupportedCount, conflicts: value.conflicts as SyncConflict[] };
}
export function createCalendarSyncClient(api: ApiClient) {
  const uncertainRuns = new Set<string>();
  return {
    async calendars(): Promise<SyncCalendar[]> {
      const value = await api.get<unknown>('/v1/calendar-sync/calendars');
      if (!record(value) || !Array.isArray(value.calendars) || !value.calendars.every((item: unknown) => record(item) && nonempty(item.id) && typeof item.summary === 'string' &&
        ['owner', 'writer', 'reader', 'freeBusyReader'].includes(item.accessRole as string))) throw invalid();
      const list = value.calendars as SyncCalendar[];
      if (new Set(list.map(item => item.id)).size !== list.length) throw invalid(); return list;
    },
    async list(): Promise<SyncConnection[]> {
      const value = await api.get<unknown>('/v1/calendar-sync');
      if (!record(value) || !Array.isArray(value.connections)) throw invalid();
      const list = value.connections.map(connection); if (new Set(list.map(item => item.id)).size !== list.length) throw invalid(); return list;
    },
    async connect(op: Mutation<ConnectInput>): Promise<SyncConnection> {
      const value = await api.post<unknown>('/v1/calendar-sync/connect', { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!record(value)) throw invalid(); return connection(value.connection);
    },
    async run(op: Mutation<ChangeInput>): Promise<SyncResult> {
      const { id, expectedRevision } = op.input;
      if (uncertainRuns.has(op.requestId)) {
        const value = await api.get<unknown>(`/v1/calendar-sync/operations/${encodeURIComponent(op.requestId)}`);
        if (!record(value) || !record(value.operation)) throw invalid();
        if (value.operation.state !== 'completed') throw new ApiError('operation_in_progress', '동기화 결과를 아직 확인할 수 없습니다.');
        const result = runResult(value.operation.result);
        if (result.connection.id !== id) throw invalid();
        uncertainRuns.delete(op.requestId); return result;
      }
      try {
        const value = await api.post<unknown>(`/v1/calendar-sync/${encodeURIComponent(id)}/run`, { requestId: op.requestId, expectedRevision }, { idempotencyKey: op.idempotencyKey });
        const result = runResult(value);
        if (result.connection.id !== id) throw invalid();
        return result;
      } catch (error) {
        if (isUncertainMutationError(error)) uncertainRuns.add(op.requestId);
        throw error;
      }
    },
    async disconnect(op: Mutation<ChangeInput>): Promise<void> {
      const { id, expectedRevision } = op.input;
      const value = await api.post<unknown>(`/v1/calendar-sync/${encodeURIComponent(id)}/disconnect`, { requestId: op.requestId, expectedRevision }, { idempotencyKey: op.idempotencyKey });
      if (!record(value) || value.disconnected !== true) throw invalid();
    },
  };
}
