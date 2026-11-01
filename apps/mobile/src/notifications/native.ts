import { compareTimestamps, isTimestamp } from '../schedule/client';
import type { ReminderAdapter, ReminderPermission, ReminderInput, ReminderScheduleResult, ReminderCancelResult } from './types';

type Notifications = typeof import('expo-notifications');
const prefix = 'pikku-reminder-v1:';
const channelId = 'pikku-reminders-v1';
const queues = new Map<string, Promise<void>>();
export function configureReminderForeground(api: Notifications): void {
  api.setNotificationHandler({ handleNotification: async notification => {
    const owned = notification.request.identifier.startsWith(prefix);
    return { shouldShowBanner: owned, shouldShowList: owned, shouldPlaySound: owned, shouldSetBadge: false };
  } });
}
function identifier(id: string): string | null {
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 1000 || /[\x00-\x1f\x7f]/.test(id)) return null;
  try { return prefix + encodeURIComponent(id); } catch { return null; }
}
function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
  const result = (queues.get(id) ?? Promise.resolve()).then(run);
  const tail = result.then(() => {}, () => {});
  queues.set(id, tail);
  void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
  return result;
}
function permission(api: Notifications, platform: 'ios' | 'android', value: Awaited<ReturnType<Notifications['getPermissionsAsync']>>): ReminderPermission {
  if (platform === 'ios') {
    switch (value.ios?.status) {
      case api.IosAuthorizationStatus.AUTHORIZED: case api.IosAuthorizationStatus.EPHEMERAL: return 'granted';
      case api.IosAuthorizationStatus.PROVISIONAL: return 'provisional';
      case api.IosAuthorizationStatus.DENIED: return 'denied';
      case api.IosAuthorizationStatus.NOT_DETERMINED: return 'undetermined';
      default: return 'error';
    }
  }
  return value.status === 'granted' || value.status === 'denied' || value.status === 'undetermined' ? value.status : 'error';
}
function valid(input: ReminderInput, now: number): number | null {
  if (!input || !identifier(input.id) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 ||
      typeof input.body !== 'string' || !input.body.trim() || input.body.length > 1000) return null;
  if (!isTimestamp(input.triggerAt)) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(input.triggerAt)?.[1] ?? '';
  const time = Date.parse(input.triggerAt) + (/[1-9]/.test(fraction.slice(3)) ? 1 : 0);
  return Number.isFinite(time) && time > now ? time : null;
}
function withinValidity(value: string | undefined, now: number): boolean {
  if (value === undefined) return true;
  if (!isTimestamp(value) || !Number.isFinite(now)) return false;
  try { return compareTimestamps(value, new Date(now).toISOString()) > 0; } catch { return false; }
}

