import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  const selectedItems = isSelectedMonth ? itemsByDay.get(selected.day) ?? [] : [];

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
      <Text accessibilityRole="header" style={styles.title}>캘린더</Text>
      <Text accessibilityLiveRegion="polite" style={styles.selectedDate}>선택한 날짜: {formatCivilDate(selected)}</Text>
      <View style={styles.monthHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => moveMonth(-1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed]}>
          <Text style={styles.navigationText}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.monthTitle}>{year}년 {month}월</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => moveMonth(1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed]}>
          <Text style={styles.navigationText}>›</Text>
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
      {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
      {result.status === 'loading' && <ScheduleLoading />}
      {result.status === 'error' && <ScheduleError error={result.error} retry={result.retry} />}
      {result.status === 'success' && (
        <View style={styles.summary}>
          {result.data.items.length === 0 && <Text style={styles.empty}>이번 달에 배치된 일정이 없습니다.</Text>}
          {isSelectedMonth && result.data.items.length > 0 && (
            <>
              <Text accessibilityRole="header" style={styles.summaryTitle}>선택한 날짜의 일정</Text>
              {selectedItems.length === 0
                ? <Text style={styles.empty}>이 날짜에 배치된 일정이 없습니다.</Text>
                : selectedItems.map((item) => <Text key={item.id} style={styles.item}>• {item.title}</Text>)}
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16, paddingBottom: 32 },
  title: { color: '#172033', fontSize: 24, fontWeight: '700' },
  selectedDate: { color: '#475569', fontSize: 16, marginTop: 8 },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 12 },
  monthTitle: { color: '#172033', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  navigationButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#f1f5f9' },
  navigationText: { color: '#172033', fontSize: 28 },
  pressed: { opacity: 0.65 },
  calendarScrollContent: { flexGrow: 1 },
  calendar: { flex: 1, minWidth: 308 },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, paddingVertical: 10, color: '#475569', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  emptyCell: { flex: 1, minHeight: 52 },
  day: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  dayText: { color: '#172033', fontSize: 16 },
  count: { color: '#1d4ed8', fontSize: 11 },
  selectedDay: { backgroundColor: '#1d4ed8' },
  selectedDayText: { color: '#ffffff', fontWeight: '700' },
  summary: { marginTop: 18, gap: 8 },
  summaryTitle: { color: '#172033', fontSize: 16, fontWeight: '700' },
  item: { color: '#172033', fontSize: 15 },
  empty: { color: '#475569', fontSize: 15 },
  error: { color: '#a01818', marginTop: 12 },
});
