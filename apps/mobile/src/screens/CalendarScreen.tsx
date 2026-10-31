import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ScheduleClient, ScheduleItem } from '../schedule/client';
import { addDays, addMonths, civilDate, civilOrdinal, formatCivilDate, monthRange, startOfDay, weekday } from '../schedule/dates';
import type { CivilDate } from '../schedule/dates';
import { ScheduleError, ScheduleLoading } from '../schedule/ScheduleStatus';
import { useSchedule } from '../schedule/useSchedule';
import { ActionButton } from '../ui/ActionButton';
import { Text } from '../ui/typography';

export type CalendarScreenProps = { selectedDate: Date; onSelectDate: (date: Date) => void; client: ScheduleClient; timezone: string; refreshVersion: number; onImport?: () => void };
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];

export default function CalendarScreen({ selectedDate, onSelectDate, client, timezone, refreshVersion, onImport }: CalendarScreenProps) {
  const selected = useMemo(() => { try { return civilDate(selectedDate, timezone); } catch { return null; } }, [selectedDate.getTime(), timezone]);
  const key = selected ? `${timezone}:${selected.year}-${selected.month}-${selected.day}` : '';
  const [monthState, setMonthState] = useState<{ key: string; month: CivilDate } | null>(null);
  const [selectionError, setSelectionError] = useState('');
  const displayed = selected && monthState?.key === key ? monthState.month : selected && { ...selected, day: 1 };
  const range = useMemo(() => { try { return displayed ? monthRange(displayed, timezone) : null; } catch { return null; } }, [displayed?.year, displayed?.month, timezone]);
  const result = useSchedule(client, range && { ...range, timezone, includeUnscheduled: false }, refreshVersion);
  const itemsByDay = useMemo(() => {
    const days = new Map<number, ScheduleItem[]>();
    if (result.status !== 'success' || !displayed) return days;
    const first = civilOrdinal(displayed), last = civilOrdinal(addMonths(displayed, 1));
    for (const item of result.data.items) {
      if (!item.timeSlot) continue;
      const start = civilOrdinal(civilDate(new Date(item.timeSlot.startsAt), timezone));
      const end = civilOrdinal(civilDate(new Date(Date.parse(item.timeSlot.endsAt) - 1), timezone));
      for (let date = Math.max(first, start); date <= Math.min(last - 1, end); date++) {
        const day = date - first + 1; days.set(day, [...(days.get(day) ?? []), item]);
      }
    }
    return days;
  }, [result.status, result.status === 'success' ? result.data : null, displayed?.year, displayed?.month, timezone]);
  if (!selected || !displayed || !range) return <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>날짜 또는 시간대를 확인할 수 없습니다.</Text></View>;
  const firstWeekday = weekday(displayed);
  const lastDay = civilOrdinal(addMonths(displayed, 1)) - civilOrdinal(displayed);
  const cellCount = Math.ceil((firstWeekday + lastDay) / 7) * 7;
  const upcoming = result.status === 'success' ? result.data.items.filter(item => item.timeSlot && Date.parse(item.timeSlot.startsAt) >= Date.now())
    .slice().sort((a, b) => Date.parse(a.timeSlot!.startsAt) - Date.parse(b.timeSlot!.startsAt)).slice(0, 3) : [];
  function select(date: CivilDate) {
    try { setSelectionError(''); onSelectDate(startOfDay(date, timezone)); }
    catch { setSelectionError('이 시간대에서 해당 날짜를 선택할 수 없습니다.'); }
  }
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <Text style={styles.date}>{formatCivilDate(selected)}</Text><Text accessibilityRole="header" style={styles.title}>월간 캘린더</Text>
    {onImport && <ActionButton label="Google 일정 가져오기" secondary onPress={onImport} />}
    <View style={styles.monthCard}>
      <View style={styles.monthHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => setMonthState({ key, month: addMonths(displayed, -1) })} style={styles.arrow}><Text>‹</Text></Pressable>
        <Text accessibilityRole="header" style={styles.monthTitle}>{displayed.year}년 {displayed.month}월</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => setMonthState({ key, month: addMonths(displayed, 1) })} style={styles.arrow}><Text>›</Text></Pressable>
      </View>
      <View style={styles.week}>{weekdays.map(day => <Text key={day} style={styles.weekday}>{day}</Text>)}</View>
      {Array.from({ length: cellCount / 7 }, (_, week) => <View key={week} style={styles.week}>
        {weekdays.map((label, index) => {
          const date = addDays(displayed, week * 7 + index - firstWeekday);
          const sameMonth = date.month === displayed.month && date.year === displayed.year;
          const chosen = date.year === selected.year && date.month === selected.month && date.day === selected.day;
          const entries = sameMonth ? itemsByDay.get(date.day) ?? [] : [];
          return <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${formatCivilDate(date)} 일간 일정 보기`}
            accessibilityState={{ selected: chosen }} onPress={() => select(date)} style={({ pressed }) => [styles.day, chosen && styles.chosen, pressed && styles.pressed]}>
            <Text style={[styles.dayText, !sameMonth && styles.outside, chosen && styles.chosenText]}>{date.day}</Text>
            <View style={styles.dots}>{entries.slice(0, 3).map(item => <View key={item.id} style={[styles.dot, { backgroundColor: item.sourceRefs.some(ref => ref.provider === 'routine') ? '#AD67F2' : item.kind === 'event' ? '#FF805A' : '#6986FC' }]} />)}</View>
          </Pressable>;
        })}
      </View>)}
    </View>
    {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
    {result.status === 'loading' && <ScheduleLoading />}{result.status === 'error' && <ScheduleError error={result.error} retry={result.retry} />}
    {result.status === 'success' && <View style={styles.upcoming}><Text accessibilityRole="header" style={styles.heading}>이번 달 다가오는 일정</Text>
      {!upcoming.length && <Text style={styles.muted}>이번 달에 예정된 일정이 없습니다.</Text>}
      {upcoming.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.title} 일간 일정 보기`}
        onPress={() => select(civilDate(new Date(item.timeSlot!.startsAt), timezone))} style={styles.upcomingRow}>
        <Text style={styles.upcomingDate}>{new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' }).format(new Date(item.timeSlot!.startsAt))}</Text>
        <View style={styles.upcomingInfo}><Text numberOfLines={2} style={styles.upcomingTitle}>{item.title}</Text>
          <Text style={styles.muted}>{new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(item.timeSlot!.startsAt))}</Text></View>
      </Pressable>)}
    </View>}
  </ScrollView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' }, content: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 100 },
  date: { color: '#626B80', fontSize: 13 }, title: { fontSize: 24, fontWeight: '700', color: '#14151A', marginTop: 6 },
  monthCard: { marginTop: 24, padding: 14, borderRadius: 20, backgroundColor: '#fff' }, monthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthTitle: { color: '#14151A', fontWeight: '700', fontSize: 17 }, arrow: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#F3F5FC', alignItems: 'center', justifyContent: 'center' },
  week: { flexDirection: 'row', alignItems: 'center' }, weekday: { width: '14.2857%', textAlign: 'center', color: '#626B80', fontSize: 12, marginVertical: 10 },
  day: { width: '14.2857%', minHeight: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 14 }, dayText: { color: '#14151A', fontSize: 14 }, outside: { color: '#AAB2C3' },
  chosen: { backgroundColor: '#5369CA' }, chosenText: { color: '#fff', fontWeight: '700' }, dots: { flexDirection: 'row', height: 8, marginTop: 3, gap: 3 }, dot: { width: 4, height: 4, borderRadius: 2 },
  upcoming: { marginTop: 24, gap: 10 }, heading: { fontSize: 18, fontWeight: '700', color: '#14151A' }, upcomingRow: { minHeight: 64, padding: 12, flexDirection: 'row', gap: 12, borderRadius: 16, backgroundColor: '#fff' },
  upcomingDate: { width: 55, color: '#6986FC', fontWeight: '700' }, upcomingInfo: { flex: 1, gap: 4 }, upcomingTitle: { fontWeight: '700', color: '#14151A' }, muted: { color: '#626B80', fontSize: 13 }, error: { color: '#A01818', marginTop: 12 }, pressed: { opacity: 0.65 },
});
