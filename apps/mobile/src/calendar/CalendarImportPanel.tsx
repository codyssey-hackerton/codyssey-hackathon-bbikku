import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../ui/typography';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { operationGuard } from '../api/operationGuard';
import { createScheduleClient, type ScheduleClient } from '../schedule/client';
import { createCalendarClient, selectedEventRefs, validPeriod } from './client';
import type { Calendar, CalendarConnection, CalendarEvents, CalendarImportInput, CalendarImportResult } from './client';

export interface CalendarImportPanelProps {
  api: ApiClient;
  timezone: string;
  onBack: () => void;
  onScheduleChanged: () => void;
  scheduleClient?: Pick<ScheduleClient, 'list'>;
}

function message(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch (error.code) {
      case 'conflict': return '일정이나 원본이 변경되었습니다. 다시 조회하고 선택해 주세요.';
      case 'not_configured': return '캘린더 연결이 설정되지 않았습니다.';
      case 'unauthenticated': return '로그인 또는 세션 설정을 확인해 주세요.';
      case 'network': return '서버에 연결할 수 없습니다.';
      case 'timeout': return '서버 응답 시간이 초과되었습니다.';
      case 'invalid_response': return '서버 응답을 확인할 수 없습니다.';
    }
  }
  return '요청을 완료하지 못했습니다. 다시 확인해 주세요.';
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

