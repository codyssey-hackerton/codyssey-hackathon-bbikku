import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleItem } from '../src/schedule/client';
import { selectNextActions } from '../src/schedule/nextAction';

const seoulDate = { year: 2026, month: 10, day: 31 };
const utcDate = { year: 2026, month: 10, day: 31 };

function event(
  id: string,
  startsAt: string,
  endsAt: string,
  completion: ScheduleItem['completion'] = 'pending',
  timezone = 'UTC',
): ScheduleItem {
  return {
    id, revision: 1, kind: 'event', title: `Synthetic ${id}`,
    timeSlot: { startsAt, endsAt, timezone }, durationMinutes: null,
    deadline: null, flexibility: 'fixed', involvement: 'personal', completion, sourceRefs: [],
  };
}

function unscheduled(id: string): ScheduleItem {
  return {
    id, revision: 1, kind: 'task', title: `Synthetic ${id}`,
    timeSlot: null, durationMinutes: 30, deadline: null,
    flexibility: 'flexible', involvement: 'personal', completion: 'pending', sourceRefs: [],
  };
}

function select(items: readonly ScheduleItem[], now: string) {
  return selectNextActions(items, utcDate, 'UTC', new Date(now));
}

test('an empty list and items with no eligible time return nulls', () => {
  assert.deepEqual(select([], '2026-10-31T10:00:00Z'), { current: null, next: null });
  const done = event('done', '2026-10-31T10:00:00Z', '2026-10-31T11:00:00Z', 'completed');
  assert.deepEqual(select([unscheduled('unscheduled'), done], '2026-10-31T10:00:00Z'), { current: null, next: null });
});

test('current includes its start and excludes its end', () => {
  const item = event('item', '2026-10-31T10:00:00Z', '2026-10-31T11:00:00Z');
  assert.deepEqual(select([item], '2026-10-31T09:59:59.999Z'), { current: null, next: item });
  assert.deepEqual(select([item], '2026-10-31T10:00:00Z'), { current: item, next: null });
  assert.deepEqual(select([item], '2026-10-31T10:59:59.999Z'), { current: item, next: null });
  assert.deepEqual(select([item], '2026-10-31T11:00:00Z'), { current: null, next: null });
});

test('items starting exactly now are current candidates, not next', () => {
  const ongoing = event('ongoing', '2026-10-31T09:00:00Z', '2026-10-31T11:00:00Z');
  const startsNow = event('starts-now', '2026-10-31T19:00:00+09:00', '2026-10-31T19:30:00+09:00');
  const duplicateId = event('ongoing', '2026-10-31T10:01:00Z', '2026-10-31T10:15:00Z');
  const later = event('later', '2026-10-31T10:02:00Z', '2026-10-31T10:30:00Z');
  assert.deepEqual(select([duplicateId, startsNow, later, ongoing], '2026-10-31T10:00:00Z'), {
    current: ongoing, next: later,
  });
  assert.deepEqual(select([ongoing, startsNow], '2026-10-31T10:00:00Z'), { current: ongoing, next: null });
  const startsNowA = event('a-starts-now', '2026-10-31T10:00:00Z', '2026-10-31T10:30:00Z');
  for (const items of [[startsNow, startsNowA], [startsNowA, startsNow]]) {
    assert.deepEqual(select(items, '2026-10-31T10:00:00Z'), { current: startsNowA, next: null });
  }
});

