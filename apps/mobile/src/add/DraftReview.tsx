import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { FormDraft } from '../chat/client';
import { Text } from '../ui/typography';
import { reviewDraft } from './draft';

const fieldLabels: Record<string, string> = { kind: '종류', title: '제목', startsAt: '시작', endsAt: '종료', timezone: '시간대', durationMinutes: '소요 시간(분)', deadline: '마감', flexibility: '유연성', involvement: '참여 범위', completion: '완료 상태', category: '분류', weekdays: '반복 요일', startDate: '시작 날짜', startTime: '시작 시간', endDate: '종료 날짜', endTime: '종료 시간', localTime: '시작 시간', duration: '소요 시간(분)' };

export function DraftReview({ pending, kind, current, disabled, onApply, onHandled }: {
  pending?: FormDraft; kind: FormDraft['kind']; current: Record<string, string | string[]>;
  disabled: boolean; onApply: (fields: Record<string, string | string[]>) => void; onHandled?: () => void;
}) {
  const [handled, setHandled] = useState<FormDraft[]>([]);
  const reviewed = reviewDraft(pending, kind, current);
  if (!pending || !reviewed || handled.includes(pending)) return null;
  const entries = Object.entries(reviewed);
  function finish(apply: boolean) {
    if (disabled || !pending) return;
    if (apply) onApply(Object.fromEntries(entries));
    setHandled(previous => [...previous, pending]);
    onHandled?.();
  }
  return <View style={styles.box}>
    <Text accessibilityRole="header" style={styles.title}>AI 초안 확인</Text>
    <Text>아직 저장되지 않았어요. 적용을 선택하면 표시된 입력을 바꿉니다.</Text>
    {entries.map(([key, value]) => <Text key={key}>{fieldLabels[key] ?? '항목'}: {String(current[key]) || '(비어 있음)'} → {String(value) || '(비어 있음)'}</Text>)}
    {entries.length === 0 && <Text>적용할 수 있는 입력이 없습니다.</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => finish(false)} style={styles.button}><Text>기존 값 유지</Text></Pressable>
    {entries.length > 0 && <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => finish(true)} style={styles.button}><Text>제안 값 적용</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create({ box: { padding: 14, borderRadius: 14, backgroundColor: '#F3F5FC', gap: 8 }, title: { fontWeight: '700', color: '#14151A' }, button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#E2E8FF' } });
