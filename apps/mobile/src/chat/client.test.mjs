import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createChatClient } from './client.ts';

function setup(result) {
  let sent; let calls = 0;
  const api = createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-session', fetcher: async (_url, init) => {
    calls++;
    sent = { body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] };
    return Response.json({ requestId: 'r', data: { conversationId: 'c', result } });
  } });
  return { client: createChatClient(api), sent: () => sent, calls: () => calls };
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

test('응답 선택지는 문자열 두 필드로 된 한두 개만 허용한다', async () => {
  const suggestions = [{ label: '시간 조정', message: '오후 2시로 옮기는 제안을 만들어줘' }];
  for (const result of [{ kind: 'reply', message: '선택해 주세요', suggestions },
    { kind: 'question', message: '어떻게 할까요?', missingFields: [], suggestions }]) {
    assert.deepEqual((await setup(result).client.sendMessage(request)).result, result);
  }
  for (const value of [[], [suggestions[0], suggestions[0], suggestions[0]], [{ label: '', message: '요청' }],
    [{ label: 'a'.repeat(61), message: '요청' }], [{ label: '제안', message: ' '.repeat(5) }],
    [{ label: '제안', message: 'x'.repeat(501) }], [{ ...suggestions[0], action: 'approve' }]]) {
    await assert.rejects(setup({ kind: 'reply', message: '선택', suggestions: value }).client.sendMessage(request), error => error.code === 'invalid_response');
  }
  await assert.rejects(setup({ kind: 'proposal', message: '제안', proposalIds: ['p'], suggestions }).client.sendMessage(request),
    error => error.code === 'invalid_response');
});

test('기기 맥락을 그대로 전송하고 유효한 알림 후보만 수용한다', async () => {
  const deviceContext = { currentLocation: { latitude: 37.1, longitude: 127.1, accuracyMeters: 10, capturedAt: '2030-01-02T00:00:00Z' },
    travelMode: 'car', notificationSupport: 'device' };
  const reminder = { itemId: 'item', expectedRevision: 1, title: '약속', appointmentAt: '2030-01-02T02:00:00Z',
    appointmentEndsAt: '2030-01-02T03:00:00Z', timezone: 'Asia/Seoul', basis: 'departure', minutesBefore: 10,
    departureAt: '2030-01-02T01:40:00Z', reminderAt: '2030-01-02T01:30:00Z', expiresAt: '2030-01-02T00:05:00Z',
    appointmentLocation: '서울역',
    travel: { mode: 'car', durationMinutes: 20, provider: 'kakao', basis: 'current_time', destinationName: '부산역', destinationAddress: '부산로 1' } };
  const valid = { kind: 'reminder_request', message: '확인해 주세요', reminder };
  const { client, sent } = setup(valid);
  assert.deepEqual((await client.sendMessage({ ...request, deviceContext })).result, valid);
  assert.deepEqual(sent().body.deviceContext, deviceContext); assert.equal(sent().key, 'key');
  for (const bad of [
    { ...reminder, expectedRevision: 0 }, { ...reminder, reminderAt: 'bad' }, { ...reminder, reminderAt: reminder.departureAt },
    { ...reminder, travel: { ...reminder.travel, durationMinutes: 21 } }, { ...reminder, timezone: 'Invalid/Zone' },
    { ...reminder, travel: { ...reminder.travel, destinationName: '' } }, { ...reminder, travel: { ...reminder.travel, destinationAddress: undefined } },
    { ...reminder, basis: 'event_start' }, { ...reminder, extra: 'unexpected' },
  ]) await assert.rejects(setup({ ...valid, reminder: bad }).client.sendMessage(request), error => error.code === 'invalid_response');
  const event = { ...reminder, basis: 'event_start', reminderAt: '2030-01-02T01:50:00Z' };
  delete event.travel; delete event.departureAt;
  assert.deepEqual((await setup({ ...valid, reminder: event }).client.sendMessage(request)).result.reminder, event);
});

test('만료된 위치는 같은 키 재시도에서도 다시 전송하지 않는다', async () => {
  const previousNow = Date.now;
  const base = Date.parse('2030-01-02T00:00:00Z');
  try {
    const context = { currentLocation: { latitude: 37.1, longitude: 127.1, accuracyMeters: 10,
      capturedAt: '2030-01-02T00:00:00Z' } };
    const { client, sent, calls } = setup({ kind: 'reply', message: '확인' });
    Date.now = () => base + 299_999;
    await client.sendMessage({ ...request, deviceContext: context });
    assert.deepEqual(sent().body.deviceContext, context);
    assert.equal(calls(), 1);
    Date.now = () => base + 300_000;
    await assert.rejects(client.sendMessage({ ...request, deviceContext: context }), error => error.code === 'location_expired');
    assert.equal(calls(), 1);
    assert.equal(sent().key, 'key');
  } finally { Date.now = previousNow; }
});
