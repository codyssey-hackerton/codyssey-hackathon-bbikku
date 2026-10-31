import { z } from 'zod';
import type { ContextSnapshot } from '@pikku/domain';
import { compareInstants, timestamp, timezone } from './planning-schemas.ts';

const MAX_MINUTES = 31 * 24 * 60;
const remainder = (value: string) => (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '').slice(3);
function compareRemainders(left: string, right: string): number {
  const a = remainder(left), b = remainder(right), length = Math.max(a.length, b.length);
  return a.padEnd(length, '0').localeCompare(b.padEnd(length, '0'));
}
function compareDuration(from: string, to: string, minutes: number): number {
  const difference = Date.parse(to) - Date.parse(from) - minutes * 60_000;
  return difference === 0 ? compareRemainders(to, from) : Math.sign(difference);
}
export const freeSlotsInput = z.object({
  from: timestamp, to: timestamp, timezone, durationMinutes: z.number().int().min(1).max(MAX_MINUTES),
}).strict().refine(value => timestamp.safeParse(value.from).success && timestamp.safeParse(value.to).success &&
  compareInstants(value.from, value.to) < 0 && compareDuration(value.from, value.to, MAX_MINUTES) <= 0);

export function findFreeSlots(snapshot: ContextSnapshot, input: z.infer<typeof freeSlotsInput>) {
  const { from, to, timezone: zone, durationMinutes } = freeSlotsInput.parse(input);
  if (!timestamp.safeParse(snapshot.now).success || !Number.isSafeInteger(snapshot.scheduleRevision) ||
      snapshot.scheduleRevision < 0 || !Array.isArray(snapshot.items)) throw new Error('Invalid snapshot');
  const start = compareInstants(from, snapshot.now) < 0 ? snapshot.now : from;
  const intervals: { start: string; end: string }[] = [];
  for (const item of snapshot.items) {
    if (!item || !('timeSlot' in item)) throw new Error('Invalid snapshot item');
    if (item.timeSlot === null && item.kind === 'task') continue;
    const slot = item.timeSlot;
    if (!slot || !timestamp.safeParse(slot.startsAt).success || !timestamp.safeParse(slot.endsAt).success ||
        compareInstants(slot.startsAt, slot.endsAt) >= 0) throw new Error('Invalid snapshot item');
    if (compareInstants(slot.endsAt, start) <= 0 || compareInstants(slot.startsAt, to) >= 0) continue;
    intervals.push({ start: compareInstants(slot.startsAt, start) < 0 ? start : slot.startsAt,
      end: compareInstants(slot.endsAt, to) > 0 ? to : slot.endsAt });
  }
  intervals.sort((a, b) => compareInstants(a.start, b.start) || compareInstants(a.end, b.end));
  const slots: { startsAt: string; endsAt: string }[] = [];
  let truncated = false, cursor = start;
  const addGap = (end: string) => {
    if (compareInstants(cursor, end) < 0 && compareDuration(cursor, end, durationMinutes) >= 0) {
      if (slots.length === 20) truncated = true;
      else slots.push({ startsAt: cursor, endsAt: end });
    }
  };
  if (compareInstants(start, to) < 0) {
    for (const interval of intervals) {
      if (compareInstants(interval.start, cursor) > 0) addGap(interval.start);
      if (compareInstants(interval.end, cursor) > 0) cursor = interval.end;
      if (truncated) break;
    }
    if (!truncated) addGap(to);
  }
  return { slots, truncated, scheduleRevision: snapshot.scheduleRevision, timezone: zone, asOf: snapshot.now };
}
