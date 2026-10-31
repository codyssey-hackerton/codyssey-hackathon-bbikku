import { randomUUID } from 'node:crypto';
import { assessChanges, type ScheduleFields, type ScheduleItem } from '@pikku/domain';
import { PlanningError } from './planning-service.ts';
import type { PlanningStore } from './planning-store.ts';
import type { getCalendarConnection } from './google-calendar.ts';

type Connection = NonNullable<Awaited<ReturnType<typeof getCalendarConnection>>>;
type ImportInput = { userId: string; calendarId: string; from: string; to: string; selectedEvents: { id: string; etag: string }[]; expectedScheduleRevision: number };
type Selected = Awaited<ReturnType<Connection['resolveEvents']>>['events'];
export class CalendarImportService {
  private readonly prepared = new WeakMap<object, { input: ImportInput; selected: Selected }>();
  constructor(private readonly store: PlanningStore, private readonly connection: Connection) {}
  async prepareSelected(input: ImportInput): Promise<object> {
    if (input.userId !== this.connection.userId) throw new PlanningError(403, 'permission_denied', '캘린더 사용자 범위가 다릅니다.');
    if (!Array.isArray(input.selectedEvents) || input.selectedEvents.length < 1 || input.selectedEvents.length > 100 ||
        input.selectedEvents.some(e => !e || typeof e.id !== 'string' || !e.id || typeof e.etag !== 'string' || !e.etag) ||
        new Set(input.selectedEvents.map(e => e.id)).size !== input.selectedEvents.length || !Number.isSafeInteger(input.expectedScheduleRevision) || input.expectedScheduleRevision < 0) {
      throw new PlanningError(400, 'invalid_request', '가져올 일정을 확인해 주세요.');
    }
    const captured = structuredClone(input);
    const listed = await this.connection.resolveEvents(captured);
    const selected = captured.selectedEvents.map(selected => {
      const matches = listed.events.filter(event => event.id === selected.id);
      if (matches.length !== 1 || matches[0].etag !== selected.etag) throw new PlanningError(409, 'conflict', '원본 일정이 변경되었습니다. 다시 확인해 주세요.');
      return matches[0];
    });
    const ticket = Object.freeze({});
    this.prepared.set(ticket, { input: captured, selected: structuredClone(selected) });
    return ticket;
  }
  async commitPrepared(ticket: object) {
    const prepared = ticket && this.prepared.get(ticket);
    if (!prepared) throw new PlanningError(400, 'invalid_request', '가져올 일정을 다시 확인해 주세요.');
    const { input, selected } = prepared;
    return this.store.transaction(input.userId, state => {
      if (state.scheduleRevision !== input.expectedScheduleRevision) throw new PlanningError(409, 'conflict', '일정 버전이 변경되었습니다.');
      if (selected.some(event => [...state.items.values()].some(item => item.sourceRefs.some(ref => ref.provider === 'google_calendar' &&
        ref.accountRef === this.connection.accountRef && ref.calendarId === input.calendarId && ref.externalEventId === event.id)))) {
        throw new PlanningError(409, 'conflict', '이미 가져온 원본 일정이 있습니다.');
      }
      const changes = selected.map(event => {
        const after: ScheduleFields = { kind: 'event', title: event.title, timeSlot: { startsAt: event.startsAt, endsAt: event.endsAt, timezone: event.timezone },
          durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: event.involvement, completion: 'unknown' };
        return { changeId: randomUUID(), operation: 'create' as const, after };
      });
      const now = new Date().toISOString();
      const assessment = assessChanges({ authenticatedUserId: input.userId, snapshotUserId: input.userId, checkedAt: now, purpose: 'user_command',
        snapshot: { now, timezone: 'UTC', scheduleRevision: state.scheduleRevision, contextRevision: state.contextRevision, items: [...state.items.values()], facts: [], missingFields: [] }, changeSet: { changes } });
      if (!assessment.validation.valid) throw new PlanningError(409, 'conflict', '가져올 일정이 기존 일정과 충돌합니다.', false, assessment.validation);
      const items: ScheduleItem[] = changes.map((change, index) => ({ ...change.after, id: randomUUID(), revision: 1,
        sourceRefs: [{ provider: 'google_calendar', accountRef: this.connection.accountRef, calendarId: input.calendarId,
          externalEventId: selected[index].id, sourceVersion: selected[index].etag, lastSyncedAt: now }] }));
      for (const item of items) state.items.set(item.id, item);
      state.scheduleRevision++;
      return { items, scheduleRevision: state.scheduleRevision };
    });
  }
  async importSelected(input: ImportInput) { return this.commitPrepared(await this.prepareSelected(input)); }
}
