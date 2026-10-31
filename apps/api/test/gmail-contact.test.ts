import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGmailContact, type ApprovedGmailContact } from '../src/gmail-contact.ts';

const approved: ApprovedGmailContact = {
  recipient: 'synthetic+contact@example.com',
  subject: '일정 조정 요청 😀'.repeat(10),
  message: '합성 메시지입니다.\nBcc: body-only@example.com',
  executionKey: 'synthetic-execution-key',
};
const token = 'synthetic.token-123';
const senderAddress = 'synthetic-sender@example.com';
const failed = { status: 'failed', providerOperationId: null };
const unknown = { status: 'outcome_unknown', providerOperationId: null };

test('sends the approved single-recipient MIME content and returns only the provider ID', async () => {
  let calls = 0;
  const adapter = createGmailContact({
    senderAddress,
    getAccessToken: async () => token,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.deepEqual(init?.headers, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      assert.deepEqual(Object.keys(payload), ['raw']);
      assert.match(payload.raw, /^[A-Za-z0-9_-]+$/);
      const mime = Buffer.from(payload.raw, 'base64url').toString('utf8');
      const [headers, body] = mime.split('\r\n\r\n');
      assert.ok(headers.startsWith(`From: ${senderAddress}\r\nTo: ${approved.recipient}\r\n`));
      assert.match(headers, /\r\nDate: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/);
      assert.doesNotMatch(headers, /(?:^|\r\n)Bcc:/i);
      assert.ok(!mime.includes(approved.executionKey));
      const words = [...headers.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
      assert.ok(words.length > 1);
      assert.ok(words.every(word => word[0].length <= 75));
      assert.equal(words.map(word => Buffer.from(word[1], 'base64').toString('utf8')).join(''), approved.subject);
      assert.equal(Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8'), approved.message);
      return Response.json({ id: 'synthetic-message-id', snippet: 'ignored-response-body' });
    },
  });
  assert.deepEqual(await adapter.dispatch(approved), { status: 'submitted', providerOperationId: 'synthetic-message-id' });
  assert.equal(calls, 1);
});

test('rejects invalid or injected recipient, subject, execution key and malformed Unicode before token access', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const adapter = createGmailContact({
    senderAddress,
    getAccessToken: async () => { tokenCalls++; return token; },
    fetch: async () => { fetchCalls++; return Response.json({ id: 'unexpected' }); },
  });
  const invalid = [
    { ...approved, recipient: 'a@example.com\r\nBcc: b@example.com' },
    { ...approved, recipient: 'a@example.com,b@example.com' },
    { ...approved, recipient: 'a..b@example.com' },
    { ...approved, recipient: 'a@-example.com' },
    { ...approved, subject: '제목\r\nBcc: b@example.com' },
    { ...approved, subject: ' ' },
    { ...approved, message: '\ud800' },
    { ...approved, executionKey: 'key\r\nother' },
    { ...approved, executionKey: '' },
  ];
  for (const input of invalid) assert.deepEqual(await adapter.dispatch(input), failed);
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
  const invalidSender = createGmailContact({
    senderAddress: 'a@example.com\r\nBcc: b@example.com',
    getAccessToken: async () => { tokenCalls++; return token; },
    fetch: async () => { fetchCalls++; return Response.json({ id: 'unexpected' }); },
  });
  assert.deepEqual(await invalidSender.dispatch(approved), failed);
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('token failures do not call Gmail or expose credentials', async () => {
  for (const getAccessToken of [async () => 'secret\r\nInjected: value', async () => { throw new Error('secret-token'); }]) {
    let calls = 0;
    const adapter = createGmailContact({ senderAddress, getAccessToken, fetch: async () => { calls++; throw new Error('unexpected'); } });
    const result = await adapter.dispatch(approved);
    assert.deepEqual(result, failed);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(calls, 0);
  }
});

test('classifies definite rejections and ambiguous HTTP or transport failures without retry', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
    let calls = 0;
    const adapter = createGmailContact({
      senderAddress,
      getAccessToken: async () => token,
      fetch: async () => { calls++; return new Response('sensitive response body', { status }); },
    });
    const result = await adapter.dispatch(approved);
    assert.deepEqual(result, [400, 401, 403, 404].includes(status) ? failed : unknown);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
    assert.equal(calls, 1);
  }
  for (const error of [new Error('secret-token in network error'), new DOMException('timeout', 'AbortError')]) {
    let calls = 0;
    const adapter = createGmailContact({ senderAddress, getAccessToken: async () => token, fetch: async () => { calls++; throw error; } });
    const result = await adapter.dispatch(approved);
    assert.deepEqual(result, unknown);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(calls, 1);
  }
});

test('treats a missing, invalid or unreadable success ID as outcome unknown', async () => {
  for (const body of ['not-json', '{}', '{"id":42}', '{"id":" "}', '{"id":"abc\\nother"}']) {
    let calls = 0;
    const adapter = createGmailContact({
      senderAddress,
      getAccessToken: async () => token,
      fetch: async () => { calls++; return new Response(body, { status: 200 }); },
    });
    assert.deepEqual(await adapter.dispatch(approved), unknown);
    assert.equal(calls, 1);
  }
});

test('snapshots approved text before waiting for a token', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const mutable = { ...approved };
  let raw = '';
  const adapter = createGmailContact({
    senderAddress,
    getAccessToken: async () => { await wait; return token; },
    fetch: async (_url, init) => { raw = (JSON.parse(String(init?.body)) as { raw: string }).raw; return Response.json({ id: 'synthetic-id' }); },
  });
  const pending = adapter.dispatch(mutable);
  mutable.recipient = 'changed@example.com';
  mutable.message = 'changed';
  release();
  assert.equal((await pending).status, 'submitted');
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(mime.startsWith(`From: ${senderAddress}\r\nTo: ${approved.recipient}\r\n`));
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replaceAll('\r\n', ''), 'base64').toString('utf8'), approved.message);
});

