import { createHash, randomUUID } from 'node:crypto';
import { assessChanges, type Change, type ScheduleFields, type ScheduleItem } from '@pikku/domain';
import type { GoogleCalendarEvent, GoogleCalendarEventWrite, getCalendarWriteConnection } from './google-calendar-write.ts';
import { PlanningError } from './planning-service.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';
import { PostgresPlanningStore } from './postgres-store.ts';
import { PostgresCalendarSyncStore, type CalendarSyncStore, type SyncConnection, type SyncMapping } from './calendar-sync-store.ts';

type Google = NonNullable<Awaited<ReturnType<typeof getCalendarWriteConnection>>>;
type Conflict = { reason: string; itemId?: string; eventId?: string };
const error = (status: number, code: string, message: string): never => { throw new PlanningError(status, code, message); };
const bad = () => error(400, 'invalid_request', '동기화 요청을 확인해 주세요.');
const unavailable = () => error(503, 'not_configured', 'Google 캘린더 쓰기 연결이 필요합니다.');
const conflict = () => error(409, 'conflict', '동기화 연결 상태가 변경되었습니다.');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const publicConnection = (c: SyncConnection) => ({ id: c.id, calendarId: c.calendarId, revision: c.revision, allowDeletes: c.allowDeletes,
  status: c.activeRun ? 'review_required' as const : 'connected' as const, pendingExportCount: c.exportItemIds.length });
const digest = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
const unsupported = (e: GoogleCalendarEvent) => Object.values(e.unsupported).some(Boolean) || !e.etag || !e.title || !e.timeSlot;
const fields = (event: GoogleCalendarEvent): ScheduleFields => ({ kind: 'event', title: event.title!, timeSlot: event.timeSlot!, durationMinutes: null,
  deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'unknown' });
function assess(userId: string, state: UserPlanningState, change: Change): boolean {
  const now = new Date().toISOString();
  return assessChanges({ authenticatedUserId: userId, snapshotUserId: userId, checkedAt: now, purpose: 'user_command',
    snapshot: { now, timezone: 'UTC', scheduleRevision: state.scheduleRevision, contextRevision: state.contextRevision,
      items: [...state.items.values()], facts: [], missingFields: [] }, changeSet: { changes: [change] } }).validation.valid;
}
function write(item: ScheduleItem, bindingId: string): GoogleCalendarEventWrite {
  return { title: item.title, timeSlot: item.timeSlot!, privateProperties: { pIKKU: bindingId } };
}

