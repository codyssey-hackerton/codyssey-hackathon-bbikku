import { z } from 'zod';
import { identifier, timezone } from './planning-schemas.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
});
const fields = {
  title: z.string().max(2000).refine(value => value.trim().length > 0),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform(value => [...new Set(value)].sort((a, b) => a - b)),
  timezone, startDate: date, localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(1).max(1440),
  category: z.enum(['personal', 'work']).nullable().optional(),
};
export const routineCreate = z.object({ requestId: identifier, ...fields }).strict();
export const routinePatch = z.object({ requestId: identifier, expectedRevision: z.number().int().min(1),
  ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> },
  active: z.boolean().optional() }).strict().refine(value => Object.keys(value).some(key => key !== 'requestId' && key !== 'expectedRevision'));
export const routineMaterialize = z.object({ requestId: identifier, fromDate: date, toDate: date }).strict().refine(value => {
  const days = (Date.parse(`${value.toDate}T00:00:00Z`) - Date.parse(`${value.fromDate}T00:00:00Z`)) / 86_400_000;
  return days >= 0 && days < 31;
});
export type RoutineCreate = z.infer<typeof routineCreate>;
export type RoutinePatch = z.infer<typeof routinePatch>;
export type RoutineMaterialize = z.infer<typeof routineMaterialize>;

// Reject both repeated and nonexistent local times instead of silently shifting a routine.
export function routineInstant(dateValue: string, time: string, zone: string): string | null {
  try {
  const nominal = Date.parse(`${dateValue}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = (epoch: number) => {
    const values = Object.fromEntries(formatter.formatToParts(epoch).map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`;
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours++) {
    const sample = nominal + hours * 3_600_000;
    offsets.add(Date.parse(wall(sample)) - sample);
  }
  const target = `${dateValue}T${time}:00Z`;
  const matches = [...offsets].map(offset => nominal - offset).filter(value => wall(value) === target);
  return matches.length === 1 ? new Date(matches[0]!).toISOString() : null;
  } catch { return null; }
}
