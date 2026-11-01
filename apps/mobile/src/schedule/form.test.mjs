import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTimestamps, isTimestamp } from './client.ts';
import { canCoordinate, scheduleDraft, scheduleFields } from './form.ts';

const event = {
  id: 'event-1', revision: 7, kind: 'event', title: '회의',
  timeSlot: { startsAt: '2026-10-31T09:00:00+09:00', endsAt: '2026-10-31T10:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: 60, deadline: '2026-10-31T11:00:00+09:00', flexibility: 'flexible',
  involvement: 'shared', completion: 'unknown', sourceRefs: [],
};

test('editing shows and preserves every field until the user changes it', () => {
  const draft = scheduleDraft(event, 'UTC');
  assert.deepEqual(draft, {
    kind: 'event', title: '회의', startsAt: event.timeSlot.startsAt, endsAt: event.timeSlot.endsAt,
    timezone: 'Asia/Seoul', durationMinutes: '60', deadline: event.deadline,
    flexibility: 'flexible', involvement: 'shared', completion: 'unknown', category: '', allDay: false, notes: '',
  });
  const { id, revision, sourceRefs, ...fields } = event;
  assert.deepEqual(scheduleFields(draft, event), { fields });
  assert.match(scheduleFields({ ...draft, involvement: 'personal' }, event).error, /공동.*개인/);
  assert.equal(scheduleFields({ ...draft, title: '새 제목' }, event).fields.title, '새 제목');
});

test('category edits preserve attendance and clearing a category is explicit', () => {
  const item = { ...event, category: 'work', attendance: 'attended' };
  const draft = scheduleDraft(item, 'UTC');
  assert.equal(draft.category, 'work');
  assert.equal(scheduleFields({ ...draft, category: '' }, item).fields.category, null);
  assert.equal(scheduleFields({ ...draft, title: '다른 제목' }, item).fields.attendance, 'attended');
  assert.equal(scheduleFields({ ...draft, completion: 'completed' }, item).fields.completion, item.completion);
  assert.match(scheduleFields({ ...draft, kind: 'task' }, item).error, /참석 기록/);
  assert.equal(scheduleFields({ ...scheduleDraft(null, 'UTC'), kind: 'task', title: '업무', durationMinutes: '30', category: 'work' }, null).fields.category, 'work');
});

test('new events start pending regardless of draft completion while task edits remain explicit', () => {
  const base = { ...scheduleDraft(null, 'UTC'), title: '약속', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-01T01:00:00Z', completion: 'completed' };
  assert.equal(scheduleFields(base, null).fields.completion, 'pending');
  assert.equal(scheduleFields({ ...base, kind: 'task', durationMinutes: '60' }, null).fields.completion, 'completed');
});

test('event and task fields require valid times, positive task duration and deadline order', () => {
  const blank = scheduleDraft(null, 'Asia/Seoul');
  assert.match(scheduleFields(blank, null).error, /제목/);
  const named = { ...blank, title: '계획' };
  assert.match(scheduleFields(named, null).error, /시각/);
  assert.match(scheduleFields({ ...named, kind: 'task', durationMinutes: '0' }, null).error, /0보다 큰/);
  const task = { ...named, kind: 'task', durationMinutes: '30', completion: 'incomplete' };
  assert.deepEqual(scheduleFields(task, null).fields, {
    kind: 'task', title: '계획', timeSlot: null, durationMinutes: 30, deadline: null,
    flexibility: 'fixed', involvement: 'personal', completion: 'incomplete',
  });
  assert.match(scheduleFields({ ...task, startsAt: '2026-10-31T09:00:00' }, null).error, /날짜·시간/);
  assert.match(scheduleFields({ ...task, startsAt: event.timeSlot.startsAt, endsAt: event.timeSlot.endsAt, timezone: 'invalid/timezone' }, null).error, /지역/);
  assert.match(scheduleFields({ ...task, startsAt: event.timeSlot.startsAt, endsAt: event.timeSlot.startsAt }, null).error, /종료/);
  assert.match(scheduleFields({ ...task, ...event.timeSlot, deadline: '2026-10-31T09:30:00+09:00' }, null).error, /마감/);
  assert.match(scheduleFields({ ...task, durationMinutes: 'Infinity' }, null).error, /숫자/);
});

test('ISO offset and sub-millisecond ordering are validated without truncation', () => {
  for (const value of ['2026-02-29T10:00:00Z', '2026-10-31T10:00:00', '2026-10-31T10:00:00+25:00']) {
    assert.equal(isTimestamp(value), false);
  }
  assert.equal(isTimestamp('2028-02-29T10:00:00+09:00'), true);
  assert.equal(compareTimestamps('2026-10-31T00:00:00.0001Z', '2026-10-31T09:00:00.0002+09:00'), -1);
  const personalEvent = { ...event, involvement: 'personal' };
  const draft = { ...scheduleDraft(personalEvent, 'UTC'), startsAt: '2026-10-31T00:00:00.0001Z',
    endsAt: '2026-10-31T00:00:00.0002Z', deadline: '2026-10-31T00:00:00.0002Z' };
  assert.ok(scheduleFields(draft, personalEvent).fields);
  assert.match(scheduleFields({ ...draft, deadline: draft.startsAt }, personalEvent).error, /마감/);
});

test('only an unfinished shared event is eligible for coordination selection', () => {
  for (const completion of ['pending', 'incomplete', 'unknown']) assert.equal(canCoordinate({ ...event, completion }), true);
  assert.equal(canCoordinate({ ...event, completion: 'completed' }), false);
  assert.equal(canCoordinate({ ...event, involvement: 'personal' }), false);
  assert.equal(canCoordinate({ ...event, kind: 'task' }), false);
});


test('an existing shared event cannot be moved or converted by the direct edit form', () => {
  const draft = scheduleDraft(event, 'Asia/Seoul');
  assert.match(scheduleFields({ ...draft, startsAt: '2026-10-31T09:30:00+09:00' }, event).error, /공동 약속.*조정/);
  assert.match(scheduleFields({ ...draft, kind: 'task' }, event).error, /공동 약속.*조정/);
  assert.ok(scheduleFields({ ...draft, title: '회의 메모 수정' }, event).fields);
  assert.ok(scheduleFields({ ...draft, startsAt: '2026-10-31T00:00:00Z', endsAt: '2026-10-31T01:00:00Z' }, event).fields);
});

test('notes preserve the existing value, clear explicitly, and enforce the maximum length', () => {
  const item = { ...event, notes: '기존 메모', allDay: false };
  const draft = scheduleDraft(item, 'Asia/Seoul');
  assert.equal(scheduleFields(draft, item).fields.notes, '기존 메모');
  assert.equal(scheduleFields({ ...draft, notes: '' }, item).fields.notes, null);
  assert.match(scheduleFields({ ...draft, notes: '가'.repeat(20_001) }, item).error, /20,000/);
});
