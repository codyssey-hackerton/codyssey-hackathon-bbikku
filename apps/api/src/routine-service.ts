import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PlanningError, type PlanningService } from './planning-service.ts';
import type { PlanningStore } from './planning-store.ts';
import { routineCreate, routineInstant, routineMaterialize, routinePatch, type RoutineCreate, type RoutineMaterialize, type RoutinePatch } from './routine-schemas.ts';

type AtomicStore = PlanningStore & { pool: Pool; atomicWithClient<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> };
export type Routine = Omit<RoutineCreate, 'requestId'> & { id: string; revision: number; active: boolean };
export type RoutineConflict = { routineId: string; date: string; code: 'schedule_conflict' | 'invalid_local_time' };
type Materialized = { createdCount: number; existingCount: number; conflicts: RoutineConflict[]; scheduleRevision: number };
type Options = { pool: Pool; planning: PlanningService; store: PlanningStore; clock?: () => Date };

export const routineMigration = `
CREATE TABLE IF NOT EXISTS pikku_routines_v1 (
  user_id text NOT NULL, routine_id text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  data jsonb NOT NULL, PRIMARY KEY (user_id, routine_id)
);
CREATE TABLE IF NOT EXISTS pikku_routine_occurrences_v1 (
  user_id text NOT NULL, routine_id text NOT NULL, occurrence_date date NOT NULL, item_id text NOT NULL,
  PRIMARY KEY (user_id, routine_id, occurrence_date),
  FOREIGN KEY (user_id, routine_id) REFERENCES pikku_routines_v1(user_id, routine_id)
);
CREATE TABLE IF NOT EXISTS pikku_routine_requests_v1 (
  user_id text NOT NULL, operation text NOT NULL, request_key text NOT NULL,
  fingerprint text NOT NULL, result jsonb NOT NULL, PRIMARY KEY (user_id, operation, request_key)
)`;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function badRequest(): never { throw new PlanningError(400, 'invalid_request', '루틴 입력을 확인해 주세요.'); }
function requireIdentity(userId: string, key?: string) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 200 || (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200))) badRequest();
}

