import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { DateTimeFields } from '../ui/DateTimeFields';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { operationGuard } from '../api/operationGuard';
import { createScheduleClient, type ScheduleClient } from '../schedule/client';
import { addDays, addMonths, civilDate, type CivilDate } from '../schedule/dates';
import { calendarDateRange, createCalendarClient, selectedEventRefs } from './client';
import type { Calendar, CalendarConnection, CalendarEvents, CalendarImportInput, CalendarImportResult } from './client';

export interface CalendarImportPanelProps {
  api: ApiClient;
  timezone: string;
  onBack: () => void;
  onScheduleChanged: () => void;
  onOpenGoogle?: () => void;
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

function eventTime(event: CalendarEvents['events'][number], timezone: string): string {
  try {
    if (!event.allDay) {
      const format = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `${format.format(new Date(event.startsAt))} ~ ${format.format(new Date(event.endsAt))}`;
    }
    const format = new Intl.DateTimeFormat('ko-KR', { timeZone: event.timezone, year: 'numeric', month: 'long', day: 'numeric' });
    const start = format.format(new Date(event.startsAt)); const end = format.format(new Date(Date.parse(event.endsAt) - 1));
    return `종일 · ${start}${start === end ? '' : ` ~ ${end}`}`;
  } catch { return '일정 시각을 표시할 수 없습니다.'; }
}

export default function CalendarImportPanel({ api, timezone, onBack, onScheduleChanged, onOpenGoogle, scheduleClient }: CalendarImportPanelProps) {
  const client = useMemo(() => createCalendarClient(api), [api]);
  const schedule = useMemo(() => scheduleClient ?? createScheduleClient(api), [api, scheduleClient]);
  const initialPeriod = useMemo(() => {
    try {
      const today = civilDate(new Date(), timezone), first = { ...today, day: 1 };
      const date = (value: CivilDate) => `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
      return { first: date(first), last: date(addDays(addMonths(first, 1), -1)) };
    } catch { return { first: '', last: '' }; }
  }, []);
  const [firstDate, setFirstDate] = useState(initialPeriod.first);
  const [lastDate, setLastDate] = useState(initialPeriod.last);
  const range = calendarDateRange(firstDate, lastDate, timezone);
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
  useEffect(() => {
    void readCalendars();
    return () => { generation.current += 1; };
  }, [client]);
  async function readEvents() {
    if (!calendarId || !range) { setError('조회 시작일과 마지막 날을 확인해 주세요. 조회 기간은 최대 366일입니다.'); return; }
    const current = ++generation.current;
    setLoading(true); clearEvents();
    try {
      const result = await client.events(calendarId, range.from, range.to);
      if (alive.current && generation.current === current) setEvents(result);
    } catch (err) { if (alive.current && generation.current === current) setError(message(err)); }
    finally { if (alive.current && generation.current === current) setLoading(false); }
  }
  async function importSelected() {
    if (prepareLock.current || locked || !calendarId || !events || !range) return;
    const refs = selectedEventRefs(events.events, selected);
    if (!refs.length) return;
    prepareLock.current = true; setPreparing(true); setError(null);
    try {
      const result = await schedule.list({ ...range, timezone, includeUnscheduled: false });
      if (alive.current) mutation.submit({ calendarId, ...range, selectedEvents: refs, expectedScheduleRevision: result.scheduleRevision,
        ...(connection?.accountRef ? { expectedAccountRef: connection.accountRef } : {}) });
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
    {loading && <Text accessibilityLiveRegion="polite" style={styles.body}>Google 캘린더를 확인하고 있습니다.</Text>}
    {connection && <Text style={styles.body}>{connection.status === 'available' ? `연결됨${connection.accountLabel ? `: ${connection.accountLabel}` : ''}` : '캘린더 연결이 설정되지 않았습니다.'}</Text>}
    {connection?.status === 'not_configured' && onOpenGoogle && <Button label="Google 연결 열기" onPress={() => {
      if (!navigationLockRef.current && !prepareLock.current && !operationGuard.hasUnresolved()) onOpenGoogle();
    }} disabled={navigationLocked || operationGuard.hasUnresolved()} />}
    {connection?.status === 'available' && calendars.length === 0 && !loading && !error && <Text style={styles.body}>조회된 캘린더가 없습니다.</Text>}
    {calendars.map(calendar => <Pressable key={calendar.id} accessibilityRole="radio" aria-checked={calendarId === calendar.id} accessibilityState={{ checked: calendarId === calendar.id, disabled: locked }} disabled={locked}
      onPress={() => { setCalendarId(calendar.id); clearEvents(); }} style={[styles.choice, calendarId === calendar.id && styles.chosen, locked && styles.disabled]}>
      <Text>{calendar.summary || '(제목 없는 캘린더)'}{calendar.timeZone ? ` · ${calendar.timeZone}` : ''}</Text>
    </Pressable>)}
    {calendarId && <>
      <DateTimeFields label="조회 시작일" mode="date" value={firstDate} disabled={locked} onChange={value => { setFirstDate(value); clearEvents(); }} />
      <DateTimeFields label="조회 마지막 날" mode="date" value={lastDate} disabled={locked} onChange={value => { setLastDate(value); clearEvents(); }} />
      <Button label="이 기간 일정 조회" onPress={() => { void readEvents(); }} disabled={locked} />
    </>}
    {loading && <ActivityIndicator accessibilityLabel="조회 중" />}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {events && <>
      {events.unsupportedCount > 0 && <Text accessibilityRole="alert" style={styles.error}>지원하지 않는 일정 {events.unsupportedCount}개는 목록에 포함되지 않았습니다.</Text>}
      {events.events.length === 0 && <Text style={styles.body}>이 기간에 가져올 수 있는 일정이 없습니다.</Text>}
      <Text style={styles.body}>한 번에 최대 100개를 선택할 수 있습니다.</Text>
      {events.events.map(event => <Pressable key={event.id} accessibilityRole="checkbox" aria-checked={selected.has(event.id)} accessibilityState={{ checked: selected.has(event.id), disabled: locked || (selected.size >= 100 && !selected.has(event.id)) }} disabled={locked || (selected.size >= 100 && !selected.has(event.id))}
        onPress={() => setSelected(previous => { const next = new Set(previous); if (next.has(event.id)) next.delete(event.id); else next.add(event.id); return next; })}
        style={[styles.choice, selected.has(event.id) && styles.chosen, locked && styles.disabled]}>
        <Text style={styles.label}>{selected.has(event.id) ? '☑' : '☐'} {event.title || '(제목 없는 일정)'}</Text>
        <Text>{eventTime(event, timezone)}{event.blocksTime === false ? ' · 시간 비차단' : ''}</Text>
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
  button: { backgroundColor: '#344F82', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#FFF', fontWeight: '600' },
  choice: { padding: 12, borderWidth: 1, borderColor: '#C7D0DE', backgroundColor: '#FFF', borderRadius: 8, gap: 4 },
  chosen: { borderColor: '#344F82', backgroundColor: '#EDF3FF' },
  disabled: { opacity: 0.5 },
  error: { color: '#A12626' },
});
