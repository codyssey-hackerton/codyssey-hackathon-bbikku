import { z } from 'zod';
import { compareInstants, timestamp } from './planning-schemas.ts';

export const deviceContext = z.object({
  currentLocation: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().positive().max(1000),
    capturedAt: timestamp,
  }).strict().optional(),
  travelMode: z.enum(['walk', 'transit', 'car']).optional(),
  notificationSupport: z.enum(['device', 'unsupported', 'unknown']).optional(),
}).strict();

export function locationAvailable(value: unknown, now: string): boolean {
  const parsed = deviceContext.shape.currentLocation.safeParse(value);
  if (!parsed.success || !parsed.data || !timestamp.safeParse(now).success) return false;
  const ms = Date.parse(now);
  return compareInstants(parsed.data.capturedAt, new Date(ms - 300_000).toISOString()) > 0 &&
    compareInstants(parsed.data.capturedAt, new Date(ms + 15_000).toISOString()) <= 0;
}
