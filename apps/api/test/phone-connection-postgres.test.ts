import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
test('phone connection requests for one user serialize across PostgreSQL-backed API instances', { skip: !connectionString, timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-lock-test-'));
  const schema = `pikku_phone_lock_${randomUUID().replaceAll('-', '')}`;
  const appName = `pikku_phone_b_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  const pools: pg.Pool[] = []; const apps: ReturnType<typeof buildApp>[] = [];
  let releaseA!: () => void; let signalA!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const enteredA = new Promise<void>(resolve => { signalA = resolve; });
  const accountSid = `AC${'1'.repeat(32)}`; const fromNumber = '+12025550123';
  const tokenA = 'a'.repeat(32); const tokenB = 'b'.repeat(32); const providerCalls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    const user = authorization === `Basic ${Buffer.from(`${accountSid}:${tokenA}`).toString('base64')}` ? 'A'
      : authorization === `Basic ${Buffer.from(`${accountSid}:${tokenB}`).toString('base64')}` ? 'B' : 'unexpected';
    providerCalls.push(user);
    if (user === 'A') { signalA(); await gateA; }
    return Response.json({ incoming_phone_numbers: [{ phone_number: fromNumber, capabilities: { voice: true } }] });
  };
  t.after(async () => {
    releaseA();
    for (const app of apps) await app.close();
    for (const pool of pools) await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const open = async (applicationName: string) => {
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, application_name: applicationName, max: 3 });
    pools.push(pool);
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const connections = new PhoneConnections({ directory, fetcher });
    const app = buildApp({ store, phoneConnections: connections, allowLocalPhoneConnect: true,
      sessions: { resolve: async () => ({ userId: 'same-user' }) } });
    apps.push(app); return { app, connections };
  };
  const a = await open('pikku_phone_a'); const b = await open(appName);
  const send = (app: ReturnType<typeof buildApp>, requestId: string, authToken: string) => app.inject({
    method: 'POST', url: '/v1/phone-connection', headers: { authorization: 'Bearer synthetic' },
    payload: { requestId, accountSid, authToken, fromNumber },
  });
  const first = send(a.app, 'request-A', tokenA);
  await enteredA;
  const second = send(b.app, 'request-B', tokenB);
  let waiting = false;
  const deadline = Date.now() + 5_000;
  while (!waiting && Date.now() < deadline) {
    const result = await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = $2', [appName, 'Lock']);
    waiting = result.rowCount !== 0;
    if (!waiting) await delay(20);
  }
  try {
    assert.ok(waiting, 'second API instance did not wait on a PostgreSQL lock');
    assert.deepEqual(providerCalls, ['A']);
  } finally { releaseA(); }
  const [resultA, resultB] = await Promise.all([first, second]);
  assert.equal(resultA.statusCode, 200); assert.equal(resultA.json().data.lastRequestId, 'request-A');
  assert.equal(resultB.statusCode, 200); assert.equal(resultB.json().data.lastRequestId, 'request-B');
  assert.deepEqual(providerCalls, ['A', 'B']);
  assert.deepEqual(await b.connections.status('same-user'), { status: 'available', senderNumber: fromNumber, lastRequestId: 'request-B' });
  assert.deepEqual(await b.connections.read('same-user'), { accountSid, authToken: tokenB, fromNumber });
});
