import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Text } from '../ui/typography';
import { DateTimeFields } from '../ui/DateTimeFields';
import { DailyReviewNotifications } from './DailyReviewNotifications';
import { colors } from '../ui/theme';
import type { ReviewSchedule } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { createReviewClient } from './client';
import type { CapabilityStatus, ReviewCapabilities, ReviewInput } from './client';
import { draftFrom, parseReviewDraft, timezoneName } from './form';
import type { ReviewDraft } from './form';

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'success'; data: ReviewSchedule };
type Capabilities = { status: 'loading' } | { status: 'error' } | { status: 'success'; data: ReviewCapabilities };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'conflict': return '다른 곳에서 설정이 바뀌었습니다. 최신 설정을 불러온 뒤 다시 확인해 주세요.';
    case 'operation_in_progress': return '같은 요청이 아직 처리 중입니다.';
    case 'unauthenticated': return '개발 연결 설정에서 세션을 확인해 주세요.';
    case 'not_configured': return '자동 검토 설정 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '자동 검토 설정 기능이 서버에 아직 구현되지 않았습니다.';
    case 'invalid_request': return '입력한 시간대와 시각을 확인해 주세요.';
    case 'invalid_response': return '서버의 응답을 확인할 수 없습니다.';
    case 'network': return '서버에 연결할 수 없습니다.';
    case 'timeout': return '서버 응답 시간이 초과되었습니다.';
    default: return '자동 검토 설정을 처리하지 못했습니다.';
  }
}

function statusText(status: CapabilityStatus): string {
  switch (status) {
    case 'available': return '사용 가능 경로 확인됨';
    case 'degraded': return '상태 저하';
    case 'not_configured': return '설정되지 않음';
  }
}

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

function TimeSetting({ label, value, disabled, onChange }: {
  label: string; value: ReviewDraft['evening']; disabled: boolean; onChange: (value: ReviewDraft['evening']) => void;
}) {
  return <View style={styles.section}>
    <View style={styles.row}>
      <Text style={styles.label}>{label} 자동 검토</Text>
      <Switch accessibilityLabel={`${label} 자동 검토`} value={value.enabled} disabled={disabled}
        onValueChange={(enabled) => onChange({ ...value, enabled })} />
    </View>
    <DateTimeFields label={`${label} 시각`} mode="time" value={value.localTime} disabled={disabled}
      onChange={(localTime) => onChange({ ...value, localTime })} />
  </View>;
}