test('completed and unscheduled items are excluded without changing other completion states', () => {
  const unknown = event('unknown', '2026-10-31T09:00:00Z', '2026-10-31T10:30:00Z', 'unknown');
  const incomplete: ScheduleItem = { ...event('incomplete', '2026-10-31T11:00:00Z', '2026-10-31T12:00:00Z', 'incomplete'), kind: 'task', durationMinutes: 60 };
  const expiredPending = event('past', '2026-10-31T07:00:00Z', '2026-10-31T08:00:00Z', 'pending');
  const expiredUnknown = event('past-unknown', '2026-10-31T08:00:00Z', '2026-10-31T09:00:00Z', 'unknown');
  const completed = event('completed', '2026-10-31T10:01:00Z', '2026-10-31T10:30:00Z', 'completed');
  const items = [incomplete, expiredPending, unscheduled('no-slot'), unknown, completed, expiredUnknown];
  for (const item of items) {
    if (item.timeSlot) Object.freeze(item.timeSlot);
    Object.freeze(item);
  }
  Object.freeze(items);
  const result = select(items, '2026-10-31T10:00:00Z');
  assert.equal(result.current, unknown);
  assert.equal(result.next, incomplete);
  assert.equal(result.current.completion, 'unknown');
  assert.equal(result.next.completion, 'incomplete');
  assert.equal(expiredPending.completion, 'pending');
  assert.equal(expiredUnknown.completion, 'unknown');
});

test('overlapping current items and tied next items use start, end, then id deterministically', () => {
  const currentLate = event('current-late', '2026-10-31T09:30:00Z', '2026-10-31T11:30:00Z');
  const currentLong = event('current-long', '2026-10-31T09:00:00Z', '2026-10-31T12:00:00Z');
  const currentB = event('b-current', '2026-10-31T09:00:00Z', '2026-10-31T11:00:00Z');
  const currentA = event('a-current', '2026-10-31T09:00:00Z', '2026-10-31T11:00:00Z');
  const nextLate = event('next-late', '2026-10-31T12:00:00Z', '2026-10-31T13:00:00Z');
  const nextLong = event('next-long', '2026-10-31T11:00:00Z', '2026-10-31T13:00:00Z');
  const nextB = event('b-next', '2026-10-31T11:00:00Z', '2026-10-31T12:00:00Z');
  const nextA = event('a-next', '2026-10-31T11:00:00Z', '2026-10-31T12:00:00Z');
  const items = [nextLate, currentLate, nextLong, currentLong, nextB, currentB, nextA, currentA];
  for (const order of [items, [...items].reverse()]) {
    assert.deepEqual(select(order, '2026-10-31T10:00:00Z'), { current: currentA, next: nextA });
  }
});

test('item instants are compared by offsets and full fractional precision', () => {
  const current = event('current', '2026-10-31T09:59:59.999999Z', '2026-10-31T10:00:00.000001Z');
  const justAfter = event('fraction-first', '2026-10-31T19:00:00.0000001+09:00', '2026-10-31T19:00:01+09:00');
  const laterFraction = event('fraction-later', '2026-10-31T10:00:00.0005Z', '2026-10-31T10:00:01Z');
  assert.deepEqual(select([laterFraction, justAfter, current], '2026-10-31T10:00:00.000Z'), {
    current, next: justAfter,
  });
  const endingNow = event('end-now', '2026-10-31T09:00:00Z', '2026-10-31T10:00:00.000000Z');
  assert.deepEqual(select([endingNow], '2026-10-31T10:00:00Z'), { current: null, next: null });
});

test('selected past or future days never turn a spanning item into the actual current item', () => {
  const spanning = event('spanning', '2026-10-30T23:00:00Z', '2026-11-02T01:00:00Z');
  const now = new Date('2026-10-31T10:00:00Z');
  for (const date of [{ year: 2026, month: 10, day: 30 }, { year: 2026, month: 11, day: 1 }]) {
    assert.deepEqual(selectNextActions([spanning], date, 'UTC', now), { current: null, next: null });
  }
  assert.deepEqual(selectNextActions([spanning], utcDate, 'UTC', now), { current: spanning, next: null });
});

test('next may start before a future selected day when its interval overlaps that day', () => {
  const spanning = event('spanning', '2026-10-30T23:30:00Z', '2026-10-31T00:30:00Z');
  const later = event('later', '2026-10-31T01:00:00Z', '2026-10-31T02:00:00Z');
  const result = selectNextActions([later, spanning], utcDate, 'UTC', new Date('2026-10-30T22:00:00Z'));
  assert.deepEqual(result, { current: null, next: spanning });
});

