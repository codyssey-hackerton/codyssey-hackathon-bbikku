import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, type ApiClient } from '../src/api/http';
import { createMutationMachine, type Mutation } from '../src/api/mutation';
import {
  createContactClient,
  type ContactDraftInput,
  type ContactRequest,
  type ContactSendInput,
  type RecipientInput,
} from '../src/contacts/client';

const proposalId = 'proposal /?1';
const contactId = 'contact /?1';
const expectedSenderAddress = 'sender@example.test';
const sendInput = { id: contactId, contactRevision: 1, expectedSenderAddress };
const recipientInput: RecipientInput = {
  displayName: '테스트 상대', channel: 'email', address: 'recipient@example.test', confirmed: true,
};
const recipient = {
  id: 'recipient-1', displayName: recipientInput.displayName, channel: recipientInput.channel,
  address: recipientInput.address, confirmedByUserAt: '2026-10-31T10:00:00.000Z',
};
const draftInput: ContactDraftInput = {
  recipientRef: recipient.id, channel: 'email', purpose: '일정 조정', messageOrCallBrief: '가능한 시간을 확인합니다.',
  allowedOptions: [{ optionId: 'option-1', proposalId, proposalRevision: 2 }],
};
const draft: ContactRequest = {
  id: contactId, revision: 1, baseScheduleRevision: 0, baseContextRevision: 0,
  recipientRef: recipient.id, recipientSnapshot: { displayName: recipient.displayName, channel: 'email', address: recipient.address },
  channel: 'email', purpose: draftInput.purpose, messageOrCallBrief: draftInput.messageOrCallBrief,
  allowedOptions: draftInput.allowedOptions, approvalId: null, executionKey: 'execution-1', providerOperationId: null,
  deliveryStatus: 'pending_approval', negotiationStatus: 'not_started', createdAt: '2026-10-31T10:00:00.000Z',
};
const ready: ContactRequest = { ...draft, approvalId: 'approval-1', deliveryStatus: 'ready' };
const sent: ContactRequest = { ...ready, deliveryStatus: 'sent_or_connected', negotiationStatus: 'awaiting_response', providerOperationId: 'provider-1' };
const op = <I>(input: I): Mutation<I> => ({ input, requestId: 'request-1', idempotencyKey: 'operation-1' });

function stub(data: unknown): ApiClient {
  return { get: async <T>() => data as T, post: async <T>() => data as T };
}

const isInvalidResponse = (error: unknown) => error instanceof ApiError && error.code === 'invalid_response';

test('reply results validate contact identity, counts and stored response identity', async () => {
  const response = { id: 'response-1', contactRequestId: contactId, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z',
    outcome: 'unclear', selectedOptionId: null, evidenceRef: 'evidence-1', displayText: '네', reviewReason: 'sender_unverified' };
  const good = { contactRequest: sent, responses: [response], checkedCount: 1, unmatchedCount: 0 };
  assert.deepEqual(await createContactClient(stub(good)).checkReplies(op({ id: contactId, contactRevision: 1 })), good);
  for (const data of [{ ...good, unmatchedCount: -1 }, { ...good, checkedCount: 0.5 },
    { ...good, responses: [{ ...response, contactRequestId: 'other' }] }, { ...good, responses: [response, response] },
    { ...good, responses: [{ ...response, displayText: 'x'.repeat(2001) }] }]) {
    await assert.rejects(createContactClient(stub(data)).checkReplies(op({ id: contactId, contactRevision: 1 })), isInvalidResponse);
  }
  await assert.rejects(createContactClient(stub({ contactRequest: sent, response: { ...response, id: 'other' }, scheduleRevision: 1, changed: true }))
    .confirmResponse(op({ id: contactId, responseId: response.id, contactRevision: 1, selectedOptionId: 'option-1' })), isInvalidResponse);
});

