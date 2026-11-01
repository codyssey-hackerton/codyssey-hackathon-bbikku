import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AgentResult } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { compareTimestamps, createScheduleClient, isTimestamp } from '../schedule/client';
import { ActionButton } from '../ui/ActionButton';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { createReminderAdapter } from './adapter';
import { clearReminderEntry, reminderEntry, setReminderEntry, subscribeReminders } from './registry';
import type { ReminderPermission } from './types';

type Reminder = Extract<AgentResult, { kind: 'reminder_request' }>['reminder'];
type Phase = 'idle' | 'busy';

function localTime(value: string): string {
  try { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return '시간을 확인할 수 없습니다'; }
}
function usable(reminder: Reminder): boolean {
  return isTimestamp(reminder.reminderAt) && isTimestamp(reminder.expiresAt) && isTimestamp(reminder.appointmentAt) &&
    isTimestamp(reminder.appointmentEndsAt) && compareTimestamps(reminder.appointmentAt, reminder.appointmentEndsAt) < 0 &&
    Date.parse(reminder.reminderAt) > Date.now() && Date.parse(reminder.expiresAt) > Date.now();
}

export default function ReminderCard({ api, reminder, scope }: { api: ApiClient; reminder: Reminder; scope: string | undefined }) {
  const adapter = useMemo(() => createReminderAdapter(), []);
  const scheduleClient = useMemo(() => createScheduleClient(api), [api]);
  const [permission, setPermission] = useState<ReminderPermission | 'checking'>('checking');
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [, setRegistryVersion] = useState(0);
  const [message, setMessage] = useState('');
  const lock = useRef(false), owner = useRef<object>({}), mounted = useRef(false), controller = useRef<AbortController | null>(null);
  const contextKey = JSON.stringify([scope, reminder]);
  const phaseKey = useRef({ api, contextKey });
  const current = useRef({ api, contextKey }); current.current = { api, contextKey };
  const id = scope?.trim() ? JSON.stringify([scope, reminder.itemId, reminder.basis]) : null;
  const fingerprint = JSON.stringify([reminder.expectedRevision, reminder.title, reminder.appointmentAt, reminder.appointmentEndsAt,
    reminder.timezone, reminder.appointmentLocation, reminder.minutesBefore, reminder.reminderAt, reminder.departureAt, reminder.travel]);
  const entry = reminderEntry(id);
  const shownPhase = (phaseKey.current.api === api && phaseKey.current.contextKey === contextKey && phase === 'busy') || entry?.status === 'cancelling'
    ? 'busy' : entry?.status ?? 'idle';
  const sameCandidate = entry?.fingerprint === fingerprint;
  const destinationValid = reminder.basis !== 'departure' || (isTimestamp(reminder.departureAt) && typeof reminder.travel?.destinationName === 'string' && !!reminder.travel.destinationName.trim() &&
    typeof reminder.travel.destinationAddress === 'string' && !!reminder.travel.destinationAddress.trim());
  const destinationConfirmed = reminder.basis !== 'departure' || confirmedKey === contextKey;
  useEffect(() => subscribeReminders(() => setRegistryVersion(value => value + 1)), []);
  useEffect(() => {
    mounted.current = true; let active = true; phaseKey.current = { api, contextKey };
    setPermission('checking'); setPhase('idle'); setConfirmedKey(null); setMessage('');
    void adapter.getPermission().then(value => { if (active) setPermission(value); }, () => { if (active) setPermission('error'); });
    return () => { active = false; mounted.current = false; controller.current?.abort(); };
  }, [adapter, api, contextKey]);
  const stillCurrent = (request: AbortController, originalApi: ApiClient, key: string) =>
    mounted.current && !request.signal.aborted && current.current.api === originalApi && current.current.contextKey === key;

  async function setReminder() {
    if (lock.current || shownPhase !== 'idle' || current.current.api !== api || current.current.contextKey !== contextKey || !id || !destinationValid || !destinationConfirmed || permission === 'not_supported' || operationGuard.hasUnresolved()) return;
    const request = new AbortController(), originalApi = api, key = contextKey, candidate = { ...reminder };
    controller.current = request; lock.current = true; setPhase('busy'); setMessage('');
    operationGuard.update(owner.current, { status: 'pending' });
    let attempted = false, uncertain = false;
    try {
      const access = await adapter.requestPermission();
      if (!stillCurrent(request, originalApi, key)) return;
      setPermission(access);
      if (access !== 'granted' && access !== 'provisional') {
        setMessage(access === 'not_supported' ? '브라우저는 예약 알림을 지원하지 않습니다. 설치형 앱이 필요합니다.' : '알림 권한을 확인해 주세요.');
        return;
      }
      if (!usable(candidate)) { setMessage('알림 시간이 지났거나 제안이 만료되었습니다. 다시 요청해 주세요.'); return; }
      const listed = await scheduleClient.list({ from: candidate.appointmentAt, to: candidate.appointmentEndsAt, timezone: candidate.timezone, includeUnscheduled: false });
      if (!stillCurrent(request, originalApi, key)) return;
      const item = listed.items.find(value => value.id === candidate.itemId && value.revision === candidate.expectedRevision);
      if (!usable(candidate) || !item?.timeSlot || item.title !== candidate.title || (item.location ?? null) !== (candidate.appointmentLocation ?? null) || item.timeSlot.timezone !== candidate.timezone ||
          compareTimestamps(item.timeSlot.startsAt, candidate.appointmentAt) !== 0 || compareTimestamps(item.timeSlot.endsAt, candidate.appointmentEndsAt) !== 0) {
        setMessage('일정이 바뀌었거나 제안이 만료되었습니다. 다시 요청해 주세요.'); return;
      }
      attempted = true;
      const result = await adapter.schedule({ id, title: '일정 알림', body: candidate.basis === 'departure' ? '출발 준비를 확인해 주세요.' : '일정 시간을 확인해 주세요.', triggerAt: candidate.reminderAt }, { signal: request.signal, validUntil: candidate.expiresAt });
      if (!stillCurrent(request, originalApi, key)) {
        try { uncertain = (await adapter.cancel(id)).status !== 'cancelled'; } catch { uncertain = true; }
        return;
      }
      if (result.status === 'scheduled') { setReminderEntry(id, { fingerprint, status: 'scheduled', owner: owner.current }); }
      else if (result.status === 'error') {
        setReminderEntry(id, { fingerprint, status: 'uncertain', owner: owner.current }); setMessage('예약 결과를 확인하지 못했습니다. 취소로 기존 예약을 확인해 주세요.');
        uncertain = true; return;
      } else setMessage(result.status === 'not_supported' ? '브라우저는 예약 알림을 지원하지 않습니다. 설치형 앱이 필요합니다.' : '알림 권한을 확인해 주세요.');
    } catch {
      if (stillCurrent(request, originalApi, key)) {
        if (attempted) { setReminderEntry(id, { fingerprint, status: 'uncertain', owner: owner.current }); setMessage('예약 결과를 확인하지 못했습니다. 취소로 기존 예약을 확인해 주세요.');
          uncertain = true; return; }
        setMessage('일정을 확인하지 못했습니다. 다시 확인해 주세요.');
      } else if (attempted) { try { uncertain = (await adapter.cancel(id)).status !== 'cancelled'; } catch { uncertain = true; } }
    } finally {
      lock.current = false;
      if (stillCurrent(request, originalApi, key)) setPhase(value => value === 'busy' ? 'idle' : value);
      if (uncertain) { setReminderEntry(id, { fingerprint, status: 'uncertain', owner: owner.current }); operationGuard.update(owner.current, { status: 'error', error: new Error('unknown'), uncertain: true }); }
      else operationGuard.clear(owner.current);
    }
  }

  async function cancelReminder() {
    if (!id || !entry || reminderEntry(id) !== entry || lock.current || current.current.api !== api || current.current.contextKey !== contextKey || (shownPhase !== 'scheduled' && shownPhase !== 'uncertain')) return;
    const originalApi = api, key = contextKey;
    const currentCard = () => mounted.current && current.current.api === originalApi && current.current.contextKey === key;
    const guardOwner = entry.status === 'uncertain' ? entry.owner : owner.current;
    const cancelling = { ...entry, status: 'cancelling' as const };
    lock.current = true; setPhase('busy'); operationGuard.update(guardOwner, { status: 'pending' }); setReminderEntry(id, cancelling);
    try {
      const result = await adapter.cancel(id);
      if (result.status === 'cancelled') { clearReminderEntry(id, cancelling); operationGuard.clear(guardOwner); if (currentCard()) setMessage('이 기기의 알림을 취소했습니다.'); }
      else { setReminderEntry(id, { ...entry, status: 'uncertain', owner: guardOwner }); operationGuard.update(guardOwner, { status: 'error', error: new Error('unknown'), uncertain: true }); if (currentCard()) setMessage('알림 취소 결과를 확인하지 못했습니다.'); }
    } catch { setReminderEntry(id, { ...entry, status: 'uncertain', owner: guardOwner }); operationGuard.update(guardOwner, { status: 'error', error: new Error('unknown'), uncertain: true }); if (currentCard()) setMessage('알림 취소 결과를 확인하지 못했습니다.'); }
    finally { lock.current = false; if (currentCard()) setPhase('idle'); }
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>알림 확인</Text>
    <Text>{reminder.title}</Text>
    <Text>알림 시각: {localTime(reminder.reminderAt)}</Text>
    <Text>{reminder.basis === 'departure' ? '출발 기준' : '일정 시작 기준'} · {reminder.minutesBefore}분 전</Text>
    {reminder.basis === 'departure' && reminder.departureAt && <Text>출발 예상 시각: {localTime(reminder.departureAt)}</Text>}
    {reminder.appointmentLocation && <Text>일정의 원래 장소: {reminder.appointmentLocation}</Text>}
    {reminder.basis === 'departure' && destinationValid && <Text>도착지: {reminder.travel!.destinationName} · {reminder.travel!.destinationAddress}</Text>}
    {!destinationValid && <Text accessibilityRole="alert">도착지 정보를 확인할 수 없습니다. 알림을 다시 요청해 주세요.</Text>}
    {reminder.basis === 'departure' && destinationValid && <Pressable accessibilityRole="checkbox" aria-checked={destinationConfirmed}
      accessibilityState={{ checked: destinationConfirmed, disabled: shownPhase !== 'idle' }} disabled={shownPhase !== 'idle'}
      onPress={() => setConfirmedKey(destinationConfirmed ? null : contextKey)}><Text>{destinationConfirmed ? '☑' : '☐'} 이 도착지와 알림 시각을 확인했어요</Text></Pressable>}
    {reminder.travel && <Text>현재 조회한 {reminder.travel.mode === 'walk' ? '도보' : reminder.travel.mode === 'transit' ? '대중교통' : '자동차'} 예상 {reminder.travel.durationMinutes}분 기준입니다. 실제 이동시간은 달라질 수 있습니다.</Text>}
    <Text style={styles.hint}>이 기기에 고정된 시각으로 예약합니다. 외부 일정이 바뀌어도 자동으로 갱신되지 않습니다.</Text>
    {!id && <Text accessibilityRole="alert">알림을 설정하려면 정식 로그인이 필요합니다.</Text>}
    {permission === 'not_supported' && <Text>브라우저는 예약 알림을 지원하지 않습니다. 설치형 앱이 필요합니다.</Text>}
    {permission === 'provisional' && <Text>현재 조용한 알림 권한으로 설정되어 있습니다.</Text>}
    {entry?.status === 'scheduled' && !sameCandidate && <Text>같은 일정의 기존 알림이 있습니다. 취소한 뒤 새 알림을 설정해 주세요.</Text>}
    {entry?.status === 'uncertain' && <Text accessibilityRole="alert">이 일정의 알림 결과를 확인하지 못했습니다. 취소 결과를 확인해 주세요.</Text>}
    {!!message && <Text accessibilityRole="alert">{message}</Text>}
    {permission !== 'not_supported' && <ActionButton label={shownPhase === 'busy' ? '알림 처리 중' : shownPhase === 'scheduled' ? sameCandidate ? '알림 설정됨' : '기존 알림 있음' : '알림 설정'}
      disabled={!id || !destinationValid || !destinationConfirmed || permission === 'checking' || shownPhase !== 'idle'} onPress={() => void setReminder()} />}
    {(shownPhase === 'scheduled' || shownPhase === 'uncertain') && <ActionButton label={sameCandidate ? '알림 취소' : '기존 알림 취소'} secondary onPress={() => void cancelReminder()} />}
  </View>;
}

const styles = StyleSheet.create({ card: { padding: 14, gap: 8, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  title: { fontWeight: '700', color: colors.text }, hint: { color: colors.muted, lineHeight: 19 } });
