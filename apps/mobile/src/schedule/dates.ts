export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function civilDate(date: Date, timezone: string): CivilDate {
  if (!Number.isFinite(date.getTime()) || !timezone) throw new RangeError('Invalid date or timezone');
  const parts = formatterFor(timezone).formatToParts(date);
  const number = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  const result = { year: number('year'), month: number('month'), day: number('day') };
  if (!Number.isInteger(result.year) || !Number.isInteger(result.month) || !Number.isInteger(result.day)) {
    throw new RangeError('Timezone date is unavailable');
  }
  return result;
}

function asUtcDate(date: CivilDate): Date {
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  return result;
}

export function civilOrdinal(date: CivilDate): number {
  return asUtcDate(date).getTime() / DAY_MS;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const next = new Date(asUtcDate(date).getTime() + days * DAY_MS);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function addMonths(date: CivilDate, months: number): CivilDate {
  const next = asUtcDate({ ...date, day: 1 });
  next.setUTCMonth(next.getUTCMonth() + months);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: 1 };
}

export function weekday(date: CivilDate): number {
  return asUtcDate(date).getUTCDay();
}

/** The first instant in a local day; handles offset changes and a skipped midnight. */
export function startOfDay(date: CivilDate, timezone: string): Date {
  const target = civilOrdinal(date);
  const nominal = asUtcDate(date).getTime();
  let before = nominal - 36 * 60 * 60 * 1000;
  const end = nominal + 36 * 60 * 60 * 1000;
  let after = before;
  while (after <= end && civilOrdinal(civilDate(new Date(after), timezone)) < target) {
    before = after;
    after += 60 * 60 * 1000;
  }
  if (after > end || after === before) throw new RangeError('Local day is unavailable');

  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (civilOrdinal(civilDate(new Date(middle), timezone)) < target) before = middle;
    else after = middle;
  }
  if (civilOrdinal(civilDate(new Date(after), timezone)) !== target) {
    throw new RangeError('Local day does not exist');
  }
  return new Date(after);
}

export function dayRange(date: CivilDate, timezone: string): { from: string; to: string } {
  return { from: startOfDay(date, timezone).toISOString(), to: startOfDay(addDays(date, 1), timezone).toISOString() };
}

export function monthRange(date: CivilDate, timezone: string): { from: string; to: string } {
  const first = { ...date, day: 1 };
  return { from: startOfDay(first, timezone).toISOString(), to: startOfDay(addMonths(first, 1), timezone).toISOString() };
}

export function formatCivilDate(date: CivilDate): string {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.year}년 ${date.month}월 ${date.day}일 ${weekdays[weekday(date)]}요일`;
}
