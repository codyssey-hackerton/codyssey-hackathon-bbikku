import type { ScheduleItem } from '@pikku/domain';

export function scheduleCardModel(item: ScheduleItem, now: number) {
  const routine = item.sourceRefs.some(ref => ref.provider === 'routine');
  const event = !routine && item.kind === 'event';
  const start = item.timeSlot ? Date.parse(item.timeSlot.startsAt) : NaN;
  const end = item.timeSlot ? Date.parse(item.timeSlot.endsAt) : NaN;
  const validRange = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const recorded = event ? item.attendance === 'attended' || item.attendance === 'absent' : item.completion === 'completed' || item.completion === 'incomplete';
  const active = validRange && start <= now && now < end;
  const state = event ? item.attendance === 'attended' ? (validRange && now < start ? '참석 예정' : '참석')
    : item.attendance === 'absent' ? (validRange && now < start ? '불참 예정' : '불참') : '참석 확인'
    : item.completion === 'completed' ? '완료됨' : '완료';
  const phase = active ? '진행 중' : item.completion === 'incomplete' && !event ? '미완료'
    : !validRange || now >= end ? '확인 필요' : '예정';
  return { routine, event, active, recorded, state, phase,
    selected: event ? item.attendance === 'attended' : item.completion === 'completed',
    absent: event && item.attendance === 'absent',
    type: routine ? '루틴' : event ? '약속' : '할 일' };
}

export function scheduleTimeLabel(item: ScheduleItem, timezone: string): string {
  if (!item.timeSlot) return '시간 미정';
  try {
    const start = new Date(item.timeSlot.startsAt), end = new Date(item.timeSlot.endsAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) return '시간 확인 필요';
    const time = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const date = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' });
    return `${time.format(start)} - ${day.format(start) === day.format(end) ? '' : `${date.format(end)} `}${time.format(end)}`;
  } catch { return '시간 확인 필요'; }
}
