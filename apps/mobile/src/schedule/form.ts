import { compareTimestamps, isTimestamp } from './client';
import type { ScheduleFields, ScheduleItem } from './client';

export interface ScheduleDraft {
  kind: ScheduleFields['kind'];
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: string;
  deadline: string;
  flexibility: ScheduleFields['flexibility'];
  involvement: ScheduleFields['involvement'];
  completion: ScheduleFields['completion'];
  category: '' | 'personal' | 'work';
  allDay: boolean;
  notes: string;
}

export function canCoordinate(item: ScheduleItem): boolean {
  return item.kind === 'event' && item.involvement === 'shared' && item.completion !== 'completed';
}

export function scheduleDraft(item: ScheduleItem | null, timezone: string): ScheduleDraft {
  return {
    kind: item?.kind ?? 'event',
    title: item?.title ?? '',
    startsAt: item?.timeSlot?.startsAt ?? '',
    endsAt: item?.timeSlot?.endsAt ?? '',
    timezone: item?.timeSlot?.timezone ?? timezone,
    durationMinutes: item?.durationMinutes == null ? '' : String(item.durationMinutes),
    deadline: item?.deadline ?? '',
    flexibility: item?.flexibility ?? 'fixed',
    involvement: item?.involvement ?? 'personal',
    completion: item?.completion ?? 'pending',
    category: item?.category ?? '',
    allDay: item?.allDay === true,
    notes: item?.notes ?? '',
  };
}

function isTimezone(value: string): boolean {
  if (!value || value !== value.trim() || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function scheduleFields(
  draft: ScheduleDraft,
  original: ScheduleItem | null,
): { fields: ScheduleFields; error?: never } | { fields?: never; error: string } {
  if (!draft.title.trim()) return { error: '제목을 입력해 주세요.' };
  if (draft.notes.length > 20_000) return { error: '메모는 20,000자까지 입력할 수 있습니다.' };
  if (original?.involvement === 'shared' && draft.involvement !== 'shared') {
    return { error: '기존 공동 일정은 개인 일정으로 바꿀 수 없습니다.' };
  }
  if (original?.attendance != null && draft.kind !== 'event') {
    return { error: '참석 기록이 있는 일정은 할 일로 바꿀 수 없습니다.' };
  }

  const hasTime = draft.startsAt !== '' || draft.endsAt !== '';
  if (draft.kind === 'event' && !hasTime) return { error: '일정에는 시작과 종료 시각이 필요합니다.' };
  if (hasTime && (!isTimestamp(draft.startsAt) || !isTimestamp(draft.endsAt))) {
    return { error: '시작과 종료 날짜·시간을 확인해 주세요. 해당 지역에서 존재하지 않거나 중복된 시각은 사용할 수 없습니다.' };
  }
  if (hasTime && !isTimezone(draft.timezone)) return { error: '시간대 지역을 확인해 주세요.' };
  if (hasTime && compareTimestamps(draft.endsAt, draft.startsAt) <= 0) {
    return { error: '종료 시각은 시작 시각보다 뒤여야 합니다.' };
  }
  if (original?.kind === 'event' && original.involvement === 'shared' && original.timeSlot &&
      (draft.kind !== 'event' || !hasTime ||
       compareTimestamps(draft.startsAt, original.timeSlot.startsAt) !== 0 ||
       compareTimestamps(draft.endsAt, original.timeSlot.endsAt) !== 0)) {
    return { error: '공동 약속의 시간 변경은 조정 검토와 별도 연락이 필요합니다. 기존 일정은 유지됩니다.' };
  }
  if (draft.deadline !== '' && !isTimestamp(draft.deadline)) {
    return { error: '저장된 마감 시각을 확인해 주세요.' };
  }
  if (hasTime && draft.deadline !== '' && compareTimestamps(draft.endsAt, draft.deadline) > 0) {
    return { error: '종료 시각은 마감보다 늦을 수 없습니다.' };
  }
  const duration = draft.durationMinutes === '' ? null : Number(draft.durationMinutes);
  if (draft.durationMinutes !== '' && (!draft.durationMinutes.trim() || !Number.isFinite(duration))) {
    return { error: '소요시간은 숫자로 입력해 주세요.' };
  }
  if (draft.kind === 'task' && (duration === null || duration <= 0)) {
    return { error: '할 일에는 0보다 큰 소요시간이 필요합니다.' };
  }
  if (duration !== null && duration < 0) return { error: '소요시간은 음수일 수 없습니다.' };
  return {
    fields: {
      kind: draft.kind,
      title: draft.title,
      timeSlot: hasTime ? { startsAt: draft.startsAt, endsAt: draft.endsAt, timezone: draft.timezone } : null,
      durationMinutes: duration,
      deadline: draft.deadline === '' ? null : draft.deadline,
      flexibility: draft.flexibility,
      involvement: draft.involvement,
      completion: draft.kind === 'event' ? original?.completion ?? 'pending' : draft.completion,
      ...(draft.category ? { category: draft.category } : original?.category !== undefined ? { category: null } : {}),
      ...(draft.kind === 'event' && original && 'attendance' in original ? { attendance: original.attendance } : {}),
      ...(draft.allDay || original?.allDay !== undefined ? { allDay: draft.allDay } : {}),
      ...(draft.notes !== '' || original?.notes !== undefined ? { notes: draft.notes || null } : {}),
    },
  };
}