test('an abort during token acquisition prevents a later Gmail request', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const controller = new AbortController();
  const adapter = createGmailContact({ senderAddress,
    getAccessToken: async signal => { assert.equal(signal, controller.signal); entered(); await waiting; return token; },
    fetch: async () => { calls++; return Response.json({ id: 'unexpected' }); },
  });
  const pending = adapter.dispatch(approved, controller.signal);
  await started;
  controller.abort();
  release();
  assert.deepEqual(await pending, failed);
  assert.equal(calls, 0);
});

test('an abort after Gmail dispatch starts leaves the outcome unknown', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const adapter = createGmailContact({ senderAddress, getAccessToken: async () => token,
    fetch: async (_url, init) => { entered(); await waiting; assert.equal(init?.signal?.aborted, true); return Response.json({ id: 'late-id' }); },
  });
  const pending = adapter.dispatch(approved, controller.signal);
  await started;
  controller.abort();
  release();
  assert.deepEqual(await pending, unknown);
});

test('the final check runs after token acquisition and can refuse Gmail dispatch', async () => {
  const calls: string[] = [];
  const adapter = createGmailContact({ senderAddress,
    getAccessToken: async () => { calls.push('token'); return token; },
    fetch: async () => { calls.push('send'); return Response.json({ id: 'synthetic-id' }); },
  });
  const rejected = await adapter.dispatch(approved, undefined, async (...args: []) => {
    assert.deepEqual(args, []);
    calls.push('check');
    throw new Error('synthetic-secret');
  });
  assert.deepEqual(rejected, failed);
  assert.ok(!JSON.stringify(rejected).includes('secret'));
  assert.deepEqual(calls, ['token', 'check']);
  calls.length = 0;
  assert.deepEqual(await adapter.dispatch(approved, undefined, async () => { calls.push('check'); }),
    { status: 'submitted', providerOperationId: 'synthetic-id' });
  assert.deepEqual(calls, ['token', 'check', 'send']);
});

test('an abort while the final check is pending prevents a later Gmail request', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  let calls = 0;
  const adapter = createGmailContact({ senderAddress, getAccessToken: async () => token,
    fetch: async () => { calls++; return Response.json({ id: 'unexpected' }); },
  });
  const pending = adapter.dispatch(approved, controller.signal, async () => { entered(); await waiting; });
  await started;
  controller.abort();
  release();
  assert.deepEqual(await pending, failed);
  assert.equal(calls, 0);
});
