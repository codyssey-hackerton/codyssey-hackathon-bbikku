import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { PhoneConnections } from '../src/phone-connection.ts';
import { PlanningService } from '../src/planning-service.ts';
import { PostgresPlanningStore } from '../src/postgres-store.ts';

// An isolated cluster and mocked ports only; never read an application database URL or real credentials.
test('approved schedule call and location correction persist and replay in PostgreSQL',
  { skip: process.env.PIKKU_SCHEDULE_CALL_ISOLATED_PG !== '1', timeout: 45_000 }, async t => {
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
    const directory = await mkdtemp(join(tmpdir(), 'pikku-schedule-call-pg-'));
    const listener = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'synthetic', password: 'synthetic-only-password',
      persistent: false, authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
    let started = false; let pool: pg.Pool | undefined; let app: ReturnType<typeof buildApp> | undefined;
    t.after(async () => {
      await app?.close(); await pool?.end(); if (started) await postgres.stop();
      await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0);
    });
    const previousUmask = process.umask(0o077);
    try { await postgres.initialise(); await postgres.start(); started = true; } finally { process.umask(previousUmask); }
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'synthetic', password: 'synthetic-only-password', database: 'postgres',
      options: '-c statement_timeout=4000 -c lock_timeout=2000' });
    const store = new PostgresPlanningStore(pool); await store.migrate();
    const reopened = new PostgresPlanningStore(pool);
    const now = '2026-11-01T03:00:00.000Z'; const clock = () => new Date(now);
    const planning = new PlanningService(store, clock);
    const timeSlot = { startsAt: '2026-11-02T18:00:00+09:00', endsAt: '2026-11-02T19:00:00+09:00', timezone: 'Asia/Seoul' };
    const original = (await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create',
      after: { kind: 'event', title: '저녁 약속', location: '강남역', timeSlot, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' } }] } })).items[0]!;
    let calls = 0; let upstreamTransactions = 0; let reviews = 0;
    const credential = { provider: 'clawops' as const, mode: 'agent' as const, accountId: 'synthetic-account', apiKey: 'synthetic-key', agentId: 'synthetic-agent', fromNumber: '+827012345678' };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.claw-ops.com');
      // A separate store has a separate transaction context and must acquire the same user's row lock.
      await reopened.transaction('alice', () => undefined); upstreamTransactions++;
      if (url.pathname.endsWith('/numbers')) return Response.json({ data: [{ number: '07012345678' }] });
      if (url.pathname.endsWith('/agents/synthetic-agent')) return Response.json({ agentId: credential.agentId, maxDurationSeconds: 120, liveEvents: { events: ['transcript.final'] } });
      if (url.pathname.endsWith('/calls') && init?.method === 'POST') {
        calls++; const body = JSON.parse(String(init.body)); assert.equal(body.AgentId, credential.agentId); assert.match(body.CallContext.Instruction, /강남역/);
        return Response.json({ callId: 'synthetic-call' }, { status: 201 });
      }
      if (url.pathname.endsWith('/live-events')) {
        const event = (id: string, name: string, detail: object = {}) => ({ id, event: name, timestamp: now, detail });
        return Response.json({ data: [event('1', 'stream.started'),
          event('2', 'transcript.final', { utteranceId: 'a1', role: 'agent', text: '내일 오후 6시에 강남역이 맞나요?' }),
          event('3', 'transcript.final', { utteranceId: 'u1', role: 'user', text: '아니, 홍대야. 시간은 똑같이 오후 6시.' }),
          event('4', 'stream.ended', { reason: 'completed' })], hasMore: false });
      }
      assert.ok(url.pathname.endsWith('/calls/synthetic-call'));
      return Response.json({ callId: 'synthetic-call', accountId: credential.accountId, from: credential.fromNumber,
        to: '+821012345678', direction: 'outbound', status: 'completed', dateCreated: now });
    };
    const connections = new PhoneConnections({ directory, fetcher });
    await connections.connect('alice', credential);
    app = buildApp({ store, clock, phoneConnections: connections,
      sessions: { async resolve(token) { return token === 'alice' ? { userId: token } : null; } },
      model: { async decide(input) {
        if (input.context.callReview) {
          await reopened.transaction('alice', () => undefined); reviews++;
          return { kind: 'call_review', text: '시간은 그대로 두고 장소를 홍대로 정정합니다.', location: '홍대' };
        }
        if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: { from: '2026-11-02T00:00:00+09:00', to: '2026-11-03T00:00:00+09:00', timezone: 'Asia/Seoul' } };
        return { kind: 'phone_request', text: '전화로 확인할까요?', itemId: original.id, expectedRevision: original.revision };
      } } });
    const post = (path: string, body: object, key: string) => app!.inject({ method: 'POST', url: path,
      headers: { authorization: 'Bearer alice', 'idempotency-key': key }, payload: { requestId: key, ...body } });
    const chat = await post('/v1/chat', { conversationId: null, message: '내일 저녁 약속이 맞는지 나에게 전화해줘', timezone: 'Asia/Seoul' }, 'chat');
    assert.equal(chat.statusCode, 200, chat.body); assert.equal(chat.json().data.result.kind, 'phone_request'); assert.equal(calls, 0);
    const created = await post('/v1/schedule-calls', { itemId: original.id, expectedRevision: original.revision, toNumber: '01012345678' }, 'create');
    assert.equal(created.statusCode, 200, created.body); let call = created.json().data.call;
    assert.equal(call.status, 'pending'); assert.equal(calls, 0);
    const approvalBody = { revision: call.revision };
    const sent = await post(`/v1/schedule-calls/${call.id}/approve`, approvalBody, 'approve');
    assert.equal(sent.statusCode, 200, sent.body); call = sent.json().data.call; assert.equal(call.status, 'submitted'); assert.equal(calls, 1);
    const replay = await post(`/v1/schedule-calls/${call.id}/approve`, approvalBody, 'approve');
    assert.deepEqual(replay.json(), sent.json()); assert.equal(calls, 1);
    const checked = await post(`/v1/schedule-calls/${call.id}/check`, { revision: call.revision }, 'check');
    assert.equal(checked.statusCode, 200, checked.body); call = checked.json().data.call;
    assert.equal(call.status, 'completed'); assert.match(JSON.stringify(call.transcript), /홍대/);
    assert.deepEqual((await reopened.read('alice')).items.get(original.id), original);
    const proposed = await post(`/v1/schedule-calls/${call.id}/propose`, { revision: call.revision }, 'propose');
    assert.equal(proposed.statusCode, 200, proposed.body); call = proposed.json().data.call;
    assert.equal(call.status, 'review_pending'); assert.equal(call.correction.beforeLocation, '강남역'); assert.equal(call.correction.afterLocation, '홍대');
    assert.equal(reviews, 1); assert.deepEqual((await reopened.read('alice')).items.get(original.id), original);
    const decisionBody = { revision: call.revision, decision: 'accept' };
    const accepted = await post(`/v1/schedule-calls/${call.id}/decision`, decisionBody, 'accept');
    assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(accepted.json().data.call.status, 'applied');
    const state = await reopened.read('alice'); const current = state.items.get(original.id)!;
    assert.equal(current.location, '홍대'); assert.deepEqual(current.timeSlot, original.timeSlot);
    assert.deepEqual(current, { ...original, location: '홍대', revision: original.revision + 1 });
    const duplicate = await post(`/v1/schedule-calls/${call.id}/decision`, decisionBody, 'accept');
    assert.deepEqual(duplicate.json(), accepted.json());
    const afterReplay = await reopened.read('alice');
    assert.deepEqual(afterReplay.items.get(original.id), current); assert.equal(afterReplay.scheduleRevision, state.scheduleRevision);
    assert.equal(calls, 1); assert.ok(upstreamTransactions >= 4);
  });