export default function ReviewPanel({ api, deviceTimezone, scope, onBack }: { api: ApiClient; deviceTimezone: string; scope?: string; onBack: () => void }) {
  const client = useMemo(() => createReviewClient(api), [api]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [capabilities, setCapabilities] = useState<Capabilities>({ status: 'loading' });
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notificationBlocked, setNotificationBlocked] = useState(false);
  const active = useRef(false);
  const loadSequence = useRef(0);
  const capabilitySequence = useRef(0);

  const refreshSettings = useCallback(() => {
    const sequence = ++loadSequence.current;
    setLoad({ status: 'loading' });
    client.get().then((data) => {
      if (active.current && loadSequence.current === sequence) {
        setLoad({ status: 'success', data }); setDraft(draftFrom(data)); setFormError(null);
      }
    }, (error: unknown) => {
      if (active.current && loadSequence.current === sequence) setLoad({ status: 'error', error });
    });
  }, [client]);
  const refreshCapabilities = useCallback(() => {
    const sequence = ++capabilitySequence.current;
    setCapabilities({ status: 'loading' });
    client.capabilities().then((data) => {
      if (active.current && capabilitySequence.current === sequence) setCapabilities({ status: 'success', data });
    }, () => {
      if (active.current && capabilitySequence.current === sequence) setCapabilities({ status: 'error' });
    });
  }, [client]);
  useEffect(() => {
    active.current = true; refreshSettings(); refreshCapabilities();
    return () => { active.current = false; loadSequence.current += 1; capabilitySequence.current += 1; };
  }, [refreshSettings, refreshCapabilities]);

  const mutation = useMutation<ReviewInput, ReviewSchedule>((operation) => client.save(operation), (saved) => {
    setLoad({ status: 'success', data: saved }); setDraft(draftFrom(saved)); setFormError(null); refreshCapabilities();
  });
  const saving = mutation.state.status === 'pending';
  const uncertain = mutation.state.status === 'error' && mutation.state.uncertain;
  const conflict = mutation.state.status === 'error' && errorCode(mutation.state.error) === 'conflict';
  const locked = load.status !== 'success' || saving || uncertain || conflict;

  function update(change: Partial<ReviewDraft>) {
    if (locked) return;
    setDraft((previous) => previous ? { ...previous, ...change } : previous);
    setFormError(null);
    if (mutation.state.status === 'success' || mutation.state.status === 'error') mutation.reset();
  }
  function save() {
    if (locked || !draft || load.status !== 'success') return;
    const parsed = parseReviewDraft(draft, load.data.revision);
    if (!parsed.ok) { setFormError(parsed.message); return; }
    setFormError(null);
    if (mutation.state.status !== 'idle') mutation.reset();
    mutation.submit(parsed.input);
  }
  function reload() {
    if (saving || uncertain) return;
    mutation.reset(); refreshSettings();
  }

  return <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={styles.title}>자동 검토 설정</Text>
        <Button label="뒤로" onPress={onBack} disabled={notificationBlocked} secondary />
      </View>
      <Text style={styles.body}>저녁에는 다음 날을, 아침에는 오늘을 검토합니다. 자동 검토는 제안만 만들며 일정 변경이나 연락을 승인하지 않습니다.</Text>
      <Text style={styles.hint}>설정 저장과 스케줄러 실행 및 모델 사용 가능 여부는 별개입니다. 사용 가능 상태도 개별 실행의 성공을 보장하지 않습니다.</Text>
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.subtitle}>현재 서버 상태</Text>
        {capabilities.status === 'loading' && <Text>서버 상태를 확인하는 중입니다.</Text>}
        {capabilities.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>서버 실행 상태를 확인할 수 없습니다.</Text>}
        {capabilities.status === 'success' && <>
          <Text>스케줄러: {statusText(capabilities.data.scheduler)}</Text>
          <Text>모델: {statusText(capabilities.data.model)}</Text>
          <Text>{capabilities.data.storage.durable ? '저장소: 지속 저장' : '저장소: 임시 저장 (서버 재시작 후 보존되지 않을 수 있음)'}</Text>
        </>}
        <Button label="서버 상태 새로고침" onPress={refreshCapabilities} secondary />
      </View>
      {load.status === 'loading' && <View style={styles.row} accessibilityLiveRegion="polite"><ActivityIndicator /><Text>설정을 불러오는 중입니다.</Text></View>}
      {load.status === 'error' && <View style={styles.section}>
        <Text accessibilityRole="alert" style={styles.error}>{errorMessage(load.error)}</Text>
        <Button label="설정 다시 불러오기" onPress={reload} secondary />
      </View>}
      {load.status === 'success' && draft && <>
        <View style={styles.section}>
          <Text style={styles.label}>설정된 시간대: {timezoneName(draft.timezone)}</Text>
          {draft.timezone !== deviceTimezone && <Button label="기기 시간대 사용" onPress={() => update({ timezone: deviceTimezone })} disabled={locked} secondary />}
          <Text style={styles.hint}>기기 시간대: {timezoneName(deviceTimezone)}</Text>
        </View>
        <TimeSetting label="저녁" value={draft.evening} disabled={locked} onChange={(evening) => update({ evening })} />
        <TimeSetting label="아침" value={draft.morning} disabled={locked} onChange={(morning) => update({ morning })} />
        {formError && <Text accessibilityRole="alert" style={styles.error}>{formError}</Text>}
        {saving && <View style={styles.row} accessibilityLiveRegion="polite"><ActivityIndicator /><Text>설정을 저장하는 중입니다.</Text></View>}
        {mutation.state.status === 'success' && <Text accessibilityLiveRegion="polite" style={styles.success}>설정을 저장했습니다. 실행 상태는 위에서 확인해 주세요.</Text>}
        {mutation.state.status === 'error' && <View style={styles.section}>
          <Text accessibilityRole="alert" style={styles.error}>{conflict && uncertain
            ? '충돌이 반환됐지만 이전 저장의 처리 여부는 아직 확인되지 않았습니다.' : errorMessage(mutation.state.error)}</Text>
          {uncertain && <Text style={styles.error}>저장 여부가 불확실합니다. 같은 요청의 결과를 확인할 때까지 새 변경은 잠깁니다.</Text>}
          <Text style={styles.hint}>같은 요청 재시도는 처음 보낸 설정과 식별자를 유지합니다.</Text>
          <Button label="같은 요청 다시 시도" onPress={mutation.retry} secondary />
          {conflict && !uncertain && <Button label="최신 설정 불러오기" onPress={reload} secondary />}
        </View>}
        <Button label="자동 검토 설정 저장" onPress={save} disabled={locked} />
        <Button label="저장된 설정 다시 불러오기" onPress={reload} disabled={saving || uncertain} secondary />
      </>}
      <DailyReviewNotifications schedule={load.status === 'success' ? load.data : undefined} deviceTimezone={deviceTimezone} scope={scope} disabled={locked} onBlockingChange={setNotificationBlocked} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 36, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  section: { gap: 8 },
  title: { flexShrink: 1, fontSize: 28, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  label: { color: colors.text, fontWeight: '600' },
  body: { color: colors.text, lineHeight: 22 },
  hint: { color: colors.muted, lineHeight: 20 },
  input: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 14, color: colors.text },
  button: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 14, backgroundColor: colors.primary, borderRadius: 14 },
  buttonText: { color: '#fff', fontWeight: '700' },
  secondary: { backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  error: { color: '#a01818', lineHeight: 22 },
  success: { color: '#166534', lineHeight: 22 },
});