export class CalendarSyncService {
  constructor(private readonly planning: PlanningStore, private readonly sync: CalendarSyncStore,
    private readonly resolve: (userId: string) => Promise<Google | undefined>) {}
  private async google(userId: string, accountRef?: string): Promise<Google> {
    const google = await this.resolve(userId);
    if (!google || google.userId !== userId || (accountRef && google.accountRef !== accountRef)) return unavailable();
    return google;
  }
  async list(userId: string) { return { connections: (await this.sync.read(userId)).connections.map(publicConnection) }; }
  async getOperation(userId: string, requestId: string) {
    if (!id(requestId) || requestId.length > 200) return bad();
    const operation = (await this.sync.read(userId)).operations.find(value => value.id === requestId);
    if (!operation) return error(404, 'not_found', '동기화 작업을 찾을 수 없습니다.');
    return { operation: { state: operation.state, ...(operation.result === undefined ? {} : { result: operation.result }) } };
  }
  async listCalendars(userId: string) { return (await this.google(userId)).listCalendars(); }
  async connect(userId: string, input: { calendarId: string; allowDeletes?: boolean; exportItemIds?: string[] }) {
    if (!id(input.calendarId) || (input.allowDeletes !== undefined && typeof input.allowDeletes !== 'boolean') ||
        (input.exportItemIds !== undefined && (!Array.isArray(input.exportItemIds) || input.exportItemIds.length > 100 ||
          input.exportItemIds.some(value => !id(value)) || new Set(input.exportItemIds).size !== input.exportItemIds.length))) return bad();
    const google = await this.google(userId);
    const listed = await google.listCalendars();
    if (!listed.calendars.some(c => c.id === input.calendarId && (c.accessRole === 'owner' || c.accessRole === 'writer'))) return unavailable();
    await this.google(userId, google.accountRef);
    const state = await this.planning.read(userId);
    if ((input.exportItemIds ?? []).some(itemId => !state.items.has(itemId))) return bad();
    return this.sync.update(userId, data => {
      if (data.connections.some(c => c.accountRef === google.accountRef && c.calendarId === input.calendarId)) return conflict();
      const connection: SyncConnection = { id: randomUUID(), calendarId: input.calendarId, accountRef: google.accountRef,
        revision: 1, allowDeletes: input.allowDeletes === true, exportItemIds: input.exportItemIds ?? [], syncToken: null, mappings: [], activeRun: null };
      data.connections.push(connection);
      return { connection: publicConnection(connection) };
    });
  }
  async disconnect(userId: string, id: string, revision: number) {
    if (!id || !Number.isSafeInteger(revision) || revision < 1) return bad();
    return this.sync.update(userId, data => {
      const index = data.connections.findIndex(c => c.id === id);
      if (index < 0) return error(404, 'not_found', '동기화 연결을 찾을 수 없습니다.');
      if (data.connections[index].revision !== revision || data.connections[index].activeRun) return conflict();
      data.connections.splice(index, 1);
      return { disconnected: true as const };
    });
  }
  private async apply(userId: string, connectionId: string, runId: string,
    plan: (state: UserPlanningState, connection: SyncConnection) => void): Promise<void> {
    if (this.planning instanceof PostgresPlanningStore && this.sync instanceof PostgresCalendarSyncStore) {
      const sync = this.sync;
      if (this.planning.pool !== sync.pool) throw new Error('Calendar sync and planning must use the same database pool');
      await this.planning.atomicWithClient(userId, async client => {
        await sync.updateWithClient(client, userId, async data => {
          const c = data.connections.find(value => value.id === connectionId && value.activeRun === runId);
          if (!c) return conflict();
          await this.google(userId, c.accountRef);
          return this.planning.transaction(userId, state => plan(state, c));
        });
      });
      return;
    }
    if (this.planning.durable || this.sync instanceof PostgresCalendarSyncStore) throw new Error('Calendar sync stores must share a transaction');
    // Memory adapters are for isolated tests; production uses the shared PostgreSQL transaction above.
    await this.planning.atomic(userId, async () => this.sync.update(userId, async data => {
      const c = data.connections.find(value => value.id === connectionId && value.activeRun === runId);
      if (!c) return conflict();
      await this.google(userId, c.accountRef);
      return this.planning.transaction(userId, state => plan(state, c));
    }));
  }

