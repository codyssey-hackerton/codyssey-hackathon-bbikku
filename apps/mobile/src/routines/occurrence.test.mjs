import test from 'node:test';
import assert from 'node:assert/strict';
import { isScheduledRoutineInRange, routineOccurrence } from './occurrence.ts';

test('only an unambiguous actual routine task identifies an occurrence', () => {
  const ref = { provider: 'routine', calendarId: 'routine-1', externalEventId: '2026-11-01' };
  const item = { kind: 'task', sourceRefs: [ref] };
  assert.deepEqual(routineOccurrence(item), { routineId: 'routine-1', date: '2026-11-01' });
  assert.equal(routineOccurrence({ ...item, sourceRefs: [] }), null);
  assert.equal(routineOccurrence({ ...item, sourceRefs: [ref, ref] }), null);
  assert.equal(routineOccurrence({ ...item, kind: 'event' }), null);
  assert.equal(routineOccurrence({ ...item, sourceRefs: [{ ...ref, calendarId: ' ' }] }), null);
  assert.equal(routineOccurrence({ ...item, sourceRefs: [{ ...ref, calendarId: ' r1 ' }] }), null);
  assert.equal(routineOccurrence({ ...item, sourceRefs: [{ ...ref, externalEventId: '2026-02-30' }] }), null);
});

test('moved routines show at their current time, not their original occurrence date', () => {
  const ref = { provider: 'routine', calendarId: 'routine-1', externalEventId: '2026-11-01' };
  const item = { kind: 'task', sourceRefs: [ref], timeSlot: { startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-02T01:00:00Z' } };
  const old = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
  const current = { from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z' };
  assert.equal(isScheduledRoutineInRange(item, old), false);
  assert.equal(isScheduledRoutineInRange(item, current), true);
  assert.equal(routineOccurrence(item).date, '2026-11-01');
  assert.equal(isScheduledRoutineInRange({ ...item, timeSlot: null }, current), false);
  assert.equal(isScheduledRoutineInRange({ ...item, sourceRefs: [ref, ref] }, current), false);
});
