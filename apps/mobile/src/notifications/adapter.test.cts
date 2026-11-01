import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureReminderForeground, createNativeReminderAdapter } from './native';
import { createReminderAdapter as createWebAdapter } from './adapter';

const now = Date.parse('2026-11-01T00:00:00Z');
const input = { id: 'opaque-id', title: '일정 알림', body: '확인해 주세요', triggerAt: '2026-11-01T01:00:00Z' };
function mockNative() {
  const calls: string[] = [], requests: any[] = [], pending = new Map<string, any>();
  let status: any = { status: 'granted', ios: { status: 2 } }, failAfterSchedule = false, channelEnabled = true;
  const api = {
    IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
    AndroidImportance: { NONE: 0, DEFAULT: 3 }, SchedulableTriggerInputTypes: { DATE: 'date', DAILY: 'daily' },
    async getPermissionsAsync() { calls.push('status'); return status; },
    async requestPermissionsAsync() { calls.push('permission'); return status; },
    async setNotificationChannelAsync() { calls.push('channel'); return { importance: channelEnabled ? 3 : 0 }; },
    setNotificationHandler() { calls.push('handler'); },
    async cancelScheduledNotificationAsync(id: string) { calls.push(`cancel:${id}`); pending.delete(id); },
    async scheduleNotificationAsync(request: any) { calls.push(`schedule:${request.identifier}`); requests.push(request); pending.set(request.identifier, request);
      if (failAfterSchedule) { failAfterSchedule = false; throw new Error('uncertain'); } return request.identifier; },
  };
  return { api, calls, requests, pending, setStatus(value: any) { status = value; }, setFail() { failAfterSchedule = true; }, disableChannel() { channelEnabled = false; } };
}
const adapter = (mock: ReturnType<typeof mockNative>, platform: 'ios' | 'android' = 'ios', clock: () => number = () => now) =>
  createNativeReminderAdapter(platform, async () => mock.api as any, clock);

test('web is explicitly unsupported without requesting permission or scheduling', async () => {
  const web = createWebAdapter();
  assert.equal(await web.getPermission(), 'not_supported'); assert.equal(await web.requestPermission(), 'not_supported');
  assert.deepEqual(await web.schedule(input), { status: 'not_supported' }); assert.deepEqual(await web.cancel(input.id), { status: 'not_supported' });
  assert.deepEqual(await web.scheduleDaily({ id: 'a', title: 'a', body: 'b', localTime: '09:00' }), { status: 'not_supported' });
});

test('daily reminders are validated, replace the same id, and never prompt implicitly', async () => {
  const mock = mockNative(), reminders = adapter(mock, 'android');
  const daily = { id: 'review-morning', title: '아침', body: '확인', localTime: '09:00' };
  assert.deepEqual(await reminders.scheduleDaily({ ...daily, localTime: '24:00' }), { status: 'error' });
  assert.equal((await reminders.scheduleDaily(daily)).status, 'scheduled');
  assert.deepEqual(mock.requests[0].trigger, { type: 'daily', hour: 9, minute: 0, channelId: 'pikku-reminders-v1', delivery: 'bestEffort' });
  assert.equal((await reminders.scheduleDaily({ ...daily, localTime: '10:15' })).status, 'scheduled');
  assert.equal(mock.pending.size, 1); assert.equal(mock.requests[1].trigger.hour, 10); assert.equal(mock.calls.includes('permission'), false);
  mock.setStatus({ status: 'denied', ios: { status: 1 } });
  assert.deepEqual(await reminders.scheduleDaily(daily), { status: 'denied' }); assert.equal(mock.requests.length, 2);
});

test('aborting an in-flight daily reminder removes the late result', async () => {
  const mock = mockNative(), reminders = adapter(mock), controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const schedule = mock.api.scheduleNotificationAsync;
  mock.api.scheduleNotificationAsync = async request => { entered(); await gate; return schedule(request); };
  const result = reminders.scheduleDaily({ id: 'daily-abort', title: '아침', body: '확인', localTime: '09:00' }, { signal: controller.signal });
  await started; controller.abort(); release();
  assert.deepEqual(await result, { status: 'error' }); assert.equal(mock.pending.size, 0);
});

