import { compareTimestamps } from './client';
import type { ScheduleItem } from './client';
import { addDays, startOfDay } from './dates';
import type { CivilDate } from './dates';

type ScheduledItem = ScheduleItem & { timeSlot: NonNullable<ScheduleItem['timeSlot']> };

function compareItems(left: ScheduledItem, right: ScheduledItem): number {
  return compareTimestamps(left.timeSlot.startsAt, right.timeSlot.startsAt) ||
    compareTimestamps(left.timeSlot.endsAt, right.timeSlot.endsAt) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function selectNextActions(
  items: readonly ScheduleItem[],
  selectedCivilDate: CivilDate,
  timezone: string,
  now: Date,
): { current: ScheduleItem | null; next: ScheduleItem | null } {
  const nowInstant = now.toISOString();
  const normalized = addDays(selectedCivilDate, 0);
  if (normalized.year !== selectedCivilDate.year || normalized.month !== selectedCivilDate.month ||
      normalized.day !== selectedCivilDate.day) throw new RangeError('Invalid civil date');

  const from = startOfDay(selectedCivilDate, timezone);
  const followingDate = addDays(selectedCivilDate, 1);
  let to: Date;
  try {
    to = startOfDay(followingDate, timezone);
  } catch (error) {
    if (!(error instanceof RangeError) || error.message !== 'Local day does not exist') throw error;
    // A timezone can skip the next civil date entirely, as in Apia in 2011.
    to = startOfDay(addDays(followingDate, 1), timezone);
  }
  const fromInstant = from.toISOString();
  const toInstant = to.toISOString();
  const overlapping = items.filter((item): item is ScheduledItem => {
    const slot = item.timeSlot;
    return slot !== null && item.completion !== 'completed' &&
      compareTimestamps(slot.endsAt, fromInstant) > 0 && compareTimestamps(slot.startsAt, toInstant) < 0;
  });

  const current = now.getTime() >= from.getTime() && now.getTime() < to.getTime()
    ? overlapping.filter((item) => compareTimestamps(item.timeSlot.startsAt, nowInstant) <= 0 &&
        compareTimestamps(item.timeSlot.endsAt, nowInstant) > 0).sort(compareItems)[0] ?? null
    : null;
  const next = overlapping.filter((item) => item.id !== current?.id &&
    compareTimestamps(item.timeSlot.startsAt, nowInstant) > 0).sort(compareItems)[0] ?? null;
  return { current, next };
}
