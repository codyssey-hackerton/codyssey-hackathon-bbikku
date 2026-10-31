import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { AgentResult, ScheduleItem } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { mutationErrorMessage } from '../schedule/MutationStatus';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createPreparationClient, parseMinutes } from './client';
import type { PreparationProposalInput, PreparationResult } from './client';

export interface PreparationProposalProps {
  target: ScheduleItem;
  expectedScheduleRevision: number;
  timezone: string;
  api: ApiClient;
  visible?: boolean;
  onClose: () => void;
  onProposalCreated: (result: AgentResult) => void;
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

export default function PreparationProposalPanel({ target, expectedScheduleRevision, timezone, api, visible = true, onClose, onProposalCreated }: PreparationProposalProps) {
  const client = useMemo(() => createPreparationClient(api), [api]);
  const [preparation, setPreparation] = useState('');
  const [travel, setTravel] = useState('');
  const [buffer, setBuffer] = useState('');
  const [callbackError, setCallbackError] = useState(false);
  const mutation = useMutation<PreparationProposalInput, PreparationResult>(op => client.create(op), result => {
    if (result.kind === 'proposal') {
      try { onProposalCreated(result); } catch { setCallbackError(true); }
    }
  });
  const unresolved = mutation.state.status === 'pending' || (mutation.state.status === 'error' && mutation.state.uncertain);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const unresolvedRef = useRef(unresolved);
  unresolvedRef.current = unresolved;
  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!unresolvedRef.current && !operationGuard.hasUnresolved()) closeRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [visible]);

  const preparationMinutes = parseMinutes(preparation);
  const travelMinutes = parseMinutes(travel);
  const bufferMinutes = parseMinutes(buffer);
  const complete = preparationMinutes !== null && travelMinutes !== null && bufferMinutes !== null;
  const allZero = complete && preparationMinutes === 0 && travelMinutes === 0 && bufferMinutes === 0;
  const locked = mutation.state.status !== 'idle';
  function generate() {
    if (locked || operationGuard.hasUnresolved() || !complete || allZero) return;
    mutation.submit({ targetId: target.id, expectedTargetRevision: target.revision, expectedScheduleRevision,
      timezone, preparationMinutes, travelMinutes, bufferMinutes });
  }
  function close() {
    if (!unresolvedRef.current && !operationGuard.hasUnresolved()) onClose();
  }
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Button label="뒤로" onPress={close} disabled={unresolved} />
    <Text style={styles.title}>준비 시간 제안</Text>
    <Text style={styles.body}>대상 일정: {target.title}</Text>
    <Text style={styles.body}>준비·이동·여유 시간을 각각 입력해 주세요. 필요 없는 항목은 0을 입력할 수 있습니다.</Text>
    <Text style={styles.body}>제안만 생성합니다. 기존 일정은 그대로이며, 변경 사항은 별도로 검토하고 승인해야 반영됩니다.</Text>
    {([
      ['준비 시간 (분)', preparation, setPreparation],
      ['이동 시간 (분)', travel, setTravel],
      ['여유 시간 (분)', buffer, setBuffer],
    ] as const).map(([label, value, setValue]) => <View key={label}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} editable={!locked} keyboardType="decimal-pad"
        onChangeText={setValue} style={styles.input} />
    </View>)}
    {!complete && <Text style={styles.body}>세 항목 모두 0 이상이며 밀리초 단위로 안전하게 표현할 수 있는 숫자로 입력해 주세요.</Text>}
    {allZero && <Text accessibilityRole="alert" style={styles.error}>세 시간이 모두 0이면 생성할 변경이 없습니다. 하나 이상 0보다 크게 입력해 주세요.</Text>}
    <Button label="제안 생성" onPress={generate} disabled={locked || !complete || allZero} />
    {mutation.state.status === 'pending' && <View accessibilityLiveRegion="polite" accessibilityState={{ busy: true }}>
      <ActivityIndicator /><Text>제안을 생성하고 있습니다.</Text>
    </View>}
    {mutation.state.status === 'error' && <View>
      <Text accessibilityRole="alert" style={styles.error}>{mutationErrorMessage(mutation.state.error)}</Text>
      {mutation.state.uncertain ? <>
        <Text style={styles.error}>생성 여부가 불확실합니다. 같은 요청으로 결과를 확인할 때까지 뒤로 갈 수 없습니다.</Text>
        <Button label="같은 요청 다시 확인" onPress={mutation.retry} />
      </> : <Button label="다시 입력" onPress={mutation.reset} />}
    </View>}
    {mutation.state.status === 'success' && <View accessibilityLiveRegion="polite">
      <Text>{mutation.state.result.message}</Text>
      {mutation.state.result.kind === 'proposal' ? <>
        <Text>제안을 열어 내용을 확인하고 별도로 승인해 주세요. 기존 일정은 아직 변경되지 않았습니다.</Text>
        {callbackError && <Text accessibilityRole="alert" style={styles.error}>제안 목록을 열지 못했습니다. 제안 목록에서 직접 확인해 주세요.</Text>}
      </> : <Button label="다시 입력" onPress={mutation.reset} />}
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  body: { color: colors.muted, lineHeight: 21 },
  label: { color: colors.text, marginBottom: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.primarySoft },
  buttonText: { color: colors.text, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  error: { color: '#a01818', lineHeight: 21 },
});
