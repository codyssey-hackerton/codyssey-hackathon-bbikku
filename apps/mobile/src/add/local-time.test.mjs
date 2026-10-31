import test from 'node:test';
import assert from 'node:assert/strict';
import { localInstant, localParts } from './local-time.ts';

test('local times use the selected timezone and reject invalid, skipped or ambiguous wall times', () => {
  assert.equal(localInstant('2026-11-01', '09:00', 'Asia/Seoul'), '2026-11-01T00:00:00.000Z');
  assert.deepEqual(localParts('2026-11-01T00:00:00Z', 'Asia/Seoul'), { date: '2026-11-01', time: '09:00' });
  assert.equal(localInstant('2026-02-30', '09:00', 'Asia/Seoul'), null);
  assert.equal(localInstant('2026-03-08', '02:30', 'America/New_York'), null);
  assert.equal(localInstant('2026-11-01', '01:30', 'America/New_York'), null);
  assert.equal(localInstant('2026-11-01', '09:00', 'Bad/Zone'), null);
});
