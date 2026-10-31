import { z } from 'zod';

const keys = {
  event: ['kind', 'title', 'startsAt', 'endsAt', 'startDate', 'startTime', 'endDate', 'endTime', 'timezone', 'durationMinutes', 'deadline', 'flexibility', 'involvement', 'completion', 'category'],
  task: ['kind', 'title', 'startsAt', 'endsAt', 'startDate', 'startTime', 'endDate', 'endTime', 'timezone', 'durationMinutes', 'deadline', 'flexibility', 'involvement', 'completion', 'category'],
  routine: ['title', 'weekdays', 'startDate', 'localTime', 'duration', 'category'],
} as const;
const value = z.union([z.string().max(2000), z.array(z.string().max(200)).max(7)]);
export const formDraft = z.object({
  kind: z.enum(['event', 'task', 'routine']),
  fields: z.record(z.string().max(50), value),
}).strict().refine(draft => Object.entries(draft.fields).every(([key, field]) =>
  (keys[draft.kind] as readonly string[]).includes(key) &&
  (key === 'weekdays' ? Array.isArray(field) : typeof field === 'string') &&
  (key !== 'kind' || field === draft.kind)));

export const chatContext = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }).strict(),
  z.object({ kind: z.literal('item'), id: z.string().trim().min(1).max(200), expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal('form'), draft: formDraft }).strict(),
]);
