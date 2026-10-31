import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { routineCreate, routineInstant, routineMaterialize } from '../src/routine-schemas.ts';
import { createRoutineService } from '../src/routine-service.ts';
import { registerRoutineRoutes } from '../src/routine-routes.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';
import { PlanningError, PlanningService } from '../src/planning-service.ts';

const rule = { requestId: 'request-1', title: '합성 루틴', weekdays: [2, 1, 1], timezone: 'UTC', startDate: '2030-01-07', localTime: '09:00', durationMinutes: 30 };
const window = { requestId: 'request-m', fromDate: '2030-01-07', toDate: '2030-01-08' };

test('validates dates, bounded windows and ISO weekdays; rejects DST gaps and ambiguity', () => {
  assert.deepEqual(routineCreate.parse(rule).weekdays, [1, 2]);
  assert.equal(routineCreate.safeParse({ ...rule, startDate: '2030-02-30' }).success, false);
  assert.equal(routineCreate.safeParse({ ...rule, timezone: 'not/a-zone' }).success, false);
  assert.equal(routineMaterialize.safeParse({ ...window, toDate: '2030-02-07' }).success, false);
  assert.equal(routineInstant('2026-03-08', '02:30', 'America/New_York'), null);
  assert.equal(routineInstant('2026-11-01', '01:30', 'America/New_York'), null);
  assert.equal(routineInstant('2026-11-01', '03:30', 'America/New_York'), '2026-11-01T08:30:00.000Z');
});

