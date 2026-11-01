import { Platform } from 'react-native';
import { configureReminderForeground, createNativeReminderAdapter } from './native';
import { createUnsupportedReminderAdapter as unsupported } from './unsupported';
import type { ReminderAdapter } from './types';

const native = Platform.OS === 'ios' || Platform.OS === 'android'
  ? import('expo-notifications').then(api => { configureReminderForeground(api); return api; }).catch(() => null) : null;

export function createReminderAdapter(): ReminderAdapter {
  return Platform.OS === 'ios' || Platform.OS === 'android'
    ? createNativeReminderAdapter(Platform.OS, async () => { const api = await native; if (!api) throw new Error('Notifications unavailable'); return api; }, Date.now,
      Platform.OS === 'android' && typeof Platform.Version === 'number' ? Platform.Version : undefined) : unsupported();
}
