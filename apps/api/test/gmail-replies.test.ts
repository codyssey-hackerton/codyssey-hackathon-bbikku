import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGmailReplies } from '../src/gmail-replies.ts';
import { getGmailReplyConnection } from '../src/gmail-reply-connection.ts';

const sender = 'sender@example.com', recipient = 'recipient@example.com';
const input = { providerOperationId: 'sent-id', recipientAddress: recipient, expectedSenderAddress: sender };
const h = (name: string, value: string) => ({ name, value });
const original = { id: 'sent-id', threadId: 'thread-id', internalDate: '1793500000000', labelIds: ['SENT'], payload: { headers: [h('From', sender), h('To', recipient), h('Message-ID', '<original@example.com>')] } };
const inbound = (changes: Record<string, unknown> = {}) => ({ id: 'reply-id', threadId: 'thread-id', internalDate: '1793500001000', labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [h('From', recipient), h('To', sender), h('In-Reply-To', '<original@example.com>')],
    body: { data: Buffer.from('확인 부탁드려요\n-- \n서명\n> 원본 내용').toString('base64url') } }, ...changes });
function adapter(messages: unknown[], originalValue: unknown = original) {
  let calls = 0;
  const fetcher: typeof fetch = async url => { calls++; return Response.json(String(url).includes('/threads/') ? { id: 'thread-id', messages } : originalValue); };
  return { provider: createGmailReplies({ senderAddress: sender, getAccessToken: async () => 'synthetic-token', fetcher }), get calls() { return calls; } };
}

test('reply lookup binds sent mail and returns only a sanitized human-review candidate', async () => {
  const fake = adapter([original, inbound()]); const result = await fake.provider.checkReplies(input);
  assert.equal(fake.calls, 2); assert.equal(result.unmatchedCount, 0); assert.equal(result.events.length, 1);
  assert.equal(result.events[0].outcome, 'unclear'); assert.equal(result.events[0].selectedOptionId, null);
  assert.equal(result.events[0].reviewReason, 'sender_unverified'); assert.equal(result.events[0].displayText, '확인 부탁드려요');
  assert.equal(result.events[0].providerOperationId, input.providerOperationId);
});

test('unrelated sender, thread, reference, duplicate and quoted-only reply never become accepted', async () => {
  const wrongFrom = inbound({ id: 'wrong-from', payload: { mimeType: 'text/plain', headers: [h('From', 'other@example.com'), h('To', sender), h('In-Reply-To', '<original@example.com>')], body: { data: Buffer.from('네').toString('base64url') } } });
  const wrongThread = inbound({ id: 'wrong-thread', threadId: 'other-thread' });
  const wrongRef = inbound({ id: 'wrong-ref', payload: { mimeType: 'text/plain', headers: [h('From', recipient), h('To', sender), h('In-Reply-To', '<different@example.com>')], body: { data: Buffer.from('네').toString('base64url') } } });
  const quoted = inbound({ id: 'quoted', payload: { mimeType: 'text/plain', headers: [h('From', recipient), h('To', sender), h('References', '<original@example.com>')], body: { data: Buffer.from('> 네, 수락합니다').toString('base64url') } } });
  const result = await adapter([original, wrongFrom, wrongThread, wrongRef, quoted, quoted]).provider.checkReplies(input);
  assert.equal(result.unmatchedCount, 4); assert.equal(result.events.length, 1);
  assert.equal(result.events[0].displayText, null); assert.equal(result.events[0].outcome, 'unclear');
});

test('automatic response remains review-only and bounded text strips control and quote', async () => {
  const automatic = inbound({ payload: { mimeType: 'text/plain', headers: [h('From', recipient), h('To', sender), h('References', '<original@example.com>'), h('Auto-Submitted', 'auto-replied')],
    body: { data: Buffer.from(`부재중\u202e${'가'.repeat(2500)}\nOn yesterday someone wrote:\n수락`).toString('base64url') } } });
  const result = await adapter([original, automatic]).provider.checkReplies(input);
  assert.equal(result.events[0].reviewReason, 'automatic_message'); assert.equal(result.events[0].outcome, 'unclear');
  assert.equal(result.events[0].displayText?.length, 2000); assert.ok(!result.events[0].displayText?.includes('\u202e'));
});