test('permission is read without prompting and iOS provisional is distinguished', async () => {
  const mock = mockNative(), reminders = adapter(mock);
  assert.equal(await reminders.getPermission(), 'granted'); assert.ok(!mock.calls.includes('permission'));
  mock.setStatus({ status: 'undetermined', ios: { status: 0 } });
  assert.equal(await reminders.getPermission(), 'undetermined');
  assert.deepEqual(await reminders.schedule(input), { status: 'denied' }); assert.ok(!mock.calls.includes('permission'));
  mock.setStatus({ status: 'granted', ios: { status: 3 } });
  assert.equal(await reminders.requestPermission(), 'provisional');
  assert.equal((await reminders.schedule(input)).status, 'scheduled');
});

test('same identifier is cancelled before rescheduling, including after an uncertain failure', async () => {
  const mock = mockNative(), reminders = adapter(mock);
  mock.setFail(); assert.deepEqual(await reminders.schedule(input), { status: 'error' }); assert.equal(mock.pending.size, 1);
  const result = await reminders.schedule({ ...input, title: '바뀐 알림' });
  assert.deepEqual(result, { status: 'scheduled', identifier: 'pikku-reminder-v1:opaque-id', delivery: 'device' });
  assert.equal(mock.pending.size, 1); assert.equal(mock.requests[1].content.title, '바뀐 알림');
  assert.equal(mock.requests[1].trigger.date.toISOString(), input.triggerAt.replace('Z', '.000Z'));
  assert.equal(mock.calls.filter(value => value.startsWith('cancel:')).length, 2);
  assert.deepEqual(await reminders.cancel(input.id), { status: 'cancelled' }); assert.equal(mock.pending.size, 0);
});

test('same-id operations are serialized across adapter instances', async () => {
  const mock = mockNative(), first = adapter(mock), second = adapter(mock);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  const schedule = mock.api.scheduleNotificationAsync;
  mock.api.scheduleNotificationAsync = async request => { entered(); await gate; return schedule(request); };
  const pending = first.schedule(input); await start;
  const cancelled = second.cancel(input.id);
  assert.equal(mock.calls.filter(value => value.startsWith('cancel:')).length, 1);
  release(); assert.equal((await pending).status, 'scheduled');
  assert.deepEqual(await cancelled, { status: 'cancelled' }); assert.equal(mock.pending.size, 0);
});

test('aborted in-flight schedule is cancelled before the next same-id request', async () => {
  const mock = mockNative(), first = adapter(mock), second = adapter(mock), controller = new AbortController();
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; }); const schedule = mock.api.scheduleNotificationAsync;
  let calls = 0;
  mock.api.scheduleNotificationAsync = async request => { if (++calls === 1) { entered(); await gate; } return schedule(request); };
  const old = first.schedule(input, { signal: controller.signal }); await start; controller.abort();
  const next = second.schedule({ ...input, title: '새 예약' }); release();
  assert.equal((await old).status, 'error'); assert.equal((await next).status, 'scheduled');
  assert.equal(mock.pending.size, 1); assert.equal([...mock.pending.values()][0].content.title, '새 예약');
});

test('foreground behavior only presents this adapter’s reminders', async () => {
  const mock = mockNative(); let handler: any;
  mock.api.setNotificationHandler = (value: any) => { handler = value; };
  configureReminderForeground(mock.api as any);
  const own = await handler.handleNotification({ request: { identifier: 'pikku-reminder-v1:one' } });
  const other = await handler.handleNotification({ request: { identifier: 'unrelated' } });
  assert.equal(own.shouldShowBanner, true); assert.equal(other.shouldShowBanner, false);
});

test('scheduled content is a snapshot and cancellation failure prevents a replacement', async () => {
  const mock = mockNative(), reminders = adapter(mock); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  const read = mock.api.getPermissionsAsync;
  mock.api.getPermissionsAsync = async () => { entered(); await gate; return read(); };
  const request = { ...input }; const pending = reminders.schedule(request); await start;
  request.id = 'changed'; request.title = '변경'; request.triggerAt = '2030-01-01T00:00:00Z';
  release(); assert.equal((await pending).status, 'scheduled');
  assert.equal(mock.requests[0].identifier, 'pikku-reminder-v1:opaque-id'); assert.equal(mock.requests[0].content.title, input.title);
  assert.equal(mock.requests[0].trigger.date.toISOString(), '2026-11-01T01:00:00.000Z');
  mock.api.cancelScheduledNotificationAsync = async () => { throw new Error('cancel outcome unknown'); };
  assert.deepEqual(await reminders.schedule(input), { status: 'error' }); assert.equal(mock.requests.length, 1);
});

