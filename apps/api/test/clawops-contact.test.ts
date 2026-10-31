import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClawOpsContact } from '../src/clawops-contact.ts';

const options = { accountId: 'AC1a2b3c4d', apiKey: 'synthetic-key', fromNumber: '+827052358010',
  voiceUrl: 'https://example.test/voice?token=%2F1' };
const approved = { recipient: '+821012345678', message: '승인된 합성 연락' };
const failed = { status: 'failed', providerOperationId: null };
const unknown = { status: 'outcome_unknown', providerOperationId: null };

test('posts the approved Korean numbers, fixed HTTPS endpoint and VoiceML URL once', async () => {
  const order: string[] = [];
  const adapter = createClawOpsContact({ ...options, fetch: async (url, init) => {
    order.push('send');
    assert.equal(url, 'https://api.claw-ops.com/v1/accounts/AC1a2b3c4d/calls');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init?.body)), { To: '01012345678', From: '07052358010', Url: options.voiceUrl, Timeout: 30 });
    return Response.json({ callId: 'CAabcdef1234567890', privateData: 'not returned' }, { status: 201 });
  } });
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { order.push('check'); }),
    { status: 'submitted', providerOperationId: 'CAabcdef1234567890' });
  assert.deepEqual(order, ['check', 'send']);
});

test('keeps non-Korean E.164 numbers and snapshots input before the approval check', async () => {
  let release!: () => void; let enter!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let body: any;
  const adapter = createClawOpsContact({ ...options, fromNumber: '+12025550100', fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body)); return Response.json({ callId: 'operation-1' }, { status: 201 });
  } });
  const input = { ...approved, recipient: '+12025550123' };
  const pending = adapter.dispatch(input, undefined, async () => { enter(); await wait; });
  await ready; input.recipient = '+12025550199'; input.message = '변경'; release();
  assert.equal((await pending).status, 'submitted');
  assert.equal(body.To, '+12025550123'); assert.equal(body.From, '+12025550100');
});

test('rejects invalid configuration, URL and oversized or invalid approved input before side effects', async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected'); };
  const adapter = createClawOpsContact({ ...options, fetch: fetcher });
  for (const input of [
    { ...approved, recipient: '01012345678' }, { ...approved, recipient: '+8201012345678' },
    { ...approved, recipient: '+1234567890123456' }, { ...approved, message: ' ' },
    { ...approved, message: '\ud800' }, { ...approved, message: '\u0000' }, { ...approved, message: 'a'.repeat(4001) },
  ]) assert.deepEqual(await adapter.dispatch(input, undefined, async () => { calls++; }), failed);
  for (const changed of [
    { accountId: '../other' }, { accountId: 'a'.repeat(129) }, { apiKey: 'bad\nkey' }, { apiKey: 'x'.repeat(4097) },
    { fromNumber: '07012345678' }, { fromNumber: '+8207012345678' },
    { voiceUrl: 'http://example.test/voice' }, { voiceUrl: 'https://user@example.test/voice' },
    { voiceUrl: 'https://example.test/#fragment' }, { voiceUrl: 'https://example.test/%ZZ' },
    { voiceUrl: 'https://example.test/' + 'a'.repeat(2048) },
  ]) assert.deepEqual(await createClawOpsContact({ ...options, ...changed, fetch: fetcher }).dispatch(approved), failed);
  assert.equal(calls, 0);
});

test('maps explicit 4xx to failed and timeouts or ambiguous results to unknown', async () => {
  for (const status of [200, 202, 302, 400, 401, 403, 404, 408, 418, 422, 429, 500, 503]) {
    let calls = 0;
    const adapter = createClawOpsContact({ ...options, fetch: async () => { calls++; return new Response('private error', { status }); } });
    const result = await adapter.dispatch(approved);
    assert.deepEqual(result, status >= 400 && status < 500 && status !== 408 ? failed : unknown);
    assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes('private error'));
  }
  for (const body of ['not json', '{}', '{"callId":42}', '{"callId":""}', '{"callId":" bad "}', '{"callId":"bad\\nvalue"}', '[]', 'x'.repeat(65_537)]) {
    const adapter = createClawOpsContact({ ...options, fetch: async () => new Response(body, { status: 201 }) });
    assert.deepEqual(await adapter.dispatch(approved), unknown);
  }
  for (const error of [new DOMException('timeout', 'TimeoutError'), new Error('synthetic-key')]) {
    const adapter = createClawOpsContact({ ...options, fetch: async () => { throw error; } });
    assert.deepEqual(await adapter.dispatch(approved), unknown);
  }
});

