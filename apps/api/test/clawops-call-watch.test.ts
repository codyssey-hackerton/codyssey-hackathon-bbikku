import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagedCallWatch } from '../src/clawops-call-watch.ts';
import { managedCallBindingKey } from '../src/phone-dispatch.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import type { PhoneConnections } from '../src/phone-connection.ts';
import type { ContactRequest } from '../src/contact-service.ts';

const accountId = 'ACsynthetic', apiKey = 'synthetic-key', callId = 'CAfixture', userId = 'alice';
const credential = { provider: 'clawops' as const, mode: 'agent' as const, accountId, apiKey, agentId: 'AGfixture', fromNumber: '+827012345678' };
const contact: ContactRequest = { id: 'contact', revision: 1, baseScheduleRevision: 0, baseContextRevision: 0, recipientRef: 'recipient',
  recipientSnapshot: { displayName: '상대', channel: 'phone', address: '+821012345678' }, channel: 'phone', purpose: '조율', messageOrCallBrief: '합성',
  allowedOptions: [], approvalId: 'approved', executionKey: 'execution', providerOperationId: callId, deliveryStatus: 'sent_or_connected',
  negotiationStatus: 'awaiting_response', createdAt: '2030-01-01T00:00:00Z' };
const call = { callId, accountId, from: '07012345678', to: '01012345678', direction: 'outbound', status: 'in-progress', dateCreated: '2030-01-01T00:01:00Z' };
const event = (id: string, name: string, detail: unknown = {}) => ({ id, event: name, timestamp: '2030-01-01T00:02:00Z', detail });
const start = event('1', 'stream.started');
const final = (text: string, role = 'user') => event('2', 'transcript.final', { utteranceId: 'u1', role, text });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const store = new MemoryPlanningStore();
  await store.transaction(userId, state => {
    state.contactRequests.set(contact.id, structuredClone(contact));
    state.voiceSessions.set(managedCallBindingKey(contact.executionKey), { contactId: contact.id, accountId, agentId: credential.agentId, fromNumber: credential.fromNumber, mode: 'agent' });
  });
  let current = { ...credential };
  const connections = { async read() { return { ...current }; }, fetcher: fetch } as unknown as PhoneConnections;
  return { store, connections, setCredential(value: typeof credential) { current = value; } };
}
function blockedWait(ready: () => void) {
  return (_ms: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    ready(); if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('clear final user hang-up requests cause exactly one bound POST', async () => {
  for (const text of ['끊어', '알겠어, 끊어', '좋아요. 끊어.', '이제 통화 종료해주세요', '왜안끊어', '전화 끊어 주세요', '그럼 끊어', '이만 끊자']) {
    const env = await fixture(); const sent = deferred(); let posts = 0;
    const before = await env.store.read(userId);
    const fetcher: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url)); assert.equal(parsed.origin, 'https://api.claw-ops.com');
      if (init?.method === 'POST') {
        posts++; assert.equal(parsed.pathname, `/v1/accounts/${accountId}/calls/${callId}`);
        assert.equal(init.redirect, 'error'); assert.deepEqual(JSON.parse(String(init.body)), { Status: 'completed' });
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${apiKey}`); sent.resolve(); return Response.json({ status: 'completed' });
      }
      return Response.json(parsed.pathname.endsWith('/live-events') ? { data: [start, final(text)], hasMore: false } : call);
    };
    const watch = createManagedCallWatch({ ...env, fetch: fetcher });
    watch.start(userId, contact.id); watch.start(userId, contact.id); await sent.promise; await watch.stop();
    assert.equal(posts, 1); assert.deepEqual(await env.store.read(userId), before);
  }
});

test('negations, quotations and agent speech never terminate a call', async () => {
  for (const [text, role] of [['끊지마', 'user'], ['아직 끊으면 안돼', 'user'], ['끊어달란 말 아니야', 'user'],
    ['전화 끊지 마세요', 'user'], ['그럼 끊지 마', 'user'], ['"끊어"라고 하지 마세요', 'user'], ['끊어', 'agent']]) {
    const env = await fixture(); const idle = deferred(); let posts = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json({}); }
      return Response.json(String(url).includes('/live-events') ? { data: [start, final(text!, role)], hasMore: false } : call);
    };
    const watch = createManagedCallWatch({ ...env, fetch: fetcher, wait: blockedWait(idle.resolve) });
    watch.start(userId, contact.id); await idle.promise; await watch.stop(); assert.equal(posts, 0);
  }
});

test('wrong binding, other user or changed credential cannot act on a call', async () => {
  const env = await fixture(); let posts = 0; let calls = 0; const idle = deferred();
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({}); }
    calls++;
    if (String(url).includes('/live-events')) { env.setCredential({ ...credential, apiKey: 'different-key' }); return Response.json({ data: [start, final('끊어')], hasMore: false }); }
    return Response.json(call);
  };
  const watch = createManagedCallWatch({ ...env, fetch: fetcher, wait: blockedWait(idle.resolve) });
  watch.start('bob', contact.id); watch.start(userId, contact.id);
  // Wait until the provider event is returned and the recheck has had a turn.
  for (let i = 0; i < 20 && calls < 2; i++) await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve)); await watch.stop(); assert.equal(posts, 0);
  const mismatch = await fixture();
  await mismatch.store.transaction(userId, state => { state.voiceSessions.delete(managedCallBindingKey(contact.executionKey)); });
  let requests = 0;
  const blocked = createManagedCallWatch({ ...mismatch, fetch: async () => { requests++; return Response.json({}); } });
  blocked.start(userId, contact.id); await new Promise<void>(resolve => setImmediate(resolve)); await blocked.stop(); assert.equal(requests, 0);
});

test('connected and overall time limits perform at most one termination attempt even after a restart', async () => {
  for (const [status, expected] of [['in-progress', 120_000], ['ringing', 150_000]] as const) {
    const env = await fixture(); let time = 0; let posts = 0; let gets = 0; const sent = deferred(); const before = await env.store.read(userId);
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') { posts++; sent.resolve(); return new Response('', { status: 503 }); }
      gets++;
      return Response.json(String(url).includes('/live-events') ? { data: [start], hasMore: false } : { ...call, status });
    };
    const watch = createManagedCallWatch({ ...env, fetch: fetcher, now: () => time, wait: async ms => { time += ms; } });
    watch.start(userId, contact.id); await sent.promise; assert.equal(time, expected);
    await new Promise<void>(resolve => setImmediate(resolve));
    const previousGets = gets;
    watch.start(userId, contact.id); await new Promise<void>(resolve => setImmediate(resolve)); await watch.stop();
    assert.equal(gets, previousGets);
    assert.equal(posts, 1); assert.deepEqual(await env.store.read(userId), before);
  }
});

test('finished calls stop and shutdown aborts a stalled provider lookup', async () => {
  const env = await fixture(); let posts = 0; const checked = deferred();
  const finished = createManagedCallWatch({ ...env, fetch: async (url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({}); }
    if (String(url).includes('/live-events')) { checked.resolve(); return Response.json({ data: [], hasMore: false }); }
    return Response.json({ ...call, status: 'completed' });
  } });
  finished.start(userId, contact.id); await checked.promise; await new Promise<void>(resolve => setImmediate(resolve)); await finished.stop(); assert.equal(posts, 0);
  const entered = deferred();
  const stalled = createManagedCallWatch({ ...env, fetch: async () => { entered.resolve(); return new Promise<Response>(() => {}); } });
  stalled.start(userId, contact.id); await entered.promise; await stalled.stop(); assert.equal(posts, 0);
});
