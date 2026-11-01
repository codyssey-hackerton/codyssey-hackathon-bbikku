import type { ReviewSchedule } from '@pikku/domain';
import { isLocalTime, isTimezone } from './client';
import type { ReviewInput } from './client';

export type ReviewDraft = {
  timezone: string;
  evening: { enabled: boolean; localTime: string };
  morning: { enabled: boolean; localTime: string };
};

export function timezoneName(timezone: string): string {
  try { return new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, timeZoneName: 'long' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? '시간대 확인 불가'; }
  catch { return '시간대 확인 불가'; }
}

export function draftFrom(schedule: ReviewSchedule): ReviewDraft {
  return {
    timezone: schedule.timezone,
    evening: { enabled: schedule.evening.enabled, localTime: schedule.evening.localTime ?? '' },
    morning: { enabled: schedule.morning.enabled, localTime: schedule.morning.localTime ?? '' },
  };
}

export function parseReviewDraft(draft: ReviewDraft, revision: number):
  | { ok: true; input: ReviewInput }
  | { ok: false; message: string } {
  const timezone = draft.timezone.trim();
  if (!isTimezone(timezone)) return { ok: false, message: '올바른 시간대를 입력해 주세요. 예: Asia/Seoul' };
  for (const [label, part] of [['저녁', draft.evening], ['아침', draft.morning]] as const) {
    const time = part.localTime.trim();
    if (part.enabled && !time) return { ok: false, message: `${label} 자동 검토를 켜려면 시각이 필요합니다.` };
    if (time && !isLocalTime(time)) return { ok: false, message: `${label} 시각을 00:00~23:59 형식으로 입력해 주세요.` };
  }
  return { ok: true, input: {
    expectedRevision: revision, timezone,
    evening: { enabled: draft.evening.enabled, localTime: draft.evening.localTime.trim() || null },
    morning: { enabled: draft.morning.enabled, localTime: draft.morning.localTime.trim() || null },
  } };
}
