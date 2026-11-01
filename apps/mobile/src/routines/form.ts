const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value: string): number | null {
  const match = clock.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function endTime(start: string, duration: string): string {
  const begin = minutes(start), length = Number(duration);
  if (begin === null || !/^\d+$/.test(duration) || length < 1 || length > 1440) return '';
  const end = (begin + length) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

export function durationBetween(start: string, end: string): string {
  const begin = minutes(start), finish = minutes(end);
  if (begin === null || finish === null) return '';
  return String((finish - begin + 1439) % 1440 + 1);
}
