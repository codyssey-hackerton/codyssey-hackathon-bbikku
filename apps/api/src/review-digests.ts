import { z } from 'zod';
import type { UserPlanningState } from './planning-store.ts';
import { identifier, timestamp, timezone } from './planning-schemas.ts';

export type ReviewDigest = { id: string; reason: 'morning_review' | 'evening_plan'; createdAt: string; message: string; proposalIds: string[] };
const message = z.string().max(8000).refine(value => !!value.trim());
const result = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message }),
  z.object({ kind: z.literal('question'), message, missingFields: z.array(z.string().max(200)).max(100) }),
  z.object({ kind: z.literal('proposal'), message, proposalIds: z.array(identifier).min(1).max(10) }),
]);
const row = z.object({ eventId: identifier, status: z.literal('completed'), reason: z.enum(['morning_review', 'evening_plan']),
  timezone, targetDate: z.iso.date(), scheduledFor: timestamp, at: timestamp, result });

export function listReviewDigests(state: UserPlanningState, now: Date): { digests: ReviewDigest[] } {
  const current = now.getTime();
  if (!Number.isFinite(current)) return { digests: [] };
  const digests: ReviewDigest[] = [];
  const order = (a: ReviewDigest, b: ReviewDigest) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
  for (const value of state.reviewLedger.values()) {
    const parsed = row.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data, created = Date.parse(entry.at), scheduled = Date.parse(entry.scheduledFor);
    if (created > current || created < current - 7 * 86_400_000 || scheduled > created) continue;
    const ids = entry.result.kind === 'proposal' ? entry.result.proposalIds : [];
    if (new Set(ids).size !== ids.length || ids.some(id => !state.proposals.has(id))) continue;
    const digest: ReviewDigest = { id: entry.eventId, reason: entry.reason, createdAt: entry.at, message: entry.result.message, proposalIds: ids };
    const duplicate = digests.findIndex(value => value.id === digest.id);
    if (duplicate >= 0) {
      if (order(digest, digests[duplicate]!) >= 0) continue;
      digests.splice(duplicate, 1);
    }
    digests.push(digest); digests.sort(order);
    if (digests.length > 10) digests.pop();
  }
  return { digests };
}
