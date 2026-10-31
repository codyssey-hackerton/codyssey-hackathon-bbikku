import { Text } from '../ui/typography';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import type { PlanningProfile } from './usePlanningProfile';

export function ProfileStatus({ profile }: { profile: PlanningProfile }) {
  const state = profile.mutation.state;
  return <>
    {profile.load.status === 'loading' && <Text accessibilityLiveRegion="polite">설정을 불러오는 중입니다.</Text>}
    {profile.load.status === 'error' && <><Text accessibilityRole="alert" style={{ color: colors.error }}>
      {profile.load.error instanceof Error && profile.load.error.message === 'invalid_profile'
        ? '서버에 저장된 설정의 형식을 확인할 수 없습니다. 기존 설정을 덮어쓰지 않습니다.'
        : '설정을 확인할 수 없습니다. 기존 설정은 유지됩니다.'}</Text><ActionButton label="다시 불러오기" onPress={profile.refresh} secondary /></>}
    {state.status === 'pending' && <Text accessibilityLiveRegion="polite">설정을 저장하고 있습니다.</Text>}
    {state.status === 'error' && <><Text accessibilityRole="alert" style={{ color: colors.error }}>{state.uncertain
      ? '저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.' : '저장하지 못했습니다. 최신 설정을 불러와 확인해 주세요.'}</Text>
      {state.uncertain ? <ActionButton label="같은 요청 다시 확인" onPress={profile.mutation.retry} disabled={!profile.mutation.canRetry} />
        : <ActionButton label="최신 설정 불러오기" onPress={profile.refresh} secondary />}</>}
  </>;
}
export function profileLocked(profile: PlanningProfile) {
  return profile.load.status !== 'success' || profile.mutation.state.status === 'pending' || profile.mutation.state.status === 'error';
}
