import { z } from 'zod';
import { parseOffsetDateTime } from '@pikku/domain';

type Instant = { milliseconds: number; remainder: string };
function instant(value: string): Instant | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const seconds = match[2] === undefined ? '' : `:${match[2]}`;
  const fraction = match[3] === undefined ? '' : `.${match[3].slice(0, 3)}`;
  const milliseconds = parseOffsetDateTime(`${match[1]}${seconds}${fraction}${match[4]}`);
  return milliseconds === null ? null : { milliseconds, remainder: (match[3] ?? '').slice(3).replace(/0+$/, '') };
}
export function compareInstants(left: string, right: string): number {
  const a = instant(left); const b = instant(right);
  if (!a || !b) throw new Error('Invalid instant');
  if (a.milliseconds !== b.milliseconds) return a.milliseconds < b.milliseconds ? -1 : 1;
  const length = Math.max(a.remainder.length, b.remainder.length);
  return a.remainder.padEnd(length, '0').localeCompare(b.remainder.padEnd(length, '0'));
}
export const identifier = z.string().max(200).refine(value => value.trim().length > 0);
export const timestamp = z.string().max(100).refine(value => instant(value) !== null);
export const timezone = identifier.refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
const revision = z.number().int().min(1);
const fields = z.object({
  kind: z.enum(['event', 'task']), title: z.string().max(2000).refine(value => value.trim().length > 0),
  timeSlot: z.object({ startsAt: timestamp, endsAt: timestamp, timezone }).strict().nullable(),
  durationMinutes: z.number().finite().nullable(), deadline: timestamp.nullable(),
  flexibility: z.enum(['fixed', 'flexible']), involvement: z.enum(['personal', 'shared']),
  completion: z.enum(['pending', 'completed', 'incomplete', 'unknown']),
}).strict();
const change = z.discriminatedUnion('operation', [
  z.object({ changeId: identifier, operation: z.literal('create'), after: fields }).strict(),
  z.object({ changeId: identifier, operation: z.literal('update'), targetId: identifier, expectedRevision: revision, after: fields }).strict(),
  z.object({ changeId: identifier, operation: z.literal('delete'), targetId: identifier, expectedRevision: revision }).strict(),
]);
const timingConstraint = z.object({
  appointment: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('existing'), id: identifier, expectedRevision: revision }).strict(),
    z.object({ kind: z.literal('change'), changeId: identifier }).strict(),
  ]),
  preparationMinutes: z.number().finite().nonnegative().nullable(),
  travelMinutes: z.number().finite().nonnegative().nullable(),
  bufferMinutes: z.number().finite().nonnegative().nullable(),
  segments: z.object({ preparation: identifier.nullable(), travel: identifier.nullable(), buffer: identifier.nullable() }).strict(),
}).strict();
export const changeSet = z.object({ changes: z.array(change).min(1).max(100), timingConstraints: z.array(timingConstraint).max(100).optional() }).strict();
export const commandBody = z.object({ requestId: identifier, expectedScheduleRevision: z.number().int().min(0), changeSet }).strict();
export const checkinBody = z.object({ requestId: identifier, expectedRevision: revision, completion: z.enum(['completed', 'incomplete', 'unknown']) }).strict();
export const memoryBody = z.object({
  requestId: identifier, expectedContextRevision: z.number().int().min(0),
  kind: z.enum(['preference', 'situation']), key: identifier, value: z.json(), validUntil: timestamp.nullable(),
}).strict();
export const decisionBody = z.object({ requestId: identifier, proposalRevision: revision, decision: z.enum(['accept', 'reject']) }).strict();
export const scheduleQuery = z.object({ from: timestamp, to: timestamp, timezone, includeUnscheduled: z.enum(['true', 'false']).default('false') }).strict()
  .refine(value => timestamp.safeParse(value.from).success && timestamp.safeParse(value.to).success && compareInstants(value.from, value.to) < 0);
export const memoryQuery = z.object({ at: timestamp }).strict();
export const proposalQuery = z.object({
  status: z.enum(['pending', 'awaiting_contact', 'applied', 'rejected', 'stale', 'expired', 'failed']).optional(),
  cursor: identifier.optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
}).strict();