export function createRoutineService({ pool, planning, store, clock = () => new Date() }: Options) {
  const atomicStore = store as Partial<AtomicStore>;
  function atomic<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    if (planning.store !== store || store.mode !== 'postgres' || !store.durable || atomicStore.pool !== pool || typeof atomicStore.atomicWithClient !== 'function') {
      throw new PlanningError(503, 'not_configured', '루틴 저장소가 준비되지 않았습니다.');
    }
    return atomicStore.atomicWithClient(userId, run);
  }
  async function mutate<T>(userId: string, key: string, operation: string, requestId: string, payload: unknown, run: (client: PoolClient) => Promise<T>): Promise<{ requestId: string; data: T }> {
    if (typeof key !== 'string') badRequest();
    requireIdentity(userId, key);
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
    return atomic(userId, async client => {
      const previous = await client.query('SELECT fingerprint, result FROM pikku_routine_requests_v1 WHERE user_id=$1 AND operation=$2 AND request_key=$3', [userId, operation, key]);
      if (previous.rows.length) {
        if (previous.rows[0].fingerprint !== fingerprint) throw new PlanningError(409, 'idempotency_conflict', '동일한 중복 키에 다른 요청을 사용할 수 없습니다.');
        return previous.rows[0].result as { requestId: string; data: T };
      }
      const result = { requestId, data: await run(client) };
      await client.query('INSERT INTO pikku_routine_requests_v1(user_id,operation,request_key,fingerprint,result) VALUES($1,$2,$3,$4,$5::jsonb)',
        [userId, operation, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
  return {
    async migrate() {
      if (planning.store !== store || store.mode !== 'postgres' || !store.durable || atomicStore.pool !== pool || typeof atomicStore.atomicWithClient !== 'function') throw new PlanningError(503, 'not_configured', '루틴 저장소가 준비되지 않았습니다.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [174274, 2]);
        await client.query(routineMigration);
        await client.query('COMMIT');
      } catch (error) { try { await client.query('ROLLBACK'); } catch { /* connection may be lost */ } throw error; }
      finally { client.release(); }
    },
    async list(userId: string): Promise<{ routines: Routine[] }> {
      requireIdentity(userId);
      if (planning.store !== store || store.mode !== 'postgres' || !store.durable || atomicStore.pool !== pool || typeof atomicStore.atomicWithClient !== 'function') throw new PlanningError(503, 'not_configured', '루틴 저장소가 준비되지 않았습니다.');
      const result = await pool.query('SELECT data FROM pikku_routines_v1 WHERE user_id=$1 ORDER BY routine_id', [userId]);
      return { routines: result.rows.map(row => row.data as Routine) };
    },
    async create(userId: string, key: string, input: RoutineCreate): Promise<{ requestId: string; data: { routine: Routine } }> {
      const parsed = routineCreate.safeParse(input); if (!parsed.success) return badRequest();
      const { requestId, ...fields } = parsed.data;
      return mutate(userId, key, 'create', requestId, fields, async client => {
        const routine: Routine = { ...fields, id: randomUUID(), revision: 1, active: true };
        await client.query('INSERT INTO pikku_routines_v1(user_id,routine_id,revision,data) VALUES($1,$2,$3,$4::jsonb)', [userId, routine.id, routine.revision, JSON.stringify(routine)]);
        return { routine };
      });
    },
    async patch(userId: string, key: string, id: string, input: RoutinePatch): Promise<{ requestId: string; data: { routine: Routine } }> {
      const parsed = routinePatch.safeParse(input); if (!parsed.success || typeof id !== 'string' || !id.trim() || id.length > 200) return badRequest();
      const { requestId, expectedRevision, ...updates } = parsed.data;
      return mutate(userId, key, 'patch', requestId, { id, expectedRevision, ...updates }, async client => {
        const existing = await client.query('SELECT data FROM pikku_routines_v1 WHERE user_id=$1 AND routine_id=$2 FOR UPDATE', [userId, id]);
        if (!existing.rows.length) throw new PlanningError(404, 'not_found', '루틴을 찾을 수 없습니다.');
        const current = existing.rows[0].data as Routine;
        if (current.revision !== expectedRevision) throw new PlanningError(409, 'conflict', '루틴 버전이 변경되었습니다.');
        const routine = { ...current, ...updates, revision: current.revision + 1 };
        await client.query('UPDATE pikku_routines_v1 SET revision=$3,data=$4::jsonb WHERE user_id=$1 AND routine_id=$2', [userId, id, routine.revision, JSON.stringify(routine)]);
        return { routine };
      });
    },
    async materialize(userId: string, key: string, input: RoutineMaterialize): Promise<{ requestId: string; data: Materialized }> {
      const parsed = routineMaterialize.safeParse(input); if (!parsed.success) return badRequest();
      const { requestId, fromDate, toDate } = parsed.data;
      return mutate(userId, key, 'materialize', requestId, { fromDate, toDate }, async client => {
        const rows = await client.query('SELECT data FROM pikku_routines_v1 WHERE user_id=$1 ORDER BY routine_id FOR UPDATE', [userId]);
        let createdCount = 0, existingCount = 0; const conflicts: RoutineConflict[] = [];
        for (const { data } of rows.rows) {
          const routine = data as Routine;
          if (!routine.active) continue;
          for (let day = Date.parse(`${fromDate}T00:00:00Z`); day <= Date.parse(`${toDate}T00:00:00Z`); day += 86_400_000) {
            const date = new Date(day).toISOString().slice(0, 10);
            const weekday = new Date(day).getUTCDay() || 7;
            if (date < routine.startDate || !routine.weekdays.includes(weekday)) continue;
            const existing = await client.query('SELECT 1 FROM pikku_routine_occurrences_v1 WHERE user_id=$1 AND routine_id=$2 AND occurrence_date=$3', [userId, routine.id, date]);
            if (existing.rows.length) { existingCount++; continue; }
            const startsAt = routineInstant(date, routine.localTime, routine.timezone);
            if (!startsAt) { conflicts.push({ routineId: routine.id, date, code: 'invalid_local_time' }); continue; }
            const endsAt = new Date(Date.parse(startsAt) + routine.durationMinutes * 60_000).toISOString();
            if (endsAt.length !== 24) { conflicts.push({ routineId: routine.id, date, code: 'invalid_local_time' }); continue; }
            try {
              const revision = (await store.read(userId)).scheduleRevision;
              const result = await planning.command(userId, { expectedScheduleRevision: revision, changeSet: { changes: [{ changeId: randomUUID(), operation: 'create',
                after: { kind: 'task', title: routine.title, timeSlot: { startsAt, endsAt, timezone: routine.timezone }, durationMinutes: routine.durationMinutes,
                  deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' } }] } });
              const item = result.items[0]; if (!item || result.items.length !== 1) throw new Error('Invalid routine occurrence');
              await store.transaction(userId, state => {
                const stored = state.items.get(item.id); if (!stored) throw new Error('Missing routine occurrence');
                stored.sourceRefs.push({ provider: 'routine', accountRef: userId, calendarId: routine.id, externalEventId: date, lastSyncedAt: clock().toISOString() });
              });
              await client.query('INSERT INTO pikku_routine_occurrences_v1(user_id,routine_id,occurrence_date,item_id) VALUES($1,$2,$3,$4)', [userId, routine.id, date, item.id]);
              createdCount++;
            } catch (error) {
              if (error instanceof PlanningError && error.code === 'conflict') conflicts.push({ routineId: routine.id, date, code: 'schedule_conflict' });
              else throw error;
            }
          }
        }
        return { createdCount, existingCount, conflicts, scheduleRevision: (await store.read(userId)).scheduleRevision };
      });
    },
  };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