test('read methods use encoded targets, unwrap contact data, and report email capability', async () => {
  const requests: string[] = [];
  const responses: unknown[] = [
    { contactRequests: [draft] }, { contactRequest: draft },
    { status: 'available', senderAddress: 'sender@example.test' }, { status: 'not_configured', senderAddress: null },
  ];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async (url, init) => {
    requests.push(`${init?.method} ${url}`);
    return Response.json({ requestId: 'response-1', data: responses.shift() });
  } });
  const client = createContactClient(api);
  assert.deepEqual(await client.list(proposalId), [draft]);
  assert.deepEqual(await client.get(contactId), draft);
  assert.deepEqual(await client.emailConnection(), { status: 'available', senderAddress: 'sender@example.test' });
  assert.deepEqual(await client.emailConnection(), { status: 'not_configured', senderAddress: null });
  assert.deepEqual(requests, [
    'GET http://localhost:3001/v1/contact-requests?proposalId=proposal%20%2F%3F1',
    'GET http://localhost:3001/v1/contact-requests/contact%20%2F%3F1',
    'GET http://localhost:3001/v1/email-connection',
    'GET http://localhost:3001/v1/email-connection',
  ]);
});

test('mutations send the contract fields and idempotency key through the shared API client', async () => {
  const requests: { url: string; method: string | undefined; body: unknown; key: string }[] = [];
  const responses: unknown[] = [
    { recipient }, { contactRequest: draft }, { contactRequest: ready },
    { contactRequest: { ...draft, approvalId: 'approval-2', deliveryStatus: 'rejected' } }, { contactRequest: sent },
  ];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)),
      key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
    return Response.json({ requestId: 'response-1', data: responses.shift() });
  } });
  const client = createContactClient(api);
  assert.deepEqual(await client.createRecipient(op(recipientInput)), recipient);
  assert.deepEqual(await client.createDraft(op(draftInput)), draft);
  assert.deepEqual(await client.decide(op({ id: contactId, contactRevision: 1, decision: 'accept' })), ready);
  assert.equal((await client.decide(op({ id: contactId, contactRevision: 1, decision: 'reject' }))).deliveryStatus, 'rejected');
  assert.deepEqual(await client.send(op(sendInput)), sent);
  assert.deepEqual(requests, [
    { url: 'http://localhost:3001/v1/recipients', method: 'POST', body: { requestId: 'request-1', ...recipientInput }, key: 'operation-1' },
    { url: 'http://localhost:3001/v1/contact-requests', method: 'POST', body: { requestId: 'request-1', ...draftInput }, key: 'operation-1' },
    { url: 'http://localhost:3001/v1/contact-requests/contact%20%2F%3F1/decision', method: 'POST', body: { requestId: 'request-1', contactRevision: 1, decision: 'accept' }, key: 'operation-1' },
    { url: 'http://localhost:3001/v1/contact-requests/contact%20%2F%3F1/decision', method: 'POST', body: { requestId: 'request-1', contactRevision: 1, decision: 'reject' }, key: 'operation-1' },
    { url: 'http://localhost:3001/v1/contact-requests/contact%20%2F%3F1/send', method: 'POST', body: { requestId: 'request-1', contactRevision: 1, expectedSenderAddress }, key: 'operation-1' },
  ]);
});

