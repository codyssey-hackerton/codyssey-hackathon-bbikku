import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/http';
import { createCalendarSyncClient } from '../src/calendar-sync/client';

test('run 응답 유실 후 running·uncertain·404·잘못된 결과는 잠금 유지하며 완료 결과만 수용한다', async () => {
  const methods: { method: string | undefined; path: string }[] = []; let reads = 0;
  const validConnection = { id: 'sync', calendarId: 'cal', revision: 2, allowDeletes: false, status: 'connected', pendingExportCount: 0 };
  const result = { connection: validConnection, imported: 1, exported: 0, deleted: 0, unsupportedCount: 0, conflicts: [] };
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'synthetic', fetcher: async (raw, init) => {
    const path = new URL(String(raw)).pathname; methods.push({ method: init?.method, path });
    if (init?.method === 'POST') throw new Error('lost');
    reads++;
    if (reads === 3) return Response.json({ requestId: 'r', error: { code: 'not_found', message: 'not found', retryable: false } }, { status: 404 });
    const operation = reads === 1 ? { state: 'running' } : reads === 2 ? { state: 'uncertain', result } : reads === 4 ? { state: 'completed', result: { ...result, connection: { ...validConnection, id: 'other' } } } : { state: 'completed', result };
    return Response.json({ requestId: 'r', data: { operation } });
  } });
  const client = createCalendarSyncClient(api);
  const op = { requestId: 'request/1', idempotencyKey: 'key', input: { id: 'sync', expectedRevision: 1 } };
  await assert.rejects(client.run(op));
  for (let i = 0; i < 4; i++) await assert.rejects(client.run(op));
  assert.deepEqual(await client.run(op), result);
  assert.equal(methods.filter(item => item.method === 'POST').length, 1);
  assert.equal(methods.filter(item => item.method === 'GET').length, 5);
  assert.ok(methods.slice(1).every(item => item.path === '/v1/calendar-sync/operations/request%2F1'));
});

test('내보내기 대기열 응답이 다른 연결이나 revision이면 성공으로 처리하지 않는다', async () => {
  let posted: any;
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'synthetic', fetcher: async (raw, init) => {
    posted = { path: new URL(String(raw)).pathname, body: JSON.parse(String(init?.body)), headers: init?.headers };
    return Response.json({ requestId: 'r', data: { connection: { id: 'other', calendarId: 'cal', revision: 2, allowDeletes: false, status: 'connected', pendingExportCount: 1 } } });
  } });
  const op = { requestId: 'request-1', idempotencyKey: 'key-1', input: { id: 'sync', expectedRevision: 1, exportItemIds: ['item'] } };
  await assert.rejects(createCalendarSyncClient(api).addExports(op));
  assert.equal(posted.path, '/v1/calendar-sync/sync/exports');
  assert.deepEqual(posted.body, { requestId: 'request-1', expectedRevision: 1, exportItemIds: ['item'] });
  assert.equal(posted.headers['Idempotency-Key'], 'key-1');
});