test('wrong original, sender account or network failure cannot produce a candidate', async () => {
  for (const sent of [{ ...original, labelIds: [] }, { ...original, threadId: 'wrong' }, { ...original, payload: { headers: [h('From', 'other@example.com'), h('To', recipient), h('Message-ID', '<original@example.com>')] } }]) {
    await assert.rejects(adapter([original, inbound()], sent).provider.checkReplies(input), (error: any) => error.code === 'provider_unavailable');
  }
  await assert.rejects(adapter([original, inbound()]).provider.checkReplies({ ...input, expectedSenderAddress: 'other@example.com' }), (error: any) => error.code === 'provider_unavailable');
  const provider = createGmailReplies({ senderAddress: sender, getAccessToken: async () => 'synthetic-token', fetcher: async () => { throw new Error('secret'); } });
  await assert.rejects(provider.checkReplies(input), (error: any) => error.code === 'provider_unavailable' && !error.message.includes('secret'));
});

test('separate reply credentials must match the send account and readonly scope', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pikku-replies-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const send = join(dir, 'send.json'), reply = join(dir, 'reply.json');
  const env = { PIKKU_GOOGLE_OAUTH_CLIENT_ID: 'client', PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };
  const credential = { version: 1, clientId: 'client', senderAddress: sender, subject: 'subject', refreshToken: 'reply-token' };
  await writeFile(send, JSON.stringify({ ...credential, refreshToken: 'send-token' }), { mode: 0o600 });
  await writeFile(reply, JSON.stringify(credential), { mode: 0o600 });
  const fetcher: typeof fetch = async url => {
    const value = String(url);
    if (value.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'synthetic-token', token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' });
    if (value.includes('openidconnect.googleapis.com')) return Response.json({ email: sender, email_verified: true, sub: 'subject' });
    return Response.json(value.includes('/threads/') ? { id: 'thread-id', messages: [original, inbound()] } : original);
  };
  const connection = await getGmailReplyConnection({ env, credentialPath: reply, sendCredentialPath: send, fetcher }); assert.ok(connection);
  assert.equal(connection.userId, 'local-developer'); assert.equal((await connection.checkReplies(input)).events.length, 1);
  await writeFile(send, JSON.stringify({ ...credential, subject: 'other-subject', refreshToken: 'send-token' }));
  await assert.rejects(connection.checkReplies(input), (error: any) => error.code === 'provider_unavailable');
  await assert.rejects(getGmailReplyConnection({ env, credentialPath: reply, sendCredentialPath: send, fetcher }), (error: any) => error.code === 'provider_unavailable');
});

test('oversized reply sets fail instead of returning incomplete results', async () => {
  const messages = [original, ...Array.from({ length: 101 }, (_, i) => inbound({ id: `reply-${i}` }))];
  await assert.rejects(adapter(messages).provider.checkReplies(input), (error: any) => error.code === 'provider_unavailable');
});

test('reply OAuth uses separate readonly consent and private file without storing access token', async t => {
  const cli: any = await import(new URL('../../../scripts/connect-gmail-replies.mjs', import.meta.url).href);
  assert.deepEqual(cli.SCOPES, ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
  assert.ok(cli.CREDENTIAL_PATH.endsWith('/.local/gmail-replies-connection.json'));
  const request = cli.createAuthorizationRequest('synthetic-client');
  assert.equal(new URL(request.url).searchParams.get('scope'), cli.SCOPES.join(' '));
  assert.equal(new URL(request.url).searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/oauth/google/callback');
  const fetcher: typeof fetch = async url => String(url).includes('oauth2.googleapis.com')
    ? Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', scope: cli.SCOPES.join(' ') })
    : Response.json({ email: sender, email_verified: true, sub: 'synthetic-subject' });
  const credential = await cli.exchangeCode({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', code: 'synthetic-code', codeVerifier: request.codeVerifier, fetcher });
  const dir = await mkdtemp(join(tmpdir(), 'pikku-reply-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'reply.json'); await cli.saveCredential(credential, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const body = await readFile(path, 'utf8'); assert.ok(!body.includes('synthetic-access')); assert.ok(!body.includes('synthetic-secret'));
});