  async run(userId: string, connectionId: string, input: { requestId: string; expectedRevision: number }) {
    if (!id(connectionId) || !id(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return bad();
    const runId = randomUUID();
    const fingerprint = digest(connectionId, String(input.expectedRevision));
    const start = await this.sync.update(userId, data => {
      const previous = data.operations.find(o => o.id === input.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return error(409, 'idempotency_conflict', '같은 요청 식별자를 다른 요청에 사용할 수 없습니다.');
        if (previous.state === 'completed') return { result: previous.result };
        return error(409, 'operation_in_progress', '이전 동기화 결과를 확인해 주세요.');
      }
      const connection = data.connections.find(c => c.id === connectionId);
      if (!connection) return error(404, 'not_found', '동기화 연결을 찾을 수 없습니다.');
      if (connection.revision !== input.expectedRevision || connection.activeRun) return conflict();
      if (data.operations.length >= 10000) return error(503, 'provider_unavailable', '동기화 기록 공간이 가득 찼습니다.');
      connection.activeRun = runId;
      data.operations.push({ id: input.requestId, fingerprint, state: 'running' });
      return { connection: structuredClone(connection) };
    });
    if ('result' in start) return start.result;
    const c = start.connection!;
    let imported = 0, exported = 0, deleted = 0, unsupportedCount = 0;
    const conflicts: Conflict[] = [];
    let uncertain = false;
    let token: string | null = null;
    let writesStarted = false;
    const addConflict = (reason: string, itemId?: string, eventId?: string) => conflicts.push({ reason, ...(itemId ? { itemId } : {}), ...(eventId ? { eventId } : {}) });
    const google = await this.google(userId, c.accountRef).catch(async e => {
      await this.sync.update(userId, data => {
        const connection = data.connections.find(v => v.id === c.id && v.activeRun === runId);
        if (connection) connection.activeRun = null;
        data.operations = data.operations.filter(v => v.id !== input.requestId);
      });
      throw e;
    });
    try {
      let allEvents: GoogleCalendarEvent[] = [];
      const load = async (syncToken?: string) => {
        const result: GoogleCalendarEvent[] = [];
        const seen = new Set<string>();
        let pageToken: string | undefined;
        for (let page = 0; page < 100; page++) {
          const response = await google.listEvents({ calendarId: c.calendarId, ...(syncToken ? { syncToken } : {}), ...(pageToken ? { pageToken } : {}) });
          result.push(...response.events);
          if (!response.nextPageToken) {
            if (!response.nextSyncToken) throw new Error('Missing sync token');
            return { result, next: response.nextSyncToken };
          }
          if (seen.has(response.nextPageToken)) throw new Error('Repeated page');
          seen.add(response.nextPageToken); pageToken = response.nextPageToken;
        }
        throw new Error('Page limit exceeded');
      };
      let listed;
      try { listed = await load(c.syncToken ?? undefined); }
      catch (e) {
        if (!c.syncToken || code(e) !== 'sync_token_expired') throw e;
        listed = await load();
      }
      allEvents = listed.result; token = listed.next;
      if (new Set(allEvents.map(e => e.id)).size !== allEvents.length) throw new Error('Duplicate event IDs');
      const events = new Map(allEvents.map(e => [e.id, e]));
      for (const event of allEvents) {
        if (event.status === 'cancelled' || c.mappings.some(m => m.eventId === event.id)) continue;
        if (unsupported(event)) { unsupportedCount++; continue; }
        const state = await this.planning.read(userId);
        const matches = [...state.items.values()].filter(item => item.sourceRefs.some(ref => ref.provider === 'google_calendar' &&
          (ref.accountRef === c.accountRef || ref.accountRef === `google:${google.subject}`) && ref.calendarId === c.calendarId && ref.externalEventId === event.id));
        if (matches.length > 1) { addConflict('duplicate_source', undefined, event.id); continue; }
        const existing = matches[0];
        if (existing && existing.involvement !== 'personal') { addConflict('contact_required', existing.id, event.id); continue; }
        const bindingId = digest(c.accountRef, c.calendarId, existing?.id ?? event.id);
        if (event.privateProperties.pIKKU && event.privateProperties.pIKKU !== bindingId) { addConflict('binding_mismatch', existing?.id, event.id); continue; }
        if (existing) {
          const ref = existing.sourceRefs.find(r => r.provider === 'google_calendar' && r.calendarId === c.calendarId && r.externalEventId === event.id &&
            (r.accountRef === c.accountRef || r.accountRef === `google:${google.subject}`))!;
          if (existing.revision !== 1 || !ref.sourceVersion) { addConflict('missing_baseline', existing.id, event.id); continue; }
          await this.apply(userId, c.id, runId, (s, current) => {
            if (s.items.get(existing.id)?.revision !== existing.revision || current.mappings.some(m => m.itemId === existing.id || m.eventId === event.id)) return conflict();
            current.mappings.push({ bindingId, itemId: existing.id, eventId: event.id, itemRevision: existing.revision, etag: ref.sourceVersion! });
            current.exportItemIds = current.exportItemIds.filter(id => id !== existing.id);
          });
          c.mappings.push({ bindingId, itemId: existing.id, eventId: event.id, itemRevision: existing.revision, etag: ref.sourceVersion });
          c.exportItemIds = c.exportItemIds.filter(id => id !== existing.id);
          continue;
        }
        if (event.privateProperties.pIKKU) { addConflict('unknown_binding', undefined, event.id); continue; }
        const itemId = randomUUID(), after = fields(event);
        let applied = false;
        await this.apply(userId, c.id, runId, (s, current) => {
          if ([...s.items.values()].some(item => item.sourceRefs.some(ref => ref.provider === 'google_calendar' &&
            (ref.accountRef === c.accountRef || ref.accountRef === `google:${google.subject}`) && ref.calendarId === c.calendarId && ref.externalEventId === event.id))) return;
          if (!assess(userId, s, { changeId: randomUUID(), operation: 'create', after })) return;
          const item: ScheduleItem = { ...after, id: itemId, revision: 1, sourceRefs: [{ provider: 'google_calendar', accountRef: c.accountRef,
            calendarId: c.calendarId, externalEventId: event.id, sourceVersion: event.etag!, lastSyncedAt: new Date().toISOString() }] };
          s.items.set(item.id, item); s.scheduleRevision++;
          const mapping = { bindingId: digest(c.accountRef, c.calendarId, item.id), itemId: item.id, eventId: event.id, itemRevision: 1, etag: event.etag! };
          current.mappings.push(mapping); c.mappings.push(mapping); applied = true;
        });
        if (applied) imported++; else addConflict('schedule_conflict', undefined, event.id);
      }
      for (const mapping of [...c.mappings]) {
        const state = await this.planning.read(userId);
        const snapshot = state.items.get(mapping.itemId);
        let event = events.get(mapping.eventId);
        if (!event) {
          try { event = await google.getEvent({ calendarId: c.calendarId, eventId: mapping.eventId }); }
          catch (e) { if (code(e) === 'not_found') { addConflict('remote_missing', mapping.itemId, mapping.eventId); continue; } throw e; }
        }
        if (event.id !== mapping.eventId) { addConflict('binding_mismatch', mapping.itemId, mapping.eventId); continue; }
        if (event.status !== 'cancelled' && (unsupported(event) || (event.privateProperties.pIKKU && event.privateProperties.pIKKU !== mapping.bindingId))) {
          addConflict('unsupported_or_shared', mapping.itemId, mapping.eventId); unsupportedCount++; continue;
        }
        const localChanged = !snapshot || snapshot.revision !== mapping.itemRevision;
        const remoteChanged = event.status === 'cancelled' || event.etag !== mapping.etag;
        if (localChanged && remoteChanged) { addConflict('both_changed', mapping.itemId, mapping.eventId); continue; }
        if ((!snapshot || event.status === 'cancelled') && !c.allowDeletes) { addConflict('delete_not_enabled', mapping.itemId, mapping.eventId); continue; }
        const tombstone = state.tombstones?.get(mapping.itemId);
        if (!snapshot && (!tombstone || tombstone.itemId !== mapping.itemId || tombstone.deletedRevision !== mapping.itemRevision + 1 || tombstone.priorInvolvement !== 'personal')) {
          addConflict('delete_requires_review', mapping.itemId, mapping.eventId); continue;
        }
        if (snapshot?.involvement === 'shared' && (localChanged || remoteChanged)) { addConflict('contact_required', mapping.itemId, mapping.eventId); continue; }
        if (event.status === 'cancelled' && snapshot) {
          let applied = false;
          await this.apply(userId, c.id, runId, (s, current) => {
            const item = s.items.get(mapping.itemId);
            if (!item || item.revision !== mapping.itemRevision || !assess(userId, s, { changeId: randomUUID(), operation: 'delete', targetId: item.id, expectedRevision: item.revision })) return;
            s.items.delete(item.id);
            (s.tombstones ??= new Map()).set(item.id, { itemId: item.id, deletedRevision: item.revision + 1,
              priorInvolvement: item.involvement, deletedAt: new Date().toISOString() });
            s.scheduleRevision++; current.mappings = current.mappings.filter(m => m.eventId !== mapping.eventId); applied = true;
          });
          if (applied) deleted++; else addConflict('schedule_conflict', mapping.itemId, mapping.eventId);
          continue;
        }
        if (remoteChanged && snapshot && event.status !== 'cancelled') {
          let applied = false;
          await this.apply(userId, c.id, runId, (s, current) => {
            const item = s.items.get(mapping.itemId);
            if (!item || item.revision !== mapping.itemRevision) return;
            const after: ScheduleFields = { ...item, title: event!.title!, timeSlot: event!.timeSlot! };
            if (!assess(userId, s, { changeId: randomUUID(), operation: 'update', targetId: item.id, expectedRevision: item.revision, after })) return;
            s.items.set(item.id, { ...item, ...after, revision: item.revision + 1, sourceRefs: item.sourceRefs.map(ref =>
              ref.provider === 'google_calendar' && ref.calendarId === c.calendarId && ref.externalEventId === event!.id &&
              (ref.accountRef === c.accountRef || ref.accountRef === `google:${google.subject}`) ? { ...ref, sourceVersion: event!.etag!, lastSyncedAt: new Date().toISOString() } : ref) });
            s.scheduleRevision++;
            const stored = current.mappings.find(m => m.eventId === mapping.eventId)!;
            stored.itemRevision = item.revision + 1; stored.etag = event!.etag!; applied = true;
          });
          if (applied) imported++; else addConflict('schedule_conflict', mapping.itemId, mapping.eventId);
          continue;
        }
        if (!localChanged) continue;
        if (snapshot && (snapshot.kind !== 'event' || !snapshot.timeSlot || snapshot.involvement !== 'personal')) { addConflict('unsupported_item', mapping.itemId, mapping.eventId); continue; }
        let writeCompleted = false;
        try {
          await this.planning.atomic(userId, async () => {
            const latestState = await this.planning.read(userId);
            const latest = latestState.items.get(mapping.itemId);
            if (latest?.revision !== snapshot?.revision) return conflict();
            if (!latest) {
              const deleted = latestState.tombstones?.get(mapping.itemId);
              if (!deleted || deleted.itemId !== mapping.itemId || deleted.deletedRevision !== mapping.itemRevision + 1 || deleted.priorInvolvement !== 'personal') return conflict();
            }
            const port = await this.google(userId, c.accountRef);
            const currentEvent = await port.getEvent({ calendarId: c.calendarId, eventId: mapping.eventId });
            if (currentEvent.id !== mapping.eventId || currentEvent.etag !== mapping.etag || currentEvent.status === 'cancelled' || unsupported(currentEvent) ||
              (currentEvent.privateProperties.pIKKU && currentEvent.privateProperties.pIKKU !== mapping.bindingId)) return conflict();
            writesStarted = true;
            if (!latest) { await port.deleteEvent({ calendarId: c.calendarId, eventId: mapping.eventId, etag: mapping.etag }); writeCompleted = true; }
            const updated = latest ? await port.updateEvent({ calendarId: c.calendarId, eventId: mapping.eventId, etag: mapping.etag, event: write(latest, mapping.bindingId) }) : undefined;
            if (latest) writeCompleted = true;
            if (updated && (updated.id !== mapping.eventId || !updated.etag)) { uncertain = true; throw new Error('Unknown write outcome'); }
            await this.apply(userId, c.id, runId, (s, current) => {
              if (!latest) current.mappings = current.mappings.filter(m => m.eventId !== mapping.eventId);
              else {
                const item = s.items.get(latest.id);
                if (!item || item.revision !== latest.revision) return conflict();
                item.sourceRefs = item.sourceRefs.map(ref => ref.provider === 'google_calendar' && ref.calendarId === c.calendarId && ref.externalEventId === mapping.eventId &&
                  (ref.accountRef === c.accountRef || ref.accountRef === `google:${google.subject}`)
                  ? { ...ref, sourceVersion: updated!.etag!, lastSyncedAt: new Date().toISOString() } : ref);
                const stored = current.mappings.find(m => m.eventId === mapping.eventId)!;
                stored.etag = updated!.etag!; stored.itemRevision = latest.revision;
              }
            });
          });
          writesStarted = false;
          if (snapshot) exported++; else deleted++;
        } catch (e) {
          if (writeCompleted || code(e) === 'outcome_unknown' || uncertain) { uncertain = true; addConflict('outcome_unknown', mapping.itemId, mapping.eventId); break; }
          if (code(e) === 'conflict' || e instanceof PlanningError || ['forbidden', 'not_found', 'invalid_request'].includes(String(code(e)))) {
            writesStarted = false; addConflict('concurrent_change', mapping.itemId, mapping.eventId); continue;
          }
          if (writesStarted) { uncertain = true; addConflict('outcome_unknown', mapping.itemId, mapping.eventId); break; }
          throw e;
        }
      }
      if (!uncertain) for (const itemId of c.exportItemIds) {
        if (c.mappings.some(m => m.itemId === itemId)) continue;
        const item = (await this.planning.read(userId)).items.get(itemId);
        if (!item || item.kind !== 'event' || item.involvement !== 'personal' || !item.timeSlot || item.sourceRefs.length) { addConflict('unsupported_item', itemId); continue; }
        const eventId = digest(c.accountRef, c.calendarId, item.id), bindingId = digest(c.accountRef, c.calendarId, item.id);
        let writeCompleted = false;
        try {
          await this.planning.atomic(userId, async () => {
            const latest = (await this.planning.read(userId)).items.get(itemId);
            if (!latest || latest.revision !== item.revision) return conflict();
            const port = await this.google(userId, c.accountRef);
            writesStarted = true;
            const result = await port.insertEvent({ calendarId: c.calendarId, eventId, event: write(latest, bindingId) });
            writeCompleted = true;
            if (result.id !== eventId || !result.etag) { uncertain = true; throw new Error('Unknown write outcome'); }
            await this.apply(userId, c.id, runId, (s, current) => {
              const stored = s.items.get(itemId)!;
              stored.sourceRefs.push({ provider: 'google_calendar', accountRef: c.accountRef, calendarId: c.calendarId, externalEventId: eventId,
                sourceVersion: result.etag!, lastSyncedAt: new Date().toISOString() });
              current.mappings.push({ bindingId, itemId, eventId, itemRevision: stored.revision, etag: result.etag! });
              current.exportItemIds = current.exportItemIds.filter(id => id !== itemId);
            });
          });
          writesStarted = false;
          exported++;
        } catch (e) {
          if (writeCompleted || code(e) === 'outcome_unknown' || uncertain) { uncertain = true; addConflict('outcome_unknown', itemId, eventId); break; }
          if (code(e) === 'conflict' || e instanceof PlanningError || ['forbidden', 'not_found', 'invalid_request'].includes(String(code(e)))) {
            writesStarted = false; addConflict('concurrent_change', itemId, eventId); continue;
          }
          if (writesStarted) { uncertain = true; addConflict('outcome_unknown', itemId, eventId); break; }
          throw e;
        }
      }
    } catch {
      if (writesStarted) uncertain = true;
      addConflict(uncertain ? 'outcome_unknown' : 'provider_unavailable');
    }
    return this.sync.update(userId, data => {
      const current = data.connections.find(v => v.id === c.id && v.activeRun === runId);
      const op = data.operations.find(v => v.id === input.requestId);
      if (!current || !op) return conflict();
      if (!uncertain) current.activeRun = null;
      if (!uncertain && conflicts.length === 0) current.syncToken = token;
      current.revision++;
      const result = { connection: publicConnection(current), imported, exported, deleted, conflicts, unsupportedCount };
      op.state = uncertain ? 'uncertain' : 'completed'; op.result = result;
      return result;
    });
  }
}
