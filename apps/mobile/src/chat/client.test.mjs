import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createChatClient } from './client.ts';

function setup(result) {
  let sent;
  const api = createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-session', fetcher: async (_url, init) => {
    sent = { body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] };
    return Response.json({ requestId: 'r', data: { conversationId: 'c', result } });
  } });
  return { client: createChatClient(api), sent: () => sent };
}
const request = { requestId: 'r', idempotencyKey: 'key', conversationId: null, message: '추천해줘', timezone: 'Asia/Seoul' };

test('맥락과 멱등 키를 전달하고 정상 폼 초안을 반환한다', async () => {
  const draft = { kind: 'routine', fields: { title: '운동', weekdays: ['1', '3'] } };
  const { client, sent } = setup({ kind: 'reply', message: '초안', draft });
  const entryContext = { kind: 'form', draft: { kind: 'routine', fields: { title: '', weekdays: ['1'] } } };
  const result = await client.sendMessage({ ...request, entryContext });
  assert.deepEqual(result.result.draft, draft);
  assert.deepEqual(sent().body.entryContext, entryContext);
  assert.equal(sent().key, 'key');
});

test('형식이 틀리거나 예상하지 않은 초안 필드는 응답 오류로 처리한다', async () => {
  for (const draft of [
    { kind: 'routine', fields: { weekdays: '1' } },
    { kind: 'routine', fields: { userId: 'bob' } },
    { kind: 'task', fields: { title: ['배열'] } },
    { kind: 'task', fields: { kind: 'event' } },
  ]) await assert.rejects(setup({ kind: 'reply', message: '초안', draft }).client.sendMessage(request), error => error.code === 'invalid_response');
});

test('전화 요청은 일정 ID와 버전이 유효할 때만 표시 가능한 응답으로 수용한다', async () => {
  const valid = { kind: 'phone_request', message: '전화 내용을 확인해 주세요.', itemId: 'item-1', expectedRevision: 3 };
  assert.deepEqual((await setup(valid).client.sendMessage(request)).result, valid);
  for (const bad of [{ ...valid, itemId: '' }, { ...valid, expectedRevision: 0 }, { ...valid, expectedRevision: 1.5 }, { ...valid, expectedRevision: '3' }]) {
    await assert.rejects(setup(bad).client.sendMessage(request), error => error.code === 'invalid_response');
  }
});
