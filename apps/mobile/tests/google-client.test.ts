import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../src/api/http';
import { createGoogleClient } from '../src/google/client';

const validUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code',
  state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback',
  scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly' })}`;
const completionSecret = 'q'.repeat(43), confirmationCode = 'z'.repeat(43);
function stub(data: unknown): ApiClient { return { get: async <T>() => data as T, post: async <T>() => data as T }; }

test('Google 연결은 신뢰할 수 있는 동의 URL만 수락하고 앱 세션이나 코드를 전송하지 않는다', async () => {
  const calls: any[] = [];
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(...args: any[]) => { calls.push(args); return { authorizationUrl: validUrl, completionSecret } as T; } };
  assert.deepEqual(await createGoogleClient(api).start('calendar'), { authorizationUrl: validUrl, completionSecret });
  assert.deepEqual(calls, [['/v1/google/oauth/start', { kind: 'calendar' }, { idempotencyKey: '' }]]);
  for (const authorizationUrl of ['https://example.test/o/oauth2/v2/auth?client_id=x&response_type=code&state=y',
    'http://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=y',
    `${validUrl}&access_token=secret`, `${validUrl}&code=secret`, validUrl.replace(`state=${'s'.repeat(43)}`, ''), `${validUrl}#token`,
    validUrl.replace('calendar.events.readonly', 'gmail.send'), `${validUrl}&state=another`]) {
    await assert.rejects(createGoogleClient(stub({ authorizationUrl, completionSecret })).start('calendar'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
  await assert.rejects(createGoogleClient(stub({ authorizationUrl: validUrl })).start('calendar'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
});

test('최종 확인은 메모리 secret과 일회 코드만 본문에 보내고 명시 성공만 수용한다', async () => {
  const calls: any[] = [];
  const api: ApiClient = { get: async <T>() => ({} as T), post: async <T>(...args: any[]) => { calls.push(args); return { status: 'connected' } as T; } };
  await createGoogleClient(api).complete(completionSecret, confirmationCode);
  assert.deepEqual(calls, [['/v1/google/oauth/complete', { completionSecret, confirmationCode }, { idempotencyKey: '' }]]);
  await assert.rejects(createGoogleClient(stub({ status: 'pending' })).complete(completionSecret, confirmationCode), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
});

test('연결 상태를 권한별로 별도 확인하고 잘못된 상태를 연결됨으로 처리하지 않는다', async () => {
  const calls: string[] = [];
  const api: ApiClient = { get: async <T>(path: string) => { calls.push(path); return (path.includes('calendar')
    ? { status: 'available', accountLabel: null } : { status: 'not_configured', senderAddress: null }) as T; }, post: async <T>() => ({} as T) };
  const client = createGoogleClient(api);
  assert.deepEqual(await client.status('calendar'), { status: 'available', account: null });
  assert.deepEqual(await client.status('gmail_send'), { status: 'not_configured', account: null });
  assert.deepEqual(await client.status('gmail_read'), { status: 'not_configured', account: null });
  assert.deepEqual(calls, ['/v1/calendar-connection', '/v1/email-connection', '/v1/email-reply-connection']);
  await assert.rejects(createGoogleClient(stub({ status: 'available', senderAddress: null })).status('gmail_send'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
});