export function createNativeReminderAdapter(platform: 'ios' | 'android', load: () => Promise<Notifications>, now: () => number = Date.now, androidApiLevel?: number): ReminderAdapter {
  let native: Promise<Notifications> | undefined;
  const api = () => native ??= load().catch(error => { native = undefined; throw error; });
  const supportsChannels = platform === 'android' && (androidApiLevel === undefined || androidApiLevel >= 26);
  async function channel(notifications: Notifications): Promise<boolean> {
    if (!supportsChannels) return true;
    const value = await notifications.setNotificationChannelAsync(channelId, { name: '일정 알림', importance: notifications.AndroidImportance.DEFAULT });
    return !!value && value.importance !== notifications.AndroidImportance.NONE;
  }
  return {
    async getPermission() {
      try { const notifications = await api(); return permission(notifications, platform, await notifications.getPermissionsAsync()); }
      catch { return 'error'; }
    },
    async requestPermission() {
      try {
        const notifications = await api();
        if (!await channel(notifications)) return 'denied';
        return permission(notifications, platform, await notifications.requestPermissionsAsync());
      } catch { return 'error'; }
    },
    async schedule(input, options) {
      const request = input && { id: input.id, title: input.title, body: input.body, triggerAt: input.triggerAt };
      const id = request && identifier(request.id);
      if (!id || options?.signal?.aborted || valid(request, now()) === null || !withinValidity(options?.validUntil, now())) return { status: 'error' };
      return serial<ReminderScheduleResult>(id, async () => {
        let started = false;
        try {
          if (options?.signal?.aborted) return { status: 'error' };
          const notifications = await api();
          const status = permission(notifications, platform, await notifications.getPermissionsAsync());
          if (status !== 'granted' && status !== 'provisional') return { status: status === 'error' ? 'error' : 'denied' };
          if (!await channel(notifications)) return { status: 'denied' };
          const time = valid(request, now());
          if (time === null || options?.signal?.aborted || !withinValidity(options?.validUntil, now())) return { status: 'error' };
          configureReminderForeground(notifications);
          await notifications.cancelScheduledNotificationAsync(id);
          if (options?.signal?.aborted || valid(request, now()) === null || !withinValidity(options?.validUntil, now())) return { status: 'error' };
          started = true;
          const result = await notifications.scheduleNotificationAsync({ identifier: id, content: { title: request.title, body: request.body },
            trigger: { type: notifications.SchedulableTriggerInputTypes.DATE, date: new Date(time), ...(platform === 'android' ? { ...(supportsChannels ? { channelId } : {}), delivery: 'bestEffort' as const } : {}) } });
          if (options?.signal?.aborted) { started = false; await notifications.cancelScheduledNotificationAsync(id); return { status: 'error' }; }
          return result === id ? { status: 'scheduled', identifier: id, delivery: 'device' } : { status: 'error' };
        } catch {
          if (started && options?.signal?.aborted) { try { await (await api()).cancelScheduledNotificationAsync(id); } catch { /* outcome remains unknown */ } }
          return { status: 'error' };
        }
      });
    },
    async scheduleDaily(input, options) {
      const request = input && { ...input };
      const id = request && identifier(request.id);
      const time = request && /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(request.localTime);
      if (!id || !time || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 200 ||
          typeof request.body !== 'string' || !request.body.trim() || request.body.length > 1000 || options?.signal?.aborted) return { status: 'error' };
      return serial<ReminderScheduleResult>(id, async () => {
        let started = false;
        try {
          if (options?.signal?.aborted) return { status: 'error' };
          const notifications = await api();
          const status = permission(notifications, platform, await notifications.getPermissionsAsync());
          if (status !== 'granted' && status !== 'provisional') return { status: status === 'error' ? 'error' : 'denied' };
          if (!await channel(notifications)) return { status: 'denied' };
          if (options?.signal?.aborted) return { status: 'error' };
          configureReminderForeground(notifications);
          await notifications.cancelScheduledNotificationAsync(id);
          if (options?.signal?.aborted) return { status: 'error' };
          started = true;
          const result = await notifications.scheduleNotificationAsync({ identifier: id, content: { title: request.title, body: request.body },
            trigger: { type: notifications.SchedulableTriggerInputTypes.DAILY, hour: Number(request.localTime.slice(0, 2)), minute: Number(request.localTime.slice(3)),
              ...(platform === 'android' ? { ...(supportsChannels ? { channelId } : {}), delivery: 'bestEffort' as const } : {}) } });
          if (options?.signal?.aborted) { started = false; await notifications.cancelScheduledNotificationAsync(id); return { status: 'error' }; }
          return result === id ? { status: 'scheduled', identifier: id, delivery: 'device' } : { status: 'error' };
        } catch {
          if (started && options?.signal?.aborted) { try { await (await api()).cancelScheduledNotificationAsync(id); } catch { /* outcome remains unknown */ } }
          return { status: 'error' };
        }
      });
    },
    async cancel(value) {
      const id = identifier(value);
      if (!id) return { status: 'error' };
      return serial<ReminderCancelResult>(id, async () => {
        try { await (await api()).cancelScheduledNotificationAsync(id); return { status: 'cancelled' }; }
        catch { return { status: 'error' }; }
      });
    },
  };
}
