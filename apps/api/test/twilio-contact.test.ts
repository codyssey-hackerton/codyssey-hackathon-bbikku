import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTwilioContact, type ApprovedTwilioContact } from '../src/twilio-contact.ts';

const accountSid = `AC${'a'.repeat(32)}`;
const authToken = 'synthetic-token';
const fromNumber = '+12025550100';
const sid = `CA${'b'.repeat(32)}`;
const approved: ApprovedTwilioContact = { recipient: '+821012345678', message: '안녕하세요 & <Say> "확인" \'예\' 😀' };
const failed = { status: 'failed', providerOperationId: null };
const unknown = { status: 'outcome_unknown', providerOperationId: null };

test('posts exactly once with the approved recipient and escaped Korean TwiML', async () => {
  const order: string[] = [];
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async (url, init) => {
    order.push('send');
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(String(init?.body));
    assert.deepEqual([...body.keys()], ['To', 'From', 'Twiml']);
    assert.equal(body.get('To'), approved.recipient);
    assert.equal(body.get('From'), fromNumber);
    assert.equal(body.get('Twiml'), '<Response><Say voice="Google.ko-KR-Standard-A" language="ko-KR">안녕하세요 &amp; &lt;Say&gt; &quot;확인&quot; &apos;예&apos; 😀</Say></Response>');
    return Response.json({ sid, secret: 'ignored' }, { status: 201 });
  } });
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { order.push('check'); }), { status: 'submitted', providerOperationId: sid });
  assert.deepEqual(order, ['check', 'send']);
});

test('rejects invalid input, configuration and oversized TwiML before the check or request', async () => {
  let calls = 0;
  const send: typeof fetch = async () => { calls++; throw new Error('unexpected'); };
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: send });
  for (const input of [
    { ...approved, recipient: '821012345678' }, { ...approved, recipient: '+012345' },
    { ...approved, recipient: '+1234567890123456' }, { ...approved, recipient: '+8210 12345678' },
    { ...approved, message: ' ' }, { ...approved, message: 'text\u0001more' }, { ...approved, message: '\u0085' },
    { ...approved, message: '\ud800' }, { ...approved, message: '\uffff' }, { ...approved, message: '&'.repeat(1000) },
  ]) assert.deepEqual(await adapter.dispatch(input, undefined, async () => { calls++; }), failed);
  for (const config of [
    { accountSid: 'invalid', authToken, fromNumber }, { accountSid, authToken: 'invalid\nsecret', fromNumber },
    { accountSid, authToken: '', fromNumber }, { accountSid, authToken, fromNumber: '01012345678' },
  ]) assert.deepEqual(await createTwilioContact({ ...config, fetch: send }).dispatch(approved), failed);
  assert.equal(calls, 0);
});

test('preserves the approved multiline mobile draft in escaped TwiML', async () => {
  const message = '안녕하세요.\n\n“합성 약속 & 회의”과 관련하여 제안된 일정 조정 방안이 가능하신지 확인 부탁드립니다.\n답변을 확인하기 전까지 원래 약속은 유지됩니다.\n\n감사합니다.';
  let calls = 0;
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async (_url, init) => {
    calls++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('Twiml'), `<Response><Say voice="Google.ko-KR-Standard-A" language="ko-KR">${message.replace('&', '&amp;')}</Say></Response>`);
    return Response.json({ sid }, { status: 201 });
  } });
  assert.equal((await adapter.dispatch({ ...approved, message })).status, 'submitted');
  assert.equal(calls, 1);
});

test('preserves XML-safe carriage return and tab without accepting other controls', async () => {
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.ok(body.get('Twiml')?.includes('첫 줄&#13;\n\t둘째 줄'));
    return Response.json({ sid }, { status: 201 });
  } });
  assert.equal((await adapter.dispatch({ ...approved, message: '첫 줄\r\n\t둘째 줄' })).status, 'submitted');
});

test('classifies responses and transport errors without retrying or leaking response data', async () => {
  for (const status of [200, 202, 302, 400, 401, 403, 404, 405, 408, 418, 422, 429, 500, 503]) {
    let calls = 0;
    const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async () => {
      calls++; return new Response('sensitive response', { status });
    } });
    const result = await adapter.dispatch(approved);
    assert.deepEqual(result, [400, 401, 403, 404, 405, 422, 429].includes(status) ? failed : unknown);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  }
  for (const error of [new Error('synthetic-token'), new DOMException('timeout', 'AbortError')]) {
    let calls = 0;
    const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async () => { calls++; throw error; } });
    assert.deepEqual(await adapter.dispatch(approved), unknown);
    assert.equal(calls, 1);
  }
  for (const body of ['not json', '{}', '{"sid":42}', '{"sid":"CAwrong"}', '[]']) {
    const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async () => new Response(body, { status: 201 }) });
    assert.deepEqual(await adapter.dispatch(approved), unknown);
  }
});

test('snapshots approved content before the final check and blocks failed or aborted checks', async () => {
  let release!: () => void;
  let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  let sent: URLSearchParams | undefined;
  const mutable = { ...approved };
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async (_url, init) => {
    sent = new URLSearchParams(String(init?.body)); return Response.json({ sid }, { status: 201 });
  } });
  const pending = adapter.dispatch(mutable, undefined, async () => { enter(); await wait; });
  await started;
  mutable.recipient = '+12025550199'; mutable.message = 'changed';
  release();
  assert.equal((await pending).status, 'submitted');
  assert.equal(sent?.get('To'), approved.recipient);
  assert.ok(sent?.get('Twiml')?.includes('안녕하세요'));
  sent = undefined;
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { throw new Error('secret'); }), failed);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await adapter.dispatch(approved, controller.signal), failed);
  assert.equal(sent, undefined);
});

test('abort after dispatch starts leaves the outcome unknown', async () => {
  let release!: () => void;
  let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  const controller = new AbortController();
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async (_url, init) => {
    enter(); await wait; assert.equal(init?.signal?.aborted, true); return Response.json({ sid }, { status: 201 });
  } });
  const pending = adapter.dispatch(approved, controller.signal);
  await started; controller.abort(); release();
  assert.deepEqual(await pending, unknown);
});

test('abort during the final check prevents dispatch', async () => {
  let release!: () => void;
  let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  let calls = 0;
  const controller = new AbortController();
  const adapter = createTwilioContact({ accountSid, authToken, fromNumber, fetch: async () => { calls++; throw new Error('unexpected'); } });
  const pending = adapter.dispatch(approved, controller.signal, async () => { enter(); await wait; });
  await started; controller.abort(); release();
  assert.deepEqual(await pending, failed);
  assert.equal(calls, 0);
});
