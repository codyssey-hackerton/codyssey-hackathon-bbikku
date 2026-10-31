import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { Icon } from '../ui/Icon';
import { compareTimestamps } from '../schedule/client';
import type { ScheduleClient, ScheduleItem } from '../schedule/client';
import {
  addMonths, civilDate, civilOrdinal, formatCivilDate, monthRange, startOfDay, weekday,
} from '../schedule/dates';
import type { CivilDate } from '../schedule/dates';
import { ScheduleError, ScheduleLoading } from '../schedule/ScheduleStatus';
import { useSchedule } from '../schedule/useSchedule';

export type CalendarScreenProps = {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  client: ScheduleClient;
  timezone: string;
  refreshVersion: number;
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const COMPLETION_LABELS: Record<ScheduleItem['completion'], string> = {
  pending: '대기', completed: '완료', incomplete: '미완료', unknown: '상태 미확인',
};

function formatTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(instant));
}

function formatTimeRange(start: string, end: string, timezone: string): string {
  const startDate = civilDate(new Date(start), timezone);
  const endDate = civilDate(new Date(end), timezone);
  if (startDate.year === endDate.year && startDate.month === endDate.month && startDate.day === endDate.day) {
    const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
    return `${clock.format(new Date(start))} – ${clock.format(new Date(end))}`;
  }
  return `${formatTime(start, timezone)} – ${formatTime(end, timezone)}`;
}

