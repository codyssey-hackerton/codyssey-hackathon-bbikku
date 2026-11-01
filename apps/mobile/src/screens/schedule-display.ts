import type { ScheduleItem } from '../schedule/client';
import { civilDate, civilOrdinal } from '../schedule/dates';

export function dailyProgress(items: ScheduleItem[]): { done: number; total: number; percent: number | null } {
  const tracked = [...new Map(items.filter(item => item.kind === 'task' && item.timeSlot !== null).map(item => [item.id, item])).values()];
  const done = tracked.filter(item => item.completion === 'completed').length;
  return { done, total: tracked.length, percent: tracked.length ? Math.round(done / tracked.length * 100) : null };
}

export function scheduleLayout(items: ScheduleItem[], now: number, selectedDate: Date, timezone: string) {
  const scheduled = items.filter(item => item.timeSlot !== null).slice()
    .sort((a, b) => Date.parse(a.timeSlot!.startsAt) - Date.parse(b.timeSlot!.startsAt));
  const layout = new Map<string, { gap: number; height: number; overlap: boolean }>();
  let latestEnd = -Infinity;
  for (const item of scheduled) {
    const start = Date.parse(item.timeSlot!.startsAt), end = Date.parse(item.timeSlot!.endsAt);
    const overlap = item.blocksTime !== false && scheduled.some(other => other.id !== item.id && other.blocksTime !== false && start < Date.parse(other.timeSlot!.endsAt) && Date.parse(other.timeSlot!.startsAt) < end);
    const free = Number.isFinite(latestEnd) ? Math.max(0, (start - latestEnd) / 60_000) : 0;
    const gap = free ? Math.min(32, Math.round(8 + Math.log2(1 + free / 15) * 5)) : 8;
    const height = Math.min(112, Math.max(72, Math.round(72 + Math.max(0, (end - start) / 60_000 - 30) / 30 * 4)));
    layout.set(item.id, { gap, height, overlap });
    latestEnd = Math.max(latestEnd, end);
  }
  const today = civilOrdinal(civilDate(selectedDate, timezone)) === civilOrdinal(civilDate(new Date(now), timezone));
  if (!today) return { scheduled, front: undefined, past: [] as ScheduleItem[], remaining: scheduled, layout };
  const past = scheduled.filter(item => Date.parse(item.timeSlot!.endsAt) <= now)
    .sort((a, b) => Date.parse(b.timeSlot!.endsAt) - Date.parse(a.timeSlot!.endsAt));
  const remaining = scheduled.filter(item => Date.parse(item.timeSlot!.endsAt) > now);
  const front = remaining.find(item => Date.parse(item.timeSlot!.startsAt) <= now) ?? remaining[0] ?? past.shift();
  return { scheduled, front, past, remaining: remaining.filter(item => item.id !== front?.id), layout };
}

export function axisTime(value: string, selectedDate: Date, timezone: string): string {
  const date = new Date(value);
  const delta = civilOrdinal(civilDate(date, timezone)) - civilOrdinal(civilDate(selectedDate, timezone));
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  if (delta === 0) return time;
  if (delta === -1) return `전날 ${time}`;
  if (delta === 1) return `다음 날 ${time}`;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
