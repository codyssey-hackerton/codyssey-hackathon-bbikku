import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ReviewSchedule } from '@pikku/domain';
import { operationGuard } from '../api/operationGuard';
import { createReminderAdapter } from '../notifications/adapter';
import { clearReminderEntry, reminderEntry, setReminderEntry, subscribeReminders } from '../notifications/registry';
import { ActionButton } from '../ui/ActionButton';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';

export function DailyReviewNotifications({ schedule, deviceTimezone, scope, disabled = false, onBlockingChange }: {
  schedule?: ReviewSchedule; deviceTimezone: string; scope?: string; disabled?: boolean; onBlockingChange?: (blocked: boolean) => void;
}) {
  const adapter = useMemo(createReminderAdapter, []);
  const active = useRef<AbortController | null>(null);
  const owner = useRef<object>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [, setRegistryVersion] = useState(0);
  const ids = scope ? (['morning', 'evening'] as const).map(period => JSON.stringify([scope, 'review', period])) : [];
  const unresolved = ids.map(id => ({ id, entry: reminderEntry(id) })).filter(value => value.entry?.status === 'uncertain' || value.entry?.status === 'cancelling');
  useEffect(() => subscribeReminders(() => setRegistryVersion(value => value + 1)), []);
  useEffect(() => { onBlockingChange?.(busy || !!unresolved.length); }, [busy, unresolved.length, onBlockingChange]);
  useEffect(() => {
    setBusy(false); setMessage('');
    return () => { active.current?.abort(); active.current = null; };
  }, [scope, disabled, deviceTimezone, schedule?.revision, schedule?.timezone, schedule?.morning.enabled, schedule?.morning.localTime, schedule?.evening.enabled, schedule?.evening.localTime]);
  async function connect() {
    if (!schedule || !scope || busy || active.current || disabled || unresolved.length || operationGuard.hasUnresolved() || schedule.timezone !== deviceTimezone) return;
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== deviceTimezone) { setMessage('기기 시간대가 바뀌었습니다. 앱을 다시 열고 설정을 확인해 주세요.'); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage('');
    onBlockingChange?.(true);
    operationGuard.update(owner.current, { status: 'pending' });
    let attemptedId: string | null = null, uncertain = false;
    try {
      const permission = await adapter.requestPermission();
      if (controller.signal.aborted) return;
      if (permission !== 'granted' && permission !== 'provisional') {
        setMessage(permission === 'not_supported' ? '이 환경에서는 기기 알림을 지원하지 않습니다.' : '알림 권한을 확인해 주세요.'); return;
      }
      for (const period of ['morning', 'evening'] as const) {
        const setting = schedule[period], id = JSON.stringify([scope, 'review', period]);
        attemptedId = id;
        const result = setting.enabled && setting.localTime
          ? await adapter.scheduleDaily({ id, localTime: setting.localTime, title: period === 'morning' ? '아침 브리핑' : '저녁 회고', body: 'PIKKU에서 확인해 주세요.' }, { signal: controller.signal })
          : await adapter.cancel(id);
        if (controller.signal.aborted) {
          try { uncertain = (await adapter.cancel(id)).status !== 'cancelled'; } catch { uncertain = true; }
          return;
        }
        if (result.status === 'error') { uncertain = true; setMessage('기기 알림 결과를 확인하지 못했습니다. 취소로 확인해 주세요.'); return; }
        if (result.status !== 'scheduled' && result.status !== 'cancelled') { setMessage('일부 기기 알림을 설정하지 못했습니다. 다시 시도해 주세요.'); return; }
        attemptedId = null;
      }
      setMessage('이 기기의 알림 설정을 적용했습니다. 실제 알림 시각은 기기 상태에 따라 달라질 수 있어요.');
    } catch {
      if (attemptedId) {
        if (controller.signal.aborted) { try { uncertain = (await adapter.cancel(attemptedId)).status !== 'cancelled'; } catch { uncertain = true; } }
        else uncertain = true;
      }
      if (!controller.signal.aborted) setMessage(attemptedId ? '기기 알림 결과를 확인하지 못했습니다. 취소로 확인해 주세요.' : '알림 권한을 확인하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (uncertain && attemptedId) {
        setReminderEntry(attemptedId, { fingerprint: 'daily-review', status: 'uncertain', owner: owner.current });
        operationGuard.update(owner.current, { status: 'error', error: new Error('unknown'), uncertain: true });
      } else operationGuard.clear(owner.current);
      if (!controller.signal.aborted) { active.current = null; setBusy(false); }
    }
  }
  async function resolve(id: string) {
    const entry = reminderEntry(id);
    if (!entry || entry.status !== 'uncertain' || busy || active.current) return;
    const cancelling = { ...entry, status: 'cancelling' as const };
    setReminderEntry(id, cancelling); operationGuard.update(entry.owner, { status: 'pending' });
    try {
      const result = await adapter.cancel(id);
      if (result.status === 'cancelled') { clearReminderEntry(id, cancelling); operationGuard.clear(entry.owner); setMessage('확인되지 않은 알림을 취소했습니다.'); }
      else { setReminderEntry(id, { ...entry, status: 'uncertain' }); operationGuard.update(entry.owner, { status: 'error', error: new Error('unknown'), uncertain: true }); }
    } catch { setReminderEntry(id, { ...entry, status: 'uncertain' }); operationGuard.update(entry.owner, { status: 'error', error: new Error('unknown'), uncertain: true }); }
  }
  if (!schedule && !unresolved.length) return null;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>이 기기의 알림</Text>
    {schedule && <>
    <Text style={styles.hint}>저장된 아침·저녁 시간으로 이 기기에 반복 알림을 설정합니다. 시간을 바꾸면 이 기기의 알림도 다시 설정해 주세요. 브리핑 생성 및 알림 도착은 보장되지 않습니다.</Text>
    {schedule.timezone !== deviceTimezone && <Text style={styles.hint}>기기 알림을 연결하려면 먼저 기기 시간대로 설정을 저장해 주세요.</Text>}
    {!scope && <Text style={styles.hint}>로그인 후 기기 알림을 연결할 수 있습니다.</Text>}
    <ActionButton label={busy ? '기기 알림 설정 중' : '이 기기에 알림 설정'} onPress={connect} disabled={disabled || busy || !!unresolved.length || !scope || schedule.timezone !== deviceTimezone} secondary />
    </>}
    {unresolved.map(({ id, entry }) => <View key={id}><Text accessibilityRole="alert">{id === ids[0] ? '아침' : '저녁'} 알림 결과를 확인하지 못했습니다. 취소 결과를 확인해 주세요.</Text>
      <ActionButton label={id === ids[0] ? '아침 알림 취소 확인' : '저녁 알림 취소 확인'} disabled={entry?.status === 'cancelling'} secondary onPress={() => void resolve(id)} /></View>)}
    {!!message && <Text accessibilityLiveRegion="polite" style={styles.hint}>{message}</Text>}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 8, marginTop: 12 }, title: { fontSize: 18, fontWeight: '700' }, hint: { color: colors.muted, lineHeight: 20 } });
