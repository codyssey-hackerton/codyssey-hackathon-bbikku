import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { emptyPreferences } from './preferences';
import type { Goal, Period, PlanningPreferences } from './preferences';

export type Draft = { goals: Goal[]; timing: PlanningPreferences['timing']; preferredPeriod: Period };
export function toDraft(value: PlanningPreferences | null): Draft {
  const current = value ?? emptyPreferences();
  return { goals: [...current.goals], timing: { ...current.timing }, preferredPeriod: current.preferredPeriod };
}
export function fromDraft(draft: Draft, status: PlanningPreferences['onboardingStatus']): PlanningPreferences {
  return { version: 1, goals: draft.goals, timing: { ...draft.timing }, preferredPeriod: draft.preferredPeriod, onboardingStatus: status };
}
const goals: { value: Goal; title: string; hint: string }[] = [
  { value: 'work', title: '업무·공부', hint: '집중할 일과 마감 관리' }, { value: 'health', title: '운동·건강', hint: '건강한 루틴 이어가기' },
  { value: 'life', title: '일상·약속', hint: '오늘의 일정과 여유 시간' },
];
const periods: { value: Exclude<Period, null>; title: string }[] = [
  { value: 'morning', title: '오전이 편해요' }, { value: 'afternoon', title: '오후가 편해요' }, { value: 'unknown', title: '아직 잘 모르겠어요' },
];
export function PreferenceFields({ section, draft, setDraft, disabled }: { section: 'goals' | 'period'; draft: Draft; setDraft: (value: Draft) => void; disabled: boolean }) {
  if (section === 'goals') return <View style={styles.list}>{goals.map(goal => {
    const checked = draft.goals.includes(goal.value);
    return <Pressable key={goal.value} accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} disabled={disabled}
      onPress={() => setDraft({ ...draft, goals: checked ? draft.goals.filter(value => value !== goal.value) : [...draft.goals, goal.value] })}
      style={[styles.card, checked && styles.selected]}><Text style={styles.title}>{goal.title}</Text><Text style={styles.hint}>{goal.hint}</Text></Pressable>;
  })}</View>;
  return <View accessibilityRole="radiogroup" accessibilityLabel="편한 시간대" style={styles.list}>{periods.map(period => {
    const checked = draft.preferredPeriod === period.value;
    return <Pressable key={period.value} accessibilityRole="radio" accessibilityState={{ checked, disabled }} disabled={disabled}
      onPress={() => setDraft({ ...draft, preferredPeriod: checked ? null : period.value })} style={[styles.card, checked && styles.selected]}><Text style={styles.title}>{period.title}</Text></Pressable>;
  })}</View>;
}
const styles = StyleSheet.create({ list: { gap: 12 }, card: { backgroundColor: colors.surface, borderRadius: 17, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 5, minHeight: 68, justifyContent: 'center' },
  selected: { borderColor: colors.primaryPressed, backgroundColor: colors.primarySoft }, title: { fontSize: 15, fontWeight: '700' }, hint: { color: colors.muted, fontSize: 13, lineHeight: 19 } });
