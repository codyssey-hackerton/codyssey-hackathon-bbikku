import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/http';
import { ApiError } from '../api/http';
import { useMutation } from '../api/useMutation';
import { createScheduleClient, type CheckinResult, type ScheduleItem } from '../schedule/client';
import { addDays, dayRange, weekday, type CivilDate } from '../schedule/dates';
import { MutationStatus } from '../schedule/MutationStatus';
import { useSchedule } from '../schedule/useSchedule';
import { ActionButton } from '../ui/ActionButton';
import { ScheduleCard } from '../ui/ScheduleCard';
import { BottomSheet } from '../ui/BottomSheet';
import { Text } from '../ui/typography';
import { validDate } from './client';
import { isScheduledRoutineInRange, routineOccurrence } from './occurrence';
import { startWrite } from '../add/startWrite';

type Intent = { kind: 'checkin'; id: string; expectedRevision: number; completion: 'completed' | 'incomplete' | 'unknown' }
  | { kind: 'undo'; id: string; expectedRevision: number; field: 'completion' };
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
function parse(value: string): CivilDate | null {
  if (!validDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}
function key(date: CivilDate) { return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`; }

export function RoutineOccurrences({ api, timezone, selectedDate, visible, blocked, onBusyChange, onScheduleChanged, onSelectDate, onRecovery, onDay }: {
  api: ApiClient; timezone: string; selectedDate: string; visible: boolean; blocked: boolean;
  onBusyChange: (busy: boolean) => void; onScheduleChanged: () => void;
  onSelectDate?: (date: string) => void; onRecovery?: (item: ScheduleItem) => void;
  onDay: (date: string) => void;
}) {
  const client = useMemo(() => createScheduleClient(api), [api]);
  const [day, setDay] = useState(selectedDate);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<ScheduleItem | null>(null);
  const [sheet, setSheet] = useState<'detail' | 'status' | 'more'>('status');
  const [guardMessage, setGuardMessage] = useState('');
  const requestClient = useRef(client);
  useEffect(() => { setDay(selectedDate); }, [selectedDate]);
  const civil = parse(day);
  const range = useMemo(() => {
    if (!visible || !civil) return null;
    try { return dayRange(civil, timezone); } catch { return null; }
  }, [day, timezone, visible]);
  const result = useSchedule(client, range && { ...range, timezone, includeUnscheduled: true }, version);
  const action = useMutation<Intent, CheckinResult>(op => {
    if (op.input.kind === 'checkin') {
      const { kind: _kind, ...input } = op.input;
      return requestClient.current.checkin({ ...op, input });
    }
    const { kind: _kind, ...input } = op.input;
    return requestClient.current.undo({ ...op, input });
  }, () => { setSelected(null); setVersion(value => value + 1); onScheduleChanged(); });
  const busy = action.state.status === 'pending' || action.state.status === 'error';
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const locked = blocked || busy;
  const items = range && result.status === 'success' ? result.data.items.filter(item => isScheduledRoutineInRange(item, range)) : [];
  const completed = items.filter(item => item.completion === 'completed').length;
  const first = civil && addDays(civil, -((weekday(civil) + 6) % 7));
  function selectDate(value: string) { if (!locked) { setSelected(null); setDay(value); onSelectDate?.(value); } }
  function open(item: ScheduleItem, mode: 'detail' | 'status' | 'more') {
    if (!locked) { setGuardMessage(''); setSelected(item); setSheet(mode); }
  }
  function submit(intent: Intent) {
    if (locked || !selected || !items.some(item => item.id === selected.id && item.revision === selected.revision)) return;
    startWrite(() => {
      if (action.state.status === 'success') action.reset();
      requestClient.current = client;
      action.submit(intent);
    }, setGuardMessage);
  }
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.heading}>나의 작은 습관들</Text>
    {range && result.status === 'success' && <><Text>{day} · {items.length}개 중 {completed}개 완료</Text>
    <View accessibilityRole="progressbar" accessibilityLabel="선택한 날짜 루틴 완료율" accessibilityValue={{ min: 0, max: 100, now: items.length ? Math.round(completed / items.length * 100) : 0 }} style={styles.progress}>
      <View style={[styles.progressFill, { width: `${items.length ? Math.round(completed / items.length * 100) : 0}%` }]} />
    </View></>}
    <Text style={styles.hint}>선택한 날짜에 진행되는 생성 회차 기준입니다. 자정을 넘는 회차는 양쪽 날짜에 표시될 수 있으며 기록하지 않은 루틴은 자동으로 미완료 처리되지 않습니다.</Text>
    <View style={styles.row}>
      <ActionButton label="이전 주" secondary disabled={locked || !civil} onPress={() => civil && selectDate(key(addDays(civil, -7)))} />
      <ActionButton label="다음 주" secondary disabled={locked || !civil} onPress={() => civil && selectDate(key(addDays(civil, 7)))} />
    </View>
    <View style={styles.row}>{first && Array.from({ length: 7 }, (_, index) => addDays(first, index)).map(date => {
      const dateKey = key(date); const active = dateKey === day;
      return <Pressable key={dateKey} accessibilityRole="button" accessibilityLabel={`${date.month}월 ${date.day}일 ${weekdays[weekday(date)]}요일`}
        accessibilityState={{ selected: active, disabled: locked }} disabled={locked} onPress={() => selectDate(dateKey)} style={[styles.day, active && styles.active]}>
        <Text>{weekdays[weekday(date)]} {date.day}</Text></Pressable>;
    })}</View>
    {!range && <Text accessibilityRole="alert">날짜 또는 시간대를 확인할 수 없습니다.</Text>}
    {range && result.status === 'loading' && <Text>회차를 불러오는 중입니다.</Text>}
    {range && result.status === 'error' && <ActionButton label="회차 다시 조회" secondary onPress={result.retry} />}
    {result.status === 'success' && items.length === 0 && <Text>선택한 날짜에 생성된 루틴 회차가 없습니다.</Text>}
    {items.map(item => <View key={item.id} style={styles.section}>
      <ScheduleCard item={item} timezone={timezone} disabled={locked} onPress={() => open(item, 'detail')} onStatus={() => open(item, 'status')} onMore={() => open(item, 'more')} />
      {routineOccurrence(item)?.date !== day && <Text style={styles.hint}>원래 {routineOccurrence(item)?.date} 회차</Text>}
    </View>)}
    <BottomSheet visible={selected !== null} title={selected?.title ?? ''} onClose={() => { if (!locked) setSelected(null); }}>
      {selected && <View style={styles.card}>
      {sheet === 'detail' && <Text>현재 선택한 날짜: {day} · 원래 {routineOccurrence(selected)?.date} 회차</Text>}
      <Text>반복 규칙은 변경되지 않습니다.</Text>
      {sheet !== 'status' && <ActionButton label="완료 상태 변경" secondary disabled={locked} onPress={() => setSheet('status')} />}
      {sheet !== 'status' && <ActionButton label="일간에서 보기" secondary disabled={locked} onPress={() => { setSelected(null); onDay(day); }} />}
      {sheet === 'status' && <>
      <View style={styles.row}>{(['completed', 'incomplete', 'unknown'] as const).map(completion => <ActionButton key={completion}
        label={completion === 'completed' ? '완료' : completion === 'incomplete' ? '못했어요' : '미확인'} secondary disabled={locked || selected.completion === completion}
        onPress={() => submit({ kind: 'checkin', id: selected.id, expectedRevision: selected.revision, completion })} />)}</View>
      <ActionButton label="직전 기록 되돌리기" secondary disabled={locked} onPress={() => submit({ kind: 'undo', id: selected.id, expectedRevision: selected.revision, field: 'completion' })} />
      </>}
      {selected.completion === 'incomplete' && onRecovery && <ActionButton label="AI로 다시 계획하기" disabled={locked} onPress={() => { setSelected(null); onRecovery(selected); }} />}
      {!!guardMessage && <Text accessibilityRole="alert">{guardMessage}</Text>}
      {action.state.status === 'error' && action.state.error instanceof ApiError && action.state.error.code === 'no_undo' &&
        <Text accessibilityRole="alert">되돌릴 이전 기록이 없습니다. 필요한 상태를 직접 선택해 주세요.</Text>}
      <MutationStatus state={action.state} retry={action.retry} reset={action.reset} refresh={result.retry} canRetry={requestClient.current === client} success="루틴 기록을 저장했습니다." />
      </View>}
    </BottomSheet>
    {!selected && <MutationStatus state={action.state} retry={action.retry} reset={action.reset} refresh={result.retry} canRetry={requestClient.current === client} success="루틴 기록을 저장했습니다." />}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 10, padding: 14, borderRadius: 20, backgroundColor: '#F3F5FC' },
  heading: { color: '#14151A', fontSize: 17, fontWeight: '700' }, hint: { color: '#626B80', lineHeight: 20 },
  progress: { height: 7, backgroundColor: '#DDE4FF', borderRadius: 6 }, progressFill: { height: 7, backgroundColor: '#6986FC', borderRadius: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 }, day: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  active: { backgroundColor: '#DDE4FF', borderRadius: 12 }, card: { gap: 8, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14 } });