test('selected local day uses half-open overlap, including midnight-spanning items', () => {
  const before = event('before', '2026-10-30T13:00:00Z', '2026-10-30T15:00:00Z');
  const crossesStart = event('cross-start', '2026-10-30T14:30:00Z', '2026-10-30T15:00:00.000001Z');
  const crossesEnd = event('cross-end', '2026-10-31T14:30:00Z', '2026-10-31T15:30:00Z');
  const atEnd = event('at-end', '2026-10-31T15:00:00Z', '2026-10-31T16:00:00Z');
  const items = [atEnd, crossesEnd, before, crossesStart];
  assert.deepEqual(selectNextActions(items, seoulDate, 'Asia/Seoul', new Date('2026-10-30T15:00:00Z')), {
    current: crossesStart, next: crossesEnd,
  });
  assert.deepEqual(selectNextActions(items, seoulDate, 'Asia/Seoul', new Date('2026-10-31T15:00:00Z')), {
    current: null, next: null,
  });
});

test('the requested display timezone determines the selected date, not the item timezone or UTC', () => {
  const item = event('offset', '2026-10-30T14:30:00Z', '2026-10-30T16:00:00Z', 'unknown', 'America/Los_Angeles');
  const now = new Date('2026-10-30T15:00:00Z');
  assert.deepEqual(selectNextActions([item], seoulDate, 'Asia/Seoul', now), { current: item, next: null });
  assert.deepEqual(selectNextActions([item], utcDate, 'UTC', now), { current: null, next: null });
});

test('spring-forward and repeated fall-back hours compare real instants', () => {
  const springCurrent = event('spring-current', '2026-03-08T01:30:00-05:00', '2026-03-08T03:15:00-04:00');
  const springNext = event('spring-next', '2026-03-08T03:00:00-04:00', '2026-03-08T03:30:00-04:00');
  assert.deepEqual(selectNextActions([springNext, springCurrent], { year: 2026, month: 3, day: 8 }, 'America/New_York', new Date('2026-03-08T06:59:59Z')), {
    current: springCurrent, next: springNext,
  });
  const fallCurrent = event('fall-current', '2026-11-01T01:30:00-04:00', '2026-11-01T01:10:00-05:00');
  const fallNext = event('fall-next', '2026-11-01T01:15:00-05:00', '2026-11-01T01:45:00-05:00');
  assert.deepEqual(selectNextActions([fallNext, fallCurrent], { year: 2026, month: 11, day: 1 }, 'America/New_York', new Date('2026-11-01T05:45:00Z')), {
    current: fallCurrent, next: fallNext,
  });
});

test('midnight gaps and a skipped following civil day retain the real day boundary', () => {
  const gapItem = event('gap', '2018-11-04T02:59:00Z', '2018-11-04T03:30:00Z');
  assert.deepEqual(selectNextActions([gapItem], { year: 2018, month: 11, day: 4 }, 'America/Sao_Paulo', new Date('2018-11-04T03:00:00Z')), {
    current: gapItem, next: null,
  });
  const beforeSkip = event('before-skip', '2011-12-30T09:00:00Z', '2011-12-30T10:00:00Z');
  const afterSkip = event('after-skip', '2011-12-30T10:00:00Z', '2011-12-30T11:00:00Z');
  assert.deepEqual(selectNextActions([afterSkip, beforeSkip], { year: 2011, month: 12, day: 29 }, 'Pacific/Apia', new Date('2011-12-30T09:30:00Z')), {
    current: beforeSkip, next: null,
  });
  assert.throws(() => selectNextActions([], { year: 2011, month: 12, day: 30 }, 'Pacific/Apia', new Date('2011-12-30T09:30:00Z')), RangeError);
});

test('invalid now or timezone is rejected instead of selecting from an invented day', () => {
  assert.throws(() => selectNextActions([], utcDate, 'UTC', new Date('invalid')), RangeError);
  assert.throws(() => selectNextActions([], utcDate, 'Not/A_Zone', new Date('2026-10-31T10:00:00Z')), RangeError);
  assert.throws(() => selectNextActions([], { year: 2026, month: 2, day: 30 }, 'UTC', new Date('2026-10-31T10:00:00Z')), RangeError);
});