export default function CalendarImportPanel({ api, timezone, onBack, onScheduleChanged, scheduleClient }: CalendarImportPanelProps) {
  const client = useMemo(() => createCalendarClient(api), [api]);
  const schedule = useMemo(() => scheduleClient ?? createScheduleClient(api), [api, scheduleClient]);
  const initialPeriod = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now).toISOString(), to: new Date(now + 7 * 86400000).toISOString() };
  }, []);
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [connection, setConnection] = useState<CalendarConnection | null>(null);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvents | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const prepareLock = useRef(false);
  const mutation = useMutation<CalendarImportInput, CalendarImportResult>(
    operation => client.importEvents(operation),
    () => {
      setSelected(new Set());
      try { onScheduleChanged(); setRefreshError(false); } catch { setRefreshError(true); }
    },
  );
  const unresolved = mutation.state.status === 'pending' || (mutation.state.status === 'error' && mutation.state.uncertain);
  const locked = loading || preparing || mutation.state.status !== 'idle';
  const navigationLocked = preparing || unresolved;
  const navigationLockRef = useRef(navigationLocked);
  navigationLockRef.current = navigationLocked;
  const backRef = useRef(onBack);
  backRef.current = onBack;

  useEffect(() => {
    alive.current = true;
    const subscription = Platform.OS === 'web' ? null : BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigationLockRef.current && !prepareLock.current && !operationGuard.hasUnresolved()) backRef.current();
      return true;
    });
    return () => { alive.current = false; generation.current += 1; subscription?.remove(); };
  }, []);

  function clearEvents() { setEvents(null); setSelected(new Set()); setError(null); }
  async function readCalendars() {
    const current = ++generation.current;
    setLoading(true); setError(null); setConnection(null); setCalendars([]); setCalendarId(null); clearEvents();
    try {
      const result = await client.connection();
      if (!alive.current || generation.current !== current) return;
      setConnection(result);
      if (result.status === 'available') {
        const list = await client.calendars();
        if (!alive.current || generation.current !== current) return;
        setCalendars(list);
      }
    } catch (err) { if (alive.current && generation.current === current) setError(message(err)); }
    finally { if (alive.current && generation.current === current) setLoading(false); }
  }
  async function readEvents() {
    if (!calendarId || !validPeriod(from, to)) { setError('시작과 종료에 시간대가 포함된 ISO 시각을 입력해 주세요. 종료는 시작보다 늦어야 합니다.'); return; }
    const current = ++generation.current;
    setLoading(true); clearEvents();
    try {
      const result = await client.events(calendarId, from, to);
      if (alive.current && generation.current === current) setEvents(result);
    } catch (err) { if (alive.current && generation.current === current) setError(message(err)); }
    finally { if (alive.current && generation.current === current) setLoading(false); }
  }
  async function importSelected() {
    if (prepareLock.current || locked || !calendarId || !events || !validPeriod(from, to)) return;
    const refs = selectedEventRefs(events.events, selected);
    if (!refs.length) return;
    prepareLock.current = true; setPreparing(true); setError(null);
    try {
      const result = await schedule.list({ from, to, timezone, includeUnscheduled: false });
      if (alive.current) mutation.submit({ calendarId, from, to, selectedEvents: refs, expectedScheduleRevision: result.scheduleRevision });
    } catch (err) { if (alive.current) setError(message(err)); }
    finally { prepareLock.current = false; if (alive.current) setPreparing(false); }
  }
  function resetImport() {
    mutation.reset();
    clearEvents();
    setRefreshError(false);
  }

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Button label="뒤로" onPress={() => { if (!navigationLockRef.current && !prepareLock.current && !operationGuard.hasUnresolved()) onBack(); }} disabled={navigationLocked} />
    <Text style={styles.title}>캘린더 일정 가져오기</Text>
    <Text style={styles.body}>선택한 기간의 일정을 직접 조회하고, 선택한 항목만 앱 일정에 가져옵니다.</Text>
    <Button label="연결 및 캘린더 조회" onPress={() => { void readCalendars(); }} disabled={locked} />
    {connection && <Text style={styles.body}>{connection.status === 'available' ? `연결됨${connection.accountLabel ? `: ${connection.accountLabel}` : ''}` : '캘린더 연결이 설정되지 않았습니다.'}</Text>}
    {connection?.status === 'available' && calendars.length === 0 && !loading && !error && <Text style={styles.body}>조회된 캘린더가 없습니다.</Text>}
    {calendars.map(calendar => <Pressable key={calendar.id} accessibilityRole="radio" aria-checked={calendarId === calendar.id} accessibilityState={{ checked: calendarId === calendar.id, disabled: locked }} disabled={locked}
      onPress={() => { setCalendarId(calendar.id); clearEvents(); }} style={[styles.choice, calendarId === calendar.id && styles.chosen, locked && styles.disabled]}>
      <Text>{calendar.summary || '(제목 없는 캘린더)'}{calendar.timeZone ? ` · ${calendar.timeZone}` : ''}</Text>
    </Pressable>)}
    {calendarId && <>
      <Text style={styles.label}>조회 시작 (시간대 포함 ISO 8601)</Text>
      <TextInput accessibilityLabel="조회 시작" value={from} editable={!locked} autoCapitalize="none" onChangeText={value => { setFrom(value); clearEvents(); }} style={styles.input} />
      <Text style={styles.label}>조회 종료 (미포함, 시간대 포함 ISO 8601)</Text>
      <TextInput accessibilityLabel="조회 종료" value={to} editable={!locked} autoCapitalize="none" onChangeText={value => { setTo(value); clearEvents(); }} style={styles.input} />
      <Text style={styles.body}>앱 시간대: {timezone}</Text>
      <Button label="이 기간 일정 조회" onPress={() => { void readEvents(); }} disabled={locked} />
    </>}
    {loading && <ActivityIndicator accessibilityLabel="조회 중" />}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {events && <>
      {events.unsupportedCount > 0 && <Text accessibilityRole="alert" style={styles.error}>지원하지 않는 일정 {events.unsupportedCount}개는 목록에 포함되지 않았습니다.</Text>}
      {events.events.length === 0 && <Text style={styles.body}>이 기간에 가져올 수 있는 일정이 없습니다.</Text>}
      {events.events.map(event => <Pressable key={event.id} accessibilityRole="checkbox" aria-checked={selected.has(event.id)} accessibilityState={{ checked: selected.has(event.id), disabled: locked }} disabled={locked}
        onPress={() => setSelected(previous => { const next = new Set(previous); if (next.has(event.id)) next.delete(event.id); else next.add(event.id); return next; })}
        style={[styles.choice, selected.has(event.id) && styles.chosen, locked && styles.disabled]}>
        <Text style={styles.label}>{selected.has(event.id) ? '☑' : '☐'} {event.title || '(제목 없는 일정)'}</Text>
        <Text>{event.startsAt} ~ {event.endsAt} · {event.timezone}</Text>
      </Pressable>)}
      <Button label={`선택한 ${selected.size}개 가져오기`} onPress={() => { void importSelected(); }} disabled={locked || selected.size === 0} />
    </>}
    {preparing && <Text>현재 일정 버전을 확인하고 있습니다.</Text>}
    {mutation.state.status === 'pending' && <Text>가져오기 처리 중입니다.</Text>}
    {mutation.state.status === 'error' && <>
      <Text accessibilityRole="alert" style={styles.error}>{message(mutation.state.error)}</Text>
      {mutation.state.uncertain ? <>
        <Text style={styles.error}>처리 결과를 확인할 수 없습니다. 같은 요청으로 결과를 다시 확인해 주세요. 확인 전에는 이 화면을 나갈 수 없습니다.</Text>
        <Button label="같은 요청 다시 확인" onPress={mutation.retry} />
      </> : <Button label="다시 조회하기" onPress={resetImport} />}
    </>}
    {mutation.state.status === 'success' && <>
      <Text accessibilityRole="alert">선택한 일정을 앱에 가져왔습니다.</Text>
      {refreshError && <Text style={styles.error}>일정 화면을 새로 고치지 못했습니다. 일정을 다시 확인해 주세요.</Text>}
      <Button label="다른 일정 조회" onPress={resetImport} />
    </>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F8FA' },
  content: { padding: 20, gap: 12, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '700', color: '#202A3A' },
  body: { color: '#34435D' },
  label: { fontWeight: '600', color: '#202A3A' },
  input: { borderWidth: 1, borderColor: '#AAB5C5', backgroundColor: '#FFF', borderRadius: 8, padding: 10, color: '#202A3A' },
  button: { backgroundColor: '#344F82', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#FFF', fontWeight: '600' },
  choice: { padding: 12, borderWidth: 1, borderColor: '#C7D0DE', backgroundColor: '#FFF', borderRadius: 8, gap: 4 },
  chosen: { borderColor: '#344F82', backgroundColor: '#EDF3FF' },
  disabled: { opacity: 0.5 },
  error: { color: '#A12626' },
});
