import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ScheduleClient } from '../schedule/client';
import { civilDate, dayRange, formatCivilDate } from '../schedule/dates';
import { scheduleErrorMessage, useSchedule } from '../schedule/useSchedule';

export function ChatScheduleSummary({ client, selectedDate, timezone, refreshVersion }: {
  client: ScheduleClient;
  selectedDate: Date;
  timezone: string;
  refreshVersion: number;
}) {
  const selection = useMemo(() => {
    try {
      const date = civilDate(selectedDate, timezone);
      return { date, ...dayRange(date, timezone) };
    } catch { return null; }
  }, [selectedDate.getTime(), timezone]);
  const result = useSchedule(client, selection && {
    from: selection.from, to: selection.to, timezone, includeUnscheduled: false,
  }, refreshVersion);

  if (!selection) return <Text accessibilityRole="alert">선택 날짜를 확인할 수 없습니다.</Text>;
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{formatCivilDate(selection.date)} 일정</Text>
      {result.status === 'loading' && <Text>일정을 불러오는 중입니다.</Text>}
      {result.status === 'error' && <>
        <Text accessibilityRole="alert" style={styles.error}>{scheduleErrorMessage(result.error)}</Text>
        <Pressable accessibilityRole="button" onPress={result.retry} style={styles.retry}><Text>일정 다시 조회</Text></Pressable>
      </>}
      {result.status === 'success' && (result.data.items.length === 0
        ? <Text>배치된 일정이 없습니다.</Text>
        : result.data.items.map((item) => <Text key={item.id}>• {item.title}</Text>))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 4, backgroundColor: '#f4f6f8', borderRadius: 8 },
  title: { fontWeight: '700', color: '#172033' },
  error: { color: '#a01818' },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
