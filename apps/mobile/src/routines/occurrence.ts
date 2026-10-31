import type { ScheduleItem } from '../schedule/client';
import { validDate } from './client';

export function routineOccurrence(item: ScheduleItem): { routineId: string; date: string } | null {
  if (item.kind !== 'task') return null;
  const refs = item.sourceRefs.filter(ref => ref.provider === 'routine');
  if (refs.length !== 1) return null;
  const ref = refs[0]!;
  if (!ref.calendarId.trim() || ref.calendarId !== ref.calendarId.trim() || !validDate(ref.externalEventId)) return null;
  return { routineId: ref.calendarId, date: ref.externalEventId };
}

export function isScheduledRoutineInRange(item: ScheduleItem, range: { from: string; to: string }): boolean {
  if (!routineOccurrence(item) || !item.timeSlot) return false;
  const start = Date.parse(item.timeSlot.startsAt), end = Date.parse(item.timeSlot.endsAt);
  const from = Date.parse(range.from), to = Date.parse(range.to);
  return [start, end, from, to].every(Number.isFinite) && start < to && end > from;
}
