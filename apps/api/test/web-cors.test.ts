import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { MemoryPlanningStore, type PlanningStore } from '../src/planning-store.ts';

test('preview permits only configured browser origins and keeps routes authenticated', async () => {
  const app = buildApp({ webOrigins: ['https://preview.example.test'], previewRateLimit: true });
  try {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/schedule', headers: { origin: 'https://preview.example.test', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://preview.example.test');
    const forbidden = await app.inject({ method: 'GET', url: '/v1/schedule', headers: { origin: 'https://other.example.test' } });
    assert.equal(forbidden.statusCode, 401);
    assert.equal(forbidden.headers['access-control-allow-origin'], undefined);
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  } finally { await app.close(); }
});

test('phone credentials are provisioned by the operator and HTTP writes cannot change files or call the provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pikku-phone-receipt-'));
  let providerCalls = 0;
  const phoneConnections = new PhoneConnections({ directory, fetcher: async () => {
    providerCalls++;
    return Response.json({ incoming_phone_numbers: [{ phone_number: '+12025550123', capabilities: { voice: true } }] });
  } });
  const credential = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), fromNumber: '+12025550123' };
  const memory = new MemoryPlanningStore();
  const store: PlanningStore = { mode: 'memory', durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
    atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  const app = buildApp({ store, phoneConnections, sessions: {
    resolve: async token => ({ userId: token === 'other' ? 'other-user' : 'user' }),
  } });
  try {
    const provisioned = await phoneConnections.connect('user', credential, 'receipt-1');
    assert.equal(providerCalls, 1);
    const files = (await readdir(directory)).sort();
    const contents = await Promise.all(files.map(name => readFile(join(directory, name))));
    const metadata = await Promise.all(files.map(async name => {
      const info = await stat(join(directory, name)); return { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs };
    }));
    const unauthenticated = await app.inject({ method: 'POST', url: '/v1/phone-connection', payload: { requestId: 'attempt', ...credential } });
    assert.equal(unauthenticated.statusCode, 401);
    for (const token of ['owner', 'other']) {
      const post = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers: { authorization: `Bearer ${token}` },
        payload: { requestId: 'overwrite', ...credential, fromNumber: '+12025550124' } });
      assert.equal(post.statusCode, 403);
      assert.equal(post.json().error.code, 'permission_denied');
      assert.doesNotMatch(post.body, /bbbbbbbb|ACaaaaaaaa/);
    }
    const empty = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers: { authorization: 'Bearer owner' }, payload: {} });
    assert.equal(empty.statusCode, 403);
    assert.equal(empty.json().error.code, 'permission_denied');
    assert.deepEqual((await readdir(directory)).sort(), files);
    assert.deepEqual(await Promise.all(files.map(name => readFile(join(directory, name)))), contents);
    assert.deepEqual(await Promise.all(files.map(async name => {
      const info = await stat(join(directory, name)); return { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs };
    })), metadata);
    assert.equal(providerCalls, 1);
    const status = await app.inject({ method: 'GET', url: '/v1/phone-connection', headers: { authorization: 'Bearer owner' } });
    assert.deepEqual(status.json().data, provisioned);
    assert.doesNotMatch(status.body, /bbbbbbbb|ACaaaaaaaa/);
    const other = await app.inject({ method: 'GET', url: '/v1/phone-connection', headers: { authorization: 'Bearer other' } });
    assert.deepEqual(other.json().data, { status: 'not_configured', senderNumber: null, lastRequestId: null });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('phone connection write is forbidden without durable storage before contacting the provider', async () => {
  let providerCalls = 0;
  const phoneConnections = new PhoneConnections({ directory: undefined, fetcher: async () => { providerCalls++; throw new Error('unexpected provider call'); } });
  const app = buildApp({ phoneConnections, sessions: { resolve: async () => ({ userId: 'user' }) } });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/phone-connection', headers: { authorization: 'Bearer owner' },
      payload: { requestId: 'receipt-1', accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), fromNumber: '+12025550123' } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'permission_denied');
    assert.equal(providerCalls, 0);
  } finally { await app.close(); }
});

test('phone connection write remains forbidden even with forwarded HTTPS', async () => {
  const app = buildApp({ trustLoopbackProxy: true, sessions: { resolve: async () => ({ userId: 'synthetic-user' }) } });
  try {
    const payload = { requestId: 'test', accountSid: 'test', authToken: 'test', fromNumber: '+12025550123' };
    const headers = { authorization: 'Bearer synthetic', 'x-forwarded-proto': 'https' };
    const spoofed = await app.inject({ method: 'POST', url: '/v1/phone-connection', remoteAddress: '198.51.100.1', headers, payload });
    assert.equal(spoofed.statusCode, 403);
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const trusted = await app.inject({ method: 'POST', url: '/v1/phone-connection', remoteAddress, headers, payload });
      assert.equal(trusted.statusCode, 403);
      assert.equal(trusted.json().error.code, 'permission_denied');
    }
  } finally { await app.close(); }
});
