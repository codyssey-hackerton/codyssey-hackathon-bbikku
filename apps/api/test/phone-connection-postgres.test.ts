import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

const connectionString = process.env.PIKKU_TEST_DATABASE_URL;
test('two PostgreSQL-backed API instances reject phone credential writes while operator provisioning remains user-scoped', { skip: !connectionString, timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-lock-test-'));
  const schema = `pikku_phone_lock_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  const pools: pg.Pool[] = []; const apps: ReturnType<typeof buildApp>[] = [];
  let providerCalls = 0;
  const credential = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), fromNumber: '+12025550123' };
  const fetcher: typeof fetch = async () => {
    providerCalls++;
    return Response.json({ incoming_phone_numbers: [{ phone_number: credential.fromNumber, capabilities: { voice: true } }] });
  };
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const pool of pools) await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const open = async () => {
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 }); pools.push(pool);
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const connections = new PhoneConnections({ directory, fetcher });
    const app = buildApp({ store, phoneConnections: connections,
      sessions: { resolve: async token => ({ userId: token === 'other' ? 'other-user' : 'same-user' }) } });
    apps.push(app); return { app, connections };
  };
  const a = await open(); const b = await open();
  const provisioned = await a.connections.connect('same-user', credential, 'operator-setup');
  assert.equal(providerCalls, 1);
  const files = await readdir(directory);
  const contents = await Promise.all(files.map(name => readFile(join(directory, name))));
  const send = (app: ReturnType<typeof buildApp>, token: string) => app.inject({
    method: 'POST', url: '/v1/phone-connection', headers: { authorization: `Bearer ${token}` },
    payload: { requestId: 'attempt', ...credential, authToken: 'b'.repeat(32) },
  });
  const writes = await Promise.all([send(a.app, 'owner'), send(b.app, 'owner'), send(b.app, 'other')]);
  for (const response of writes) { assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, 'permission_denied'); }
  assert.equal(providerCalls, 1);
  assert.deepEqual(await readdir(directory), files);
  assert.deepEqual(await Promise.all(files.map(name => readFile(join(directory, name)))), contents);
  const owner = await b.app.inject({ method: 'GET', url: '/v1/phone-connection', headers: { authorization: 'Bearer owner' } });
  const other = await b.app.inject({ method: 'GET', url: '/v1/phone-connection', headers: { authorization: 'Bearer other' } });
  assert.deepEqual(owner.json().data, provisioned);
  assert.deepEqual(other.json().data, { status: 'not_configured', senderNumber: null, lastRequestId: null });
  assert.doesNotMatch(owner.body, /aaaaaaaa|AC111111/);
});