test('reads reject malformed or unrelated data rather than claiming a valid contact', async () => {
  const badContacts: unknown[] = [
    null, { ...draft, id: '' }, { ...draft, revision: 0 }, { ...draft, baseContextRevision: -1 },
    { ...draft, recipientSnapshot: { ...draft.recipientSnapshot, channel: 'phone' } },
    { ...draft, recipientSnapshot: { ...draft.recipientSnapshot, address: '' } },
    { ...draft, allowedOptions: [] }, { ...draft, allowedOptions: [{ ...draft.allowedOptions[0], proposalRevision: 0 }] },
    { ...draft, allowedOptions: [draft.allowedOptions[0], draft.allowedOptions[0]] },
    { ...draft, approvalId: 1 }, { ...draft, providerOperationId: '' },
    { ...draft, deliveryStatus: 'delivered' }, { ...draft, negotiationStatus: 'unknown' },
    { ...draft, createdAt: '2026-02-30T10:00:00Z' },
  ];
  for (const contactRequest of badContacts) {
    await assert.rejects(createContactClient(stub({ contactRequest })).get(contactId), isInvalidResponse);
  }
  await assert.rejects(createContactClient(stub({ contactRequest: { ...draft, id: 'other' } })).get(contactId), isInvalidResponse);
  for (const contactRequests of [[draft, draft], [{ ...draft, allowedOptions: [{ ...draft.allowedOptions[0], proposalId: 'other' }] }], 'not-an-array']) {
    await assert.rejects(createContactClient(stub({ contactRequests })).list(proposalId), isInvalidResponse);
  }
  for (const data of [{ status: 'offline', senderAddress: null }, { status: 'available' }, { status: 'available', senderAddress: 1 },
    { status: 'available', senderAddress: null }, { status: 'available', senderAddress: '' }, { status: 'available', senderAddress: '  ' }]) {
    await assert.rejects(createContactClient(stub(data)).emailConnection(), isInvalidResponse);
  }
  assert.deepEqual(await createContactClient(stub({ contactRequests: [] })).list(proposalId), []);
});

test('write responses must match the original target, content, revision and decision', async () => {
  for (const invalid of [{ ...recipient, address: 'different@example.test' }, { ...recipient, confirmedByUserAt: 'yesterday' }, { ...recipient, id: '' }]) {
    await assert.rejects(createContactClient(stub({ recipient: invalid })).createRecipient(op(recipientInput)), isInvalidResponse);
  }
  for (const invalid of [
    { ...draft, purpose: 'changed' }, { ...draft, recipientRef: 'other' }, { ...draft, revision: 2 },
    { ...draft, deliveryStatus: 'ready' }, { ...draft, approvalId: 'unexpected' },
    { ...draft, allowedOptions: [{ ...draft.allowedOptions[0], proposalRevision: 3 }] },
  ]) {
    await assert.rejects(createContactClient(stub({ contactRequest: invalid })).createDraft(op(draftInput)), isInvalidResponse);
  }
  for (const invalid of [{ ...ready, id: 'other' }, { ...ready, revision: 2 }, { ...ready, approvalId: null }, { ...ready, deliveryStatus: 'rejected' }]) {
    await assert.rejects(createContactClient(stub({ contactRequest: invalid })).decide(op({ id: contactId, contactRevision: 1, decision: 'accept' })), isInvalidResponse);
  }
  for (const invalid of [
    draft, ready, { ...sent, id: 'other' }, { ...sent, revision: 2 },
    { ...sent, approvalId: null }, { ...sent, deliveryStatus: 'rejected' },
    { ...sent, negotiationStatus: 'not_started' }, { ...sent, providerOperationId: null },
    { ...sent, deliveryStatus: 'outcome_unknown' }, { ...ready, deliveryStatus: 'failed', providerOperationId: 'provider-1' },
    { ...ready, deliveryStatus: 'submitting', providerOperationId: 'provider-1' },
  ]) {
    await assert.rejects(createContactClient(stub({ contactRequest: invalid })).send(op(sendInput)), isInvalidResponse);
  }
  const unknown = { ...ready, deliveryStatus: 'outcome_unknown' as const };
  assert.equal((await createContactClient(stub({ contactRequest: unknown })).send(op(sendInput))).deliveryStatus, 'outcome_unknown');
  const failed = { ...ready, deliveryStatus: 'failed' as const };
  assert.equal((await createContactClient(stub({ contactRequest: failed })).send(op(sendInput))).deliveryStatus, 'failed');
  const submitting = { ...ready, deliveryStatus: 'submitting' as const };
  assert.equal((await createContactClient(stub({ contactRequest: submitting })).send(op(sendInput))).deliveryStatus, 'submitting');
});

test('API errors propagate without being converted into successful contact states', async () => {
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async () =>
    Response.json({ requestId: 'r', error: { code: 'not_configured', message: 'unavailable', retryable: false } }, { status: 503 }) });
  await assert.rejects(createContactClient(api).send(op(sendInput)),
    (error: unknown) => error instanceof ApiError && error.code === 'not_configured' && error.status === 503);
});

