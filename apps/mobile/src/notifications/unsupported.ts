import type { ReminderAdapter } from './types';

// Web cannot schedule an OS notification after the browser is closed.
export function createUnsupportedReminderAdapter(): ReminderAdapter {
  return {
    async getPermission() { return 'not_supported'; },
    async requestPermission() { return 'not_supported'; },
    async schedule() { return { status: 'not_supported' }; },
    async scheduleDaily() { return { status: 'not_supported' }; },
    async cancel() { return { status: 'not_supported' }; },
  };
}
