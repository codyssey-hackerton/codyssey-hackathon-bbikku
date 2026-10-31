import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const headers = (user: string, key = 'setting') => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const setting = (requestId: string, expectedRevision: number) => ({ requestId, expectedRevision, timezone: 'Asia/Seoul',
  evening: { enabled: true, localTime: '21:00' }, morning: { enabled: false, localTime: null } });

test('review settings default disabled, validate local time, use CAS and remain user-scoped', async t => {
  let reconciles = 0;
  const app = buildApp({ sessions, onReviewScheduleChanged: async () => { reconciles++; } }); t.after(() => app.close());
  const initial = await app.inject({ method: 'GET', url: '/v1/review-schedule', headers: headers('alice') });
  assert.deepEqual(initial.json().data.reviewSchedule, { revision: 0, timezone: 'UTC', evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } });
  const invalid = await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('alice', 'invalid'), payload: { ...setting('invalid', 0), evening: { enabled: true, localTime: null } } });
  assert.equal(invalid.statusCode, 400);
  const saved = await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('alice'), payload: setting('saved', 0) });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().data.reviewSchedule.revision, 1);
  const replay = await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('alice'), payload: setting('retry', 0) });
  assert.deepEqual(replay.json(), saved.json());
  assert.equal(reconciles, 2);
  const stale = await app.inject({ method: 'POST', url: '/v1/review-schedule', headers: headers('alice', 'other'), payload: setting('stale', 0) });
  assert.equal(stale.statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/review-schedule', headers: headers('bob') })).json().data.reviewSchedule.revision, 0);
});
