import test from 'node:test';
import assert from 'node:assert/strict';
import { teamPreviewSessions } from '../src/auth.ts';

test('preview sessions isolate members and expire', async () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const sessions = teamPreviewSessions([{ token: a, userId: 'user-a' }, { token: b, userId: 'user-b' }], '2030-01-01T01:00:00Z', () => now);
  assert.deepEqual(await sessions.resolve(a), { userId: 'user-a' });
  assert.deepEqual(await sessions.resolve(b), { userId: 'user-b' });
  assert.equal(await sessions.resolve('c'.repeat(32)), null);
  now += 60 * 60_000;
  assert.equal(await sessions.resolve(a), null);
});

test('preview rejects duplicate or weak credentials', () => {
  const expires = '2030-01-01T01:00:00Z', now = () => Date.parse('2030-01-01T00:00:00Z');
  assert.throws(() => teamPreviewSessions([{ token: 'short', userId: 'user-a' }], expires, now));
  assert.throws(() => teamPreviewSessions([{ token: 'a'.repeat(32), userId: 'user-a' }, { token: 'a'.repeat(32), userId: 'user-b' }], expires, now));
});
