import type { Change, ScheduleFields, ScheduleItem, SourceRef, TimeSlot } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';

export type { ScheduleFields, ScheduleItem, SourceRef, TimeSlot } from '@pikku/domain';
export type ScheduleChange = Extract<Change, { operation: 'create' | 'update' }>;

export interface ScheduleCommandInput {
  expectedScheduleRevision: number;
  changeSet: { changes: ScheduleChange[] };
}

export interface ScheduleCommandResult extends ScheduleResult {
  outcome: 'applied';
  deletedIds: string[];
}

export interface CheckinInput {
  id: string;
  expectedRevision: number;
  completion: 'completed' | 'incomplete' | 'unknown';
}

export interface CheckinResult {
  item: ScheduleItem;
  scheduleRevision: number;
}

export interface ScheduleQuery {
  from: string;
  to: string;
  timezone: string;
  includeUnscheduled: boolean;
}

export interface ScheduleResult {
  items: ScheduleItem[];
  scheduleRevision: number;
}

export interface ScheduleClient {
  list(query: ScheduleQuery): Promise<ScheduleResult>;
  command(op: Mutation<ScheduleCommandInput>): Promise<ScheduleCommandResult>;
  checkin(op: Mutation<CheckinInput>): Promise<CheckinResult>;
}

export class ScheduleResponseError extends Error {
  readonly code = 'invalid_response';

  constructor() {
    super('일정 응답 형식이 올바르지 않습니다.');
    this.name = 'ScheduleResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const lastOfMonth = new Date(0);
  lastOfMonth.setUTCFullYear(Number(year), Number(month), 0);
  const maxDay = lastOfMonth.getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 &&
    Number(day) <= maxDay && Number(hour) <= 23 && Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59) && Number.isFinite(Date.parse(value));
}

/** Compare valid ISO instants without dropping precision beyond milliseconds. */
export function compareTimestamps(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  if (difference !== 0) return Math.sign(difference);
  const remainder = (value: string) => (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '').slice(3);
  const a = remainder(left);
  const b = remainder(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const digitDifference = (a.charCodeAt(i) || 48) - (b.charCodeAt(i) || 48);
    if (digitDifference !== 0) return Math.sign(digitDifference);
  }
  return 0;
}

function isTimeSlot(value: unknown): value is TimeSlot {
  return isRecord(value) && isTimestamp(value.startsAt) && isTimestamp(value.endsAt) &&
    typeof value.timezone === 'string' && value.timezone.length > 0 &&
    compareTimestamps(value.startsAt, value.endsAt) < 0;
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value.provider === 'string' &&
    typeof value.accountRef === 'string' && typeof value.calendarId === 'string' &&
    typeof value.externalEventId === 'string' && typeof value.lastSyncedAt === 'string' &&
    (value.occurrenceKey === undefined || typeof value.occurrenceKey === 'string') &&
    (value.sourceVersion === undefined || typeof value.sourceVersion === 'string');
}

function isScheduleItem(value: unknown): value is ScheduleItem {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 || (value.kind !== 'event' && value.kind !== 'task') ||
      typeof value.title !== 'string' ||
      !(value.timeSlot === null || isTimeSlot(value.timeSlot)) ||
      !(value.durationMinutes === null ||
        (typeof value.durationMinutes === 'number' && Number.isFinite(value.durationMinutes))) ||
      !(value.deadline === null || isTimestamp(value.deadline)) ||
      (value.flexibility !== 'fixed' && value.flexibility !== 'flexible') ||
      (value.involvement !== 'personal' && value.involvement !== 'shared') ||
      (value.completion !== 'pending' && value.completion !== 'completed' &&
        value.completion !== 'incomplete' && value.completion !== 'unknown') ||
      !Array.isArray(value.sourceRefs) || !value.sourceRefs.every(isSourceRef)) return false;

  if (value.kind === 'event' && value.timeSlot === null) return false;
  if (value.kind === 'task' &&
      (typeof value.durationMinutes !== 'number' || value.durationMinutes <= 0)) return false;
  if (isTimeSlot(value.timeSlot) && typeof value.deadline === 'string' &&
      compareTimestamps(value.timeSlot.endsAt, value.deadline) > 0) return false;
  return true;
}

function isScheduleResult(value: unknown): value is ScheduleResult {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isScheduleItem) &&
    Number.isSafeInteger(value.scheduleRevision) && (value.scheduleRevision as number) >= 0;
}

function isCheckinResult(value: unknown): value is CheckinResult {
  return isRecord(value) && isScheduleItem(value.item) &&
    Number.isSafeInteger(value.scheduleRevision) && (value.scheduleRevision as number) >= 0;
}

function isCommandResult(value: unknown): value is ScheduleCommandResult {
  return isScheduleResult(value) && isRecord(value) && value.outcome === 'applied' &&
    Array.isArray(value.deletedIds) && value.deletedIds.every((id) => typeof id === 'string');
}

/** The shared ApiClient unwraps the successful {requestId, data} envelope. */
export function createScheduleClient(api: ApiClient): ScheduleClient {
  return {
    async list(query) {
      const params = [
        ['from', query.from],
        ['to', query.to],
        ['timezone', query.timezone],
        ['includeUnscheduled', String(query.includeUnscheduled)],
      ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      const data = await api.get<unknown>(`/v1/schedule?${params}`);
      if (!isScheduleResult(data)) throw new ScheduleResponseError();
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (!isTimestamp(query.from) || !isTimestamp(query.to) || !Number.isFinite(from) || !Number.isFinite(to) || compareTimestamps(query.from, query.to) >= 0 ||
          data.items.some((item) => item.timeSlot === null
            ? !query.includeUnscheduled
            : compareTimestamps(item.timeSlot.endsAt, query.from) <= 0 || compareTimestamps(item.timeSlot.startsAt, query.to) >= 0)) {
        throw new ScheduleResponseError();
      }
      return data;
    },
    async command(op) {
      const data = await api.post<unknown>('/v1/schedule/commands',
        { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!isCommandResult(data)) throw new ScheduleResponseError();
      return data;
    },
    async checkin(op) {
      const { id, ...input } = op.input;
      const data = await api.post<unknown>(`/v1/schedule/${encodeURIComponent(id)}/checkin`,
        { requestId: op.requestId, ...input }, { idempotencyKey: op.idempotencyKey });
      if (!isCheckinResult(data) || data.item.id !== id || data.item.completion !== input.completion) {
        throw new ScheduleResponseError();
      }
      return data;
    },
  };
}
