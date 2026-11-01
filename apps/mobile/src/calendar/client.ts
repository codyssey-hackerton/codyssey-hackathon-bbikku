import { ApiError, type ApiClient } from '../api/http';
import { parseOffsetDateTime } from '@pikku/domain';
import type { Mutation } from '../api/mutation';
import { compareTimestamps, isScheduleItem, isTimestamp, type ScheduleItem } from '../schedule/client';
import { addDays, civilOrdinal, startOfDay, type CivilDate } from '../schedule/dates';

export interface CalendarConnection { status: 'available' | 'not_configured'; accountLabel: string | null; accountRef?: string | null }
export interface Calendar { id: string; summary: string; timeZone?: string; primary?: boolean }
export interface CalendarEvent { id: string; etag: string; title: string; startsAt: string; endsAt: string; timezone: string; allDay?: boolean; blocksTime?: boolean; notes?: string | null; occurrenceKey?: string }
export interface CalendarEvents { events: CalendarEvent[]; unsupportedCount: number }
export interface CalendarImportInput {
  calendarId: string;
  from: string;
  to: string;
  selectedEvents: { id: string; etag: string }[];
  expectedScheduleRevision: number;
  expectedAccountRef?: string;
  skipExisting?: boolean;
}
export interface CalendarImportResult { items: ScheduleItem[]; scheduleRevision: number }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = () => new ApiError('invalid_response', '서버의 캘린더 응답을 확인할 수 없습니다.');

export function validPeriod(from: string, to: string): boolean {
  const start = parseOffsetDateTime(from), end = parseOffsetDateTime(to);
  return start !== null && end !== null && start < end && end - start <= 366 * 86_400_000;
}

export function calendarDateRange(first: string, last: string, timezone: string): { from: string; to: string } | null {
  const parse = (value: string): CivilDate | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  };
  const start = parse(first), end = parse(last);
  if (!start || !end || civilOrdinal(end) < civilOrdinal(start) || civilOrdinal(end) - civilOrdinal(start) >= 366) return null;
  try {
    const range = { from: startOfDay(start, timezone).toISOString(), to: startOfDay(addDays(end, 1), timezone).toISOString() };
    return validPeriod(range.from, range.to) ? range : null;
  } catch { return null; }
}

export function selectedEventRefs(events: CalendarEvent[], selected: ReadonlySet<string>): { id: string; etag: string }[] {
  return events.filter(event => selected.has(event.id)).map(({ id, etag }) => ({ id, etag }));
}

export function createCalendarClient(api: ApiClient) {
  return {
    async connection(): Promise<CalendarConnection> {
      const data = await api.get<unknown>('/v1/calendar-connection');
      if (!record(data) || (data.status !== 'available' && data.status !== 'not_configured') ||
          !(typeof data.accountLabel === 'string' || data.accountLabel === null) ||
          !(data.accountRef === undefined || data.accountRef === null || nonempty(data.accountRef))) throw invalid();
      return data as unknown as CalendarConnection;
    },
    async calendars(): Promise<Calendar[]> {
      const data = await api.get<unknown>('/v1/calendar/calendars');
      if (!record(data) || !Array.isArray(data.calendars) || !data.calendars.every((item: unknown) =>
        record(item) && nonempty(item.id) && typeof item.summary === 'string' &&
        (item.timeZone === undefined || nonempty(item.timeZone)) && (item.primary === undefined || typeof item.primary === 'boolean')) ||
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
            compareTimestamps(item.startsAt, item.endsAt) < 0 && nonempty(item.timezone) &&
            (item.allDay === undefined || typeof item.allDay === 'boolean') && (item.blocksTime === undefined || typeof item.blocksTime === 'boolean') &&
            (item.notes === undefined || item.notes === null || typeof item.notes === 'string') && (item.occurrenceKey === undefined || nonempty(item.occurrenceKey))) ||
          new Set(data.events.map((item: CalendarEvent) => item.id)).size !== data.events.length) throw invalid();
      return data as unknown as CalendarEvents;
    },
    async importEvents(op: Mutation<CalendarImportInput>): Promise<CalendarImportResult> {
      const data = await api.post<unknown>('/v1/calendar/import',
        { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (!record(data) || !Array.isArray(data.items) ||
          (op.input.skipExisting ? data.items.length > op.input.selectedEvents.length : data.items.length !== op.input.selectedEvents.length) ||
          !revision(data.scheduleRevision) || data.scheduleRevision !== op.input.expectedScheduleRevision + (data.items.length ? 1 : 0)) throw invalid();
      const selected = new Map(op.input.selectedEvents.map(event => [event.id, event.etag]));
      const itemIds = new Set<string>(), sourceIds = new Set<string>(), occurrences = new Set<string>();
      let accountRef = op.input.expectedAccountRef;
      for (const item of data.items) {
        if (!isScheduleItem(item) || !nonempty(item.id) || item.revision !== 1 || item.kind !== 'event' || item.sourceRefs.length !== 1) throw invalid();
        const ref = item.sourceRefs[0];
        if (ref.provider !== 'google_calendar' || !nonempty(ref.accountRef) || ref.calendarId !== op.input.calendarId ||
            (accountRef !== undefined && ref.accountRef !== accountRef) || !selected.has(ref.externalEventId) ||
            selected.get(ref.externalEventId) !== ref.sourceVersion || !isTimestamp(ref.lastSyncedAt) ||
            (ref.occurrenceKey !== undefined && !nonempty(ref.occurrenceKey)) || itemIds.has(item.id) || sourceIds.has(ref.externalEventId) ||
            (!!ref.occurrenceKey && occurrences.has(ref.occurrenceKey))) throw invalid();
        accountRef = ref.accountRef; itemIds.add(item.id); sourceIds.add(ref.externalEventId);
        if (ref.occurrenceKey) occurrences.add(ref.occurrenceKey);
      }
      return data as unknown as CalendarImportResult;
    },
  };
}
