import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';
import { createHealthAdapter } from './native-adapter';
import { summarizeHealth } from './summary';
import type { HealthAccess, HealthAvailability, HealthPermission, HealthSelection, HealthSummary } from './types';

type Props = { timezone: string; onBack: () => void; visible?: boolean };
const emptySelection = (): HealthSelection => ({ steps: false, workouts: false });
const sourceName = (source: HealthSummary['source']) => source === 'apple_health' ? 'Apple 건강' : 'Health Connect';
const permissionText: Record<HealthPermission, string> = {
  granted: '읽기 권한 확인됨', denied: '읽기 권한 없음', unknown: '권한과 데이터 유무를 확인할 수 없음',
  unavailable: '사용할 수 없음', unsupported: '지원하지 않음', not_selected: '선택하지 않음',
};
const readable = (permission: HealthPermission) => permission === 'granted' || permission === 'unknown';

export default function HealthPanel({ timezone, onBack, visible = true }: Props) {
  const adapter = useMemo(() => createHealthAdapter(), []);
  const [availability, setAvailability] = useState<HealthAvailability | null>(null);
  const [selection, setSelection] = useState<HealthSelection>(emptySelection);
  const [access, setAccess] = useState<HealthAccess | null>(null);
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const connected = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    adapter.availability().then(value => { if (active) setAvailability(value); }, () => {
      if (active) setAvailability({ status: 'unavailable', source: null, reason: 'error' });
    });
    return () => { active = false; mounted.current = false; generation.current += 1; };
  }, [adapter]);

  useEffect(() => {
    generation.current += 1; connected.current = false;
    setSummary(null); setAccess(null);
  }, [timezone]);

  useEffect(() => {
    if (!summary || !visible) return;
    const remaining = Date.parse(summary.lastSyncedAt) + 5 * 60_000 - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [summary, visible]);

  function changeSelection(key: keyof HealthSelection) {
    generation.current += 1; connected.current = false;
    setSummary(null); setAccess(null); setMessage('');
    setSelection(previous => ({ ...previous, [key]: !previous[key] }));
  }

  async function sync(requestPermission: boolean) {
    if (inFlight.current || availability?.status !== 'available' || (!selection.steps && !selection.workouts)) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const token = ++generation.current;
    const selected = { ...selection };
    try {
      const permission = requestPermission ? await adapter.connect(selected) : access;
      if (!mounted.current || generation.current !== token) return;
      if (!permission) throw new Error('HEALTH_ACCESS_UNKNOWN');
      setAccess({ steps: selected.steps ? permission.steps : 'not_selected', workouts: selected.workouts ? permission.workouts : 'not_selected' });
      const allowed = { steps: selected.steps && readable(permission.steps), workouts: selected.workouts && readable(permission.workouts) };
      if (!allowed.steps && !allowed.workouts) {
        connected.current = false; setSummary(null); setMessage('선택한 항목의 읽기 권한을 확인해 주세요.'); return;
      }
      const now = new Date().toISOString();
      const result = await adapter.read({ now, timezone, selection: allowed });
      if (!mounted.current || generation.current !== token) return;
      if (result.selection.steps !== allowed.steps || result.selection.workouts !== allowed.workouts) throw new Error('HEALTH_SELECTION_MISMATCH');
      setExpired(false);
      setSummary(summarizeHealth(result, { now, timezone, selection: allowed, calculatedAt: new Date().toISOString() })); connected.current = true;
    } catch {
      if (mounted.current && generation.current === token) { connected.current = false; setSummary(null); setMessage('건강 데이터를 확인하지 못했습니다. 권한과 기기 설정을 확인해 주세요.'); }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function disconnect() {
    generation.current += 1; connected.current = false;
    setSummary(null); setAccess(null); setSelection(emptySelection());
    setMessage('이 앱의 메모리에서 건강 데이터를 지웠습니다. 기기의 건강 권한은 별도로 변경해야 합니다.');
  }

  const availableMessage = availability?.status === 'unsupported' && availability.source === 'health_connect'
    ? 'Health Connect를 사용하려면 Android 9(API 28) 이상이 필요합니다.'
    : availability?.reason === 'needs_dev_build' ? 'Expo Go에서는 건강 데이터를 사용할 수 없습니다. 개발 빌드가 필요합니다.'
      : availability?.status === 'unsupported' && availability.source === null ? '이 환경에서는 건강 데이터를 지원하지 않습니다. 웹에서도 사용할 수 없습니다.'
        : availability?.reason === 'provider_missing_or_update_required' ? '기기의 건강 데이터 제공 앱을 설치하거나 업데이트해야 합니다.'
          : '이 기기에서 건강 데이터를 사용할 수 없습니다. 기기 설정을 확인해 주세요.';
  const stale = !!summary && (summary.stale || expired || Date.now() >= Date.parse(summary.lastSyncedAt) + 5 * 60_000);

  return <ScrollView contentContainerStyle={styles.container}>
    <View style={styles.row}><Text accessibilityRole="header" style={styles.title}>건강 데이터</Text>
      <ActionButton label="나중에" onPress={() => { if (inFlight.current) generation.current += 1; onBack(); }} secondary /></View>
    <Text style={styles.text}>최근 7일의 걸음 수와 기록된 운동만 선택해 읽습니다. 정보는 이 기기에서만 처리하며 서버나 AI로 전송하지 않습니다.</Text>
    <Text style={styles.text}>항목을 바꾸면 이전 결과를 지우고 다시 연결해야 합니다. 건강 권한은 선택 사항입니다.</Text>
    {Platform.OS === 'ios' && <><Text style={styles.text}>iPhone의 앱 설정은 건강 읽기 권한 화면이 아닙니다. 권한을 변경하려면 건강 앱에서 프로필 사진 → 개인정보 보호의 앱 → 이 앱을 직접 선택하세요.</Text>
      <Text style={styles.text}>조회 결과가 없어도 읽기 권한이 거부되었는지는 알 수 없습니다.</Text></>}
    {Platform.OS === 'android' && <Text style={styles.text}>건강 권한은 Health Connect의 앱 권한에서 관리할 수 있습니다.</Text>}
    {(['steps', 'workouts'] as const).map(key => <Pressable key={key} accessibilityRole="checkbox"
      accessibilityLabel={key === 'steps' ? '걸음 수 선택' : '운동 기록 선택'} accessibilityState={{ checked: selection[key], disabled: busy }}
      aria-checked={selection[key]} disabled={busy} onPress={() => changeSelection(key)} style={styles.choice}>
      <Text style={styles.text}>{selection[key] ? '☑' : '☐'} {key === 'steps' ? '걸음 수' : '기록된 운동'}</Text>
    </Pressable>)}
    {availability === null ? <View style={styles.row}><ActivityIndicator /><Text style={styles.text}>기기 지원 여부를 확인하는 중입니다.</Text></View> :
      availability.status !== 'available' ? <Text accessibilityRole="alert" style={styles.notice}>{availableMessage}</Text> : <>
        <ActionButton label="연결하기" onPress={() => void sync(true)} disabled={busy || (!selection.steps && !selection.workouts)} />
        {connected.current && <ActionButton label="다시 동기화" onPress={() => void sync(false)} disabled={busy} secondary />}
      </>}
    {busy && <Text accessibilityLiveRegion="polite" style={styles.text}>건강 데이터를 확인하는 중입니다.</Text>}
    {access && <View style={styles.card}><Text style={styles.text}>걸음 수: {permissionText[access.steps]}</Text><Text style={styles.text}>운동 기록: {permissionText[access.workouts]}</Text></View>}
    {summary && <>
      <Text accessibilityRole="header" style={styles.section}>최근 7일</Text>
      <Text style={styles.text}>출처: {sourceName(summary.source)} · 마지막 조회: {summary.lastSyncedAt}</Text>
      {summary.status === 'partial' && <Text style={styles.notice}>일부 데이터만 조회되었습니다.</Text>}
      {summary.status === 'no_data_or_access' && <Text style={styles.notice}>데이터가 없거나 읽기 권한을 확인할 수 없습니다.</Text>}
      {summary.truncated && <Text style={styles.notice}>조회 결과가 일부만 표시됩니다.</Text>}
      {stale && <Text style={styles.notice}>이전 조회 결과입니다. 필요하면 다시 동기화해 주세요.</Text>}
      {summary.selection.workouts && <Text style={styles.text}>운동 기록 구간은 일시정지를 포함한 시작~종료 구간이며 실제 운동 수행 시간과 다를 수 있어요.</Text>}
      {summary.days.map(day => <View key={day.date} style={styles.card}><Text style={styles.text}>{day.date}</Text>
        <Text style={styles.text}>걸음 수: {day.steps === null ? '미수집' : `${day.steps.toLocaleString()}걸음`}</Text>
        <Text style={styles.text}>운동 기록 구간: {day.exerciseMinutes === null ? '미수집' : `${day.exerciseMinutes}분`}</Text></View>)}
      <Text accessibilityRole="header" style={styles.section}>운동 세션</Text>
      {summary.workouts.length === 0 ? <Text style={styles.text}>표시할 운동 기록이 없습니다. 미수집 또는 권한 미확인일 수 있습니다.</Text> : summary.workouts.map(item =>
        <View key={`${item.source}:${item.id}`} style={styles.card}><Text style={styles.text}>{item.kind || '운동'} · {sourceName(item.source)}</Text>
          <Text style={styles.text}>{item.startAt} ~ {item.endAt}</Text></View>)}
      {!stale && summary.signals.length > 0 && <><Text accessibilityRole="header" style={styles.section}>조회 요약</Text>
        <Text style={styles.text}>최근 조회의 참고 정보이며 장기 선호나 건강 상태 판단이 아닙니다.</Text>
        {summary.signals.map(signal => <Text key={signal.kind} style={styles.text}>{signal.kind === 'days_with_steps' ? '걸음 기록 일수' : '운동 세션 수'}: {signal.value} · 표본 {signal.sampleDays}일 · 출처 {sourceName(signal.source)} · 산출 {signal.calculatedAt} · 유효기간 {signal.expiresAt}</Text>)}</>}
    </>}
    {Platform.OS === 'android' && <ActionButton label="Health Connect 설정" disabled={availability?.status !== 'available'} onPress={() => { void adapter.openSettings().catch(() => setMessage('기기 설정을 열지 못했습니다. 직접 건강 권한을 확인해 주세요.')); }} secondary />}
    <ActionButton label="연결해제" onPress={disconnect} secondary />
    {!!message && <Text accessibilityLiveRegion="polite" style={styles.notice}>{message}</Text>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12, paddingBottom: 32 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { color: colors.text, fontSize: 25, fontWeight: '700', flexShrink: 1 }, section: { color: colors.text, fontSize: 18, fontWeight: '700' },
  text: { color: colors.text, lineHeight: 21 }, notice: { color: colors.muted, lineHeight: 21 }, choice: { minHeight: 44, justifyContent: 'center' },
  card: { padding: 12, gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
});
