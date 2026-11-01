export type ReminderPermission = 'granted' | 'provisional' | 'denied' | 'undetermined' | 'not_supported' | 'error';
export type ReminderInput = { id: string; title: string; body: string; triggerAt: string };
export type ReminderScheduleResult = { status: 'scheduled'; identifier: string; delivery: 'device' } |
  { status: 'not_supported' | 'denied' | 'error' };
export type ReminderCancelResult = { status: 'cancelled' | 'not_supported' | 'error' };
export type ReminderAdapter = {
  getPermission(): Promise<ReminderPermission>;
  requestPermission(): Promise<ReminderPermission>;
  schedule(input: ReminderInput, options?: { signal?: AbortSignal; validUntil?: string }): Promise<ReminderScheduleResult>;
  scheduleDaily(input: { id: string; title: string; body: string; localTime: string }, options?: { signal?: AbortSignal }): Promise<ReminderScheduleResult>;
  cancel(id: string): Promise<ReminderCancelResult>;
};
