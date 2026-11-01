import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import type { ReviewSchedule } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { operationGuard } from '../api/operationGuard';
import { ActionButton } from '../ui/ActionButton';
import { DateTimeFields } from '../ui/DateTimeFields';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { createReviewClient } from './client';
import type { ReviewInput } from './client';
import { draftFrom, parseReviewDraft, timezoneName } from './form';
import type { ReviewDraft } from './form';
import { DailyReviewNotifications } from './DailyReviewNotifications';

export function ReviewOnboarding({ api, deviceTimezone, scope, onComplete }: { api: ApiClient; deviceTimezone: string; scope?: string; onComplete: () => void }) {
  const client = useMemo(() => createReviewClient(api), [api]);
  const [schedule, setSchedule] = useState<ReviewSchedule | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    client.get().then(value => {
      if (!active) return;
      setSchedule(value);
      setDraft(value.revision === 0 ? { timezone: deviceTimezone, morning: { enabled: true, localTime: '09:00' }, evening: { enabled: true, localTime: '21:00' } } : draftFrom(value));
      setLoading(false);
    }, () => { if (active) { setError('설정을 불러오지 못했습니다. 다시 시도하거나 나중에 설정해 주세요.'); setLoading(false); } });
    return () => { active = false; };
  }, [client, deviceTimezone, attempt]);
  const mutation = useMutation<ReviewInput, ReviewSchedule>(op => client.save(op), value => { setSchedule(value); setDraft(draftFrom(value)); setSaved(true); });
  const pending = mutation.state.status === 'pending';
  const uncertain = mutation.state.status === 'error' && mutation.state.uncertain;
  function save() {
    if (!draft || !schedule || pending || uncertain) return;
    const result = parseReviewDraft(draft, schedule.revision);
    if (!result.ok) { setError(result.message); return; }
    setError(''); mutation.submit(result.input);
  }
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>아침과 저녁을 함께 정리해요</Text>
    <Text style={styles.hint}>시간을 정하면 아침에는 오늘을 살펴보고, 저녁에는 오늘을 회고하며 내일을 준비합니다. 설정은 나중에 바꿀 수 있어요.</Text>
    {loading && <Text>설정을 불러오는 중입니다.</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!loading && !schedule && <ActionButton label="다시 불러오기" secondary onPress={() => setAttempt(value => value + 1)} />}
    {draft && schedule && !saved && <>
      {schedule.revision > 0 && <Text style={styles.hint}>기존에 저장된 설정을 불러왔습니다. 시간대: {timezoneName(draft.timezone)}</Text>}
      {(['morning', 'evening'] as const).map(period => <View key={period} style={styles.section}>
        <View style={styles.row}><Text>{period === 'morning' ? '아침 브리핑' : '저녁 회고'}</Text>
          <Switch accessibilityLabel={period === 'morning' ? '아침 브리핑' : '저녁 회고'} value={draft[period].enabled} disabled={pending || uncertain}
            onValueChange={enabled => setDraft({ ...draft, [period]: { ...draft[period], enabled } })} /></View>
        <DateTimeFields label={period === 'morning' ? '아침 시각' : '저녁 시각'} mode="time" value={draft[period].localTime} disabled={pending || uncertain}
          onChange={localTime => setDraft({ ...draft, [period]: { ...draft[period], localTime } })} />
      </View>)}
      {mutation.state.status === 'error' && <>
        <Text accessibilityRole="alert" style={styles.error}>{uncertain ? '저장 여부가 불확실합니다. 같은 요청으로 다시 확인해 주세요.' : '설정을 저장하지 못했습니다. 다시 불러와 확인해 주세요.'}</Text>
        <ActionButton label="같은 요청 다시 시도" secondary onPress={mutation.retry} />
        {!uncertain && <ActionButton label="최신 설정 불러오기" secondary onPress={() => { mutation.reset(); setSchedule(null); setDraft(null); setAttempt(value => value + 1); }} />}
      </>}
      <ActionButton label={pending ? '저장 중' : '시간 저장'} disabled={pending || uncertain || mutation.state.status === 'error'} onPress={save} />
    </>}
    {saved && schedule && <Text>시간을 저장했습니다.</Text>}
    <DailyReviewNotifications schedule={saved ? schedule ?? undefined : undefined} deviceTimezone={deviceTimezone} scope={scope} />
    <ActionButton label={saved ? '시작하기' : '나중에 설정'} secondary disabled={pending || uncertain} onPress={() => {
      if (operationGuard.hasUnresolved()) setError('처리 중인 기기 알림의 결과를 먼저 확인해 주세요.'); else onComplete();
    }} />
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 12 }, title: { fontSize: 25, fontWeight: '700' }, hint: { color: colors.muted, lineHeight: 21 }, error: { color: colors.error }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } });
