import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClawOpsReplies } from '../src/clawops-replies.ts';

const accountId = 'ACsynthetic', apiKey = 'synthetic-secret', callId = 'CAexample';
const input = { callId, fromNumber: '+827012345678', toNumber: '+821012345678', createdAt: '2030-01-01T00:00:00Z' };
const call = { callId, accountId, from: '07012345678', to: '01012345678', direction: 'outbound', status: 'completed', dateCreated: '2030-01-01T00:01:00Z' };
const event = (id: string, name: string, detail: unknown = {}) => ({ id, event: name, timestamp: '2030-01-01T00:02:00Z', detail });
const start = event('1', 'stream.started');
const user = event('2', 'transcript.final', { utteranceId: 'u1', role: 'user', text: '오후 두 시가 좋아요.' });
const agent = event('3', 'transcript.final', { utteranceId: 'a1', role: 'agent', text: '확인했습니다.' });
const end = event('4', 'stream.ended', { reason: 'completed' });
const factory = (fetcher: typeof fetch) => createClawOpsReplies({ accountId, apiKey, fetch: fetcher });
const mock = (page: unknown, callData: unknown = call): typeof fetch => async (url, init) => {
  const path = new URL(String(url));
  assert.equal(path.origin, 'https://api.claw-ops.com'); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey}`);
  return Response.json(path.pathname.endsWith('/live-events') ? page : callData);
};

test('binds the call and returns final transcripts only when the complete stream is present', async () => {
  const result = await factory(mock({ data: [start, user, event('3', 'transcript.partial', { role: 'user', text: '불완전' }),
    event('4', 'dtmf.received', { digit: '1' }), event('5', 'stream.ended', { reason: 'completed' })], hasMore: false })).check(input);
  assert.deepEqual(result, { ok: true, callStatus: 'completed', events: [{ id: '2', receivedAt: '2030-01-01T00:02:00Z', role: 'user', text: '오후 두 시가 좋아요.' }], complete: true, truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|01012345678|불완전/);
});

test('blocks mismatched identities and invalid or missing binding fields before reading events', async () => {
  for (const changed of [{ callId: 'wrong' }, { accountId: 'other' }, { from: '07099999999' }, { to: '01099999999' },
    { direction: 'inbound' }, { dateCreated: '2029-12-31T00:00:00Z' }]) {
    let calls = 0;
    const check = factory(async () => { calls++; return Response.json({ ...call, ...changed }); });
    assert.deepEqual(await check.check(input), { ok: false, error: 'forbidden' }); assert.equal(calls, 1);
  }
  for (const missing of ['callId', 'accountId', 'from', 'to', 'direction', 'status', 'dateCreated']) {
    const invalid: Record<string, unknown> = { ...call }; delete invalid[missing];
    assert.deepEqual(await factory(mock({}, invalid)).check(input), { ok: false, error: 'provider_unavailable' });
  }
  let calls = 0;
  const adapter = factory(async () => { calls++; throw new Error('unexpected'); });
  assert.deepEqual(await adapter.check({ ...input, callId: '../other' }), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await adapter.check({ ...input, createdAt: 'not-a-date' }), { ok: false, error: 'invalid_request' });
  assert.equal(calls, 0);
});

test('paginates via last id, deduplicates identical overlaps, and rejects conflicting duplicates', async () => {
  let pages = 0;
  const fetcher: typeof fetch = async url => {
    const parsed = new URL(String(url));
    if (!parsed.pathname.endsWith('/live-events')) return Response.json(call);
    pages++; assert.equal(parsed.searchParams.get('limit'), '100');
    if (pages === 1) { assert.equal(parsed.searchParams.get('after'), null); return Response.json({ data: [start, user], hasMore: true }); }
    assert.equal(parsed.searchParams.get('after'), '2'); return Response.json({ data: [user, agent, end], hasMore: false });
  };
  const result = await factory(fetcher).check(input);
  assert.equal(result.ok && result.complete, true); assert.equal(result.ok && result.events.length, 2); assert.equal(pages, 2);
  let requestCount = 0;
  const conflicting: typeof fetch = async url => {
    if (!String(url).includes('/live-events')) return Response.json(call);
    requestCount++;
    return Response.json(requestCount === 1 ? { data: [start, user], hasMore: true } :
      { data: [{ ...user, detail: { utteranceId: 'u1', role: 'user', text: '다른 내용' } }], hasMore: false });
  };
  assert.deepEqual(await factory(conflicting).check(input), { ok: false, error: 'provider_unavailable' });
});

test('incomplete streams, pending calls, no user speech and truncated text never claim completion', async () => {
  for (const [page, callData] of [
    [{ data: [], hasMore: false }, call],
    [{ data: [start, agent, end], hasMore: false }, call],
    [{ data: [start, user], hasMore: false }, call],
    [{ data: [start, user, event('4', 'stream.ended', { reason: 'runner_lost' })], hasMore: false }, call],
    [{ data: [start, user, end], hasMore: false }, { ...call, status: 'in-progress' }],
    [{ data: [start, event('2', 'transcript.final', { role: 'user', text: 'x' }), end], hasMore: false }, call],
  ] as const) {
    const result = await factory(mock(page, callData)).check(input);
    assert.equal(result.ok, true); assert.equal(result.ok && result.complete, false);
  }
  const long = event('2', 'transcript.final', { utteranceId: 'u1', role: 'user', text: 'a'.repeat(2001) });
  const result = await factory(mock({ data: [start, long, end], hasMore: false })).check(input);
  assert.equal(result.ok && result.complete, false); assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.events[0]!.text.length, 2000);
});

test('caps pages, sanitizes provider failures, and times out stalled responses', async () => {
  let pages = 0;
  const fetcher: typeof fetch = async url => {
    if (!String(url).includes('/live-events')) return Response.json(call);
    pages++;
    return Response.json({ data: [event(String(pages), pages === 1 ? 'stream.started' : 'dtmf.received')], hasMore: true });
  };
  const capped = await factory(fetcher).check(input);
  assert.equal(capped.ok && capped.complete, false); assert.equal(capped.ok && capped.truncated, true); assert.equal(pages, 4);
  assert.deepEqual(await factory(async () => new Response('', { status: 403 })).check(input), { ok: false, error: 'forbidden' });
  assert.deepEqual(await factory(async () => { throw new Error('synthetic-secret'); }).check(input), { ok: false, error: 'provider_unavailable' });
  assert.deepEqual(await factory(async () => new Response('x'.repeat(512 * 1024 + 1))).check(input), { ok: false, error: 'provider_unavailable' });
  const stalled = factory(async () => new Promise<Response>(() => {}));
  assert.deepEqual(await stalled.check(input), { ok: false, error: 'provider_unavailable' });
});