test('missing storage fails closed and routes require authenticated user', async () => {
  const store = new MemoryPlanningStore(); const pool = {} as pg.Pool;
  const service = createRoutineService({ pool, store, planning: new PlanningService(store) });
  await assert.rejects(service.create('member:test', 'key', rule), (error: unknown) => error instanceof PlanningError && error.status === 503);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof PlanningError ? error.status : 500).send(); });
  registerRoutineRoutes(app, {});
  assert.equal((await app.inject({ method: 'GET', url: '/v1/routines' })).statusCode, 401);
  await app.close();
  const app2 = Fastify();
  app2.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof PlanningError ? error.status : 500).send(); });
  registerRoutineRoutes(app2, { resolveUser: () => 'member:test' });
  assert.equal((await app2.inject({ method: 'GET', url: '/v1/routines' })).statusCode, 503);
  await app2.close();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('isolated PostgreSQL: idempotency, ownership, conflict, checkin and existing future occurrences', { skip: process.env.PIKKU_ROUTINE_ISOLATED_PG !== '1', timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-routine-test-')); const port = await freePort();
  const embedded = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), user: 'routine_test', password: 'synthetic-test-password', port,
    persistent: false, onLog: () => {}, onError: () => {} });
  let pool: pg.Pool | undefined; let started = false;
  try {
    await embedded.initialise(); await embedded.start(); started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'routine_test', password: 'synthetic-test-password', database: 'postgres' });
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const planning = new PlanningService(store, () => new Date('2029-12-01T00:00:00Z'));
    const service = createRoutineService({ pool, store, planning, clock: () => new Date('2029-12-01T00:00:00Z') }); await service.migrate();
    const user = 'member:synthetic-a';
    const created = await service.create(user, 'create-key', rule); const id = created.data.routine.id;
    assert.deepEqual(await service.create(user, 'create-key', { ...rule, requestId: 'retry' }), created);
    await assert.rejects(service.create(user, 'create-key', { ...rule, title: '다른 내용' }), (e: unknown) => e instanceof PlanningError && e.code === 'idempotency_conflict');
    assert.equal((await service.list('member:synthetic-b')).routines.length, 0);
    await assert.rejects(service.patch('member:synthetic-b', 'key', id, { requestId: 'r', expectedRevision: 1, active: false }), (e: unknown) => e instanceof PlanningError && e.status === 404);
    const other = await service.create('member:synthetic-b', 'create-key', { ...rule, title: '다른 사용자' });
    assert.notEqual(other.data.routine.id, id); assert.equal((await service.list(user)).routines.length, 1);
    await planning.command(user, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'busy', operation: 'create', after: {
      kind: 'event', title: '기존 일정', timeSlot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z', timezone: 'UTC' },
      durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' } }] } });
    const result = await service.materialize(user, 'materialize-key', window);
    assert.equal(result.data.createdCount, 1); assert.equal(result.data.conflicts[0]?.code, 'schedule_conflict');
    assert.deepEqual(await service.materialize(user, 'materialize-key', { ...window, requestId: 'retry' }), result);
    const item = [...(await store.read(user)).items.values()].find(value => value.sourceRefs.some(ref => ref.provider === 'routine'))!;
    assert.equal(item.sourceRefs[0]?.externalEventId, '2030-01-07');
    await planning.checkin(user, item.id, { expectedRevision: 1, completion: 'completed' });
    const repeat = await service.materialize(user, 'new-key', window);
    assert.equal(repeat.data.existingCount, 1); assert.equal((await store.read(user)).items.get(item.id)?.completion, 'completed');
    await service.patch(user, 'patch-key', id, { requestId: 'patch', expectedRevision: 1, title: '수정' });
    assert.equal((await store.read(user)).items.get(item.id)?.title, '합성 루틴');
    const next = { requestId: 'next', fromDate: '2030-01-14', toDate: '2030-01-14' };
    const parallel = await Promise.all([service.materialize(user, 'parallel-a', next), service.materialize(user, 'parallel-b', next)]);
    assert.equal(parallel.reduce((sum, value) => sum + value.data.createdCount, 0), 1);
    assert.equal(parallel.reduce((sum, value) => sum + value.data.existingCount, 0), 1);
    assert.equal([...((await store.read(user)).items.values())].filter(value => value.title === '수정').length, 1);

    const failingStore = { mode: store.mode, durable: store.durable, pool, read: store.read.bind(store), transaction: store.transaction.bind(store),
      atomic: store.atomic.bind(store), listUserIds: store.listUserIds.bind(store), transactionTimestamp: store.transactionTimestamp.bind(store),
      atomicWithClient: <T>(actor: string, run: (client: pg.PoolClient) => Promise<T>) => store.atomicWithClient(actor, client => {
        const proxy = new Proxy(client, { get(target, property) {
          if (property === 'query') return (...args: unknown[]) => {
            if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO pikku_routine_occurrences_v1')) throw new Error('synthetic write failure');
            return Reflect.apply(target.query, target, args);
          };
          const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        return run(proxy);
      }) };
    const failing = createRoutineService({ pool, store: failingStore, planning: new PlanningService(failingStore, () => new Date('2029-12-01T00:00:00Z')) });
    const beforeFailure = await store.read(user);
    const afterWindow = { requestId: 'rollback', fromDate: '2030-01-21', toDate: '2030-01-21' };
    await assert.rejects(failing.materialize(user, 'rollback-key', afterWindow), /synthetic write failure/);
    const afterFailure = await store.read(user);
    assert.equal(afterFailure.scheduleRevision, beforeFailure.scheduleRevision); assert.equal(afterFailure.items.size, beforeFailure.items.size);
    assert.equal((await service.materialize(user, 'rollback-key', afterWindow)).data.createdCount, 1);

    const api = Fastify();
    api.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof PlanningError ? error.status : 500).send(); });
    registerRoutineRoutes(api, { service, resolveUser: request => request.headers.authorization === 'Bearer synthetic' ? user : undefined });
    const headers = { authorization: 'Bearer synthetic', 'idempotency-key': 'http-key' };
    const response = await api.inject({ method: 'POST', url: '/v1/routines/materialize', headers, payload: next });
    assert.equal(response.statusCode, 200); assert.equal(response.json().data.existingCount, 1);
    assert.equal((await api.inject({ method: 'POST', url: '/v1/routines/materialize', headers: { authorization: 'Bearer synthetic' }, payload: next })).statusCode, 400);
    assert.equal((await api.inject({ method: 'GET', url: '/v1/routines', headers })).json().data.routines.length, 1);
    await api.close();

    await service.patch(user, 'disable-key', id, { requestId: 'disable', expectedRevision: 2, active: false });
    assert.equal((await service.materialize(user, 'inactive-key', window)).data.createdCount, 0);
    assert.equal((await service.list(user)).routines[0]?.active, false);
    const restartedStore = new PostgresPlanningStore(pool);
    const restarted = createRoutineService({ pool, store: restartedStore, planning: new PlanningService(restartedStore) });
    assert.equal((await restarted.list(user)).routines[0]?.active, false);
  } finally { if (pool) await pool.end(); if (started) await embedded.stop(); await rm(dir, { recursive: true, force: true }); }
});
