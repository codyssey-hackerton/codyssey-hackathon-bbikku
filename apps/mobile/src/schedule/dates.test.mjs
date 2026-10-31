import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, civilDate, dayRange, monthRange, startOfDay } from './dates.ts';

test('Seoul day and month use the supplied timezone and exclusive midnight end', () => {
  const selected = civilDate(new Date('2026-10-30T15:30:00Z'), 'Asia/Seoul');
  assert.deepEqual(selected, { year: 2026, month: 10, day: 31 });
  assert.deepEqual(dayRange(selected, 'Asia/Seoul'), {
    from: '2026-10-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z',
  });
  assert.deepEqual(monthRange(selected, 'Asia/Seoul'), {
    from: '2026-09-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z',
  });
  assert.deepEqual(addDays(selected, 1), { year: 2026, month: 11, day: 1 });
});

test('DST transitions use the correct offset at each endpoint', () => {
  const spring = dayRange({ year: 2026, month: 3, day: 8 }, 'America/New_York');
  const autumn = dayRange({ year: 2026, month: 11, day: 1 }, 'America/New_York');
  assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3600_000);
  assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3600_000);
  assert.deepEqual(monthRange({ year: 2026, month: 3, day: 8 }, 'America/New_York'), {
    from: '2026-03-01T05:00:00.000Z', to: '2026-04-01T04:00:00.000Z',
  });
});

test('midnight gaps use the first valid instant and a skipped civil date fails', () => {
  assert.equal(startOfDay({ year: 2018, month: 11, day: 4 }, 'America/Sao_Paulo').toISOString(), '2018-11-04T03:00:00.000Z');
  assert.throws(() => startOfDay({ year: 2011, month: 12, day: 30 }, 'Pacific/Apia'), RangeError);
  assert.throws(() => civilDate(new Date(), 'invalid/timezone'), RangeError);
});
