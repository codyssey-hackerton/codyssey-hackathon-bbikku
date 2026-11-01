import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActionButton } from '../ui/ActionButton';
import { PikkuCharacter } from '../ui/PikkuCharacter';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { PreferenceFields, fromDraft, toDraft } from './PreferenceFields';
import { ProfileStatus, profileLocked } from './ProfileStatus';
import type { PlanningProfile } from './usePlanningProfile';
import type { ApiClient } from '../api/http';
import { ReviewOnboarding } from '../review/ReviewOnboarding';

export type OnboardingPanelProps = { profile: PlanningProfile; onComplete: () => void; onBack?: () => void; reviewApi?: ApiClient; deviceTimezone?: string; scope?: string };
export function OnboardingPanel(props: OnboardingPanelProps) { return <OnboardingContent key={props.profile.scope} {...props} />; }
function OnboardingContent({ profile, onComplete, onBack, reviewApi, deviceTimezone, scope }: OnboardingPanelProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(() => toDraft(profile.load.status === 'success' ? profile.load.value : null));
  const [formError, setFormError] = useState('');
  const initialized = useRef(false);
  const baseline = useRef<number | null>(null);
  const submitted = useRef<'skip' | 'complete' | null>(null);
  useEffect(() => {
    if (profile.load.status === 'loading') initialized.current = false;
    if (!initialized.current && profile.load.status === 'success') {
      setDraft(toDraft(profile.load.value)); baseline.current = profile.load.contextRevision; initialized.current = true;
    }
  }, [profile.load]);
  useEffect(() => {
    if (profile.mutation.state.status !== 'success' || !profile.mutation.canRetry || !submitted.current) return;
    const action = submitted.current; submitted.current = null;
    if (action === 'skip') onComplete(); else setStep(2);
  }, [profile.mutation.state, profile.mutation.canRetry, onComplete]);
  const locked = profileLocked(profile);
  const navigationLocked = profile.mutation.state.status === 'pending' || (profile.mutation.state.status === 'error' && profile.mutation.state.uncertain);
  function save() {
    const value = fromDraft(draft, 'completed');
    setFormError('');
    if (baseline.current !== null && profile.save(value, baseline.current)) submitted.current = 'complete';
    else setFormError('설정을 다시 불러온 뒤 저장해 주세요.');
  }
  function skip() { if (profile.skip()) submitted.current = 'skip'; else setFormError('설정을 다시 불러온 뒤 건너뛰어 주세요.'); }
  const sections = ['goals', 'period'] as const;
  const titles = ['어떤 하루를\n만들고 싶나요?', '편한 시간대가\n있나요?'];
  const hints = ['관심 있는 활동을 선택해 주세요. 선택하지 않아도 돼요.', '생활 패턴은 선택사항이며 자동 추정하지 않아요.'];
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    {step < 2 ? <>
      <Text style={styles.eyebrow}>PERSONALIZE · {step + 1} / 2</Text>
      <Text accessibilityRole="header" style={styles.title}>{titles[step]}</Text><Text style={styles.hint}>{hints[step]}</Text>
      <View style={styles.track}><View style={[styles.progress, { width: `${(step + 1) * 100 / 2}%` }]} /></View>
      <ProfileStatus profile={profile} />
      {profile.load.status === 'success' && <PreferenceFields section={sections[step]} draft={draft} setDraft={setDraft} disabled={locked} />}
      {!!formError && <Text accessibilityRole="alert" style={styles.error}>{formError}</Text>}
      <View style={styles.actions}>
        {step < 1 ? <ActionButton label="다음" disabled={locked} onPress={() => { setFormError(''); setStep(step + 1); }} />
          : <ActionButton label="저장하고 완료" disabled={locked} onPress={save} />}
        <ActionButton label="설정은 모두 나중에" secondary disabled={locked} onPress={skip} />
        <Text style={styles.hint}>지금까지 선택한 내용은 저장하지 않아요. 기존에 저장된 설정은 유지됩니다.</Text>
        {(step > 0 || onBack) && <ActionButton label="이전" secondary disabled={navigationLocked} onPress={() => step > 0 ? setStep(step - 1) : onBack?.()} />}
      </View>
    </> : reviewApi && deviceTimezone ? <ReviewOnboarding api={reviewApi} deviceTimezone={deviceTimezone} scope={scope} onComplete={onComplete} /> : <View style={styles.complete}><PikkuCharacter size={96} /><Text accessibilityRole="header" style={styles.title}>준비가 끝났어요</Text>
      <Text style={styles.hint}>입력한 설정은 프로필에서 언제든 바꿀 수 있어요.</Text><ActionButton label="시작하기" onPress={onComplete} /></View>}
  </ScrollView>;
}
export default OnboardingPanel;
const styles = StyleSheet.create({ content: { flexGrow: 1, padding: 24, paddingBottom: 40, gap: 15 }, eyebrow: { color: colors.primaryPressed, fontSize: 12, fontWeight: '700' },
  title: { fontSize: 26, lineHeight: 36, fontWeight: '700' }, hint: { color: colors.muted, lineHeight: 21 },
  track: { height: 5, backgroundColor: colors.primarySoft, borderRadius: 3, marginVertical: 10 }, progress: { height: 5, backgroundColor: colors.primary, borderRadius: 3 },
  actions: { gap: 10, marginTop: 12 }, error: { color: colors.error }, complete: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20 } });
