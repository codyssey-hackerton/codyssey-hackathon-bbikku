import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import type { ScheduleClient } from '../schedule/client';
import { civilDate, dayRange, formatCivilDate } from '../schedule/dates';
import { scheduleErrorMessage, useSchedule } from '../schedule/useSchedule';

function formatTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(instant));
}

export function ChatScheduleSummary({ client, selectedDate, timezone, refreshVersion }: {
  client: ScheduleClient;
  selectedDate: Date;
  timezone: string;
  refreshVersion: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const selection = useMemo(() => {
    try {
      const date = civilDate(selectedDate, timezone);
      return { date, ...dayRange(date, timezone) };
    } catch { return null; }
  }, [selectedDate.getTime(), timezone]);
  const result = useSchedule(client, selection && {
    from: selection.from, to: selection.to, timezone, includeUnscheduled: false,
  }, refreshVersion);

  const items = result.status === 'success' ? [...result.data.items].sort((a, b) => (a.timeSlot ? Date.parse(a.timeSlot.startsAt) : Infinity) - (b.timeSlot ? Date.parse(b.timeSlot.startsAt) : Infinity)) : [];
  const visibleItems = expanded ? items : items.slice(0, 3);
  if (!selection) return <Text accessibilityRole="alert">선택 날짜를 확인할 수 없습니다.</Text>;
  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>하루 한눈에</Text>
      <Text accessibilityRole="header" style={styles.title}>{formatCivilDate(selection.date)} 일정</Text>
      {result.status === 'loading' && <Text style={styles.muted}>일정을 불러오는 중입니다.</Text>}
      {result.status === 'error' && <>
        <Text accessibilityRole="alert" style={styles.error}>{scheduleErrorMessage(result.error)}</Text>
        <Pressable accessibilityRole="button" onPress={result.retry} style={styles.retry}><Text style={styles.retryText}>일정 다시 조회</Text></Pressable>
      </>}
      {result.status === 'success' && <View style={styles.metrics}>
        <Text style={styles.metric}>일정 {items.filter(item => item.kind === 'event').length}</Text>
        <Text style={styles.metric}>할 일 {items.filter(item => item.kind === 'task').length}</Text>
        <Text style={styles.metric}>완료 {items.filter(item => item.completion === 'completed').length}</Text>
      </View>}
      {result.status === 'success' && (items.length === 0
        ? <Text style={styles.muted}>배치된 일정이 없습니다.</Text>
        : visibleItems.map((item) => <View key={item.id} style={styles.item}>
          <View style={styles.accent} />
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            {item.timeSlot && <Text style={styles.itemTime}>{formatTime(item.timeSlot.startsAt, timezone)} – {formatTime(item.timeSlot.endsAt, timezone)}</Text>}
          </View>
        </View>))}
      {items.length > 3 && <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.retry}>
        <Text style={styles.retryText}>{expanded ? '간단히 보기' : `일정 ${items.length}개 모두 보기`}</Text>
      </Pressable>}
    </View>
  );
}

const styles = StyleSheet.create({
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  metric: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  container: { padding: 18, gap: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#EDF0F7', borderRadius: 22 },
  eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  title: { fontWeight: '700', fontSize: 16, color: colors.text, marginBottom: 2 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  item: { flexDirection: 'row', alignItems: 'stretch', gap: 10, marginTop: 3 },
  accent: { width: 3, borderRadius: 3, backgroundColor: colors.primary },
  itemContent: { flex: 1, gap: 3 },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  itemTime: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.error },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: '#EEF3FF', borderRadius: 14 },
  retryText: { color: '#2851C7', fontWeight: '700' },
});