export default function CalendarScreen({ selectedDate, onSelectDate, client, timezone, refreshVersion }: CalendarScreenProps) {
  const selected = useMemo(() => {
    try { return civilDate(selectedDate, timezone); } catch { return null; }
  }, [selectedDate.getTime(), timezone]);
  const selectedKey = selected ? `${timezone}:${selected.year}-${selected.month}-${selected.day}` : '';
  const [monthState, setMonthState] = useState<{ key: string; month: CivilDate } | null>(null);
  const [selectionError, setSelectionError] = useState('');
  const displayed = selected && monthState?.key === selectedKey
    ? monthState.month : selected && { ...selected, day: 1 };
  const year = displayed?.year;
  const month = displayed?.month;
  const range = useMemo(() => {
    if (year === undefined || month === undefined) return null;
    try { return monthRange({ year, month, day: 1 }, timezone); } catch { return null; }
  }, [year, month, timezone]);
  const result = useSchedule(client, range && { ...range, timezone, includeUnscheduled: false }, refreshVersion);

  const itemsByDay = useMemo(() => {
    const days = new Map<number, ScheduleItem[]>();
    if (result.status !== 'success' || year === undefined || month === undefined) return days;
    const first = civilOrdinal({ year, month, day: 1 });
    const nextMonth = civilOrdinal(addMonths({ year, month, day: 1 }, 1));
    for (const item of result.data.items) {
      if (!item.timeSlot) continue;
      const start = civilOrdinal(civilDate(new Date(item.timeSlot.startsAt), timezone));
      const end = civilOrdinal(civilDate(new Date(Date.parse(item.timeSlot.endsAt) - 1), timezone));
      for (let ordinal = Math.max(first, start); ordinal <= Math.min(nextMonth - 1, end); ordinal += 1) {
        const day = ordinal - first + 1;
        days.set(day, [...(days.get(day) ?? []), item]);
      }
    }
    return days;
  }, [result.status, result.status === 'success' ? result.data : null, year, month, timezone]);

  if (!selected || !displayed || !range || year === undefined || month === undefined) {
    return <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>날짜 또는 시간대를 확인할 수 없습니다.</Text></View>;
  }

  const firstWeekday = weekday(displayed);
  const lastDay = civilOrdinal(addMonths(displayed, 1)) - civilOrdinal(displayed);
  const weekCount = Math.ceil((firstWeekday + lastDay) / 7);
  const isSelectedMonth = year === selected.year && month === selected.month;
  const selectedItems = isSelectedMonth
    ? (itemsByDay.get(selected.day) ?? []).slice().sort((a, b) => compareTimestamps(a.timeSlot!.startsAt, b.timeSlot!.startsAt)) : [];

  function moveMonth(offset: number) {
    setSelectionError('');
    setMonthState({ key: selectedKey, month: addMonths(displayed!, offset) });
  }

  function selectDay(day: number) {
    try {
      const next = startOfDay({ year: year!, month: month!, day }, timezone);
      setSelectionError('');
      onSelectDate(next);
    } catch {
      setSelectionError('이 시간대에서 해당 날짜를 선택할 수 없습니다.');
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>캘린더</Text>
        <Text accessibilityLiveRegion="polite" style={styles.selectedDate}>선택한 날짜: {formatCivilDate(selected)}</Text>
      </View>
      <View style={styles.calendarCard}>
        <View style={styles.monthHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => moveMonth(-1)}
            style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed]}>
            <Icon name="chevronLeft" size={20} color={colors.primary} />
          </Pressable>
          <Text accessibilityRole="header" style={styles.monthTitle}>{year}년 {month}월</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => moveMonth(1)}
            style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed]}>
            <Icon name="chevronRight" size={20} color={colors.primary} />
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.calendarScrollContent}>
          <View style={styles.calendar}>
            <View style={styles.week}>
              {WEEKDAYS.map((day) => <Text key={day} accessibilityLabel={`${day}요일`} style={styles.weekday}>{day}</Text>)}
            </View>
            {Array.from({ length: weekCount }, (_, week) => (
              <View key={week} style={styles.week}>
                {WEEKDAYS.map((dayName, index) => {
                  const day = week * 7 + index - firstWeekday + 1;
                  if (day < 1 || day > lastDay) return <View key={dayName} style={styles.emptyCell} />;
                  const isSelected = isSelectedMonth && day === selected.day;
                  const count = itemsByDay.get(day)?.length ?? 0;
                  const countLabel = result.status === 'success' ? `, 일정 ${count}건` : '';
                  return (
                    <Pressable key={dayName} accessibilityRole="button"
                      accessibilityLabel={`${year}년 ${month}월 ${day}일 ${dayName}요일${countLabel}`}
                      accessibilityState={{ selected: isSelected }} onPress={() => selectDay(day)}
                      style={({ pressed }) => [styles.day, isSelected && styles.selectedDay, pressed && styles.pressed]}>
                      <Text style={[styles.dayText, isSelected && styles.selectedDayText]}>{day}</Text>
                      {result.status === 'success' && count > 0 &&
                        <Text style={[styles.count, isSelected && styles.selectedDayText]}>{count}건</Text>}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
      {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
      {result.status === 'loading' && <View style={styles.statusCard}><ScheduleLoading /></View>}
      {result.status === 'error' && <View style={styles.statusCard}><ScheduleError error={result.error} retry={result.retry} /></View>}
      {result.status === 'success' && (
        <View style={styles.summary}>
          {isSelectedMonth ? (
            <>
              <View style={styles.summaryHeading}>
                <View style={styles.summaryHeadingMain}>
                  <Icon name="calendar" size={20} color={colors.primary} />
                  <View style={styles.summaryHeadingText}>
                    <Text accessibilityRole="header" style={styles.summaryTitle}>선택한 날짜의 일정</Text>
                    <Text style={styles.summaryDate}>{formatCivilDate(selected)}</Text>
                  </View>
                </View>
                <Text style={styles.summaryCount}>{selectedItems.length}건</Text>
              </View>
              {selectedItems.length === 0
                ? <View style={styles.emptyCard}><Text style={styles.empty}>{result.data.items.length === 0 ? '이번 달에 배치된 일정이 없습니다.' : '이 날짜에 배치된 일정이 없습니다.'}</Text></View>
                : selectedItems.map((item) => <View key={item.id} style={styles.item}>
                  <View accessible={false} style={[styles.itemAccent, item.completion === 'completed' && styles.completedAccent,
                    item.completion === 'incomplete' && styles.incompleteAccent, item.completion === 'unknown' && styles.unknownAccent]} />
                  <View style={styles.itemContent}>
                    {item.timeSlot && <View style={styles.itemTimeRow}>
                      <Icon name="clock" size={14} color={colors.primary} />
                      <Text style={styles.itemTime}>{formatTimeRange(item.timeSlot.startsAt, item.timeSlot.endsAt, timezone)}</Text>
                    </View>}
                    <Text style={[styles.itemTitle, item.completion === 'completed' && styles.completedTitle]}>{item.title}</Text>
                    <Text style={styles.itemKind}>{item.kind === 'event' ? '일정' : '할 일'}</Text>
                  </View>
                  <View style={[styles.stateBadge, item.completion === 'completed' && styles.completedBadge,
                    item.completion === 'incomplete' && styles.incompleteBadge, item.completion === 'unknown' && styles.unknownBadge]}>
                    {item.completion === 'completed' && <Icon name="check" size={13} color="#14734C" />}
                    <Text style={[styles.stateText, item.completion === 'completed' && styles.completedText,
                      item.completion === 'incomplete' && styles.incompleteText, item.completion === 'unknown' && styles.unknownText]}>{COMPLETION_LABELS[item.completion]}</Text>
                  </View>
                </View>)}
            </>
          ) : result.data.items.length === 0 && <View style={styles.emptyCard}><Text style={styles.empty}>이번 달에 배치된 일정이 없습니다.</Text></View>}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 36 },
  heading: { gap: 6, marginBottom: 20 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  selectedDate: { color: colors.muted, fontSize: 14 },
  calendarCard: { backgroundColor: colors.surface, borderRadius: 24, paddingHorizontal: 8, paddingVertical: 12, borderWidth: 1, borderColor: '#EDF0F7' },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  monthTitle: { color: colors.text, fontSize: 19, fontWeight: '700', textAlign: 'center' },
  navigationButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: '#F5F7FC' },
  pressed: { opacity: 0.65 },
  calendarScrollContent: { flexGrow: 1 },
  calendar: { flex: 1, minWidth: 308 },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, paddingVertical: 10, color: colors.muted, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  emptyCell: { flex: 1, minHeight: 54 },
  day: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  dayText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  count: { color: colors.primary, fontSize: 11, marginTop: 2 },
  selectedDay: { backgroundColor: colors.primary },
  selectedDayText: { color: colors.surface, fontWeight: '700' },
  statusCard: { marginTop: 18, paddingHorizontal: 16, backgroundColor: colors.surface, borderRadius: 20 },
  summary: { marginTop: 24, gap: 10 },
  summaryHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
  summaryHeadingMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryHeadingText: { flex: 1, gap: 4 },
  summaryTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  summaryDate: { color: colors.muted, fontSize: 13 },
  summaryCount: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20 },
  itemAccent: { alignSelf: 'stretch', width: 4, borderRadius: 4, backgroundColor: colors.primary },
  completedAccent: { backgroundColor: '#14734C' },
  incompleteAccent: { backgroundColor: '#9A4B14' },
  unknownAccent: { backgroundColor: colors.muted },
  itemContent: { flex: 1, gap: 5 },
  itemTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  completedTitle: { color: colors.muted, textDecorationLine: 'line-through' },
  itemTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemTime: { flexShrink: 1, color: colors.primary, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  itemKind: { color: colors.muted, fontSize: 12 },
  stateBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 10, backgroundColor: colors.primarySoft },
  stateText: { color: '#3155B8', fontSize: 12, fontWeight: '700' },
  completedBadge: { backgroundColor: '#E7F5ED' },
  completedText: { color: '#14734C' },
  incompleteBadge: { backgroundColor: '#FFF1E5' },
  incompleteText: { color: '#9A4B14' },
  unknownBadge: { backgroundColor: '#F0F2F6' },
  unknownText: { color: colors.muted },
  emptyCard: { padding: 18, backgroundColor: colors.surface, borderRadius: 20 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  error: { color: colors.error, marginTop: 12 },
});