test('send allows time for the server provider timeout', async () => {
  let options: { idempotencyKey: string; timeoutMs?: number } | undefined;
  const api: ApiClient = {
    get: async <T>() => ({} as T),
    post: async <T>(_path: string, _body: object, provided: { idempotencyKey: string; timeoutMs?: number }) => {
      options = provided;
      return { contactRequest: sent } as T;
    },
  };
  await createContactClient(api).send(op(sendInput));
  assert.deepEqual(options, { idempotencyKey: 'operation-1', timeoutMs: 60_000 });
});

test('a ready send response stays uncertain and retry preserves the exact intent', async () => {
  const requests: { url: string; body: string; key: string }[] = [];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'dev', fetcher: async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
    return Response.json({ requestId: 'r', data: requests.length === 1 ? { contactRequest: ready } : { contactRequest: sent } });
  } });
  const client = createContactClient(api);
  const machine = createMutationMachine({ execute: (operation: Mutation<ContactSendInput>) => client.send(operation), changed: () => {} });
  const input = { ...sendInput };
  machine.submit(input);
  input.id = 'another-contact';
  input.contactRevision = 2;
  input.expectedSenderAddress = 'other-sender@example.test';
  await new Promise(resolve => setTimeout(resolve, 0));
  const failed = machine.getState();
  assert.equal(failed.status, 'error');
  if (failed.status === 'error') assert.equal(failed.uncertain, true);
  machine.reset();
  assert.equal(machine.getState().status, 'error');
  machine.retry();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(machine.getState().status, 'success');
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(JSON.parse(requests[0].body).contactRevision, 1);
  assert.equal(JSON.parse(requests[0].body).expectedSenderAddress, expectedSenderAddress);
  assert.ok(requests[0].key);
});

test('phone connection and call use the requested contract and validate responses', async () => {
  const phone = { ...sent, channel: 'phone' as const, recipientSnapshot: { ...sent.recipientSnapshot, channel: 'phone' as const, address: '+821012345678' } };
  const requests: any[] = [];
  const responses = [{ status: 'not_configured', senderNumber: null, lastRequestId: null }, { status: 'available', senderNumber: '+15550000001', lastRequestId: 'request-1' }, { contactRequest: phone }];
  const api: ApiClient = {
    get: async <T>(path: string) => { requests.push({ path }); return responses.shift() as T; },
    post: async <T>(path: string, body: object, options: object) => { requests.push({ path, body, options }); return responses.shift() as T; },
  };
  const client = createContactClient(api);
  assert.equal((await client.phoneConnection()).status, 'not_configured');
  assert.equal((await client.connectPhone(op({ accountSid: 'sid', authToken: 'token', fromNumber: '+15550000001' }))).status, 'available');
  assert.deepEqual(await client.call(op({ id: contactId, contactRevision: 1, expectedSenderNumber: '+15550000001' })), phone);
  assert.deepEqual(requests[0], { path: '/v1/phone-connection' });
  assert.deepEqual(requests[1], { path: '/v1/phone-connection', body: { requestId: 'request-1', accountSid: 'sid', authToken: 'token', fromNumber: '+15550000001' }, options: { idempotencyKey: 'operation-1' } });
  assert.deepEqual(requests[2], { path: '/v1/contact-requests/contact%20%2F%3F1/call', body: { requestId: 'request-1', contactRevision: 1, expectedSenderNumber: '+15550000001' }, options: { idempotencyKey: 'operation-1', timeoutMs: 60_000 } });
  await assert.rejects(createContactClient(stub({ status: 'available', senderNumber: '01012345678' })).phoneConnection(), isInvalidResponse);
  assert.deepEqual(await createContactClient(stub({ status: 'available', senderNumber: '+15550000001', lastRequestId: 'request-1' })).phoneConnection(),
    { status: 'available', senderNumber: '+15550000001', lastRequestId: 'request-1' });
  for (const lastRequestId of ['', 4, {}, 'wrong-request']) {
    await assert.rejects(createContactClient(stub({ status: 'available', senderNumber: '+15550000001', lastRequestId }))
      .connectPhone(op({ accountSid: 'sid', authToken: 'token', fromNumber: '+15550000001' })), isInvalidResponse);
  }
  await assert.rejects(createContactClient(stub({ contactRequest: sent })).call(op({ id: contactId, contactRevision: 1, expectedSenderNumber: '+15550000001' })), isInvalidResponse);
});

