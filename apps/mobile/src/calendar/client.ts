import { ApiError, type ApiClient } from '../api/http';
import { parseOffsetDateTime } from '@pikku/domain';
import type { Mutation } from '../api/mutation';
import { compareTimestamps, isTimestamp } from '../schedule/client';

export interface CalendarConnection { status: 'available' | 'not_configured'; accountLabel: string | null }
export interface Calendar { id: string; summary: string; timeZone?: string }
export interface CalendarEvent { id: string; etag: string; title: string; startsAt: string; endsAt: string; timezone: string }
export interface CalendarEvents { events: CalendarEvent[]; unsupportedCount: number }
export interface CalendarImportInput {
  calendarId: string;
  from: string;
  to: string;
  selectedEvents: { id: string; etag: string }[];
  expectedScheduleRevision: number;
}
export interface CalendarImportResult { items: unknown[]; scheduleRevision: number }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = () => new ApiError('invalid_response', '서버의 캘린더 응답을 확인할 수 없습니다.');

export function validPeriod(from: string, to: string): boolean {
  const start = parseOffsetDateTime(from), end = parseOffsetDateTime(to);
  return start !== null && end !== null && start < end && end - start <= 366 * 86_400_000;
}

export function selectedEventRefs(events: CalendarEvent[], selected: ReadonlySet<string>): { id: string; etag: string }[] {
  return events.filter(event => selected.has(event.id)).map(({ id, etag }) => ({ id, etag }));
}

export function createCalendarClient(api: ApiClient) {
  return {
    async connection(): Promise<CalendarConnection> {
      const data = await api.get<unknown>('/v1/calendar-connection');
      if (!record(data) || (data.status !== 'available' && data.status !== 'not_configured') ||
          !(typeof data.accountLabel === 'string' || data.accountLabel === null)) throw invalid();
      return data as unknown as CalendarConnection;
    },
    async calendars(): Promise<Calendar[]> {
      const data = await api.get<unknown>('/v1/calendar/calendars');
      if (!record(data) || !Array.isArray(data.calendars) || !data.calendars.every((item: unknown) =>
        record(item) && nonempty(item.id) && typeof item.summary === 'string' &&
        (item.timeZone === undefined || nonempty(item.timeZone))) ||
        new Set(data.calendars.map((item: Calendar) => item.id)).size !== data.calendars.length) throw invalid();
      return data.calendars as Calendar[];
    },
    async events(calendarId: string, from: string, to: string): Promise<CalendarEvents> {
      const params = [['calendarId', calendarId], ['from', from], ['to', to]]
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      const data = await api.get<unknown>(`/v1/calendar/events?${params}`);
      if (!record(data) || !revision(data.unsupportedCount) || !Array.isArray(data.events) ||
          !data.events.every((item: unknown) => record(item) && nonempty(item.id) && nonempty(item.etag) &&
            typeof item.title === 'string' && isTimestamp(item.startsAt) && isTimestamp(item.endsAt) &&
            compareTimestamps(item.startsAt, item.endsAt) < 0 && nonempty(item.timezone)) ||
          new Set(data.events.map((item: CalendarEvent) => item.id)).size !== data.events.length) throw invalid();
      return data as unknown as CalendarEvents;
    },
    async importEvents(op: Mutation<CalendarImportInput>): Promise<CalendarImportResult> {
      const data = await api.post<unknown>('/v1/calendar/import',
        { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!record(data) || !Array.isArray(data.items) ||
          data.items.length !== op.input.selectedEvents.length ||
          !revision(data.scheduleRevision) || data.scheduleRevision !== op.input.expectedScheduleRevision + 1) throw invalid();
      return data as unknown as CalendarImportResult;
    },
  };
}
