import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDateRange } from './client.ts';

test('inclusive local date range becomes exclusive next-day midnight', () => {
  assert.deepEqual(calendarDateRange('2026-11-16', '2026-11-19', 'Asia/Seoul'), {
    from: '2026-11-15T15:00:00.000Z', to: '2026-11-19T15:00:00.000Z',
  });
  const spring = calendarDateRange('2026-03-08', '2026-03-08', 'America/New_York');
  assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3600_000);
  const autumn = calendarDateRange('2026-11-01', '2026-11-01', 'America/New_York');
  assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3600_000);
});

test('invalid, reversed and too-long date ranges are rejected', () => {
  for (const [start, end, zone] of [
    ['2026-02-30', '2026-03-01', 'Asia/Seoul'], ['2026-11-20', '2026-11-19', 'Asia/Seoul'],
    ['2026-01-01', '2027-01-02', 'UTC'], ['2026-11-01', '2026-11-02', 'invalid/timezone'],
  ]) assert.equal(calendarDateRange(start, end, zone), null);
});