test('ClawOps connection sends its own credential shape and requires the matching provider', async () => {
  const input = { provider: 'clawops' as const, accountId: 'account', apiKey: 'key', signingSecret: 'signing', fromNumber: '+15550000001' };
  const calls: any[] = [];
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(path, body, options) => {
    calls.push({ path, body, options }); return { status: 'available', provider: 'clawops', senderNumber: input.fromNumber, lastRequestId: 'request-1' } as T;
  } };
  assert.equal((await createContactClient(api).connectPhone(op(input))).provider, 'clawops');
  assert.deepEqual(calls[0].body, { requestId: 'request-1', ...input });
  for (const provider of [undefined, 'twilio', 'unknown']) {
    await assert.rejects(createContactClient(stub({ status: 'available', senderNumber: input.fromNumber, ...(provider ? { provider } : {}) })).connectPhone(op(input)), isInvalidResponse);
  }
  for (const lastRequestId of [undefined, null, 'other-request']) {
    await assert.rejects(createContactClient(stub({ status: 'available', provider: 'clawops', senderNumber: input.fromNumber,
      ...(lastRequestId === undefined ? {} : { lastRequestId }) })).connectPhone(op(input)), isInvalidResponse);
  }
  await assert.rejects(createContactClient(stub({ status: 'available', provider: 'clawops', senderNumber: input.fromNumber }))
    .connectPhone(op({ accountSid: 'sid', authToken: 'token', fromNumber: input.fromNumber })), isInvalidResponse);
});

test('managed connection requires agent mode and its own matching receipt', async () => {
  const input = { provider: 'clawops' as const, mode: 'agent' as const, accountId: 'account', apiKey: 'key', agentId: 'agent', fromNumber: '+15550000001' };
  const response = { status: 'available', provider: 'clawops', mode: 'agent', senderNumber: input.fromNumber, lastRequestId: 'request-1' };
  assert.deepEqual(await createContactClient(stub(response)).connectPhone(op(input)), response);
  for (const invalid of [{ ...response, mode: undefined }, { ...response, mode: 'voiceml' }, { ...response, lastRequestId: undefined }]) {
    await assert.rejects(createContactClient(stub(invalid)).connectPhone(op(input)), isInvalidResponse);
  }
});

test('call check sends a scoped idempotent request and validates review metadata', async () => {
  const phone = { ...sent, channel: 'phone' as const, recipientSnapshot: { ...sent.recipientSnapshot, channel: 'phone' as const, address: '+821012345678' } };
  const calls: any[] = [];
  const response = { contactRequest: phone, responses: [], checkedCount: 0, unmatchedCount: 0, callStatus: 'completed', complete: true, truncated: false };
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(path, body, options) => { calls.push({ path, body, options }); return response as T; } };
  assert.deepEqual(await createContactClient(api).checkCall(op({ id: contactId, contactRevision: 1 })), response);
  assert.deepEqual(calls[0], { path: '/v1/contact-requests/contact%20%2F%3F1/check-call', body: { requestId: 'request-1', contactRevision: 1 }, options: { idempotencyKey: 'operation-1', timeoutMs: 60_000 } });
  for (const invalid of [{ ...response, complete: 'true' }, { ...response, truncated: 0 }, { ...response, contactRequest: sent }]) {
    await assert.rejects(createContactClient(stub(invalid)).checkCall(op({ id: contactId, contactRevision: 1 })), isInvalidResponse);
  }
});
