export type ReviewReason = 'user_input' | 'evening_plan' | 'morning_check' | 'schedule_changed';
export type ReviewEvent = {
  id: string; userId: string; reason: ReviewReason; occurredAt: string;
  message?: string; scheduleVersion?: number;
};
export type ReviewPreference = {
  userId: string; timeZone: string; revision: number;
  eveningTime?: string; morningTime?: string;
};

// Identities are server-generated; the same local occurrence is one event.
// Call from a server ticker, never from a phone's background timer.
export function scheduledReviews(now: Date, preferences: ReviewPreference[]): ReviewEvent[] {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid current time');
  return preferences.flatMap(pref => {
    if (!Number.isInteger(pref.revision) || pref.revision < 0) throw new Error('Invalid revision');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: pref.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (key: string) => parts.find(p => p.type === key)!.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const time = `${get('hour')}:${get('minute')}`;
    return ([['evening_plan', pref.eveningTime], ['morning_check', pref.morningTime]] as const)
      .flatMap(([reason, configured]) => {
        if (configured === undefined) return [];
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(configured)) throw new Error('Invalid review time');
        if (time !== configured) return [];
        return [{ id: JSON.stringify([pref.userId, reason, date, configured, pref.revision]),
          userId: pref.userId, reason, occurredAt: now.toISOString() }];
      });
  });
}

export interface ReviewQueue {
  enqueue(event: ReviewEvent): Promise<boolean>;
  next(): Promise<ReviewEvent | undefined>;
  complete(event: ReviewEvent): Promise<void>;
  fail(event: ReviewEvent, error: unknown): Promise<void>;
}
// Development/test adapter. The production DB and durable leasing policy remain pending.
export class InMemoryReviewQueue implements ReviewQueue {
  readonly records = new Map<string, { event: ReviewEvent; status: 'pending'|'running'|'completed'|'failed'; error?: unknown }>();
  private key(event: ReviewEvent) { return JSON.stringify([event.userId, event.id]); }
  async enqueue(event: ReviewEvent) {
    const key = this.key(event);
    if (this.records.has(key)) return false;
    this.records.set(key, { event: structuredClone(event), status: 'pending' });
    return true;
  }
  async next() {
    const row = [...this.records.values()].find(r => r.status === 'pending');
    if (!row) return;
    row.status = 'running';
    return structuredClone(row.event);
  }
  async complete(event: ReviewEvent) { this.records.get(this.key(event))!.status = 'completed'; }
  async fail(event: ReviewEvent, error: unknown) {
    Object.assign(this.records.get(this.key(event))!, { status: 'failed', error });
  }
}
export async function processOne(queue: ReviewQueue, review: (event: ReviewEvent) => Promise<void>) {
  const event = await queue.next();
  if (!event) return false;
  try { await review(event); await queue.complete(event); }
  catch (error) { await queue.fail(event, error); }
  return true;
}
