import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { Member } from '../auth/client';
import { ActionButton } from '../ui/ActionButton';
import { Icon } from '../ui/Icon';
import { ProfileAvatar } from '../ui/ProfileAvatar';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import { PreferenceFields, fromDraft, toDraft } from './PreferenceFields';
import { ProfileStatus, profileLocked } from './ProfileStatus';
import { parseMinutes } from './preferences';
import type { PlanningPreferences } from './preferences';
import type { PlanningProfile } from './usePlanningProfile';

const timeFields = [
  { key: 'preparationMinutes', label: '준비시간' },
  { key: 'travelEstimateMinutes', label: '이동 예상시간' },
  { key: 'bufferMinutes', label: '도착 여유시간' },
] as const;
type TimeDraft = Record<keyof PlanningPreferences['timing'], string>;
function timeDraft(timing: PlanningPreferences['timing']): TimeDraft {
  return { preparationMinutes: timing.preparationMinutes?.toString() ?? '', travelEstimateMinutes: timing.travelEstimateMinutes?.toString() ?? '',
    bufferMinutes: timing.bufferMinutes?.toString() ?? '' };
}
export type ProfilePanelProps = { profile: PlanningProfile; member?: Member | null; onBack: () => void; onOpenGoogle: () => void;
  onOpenReview: () => void; onOpenAccount: () => void; onOpenMemory: () => void };