test('pre-send aborts and failed approval checks cannot send', async () => {
  let sends = 0; let checks = 0;
  const adapter = createClawOpsContact({ ...options, fetch: async () => { sends++; return Response.json({ callId: 'id' }, { status: 201 }); } });
  const already = new AbortController(); already.abort();
  assert.deepEqual(await adapter.dispatch(approved, already.signal, async () => { checks++; }), failed);
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { checks++; throw new Error('private'); }), failed);
  const during = new AbortController();
  assert.deepEqual(await adapter.dispatch(approved, during.signal, async () => { checks++; during.abort(); }), failed);
  assert.equal(sends, 0); assert.equal(checks, 2);
});

test('abort after the request starts cannot claim the call was not submitted', async () => {
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const adapter = createClawOpsContact({ ...options, fetch: async (_url, init) => {
    enter(); await wait; assert.equal(init?.signal?.aborted, true); return Response.json({ callId: 'CAabcdef1234567890' }, { status: 201 });
  } });
  const pending = adapter.dispatch(approved, controller.signal); await started; controller.abort(); release();
  assert.deepEqual(await pending, unknown);
});

test('managed agent call sends only the expected AgentId and call context without Url', async () => {
  let calls = 0; let checks = 0;
  const adapter = createClawOpsContact({ accountId: options.accountId, apiKey: options.apiKey, fromNumber: options.fromNumber,
    agentId: 'agent_test', callContext: { instruction: '승인된 연락 정보', variables: { note: '합성', count: 2, enabled: true } },
    fetch: async (url, init) => {
      calls++; assert.equal(url, 'https://api.claw-ops.com/v1/accounts/AC1a2b3c4d/calls');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { To: '01012345678', From: '07052358010', AgentId: 'agent_test',
        CallContext: { Instruction: '승인된 연락 정보', Variables: { note: '합성', count: 2, enabled: true } }, Timeout: 30 });
      assert.equal('Url' in body, false); assert.equal(init?.redirect, 'error');
      return Response.json({ callId: 'CAabcdef1234567890' }, { status: 201 });
    } });
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { checks++; }),
    { status: 'submitted', providerOperationId: 'CAabcdef1234567890' });
  assert.equal(calls, 1); assert.equal(checks, 1);
});

test('managed options reject mixed modes and invalid contexts without sending', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected'); };
  const base = { accountId: options.accountId, apiKey: options.apiKey, fromNumber: options.fromNumber, fetch: fetcher };
  const cases: unknown[] = [
    { ...base, voiceUrl: options.voiceUrl, agentId: 'agent', callContext: { instruction: 'approved' } },
    { ...base, agentId: '', callContext: { instruction: 'approved' } },
    { ...base, agentId: 'a'.repeat(201), callContext: { instruction: 'approved' } },
    { ...base, agentId: 'agent', callContext: { instruction: '' } },
    { ...base, agentId: 'agent', callContext: { instruction: '가'.repeat(6000) } },
    { ...base, agentId: 'agent', callContext: { instruction: 'bad\u0000' } },
    { ...base, agentId: 'agent', callContext: { instruction: 'approved', variables: { bad: Infinity } } },
    { ...base, agentId: 'agent', callContext: { instruction: 'approved', variables: { bad: ['a'] } } },
    { ...base, agentId: 'agent', callContext: { instruction: 'approved', variables: { 'bad-key': 'a' } } },
    { ...base, agentId: 'agent', callContext: { instruction: 'approved', variables: { data: 'x'.repeat(8192) } } },
    { ...base, agentId: 'agent', callContext: { instruction: 'approved', variables: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, i])) } },
  ];
  for (const value of cases) assert.deepEqual(await createClawOpsContact(value as Parameters<typeof createClawOpsContact>[0]).dispatch(approved), failed);
  assert.equal(calls, 0);
});

test('managed mode snapshots context before approval and preserves pre-send and unknown-outcome semantics', async () => {
  const context = { instruction: '승인된 정보', variables: { note: '원본' } };
  let release!: () => void; let enter!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let body: any; let calls = 0;
  const adapter = createClawOpsContact({ accountId: options.accountId, apiKey: options.apiKey, fromNumber: options.fromNumber,
    agentId: 'agent_test', callContext: context, fetch: async (_url, init) => {
      calls++; body = JSON.parse(String(init?.body)); throw new Error('ambiguous transport');
    } });
  const pending = adapter.dispatch(approved, undefined, async () => { enter(); await wait; });
  await ready; context.instruction = '변경'; context.variables.note = '변경'; release();
  assert.deepEqual(await pending, unknown);
  assert.deepEqual(body.CallContext, { Instruction: '승인된 정보', Variables: { note: '원본' } });
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { throw new Error('invalid approval'); }), failed);
  assert.equal(calls, 1);
});
