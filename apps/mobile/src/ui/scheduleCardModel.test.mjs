import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleCardModel, scheduleTimeLabel } from './scheduleCardModel.ts';

const base = { id: '1', revision: 1, title: '일정', kind: 'task', timeSlot: { startsAt: '2026-11-01T14:30:00Z', endsAt: '2026-11-01T15:30:00Z', timezone: 'Asia/Seoul' }, durationMinutes: 60, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', sourceRefs: [] };
const before = Date.parse('2026-11-01T14:00:00Z'), during = Date.parse('2026-11-01T15:00:00Z'), after = Date.parse('2026-11-01T16:00:00Z');

test('시간 경과는 작업 완료를 기록하지 않는다', () => {
  assert.equal(scheduleCardModel(base, before).phase, '예정');
  assert.equal(scheduleCardModel(base, during).phase, '진행 중');
  assert.equal(scheduleCardModel(base, after).phase, '확인 필요');
  assert.equal(scheduleCardModel(base, after).state, '완료');
  assert.equal(scheduleCardModel({ ...base, completion: 'incomplete' }, after).phase, '미완료');
});

test('약속은 과거 completion과 관계없이 attendance만 사용한다', () => {
  const event = { ...base, kind: 'event', completion: 'completed' };
  assert.equal(scheduleCardModel(event, after).state, '참석 확인');
  assert.equal(scheduleCardModel(event, after).selected, false);
  assert.equal(scheduleCardModel({ ...event, attendance: 'attended' }, before).state, '참석 예정');
  assert.equal(scheduleCardModel({ ...event, attendance: 'absent' }, after).state, '불참');
});

test('루틴은 sourceRefs로 판별하고 회차 완료를 유지한다', () => {
  const routine = { ...base, completion: 'completed', sourceRefs: [{ provider: 'routine' }] };
  const model = scheduleCardModel(routine, during);
  assert.equal(model.type, '루틴');
  assert.equal(model.routine, true);
  assert.equal(model.recorded, true);
  assert.equal(model.state, '완료됨');
});

test('시간대 자정 경계와 잘못된 설정을 구분한다', () => {
  assert.match(scheduleTimeLabel(base, 'Asia/Seoul'), /11\.\s*2\./);
  assert.doesNotMatch(scheduleTimeLabel(base, 'UTC'), /11\.\s*2\./);
  assert.equal(scheduleTimeLabel(base, 'Not/AZone'), '시간 확인 필요');
  assert.equal(scheduleTimeLabel({ ...base, timeSlot: null }, 'Asia/Seoul'), '시간 미정');
});
