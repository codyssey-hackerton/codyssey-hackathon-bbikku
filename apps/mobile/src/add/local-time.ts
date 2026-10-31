export function localInstant(date: string, time: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  try {
    const nominal = Date.parse(`${date}T${time}:00Z`);
    if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== date) return null;
    const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const wall = (value: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(value).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
    };
    const offsets = new Set<number>();
    for (let hour = -48; hour <= 48; hour++) {
      const sample = nominal + hour * 3_600_000;
      offsets.add(Date.parse(wall(sample)) - sample);
    }
    const target = `${date}T${time}:00Z`;
    const matches = [...offsets].map(offset => nominal - offset).filter(value => wall(value) === target);
    return matches.length === 1 ? new Date(matches[0]!).toISOString() : null;
  } catch { return null; }
}

export function localParts(instant: string, timezone: string): { date: string; time: string } | null {
  try {
    const epoch = Date.parse(instant);
    if (!Number.isFinite(epoch)) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(epoch).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  } catch { return null; }
}