export function ProfilePanel(props: ProfilePanelProps) { return <ProfileContent key={props.profile.scope} {...props} />; }
function ProfileContent({ profile, member, onBack, onOpenGoogle, onOpenReview, onOpenAccount, onOpenMemory }: ProfilePanelProps) {
  const [edit, setEdit] = useState<'goals' | null>(null);
  const [draft, setDraft] = useState(() => toDraft(profile.load.status === 'success' ? profile.load.value : null));
  const [times, setTimes] = useState(() => timeDraft(draft.timing));
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [preferencesExpanded, setPreferencesExpanded] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef<number | null>(null), submitted = useRef(false);
  const locked = profileLocked(profile);
  const navigationLocked = profile.mutation.state.status === 'pending' || (profile.mutation.state.status === 'error' && profile.mutation.state.uncertain);
  const preferences = profile.load.status === 'success' ? profile.load.value : null;
  const goalLabels = { work: '업무·공부', health: '운동·건강', life: '일상·약속' };
  const periodLabels = { morning: '오전', afternoon: '오후', unknown: '아직 잘 모르겠어요' };
  const preferenceSummary = preferences ? `목표: ${preferences.goals.map(goal => goalLabels[goal]).join(', ') || '미설정'} · 편한 시간대: ${preferences.preferredPeriod === null ? '미설정' : periodLabels[preferences.preferredPeriod]}` : '설정한 내용 확인·수정';
  useEffect(() => { if (submitted.current && profile.mutation.state.status === 'success' && profile.mutation.canRetry) { submitted.current = false; setEdit(null); } }, [profile.mutation.state, profile.mutation.canRetry]);
  function open(section: 'goals') {
    if (locked || profile.load.status !== 'success') return;
    const next = toDraft(profile.load.value);
    setDraft(next); setTimes(timeDraft(next.timing)); setTimeExpanded(false); baseline.current = profile.load.contextRevision; setError(''); setEdit(section);
  }
  function save() {
    const value = fromDraft(draft, profile.load.status === 'success' && profile.load.value ? profile.load.value.onboardingStatus : 'completed');
    const preparationMinutes = parseMinutes(times.preparationMinutes), travelEstimateMinutes = parseMinutes(times.travelEstimateMinutes), bufferMinutes = parseMinutes(times.bufferMinutes);
    if (preparationMinutes === undefined || travelEstimateMinutes === undefined || bufferMinutes === undefined) {
      setTimeExpanded(true); setError('시간은 0부터 1440까지의 정수로 입력하거나 비워 주세요.'); return;
    }
    value.timing = { preparationMinutes, travelEstimateMinutes, bufferMinutes };
    if (baseline.current === null || !profile.save(value, baseline.current)) { setError('설정이 변경되었습니다. 뒤로 가서 최신 설정을 다시 열어 주세요.'); return; }
    setError(''); submitted.current = true;
  }
  function goBack() { if (navigationLocked) return; if (edit) { setEdit(null); setError(''); } else onBack(); }
  function row(label: string, description: string, onPress: () => void, disabled = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.card}>
      <View style={styles.grow}><Text style={styles.cardTitle}>{label}</Text><Text style={styles.hint}>{description}</Text></View><Icon name="chevronRight" size={20} color={colors.primaryPressed} /></Pressable>;
  }
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>{edit ? 'PROFILE · PERSONALIZATION' : 'MY PIKKU · SETTINGS'}</Text>
    <Text accessibilityRole="header" style={styles.title}>{edit ? '목표와 생활 선호' : '내 프로필'}</Text>
    <Text style={styles.hint}>{edit ? '입력한 내용만 저장하며 언제든 수정할 수 있어요.' : '개인화 정보를 확인하고 언제든 수정할 수 있어요.'}</Text>
    <ProfileStatus profile={profile} />
    {edit ? <>
      <PreferenceFields section={edit} draft={draft} setDraft={setDraft} disabled={locked} />
      {edit === 'goals' && <><Text style={styles.section}>편한 시간대</Text><PreferenceFields section="period" draft={draft} setDraft={setDraft} disabled={locked} /></>}
      <Pressable accessibilityRole="button" accessibilityLabel="저장된 시간 기준 수정" accessibilityState={{ expanded: timeExpanded, disabled: locked }} disabled={locked}
        onPress={() => setTimeExpanded(value => !value)} style={styles.card}><View style={styles.grow}>
          <Text style={styles.cardTitle}>저장된 시간 기준 수정</Text><Text style={styles.hint}>선택사항</Text></View><Icon name="chevronRight" size={20} color={colors.primaryPressed} /></Pressable>
      {timeExpanded && <View style={styles.timeFields}>
        <Text style={styles.hint}>비워 두면 미설정이며 0은 0분입니다. 이동 예상시간은 실제 경로 시간이 아닙니다.</Text>
        {timeFields.map(field => <View key={field.key} style={styles.timeField}><Text>{field.label}</Text>
          <TextInput accessibilityLabel={`${field.label} 분`} keyboardType="number-pad" editable={!locked} value={times[field.key]}
            onChangeText={value => { setTimes(previous => ({ ...previous, [field.key]: value })); setError(''); }} placeholder="미설정" style={styles.input} /></View>)}
      </View>}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <ActionButton label="저장" disabled={locked} onPress={save} />
    </> : <>
      <View style={styles.identity}><ProfileAvatar size={46} /><View style={styles.grow}>
        <Text style={styles.cardTitle}>{member?.displayName || '내 프로필'}</Text>{member?.email && <Text style={styles.hint}>{member.email}</Text>}</View></View>
      <Text style={styles.section}>개인화와 일정</Text>
      <View style={styles.preferenceCard}>
        <Pressable accessibilityRole="button" accessibilityLabel="목표·활동 및 선호" accessibilityState={{ expanded: preferencesExpanded }}
          onPress={() => setPreferencesExpanded(value => !value)} style={styles.preferenceSummary}>
          <View style={styles.grow}><Text style={styles.cardTitle} numberOfLines={1}>생활 선호</Text>
            <Text style={styles.hint} numberOfLines={2}>{preferenceSummary}</Text></View>
          <Icon name="chevronRight" size={20} color={colors.primaryPressed} />
        </Pressable>
        {preferencesExpanded && <><Text style={styles.badge}>선호</Text>
          <ActionButton label="생활 선호 수정" disabled={locked} onPress={() => open('goals')} secondary /></>}
      </View>
      {row('Google 연결', '캘린더와 Google 계정', onOpenGoogle, locked)}
      {row('자동 검토', '자동 검토 설정 확인', onOpenReview, locked)}
      {row('내 선호와 상황', '나에게 맞는 일정 선호와 상황 알려주기', onOpenMemory, locked)}
      {row('계정', '계정 및 연결 관리', onOpenAccount, locked)}
    </>}
    <ActionButton label="뒤로" onPress={goBack} disabled={navigationLocked} secondary />
  </ScrollView>;
}
export default ProfilePanel;
const styles = StyleSheet.create({ content: { padding: 24, paddingBottom: 40, gap: 12 }, eyebrow: { color: colors.primaryPressed, fontWeight: '700', fontSize: 12 },
  title: { fontSize: 27, lineHeight: 36, fontWeight: '700' }, hint: { color: colors.muted, fontSize: 13, lineHeight: 20 }, section: { fontWeight: '700', color: colors.muted, marginTop: 12 },
  identity: { backgroundColor: colors.surface, borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 20 },
  card: { backgroundColor: colors.surface, borderRadius: 17, padding: 16, minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10 },
  preferenceCard: { backgroundColor: colors.surface, borderRadius: 17, padding: 12, gap: 8 },
  preferenceSummary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { alignSelf: 'flex-start', color: colors.muted, backgroundColor: colors.primarySoft, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, fontSize: 12 },
  cardTitle: { fontWeight: '700', fontSize: 15 }, grow: { flex: 1 }, error: { color: colors.error },
  timeFields: { gap: 10 }, timeField: { gap: 5 }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, minHeight: 44, paddingHorizontal: 12 } });
