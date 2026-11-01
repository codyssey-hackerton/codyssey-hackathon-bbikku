import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { ScheduleItem } from '@pikku/domain';
import { ActionButton } from '../ui/ActionButton';
import { ScheduleCard } from '../ui/ScheduleCard';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';

const titles = ['아침 산책', '기획 정리', '팀 회의', '점심 약속', '자료 읽기', '집중 작업', '친구와 통화', '저녁 장보기', '운동하기', '하루 정리'];

export default function UpcomingPreview({ timezone, onClose }: { timezone: string; onClose: () => void }) {
  const items = useMemo<ScheduleItem[]>(() => {
    const first = Math.ceil((Date.now() + 3_600_000) / 1_800_000) * 1_800_000;
    return titles.map((title, index) => {
      const start = first + index * 5_400_000;
      return { id: `preview-${index}`, revision: 0, kind: index % 3 === 2 ? 'event' : 'task', title: `예시 · ${title}`,
        timeSlot: { startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(), timezone },
        durationMinutes: 60, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', sourceRefs: [] };
    });
  }, [timezone]);
  const day = useMemo(() => new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'long', day: 'numeric', weekday: 'short' }), [timezone]);
  return <View style={styles.screen}>
    <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>다가오는 일정 미리보기</Text>
      <Text style={styles.hint}>아래는 시연용 예시입니다. 실제 일정이나 완료 기록에 저장되지 않아요.</Text>
      <ActionButton label="예시 닫기" secondary onPress={onClose} />
    </View>
    <ScrollView style={styles.list} contentContainerStyle={styles.content} accessibilityLabel="예시 일정 목록">
      {items.map(item => <View key={item.id} style={styles.row}>
        <Text style={styles.date}>{day.format(new Date(item.timeSlot!.startsAt))}</Text>
        <ScheduleCard item={item} timezone={timezone} disabled />
      </View>)}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, header: { padding: 20, gap: 10 },
  title: { color: colors.text, fontSize: 23, fontWeight: '700' }, hint: { color: colors.muted, lineHeight: 20 },
  list: { flex: 1 }, content: { paddingHorizontal: 20, paddingBottom: 32, gap: 14 },
  row: { gap: 6 }, date: { color: colors.muted, fontSize: 12, fontWeight: '600' },
});
