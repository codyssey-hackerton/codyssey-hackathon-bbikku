import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;

test('atomicWithClient commits and rolls back SQL and planning state together', { skip: !connectionString }, async () => {
  const schema = `pikku_atomic_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 });
  const store = new PostgresPlanningStore(pool);
  const deletedAt = '2030-01-01T00:00:00.000Z';
  const planning = new PlanningService(store, () => new Date(deletedAt));
  const userId = `user-${randomUUID()}`;
  const task = { kind: 'task' as const, title: '합성 작업', timeSlot: null, durationMinutes: 30, deadline: null,
    flexibility: 'flexible' as const, involvement: 'personal' as const, completion: 'pending' as const };
  try {
    await store.migrate();
    await pool.query('CREATE TABLE atomic_test (value text NOT NULL)');

    const result = await store.atomicWithClient(userId, async client => {
      await client.query('INSERT INTO atomic_test(value) VALUES ($1)', ['committed']);
      await planning.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'first', operation: 'create', after: task }] } });
      await store.atomicWithClient(userId, async nested => { assert.equal(nested, client); });
      assert.equal((await store.read(userId)).scheduleRevision, 1);
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal((await store.read(userId)).scheduleRevision, 1);
    assert.equal((await store.read(userId)).items.size, 1);
    assert.deepEqual((await pool.query('SELECT value FROM atomic_test')).rows, [{ value: 'committed' }]);

    const item = [...(await store.read(userId)).items.values()][0]!;
    assert.equal((await store.read(userId)).tombstones?.size, 0);
    const oldDocument = (await pool.query('SELECT state FROM pikku_user_state_v1 WHERE user_id = $1', [userId])).rows[0].state;
    assert.equal(Object.hasOwn(oldDocument, 'tombstones'), false);
    const deletion = { expectedScheduleRevision: 1, changeSet: { changes: [
      { changeId: 'delete', operation: 'delete' as const, targetId: item.id, expectedRevision: item.revision },
    ] } };
    await assert.rejects(store.atomicWithClient(userId, async client => {
      await client.query('INSERT INTO atomic_test(value) VALUES ($1)', ['delete-rolled-back']);
      await planning.command(userId, deletion);
      throw new Error('delete rollback');
    }), /delete rollback/);
    const rolledBack = await store.read(userId);
    assert.equal(rolledBack.items.has(item.id), true);
    assert.equal(rolledBack.tombstones?.size, 0);
    assert.equal(rolledBack.scheduleRevision, 1);
    assert.deepEqual((await pool.query('SELECT value FROM atomic_test')).rows, [{ value: 'committed' }]);

    await store.atomicWithClient(userId, async client => {
      await client.query('INSERT INTO atomic_test(value) VALUES ($1)', ['deleted']);
      await planning.command(userId, deletion);
    });
    const reconnectedPool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      const reconnected = await new PostgresPlanningStore(reconnectedPool).read(userId);
      assert.equal(reconnected.items.has(item.id), false);
      assert.equal(reconnected.scheduleRevision, 2);
      assert.deepEqual(reconnected.tombstones?.get(item.id), {
        itemId: item.id, deletedRevision: item.revision + 1, priorInvolvement: item.involvement, deletedAt,
      });
      assert.deepEqual((await reconnectedPool.query('SELECT value FROM atomic_test ORDER BY value')).rows, [{ value: 'committed' }, { value: 'deleted' }]);
    } finally { await reconnectedPool.end(); }

    await assert.rejects(store.atomicWithClient(userId, async client => {
      await client.query('INSERT INTO atomic_test(value) VALUES ($1)', ['rolled-back']);
      await planning.command(userId, { expectedScheduleRevision: 2, changeSet: { changes: [{ changeId: 'second', operation: 'create', after: task }] } });
      throw new Error('deliberate rollback');
    }), /deliberate rollback/);
    assert.equal((await store.read(userId)).scheduleRevision, 2);
    assert.equal((await store.read(userId)).items.size, 0);
    assert.deepEqual((await pool.query('SELECT value FROM atomic_test ORDER BY value')).rows, [{ value: 'committed' }, { value: 'deleted' }]);

    let called = false;
    await store.atomic(userId, async () => {
      await assert.rejects(store.atomicWithClient('another-user', async () => { called = true; }), /Cross-user transaction not allowed/);
      await store.atomicWithClient(userId, async client => { assert.equal((await client.query('SELECT 1 AS value')).rows[0].value, 1); });
    });
    assert.equal(called, false);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