test('past, malformed and expired-during-cancel requests never schedule', async () => {
  const mock = mockNative(); let clock = now; const reminders = adapter(mock, 'ios', () => clock);
  for (const value of [{ ...input, triggerAt: '2026-11-01T00:00:00Z' }, { ...input, triggerAt: 'bad' }, { ...input, id: '' }]) {
    assert.deepEqual(await reminders.schedule(value), { status: 'error' });
  }
  assert.deepEqual(mock.calls, []);
  const cancel = mock.api.cancelScheduledNotificationAsync;
  mock.api.cancelScheduledNotificationAsync = async id => { await cancel(id); clock = now + 3_600_000; };
  assert.deepEqual(await reminders.schedule(input), { status: 'error' }); assert.equal(mock.requests.length, 0);
});

test('sub-millisecond reminder timestamps round up to avoid triggering early', async () => {
  const mock = mockNative(), reminders = adapter(mock);
  assert.equal((await reminders.schedule({ ...input, triggerAt: '2026-11-01T01:00:00.123456Z' })).status, 'scheduled');
  assert.equal(mock.requests[0].trigger.date.toISOString(), '2026-11-01T01:00:00.124Z');
  assert.equal((await reminders.schedule({ ...input, triggerAt: '2026-11-01T01:00:00.123000Z' })).status, 'scheduled');
  assert.equal(mock.requests[1].trigger.date.toISOString(), '2026-11-01T01:00:00.123Z');
});

test('a candidate expiring while the OS cancels an old reminder is never scheduled', async () => {
  const mock = mockNative(); let clock = now; const reminders = adapter(mock, 'ios', () => clock);
  const cancel = mock.api.cancelScheduledNotificationAsync;
  mock.api.cancelScheduledNotificationAsync = async id => { await cancel(id); clock += 5_000; };
  assert.deepEqual(await reminders.schedule(input, { validUntil: '2026-11-01T00:00:05Z' }), { status: 'error' });
  assert.equal(mock.requests.length, 0);
});

test('a candidate expiring during Android channel setup never cancels or schedules', async () => {
  const mock = mockNative(); let clock = now; const reminders = adapter(mock, 'android', () => clock);
  const createChannel = mock.api.setNotificationChannelAsync;
  mock.api.setNotificationChannelAsync = async () => { const value = await createChannel(); clock += 5_000; return value; };
  assert.deepEqual(await reminders.schedule(input, { validUntil: '2026-11-01T00:00:05Z' }), { status: 'error' });
  assert.equal(mock.calls.some(value => value.startsWith('cancel:')), false); assert.equal(mock.requests.length, 0);
});

test('Android channel is checked before requesting permission and before scheduling', async () => {
  const mock = mockNative(), reminders = adapter(mock, 'android');
  assert.equal(await reminders.requestPermission(), 'granted'); assert.deepEqual(mock.calls.slice(0, 2), ['channel', 'permission']);
  assert.equal((await reminders.schedule(input)).status, 'scheduled');
  assert.equal(mock.requests[0].trigger.channelId, 'pikku-reminders-v1'); assert.equal(mock.requests[0].trigger.delivery, 'bestEffort');
  mock.disableChannel(); assert.deepEqual(await reminders.schedule({ ...input, id: 'other' }), { status: 'denied' });
  assert.equal(mock.requests.length, 1);
});

test('Android before API 26 does not require unsupported notification channels', async () => {
  const mock = mockNative(); mock.disableChannel();
  const reminders = createNativeReminderAdapter('android', async () => mock.api as any, () => now, 25);
  assert.equal(await reminders.requestPermission(), 'granted'); assert.equal((await reminders.schedule(input)).status, 'scheduled');
  assert.equal(mock.calls.includes('channel'), false); assert.equal(mock.requests[0].trigger.channelId, undefined);
});
