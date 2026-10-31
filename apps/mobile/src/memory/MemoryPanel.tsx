import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { createMemoryClient } from './client';
import type { MemoryFact, MemoryWriteInput, MemoryWriteResult } from './client';
import { parseMemoryDraft, userMemory } from './form';
import type { MemoryDraft } from './form';
import { useMemory } from './useMemory';

interface MemoryPanelProps {
  api: ApiClient;
  onMemoryChanged: () => void;
  onBack: () => void;
}

const initialDraft: MemoryDraft = { kind: 'preference', key: '', value: '', valueMode: 'text', validUntil: '' };
const setupFields = [
  { key: 'preparationMinutes', label: '준비시간' },
  { key: 'travelMinutes', label: '이동시간' },
  { key: 'bufferMinutes', label: '도착 여유시간' },
] as const;
type SetupKey = typeof setupFields[number]['key'];

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function errorMessage(error: unknown, action: '조회' | '저장'): string {
  switch (errorCode(error)) {
    case 'conflict': return '다른 변경으로 맥락이 달라졌습니다. 최신 목록을 확인한 뒤 다시 저장해 주세요.';
    case 'idempotency_conflict': return '요청 식별자가 다른 내용과 충돌했습니다. 내용을 확인한 뒤 새 요청으로 저장해 주세요.';
    case 'operation_in_progress': return '같은 요청이 아직 처리 중입니다.';
    case 'not_configured': return '메모리 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '메모리 기능이 서버에 아직 구현되지 않았습니다.';
    case 'unauthenticated': return '메모리를 사용하려면 로그인 또는 세션 설정이 필요합니다.';
    case 'permission_denied': return '이 메모리에 접근할 권한이 없습니다.';
    case 'invalid_configuration': return '서버 주소를 확인해 주세요.';
    case 'invalid_response': return '서버의 메모리 응답을 확인할 수 없습니다.';
    case 'invalid_request': return '입력 내용을 확인해 주세요.';
    case 'missing_information': return '서버가 필요로 하는 정보가 부족합니다.';
    case 'network': return '서버에 연결할 수 없습니다.';
    case 'timeout': return '서버 응답 시간이 초과되었습니다.';
    default: return `메모리 ${action}에 실패했습니다.`;
  }
}

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function Choice<T extends string>({ label, options, value, onChange, disabled }: {
  label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; disabled: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            aria-checked={option.value === value}
            accessibilityState={{ checked: option.value === value, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={[styles.choice, option.value === value && styles.chosen, disabled && styles.disabled]}
          >
            <Text style={styles.choiceText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function FactRow({ fact }: { fact: MemoryFact }) {
  const value = typeof fact.value === 'string' ? (fact.value === '' ? '(빈 문자열)' : fact.value) : JSON.stringify(fact.value);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{fact.kind === 'preference' ? '명시 선호' : '일시 상황'} · {fact.key}</Text>
      <Text style={styles.body}>{value}</Text>
      <Text style={styles.hint}>{fact.validUntil === null ? '만료 시각 없음' : `유효 종료: ${fact.validUntil}`}</Text>
    </View>
  );
}

function MemoryPanelContent({ api, onMemoryChanged, onBack, isCurrent }: MemoryPanelProps & { isCurrent: () => boolean }) {
  const client = useMemo(() => createMemoryClient(api), [api]);
  const { load, refresh } = useMemory(client);
  const [draft, setDraft] = useState<MemoryDraft>(initialDraft);
  const submittedDraft = useRef<MemoryDraft | null>(null);
  const [setup, setSetup] = useState<Record<SetupKey, string>>({ preparationMinutes: '', travelMinutes: '', bufferMinutes: '' });
  const submittedSetup = useRef<{ key: SetupKey; value: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [parentRefreshError, setParentRefreshError] = useState(false);
  const mutation = useMutation<MemoryWriteInput, MemoryWriteResult>(
    (operation) => client.save(operation),
    () => {
      if (!isCurrent()) return;
      const submitted = submittedDraft.current;
      setDraft((current) => {
        return submitted && current.kind === submitted.kind && current.key === submitted.key &&
          current.value === submitted.value && current.valueMode === submitted.valueMode &&
          current.validUntil === submitted.validUntil ? initialDraft : current;
      });
      submittedDraft.current = null;
      const setupSubmission = submittedSetup.current;
      if (setupSubmission) {
        setSetup((current) => current[setupSubmission.key] === setupSubmission.value ? { ...current, [setupSubmission.key]: '' } : current);
        submittedSetup.current = null;
      }
      setFormError(null);
      refresh();
      try {
        onMemoryChanged();
        setParentRefreshError(false);
      } catch {
        setParentRefreshError(true);
      }
    },
  );

  const saving = mutation.state.status === 'pending';
  const uncertain = mutation.state.status === 'error' && mutation.state.uncertain;
  const conflict = mutation.state.status === 'error' && errorCode(mutation.state.error) === 'conflict';
  const disabled = load.status !== 'success' || saving || uncertain || conflict;
  const entries = load.status === 'success' ? userMemory(load.data.facts) : { set: [], unset: [] };

  function updateDraft(change: Partial<MemoryDraft>) {
    setDraft((previous) => ({ ...previous, ...change }));
    setFormError(null);
  }

  function save() {
    if (disabled || load.status !== 'success') return;
    const parsed = parseMemoryDraft(draft, load.data.contextRevision, Date.now());
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    submittedDraft.current = { ...draft };
    submittedSetup.current = null;
    if (mutation.state.status === 'success' || mutation.state.status === 'error') mutation.reset();
    mutation.submit(parsed.input);
  }

  function saveSetup(key: SetupKey, label: string) {
    if (disabled || load.status !== 'success') return;
    const raw = setup[key].trim();
    const value = Number(raw);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(value)) {
      setFormError(`${label}은 0 이상의 숫자로 입력해 주세요.`);
      return;
    }
    setFormError(null);
    submittedDraft.current = null;
    submittedSetup.current = { key, value: setup[key] };
    if (mutation.state.status === 'success' || mutation.state.status === 'error') mutation.reset();
    mutation.submit({ expectedContextRevision: load.data.contextRevision, kind: 'preference', key, value, validUntil: null });
  }

  function refreshAfterConflict() {
    mutation.reset();
    refresh();
  }

  function retryParentRefresh() {
    try {
      onMemoryChanged();
      setParentRefreshError(false);
    } catch {
      setParentRefreshError(true);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        data={entries.set}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <FactRow fact={item} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <View style={styles.section}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>내 선호와 상황</Text>
              <Button label="뒤로" onPress={onBack} secondary />
            </View>
            <Text style={styles.body}>직접 입력한 선호와 만료 시각이 있는 일시 상황을 관리합니다.</Text>
            <Text style={styles.hint}>관찰·추정과 사용자 입력이 아닌 정보는 이 목록에 표시하지 않습니다.</Text>

            {load.status === 'loading' && (
              <View style={styles.status} accessibilityLiveRegion="polite"><ActivityIndicator /><Text>메모리를 불러오는 중입니다.</Text></View>
            )}
            {load.status === 'error' && (
              <View style={styles.statusBlock}>
                <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{errorMessage(load.error, '조회')}</Text>
                <Button label="목록 다시 불러오기" onPress={refresh} secondary />
              </View>
            )}
            {load.status === 'success' && (
              <View style={styles.statusBlock}>
                <Text style={styles.hint}>조회 기준: {load.at}</Text>
                <Button label="목록 새로고침" onPress={refresh} disabled={saving} secondary />
              </View>
            )}

            <Text accessibilityRole="header" style={styles.subtitle}>시간 최소 설정</Text>
            <Text style={styles.hint}>알고 있는 시간만 분 단위로 각각 저장하세요. 비워 둔 항목은 변경되지 않으며 나중에 설정할 수 있습니다. 이동시간은 직접 입력한 값입니다.</Text>
            {setupFields.map(({ key, label }) => {
              const saved = entries.set.find((fact) => fact.kind === 'preference' && fact.key === key);
              return (
                <View key={key} style={styles.statusBlock}>
                  <Text style={styles.label}>{label} (분)</Text>
                  {saved && <Text style={styles.hint}>현재 저장값: {typeof saved.value === 'number' ? `${saved.value}분` : JSON.stringify(saved.value)}</Text>}
                  <TextInput accessibilityLabel={`${label} 분`} accessibilityHint="0 이상의 숫자를 입력하세요. 비워 두면 변경되지 않습니다."
                    value={setup[key]} onChangeText={(value) => { setSetup((current) => ({ ...current, [key]: value })); setFormError(null); }}
                    editable={!disabled} keyboardType="decimal-pad" style={[styles.input, disabled && styles.disabled]} placeholder="분 입력" />
                  <Button label={`${label} 저장`} onPress={() => saveSetup(key, label)} disabled={disabled} secondary />
                </View>
              );
            })}
            <Button label="나중에 설정" onPress={onBack} secondary />
            {formError && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{formError}</Text>}
            {saving && <View style={styles.status} accessibilityLiveRegion="polite"><ActivityIndicator /><Text>저장 요청을 처리 중입니다.</Text></View>}
            {mutation.state.status === 'success' && <Text accessibilityLiveRegion="polite" style={styles.success}>서버에 저장했습니다.</Text>}
            {mutation.state.status === 'error' && (
              <View style={styles.statusBlock}>
                <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{conflict && uncertain
                  ? '재시도에서 충돌이 반환됐지만 이전 저장의 처리 여부는 아직 확인되지 않았습니다.'
                  : errorMessage(mutation.state.error, '저장')}</Text>
                <Text style={styles.hint}>같은 요청 재시도는 처음 저장할 때의 입력을 사용합니다.</Text>
                {uncertain && <Text style={styles.error}>저장 여부를 아직 알 수 없습니다. 같은 요청으로 다시 확인할 수 있습니다. 연결을 바꾸면 이 재시도를 이어갈 수 없습니다.</Text>}
                <Button label="같은 요청 다시 시도" onPress={mutation.retry} secondary />
                {conflict && !uncertain && <Button label="최신 목록 확인 후 새 요청" onPress={refreshAfterConflict} secondary />}
              </View>
            )}
            {parentRefreshError && (
              <View style={styles.statusBlock}>
                <Text accessibilityRole="alert" style={styles.error}>상위 화면 갱신 요청에 실패했습니다.</Text>
                <Button label="상위 화면 다시 갱신" onPress={retryParentRefresh} secondary />
              </View>
            )}

            <Text accessibilityRole="header" style={styles.subtitle}>선호 또는 상황 입력</Text>
            <Choice label="종류" value={draft.kind} disabled={disabled} onChange={(kind) => updateDraft({ kind })} options={[
              { value: 'preference', label: '명시 선호' }, { value: 'situation', label: '일시 상황' },
            ]} />
            <View>
              <Text style={styles.label}>항목 이름</Text>
              <TextInput accessibilityLabel="항목 이름" value={draft.key} onChangeText={(key) => updateDraft({ key })}
                editable={!disabled} autoCapitalize="none" style={[styles.input, disabled && styles.disabled]} placeholder="예: 공부 시간대" />
            </View>
            <Choice label="값 입력 방식" value={draft.valueMode} disabled={disabled} onChange={(valueMode) => updateDraft({ valueMode })} options={[
              { value: 'text', label: '일반 텍스트' }, { value: 'json', label: 'JSON' },
            ]} />
            <View>
              <Text style={styles.label}>값</Text>
              <TextInput accessibilityLabel="값" accessibilityHint={draft.valueMode === 'json' ? '유효한 JSON 값을 입력하세요.' : '일반 텍스트로 입력하세요.'}
                value={draft.value} onChangeText={(value) => updateDraft({ value })} editable={!disabled} multiline
                style={[styles.input, styles.valueInput, disabled && styles.disabled]} placeholder={draft.valueMode === 'json' ? '예: ["오전", "오후"]' : '예: 오전이 좋아요'} />
              {draft.valueMode === 'json' && <Text style={styles.hint}>JSON의 null은 미설정으로 표시됩니다.</Text>}
            </View>
            <View>
              <Text style={styles.label}>만료 시각 {draft.kind === 'situation' ? '(필수)' : '(선택)'}</Text>
              <TextInput accessibilityLabel={`만료 시각 ${draft.kind === 'situation' ? '필수' : '선택'}`}
                accessibilityHint="날짜, 시각과 UTC 오프셋을 입력하세요. 예: 2026-11-01T18:00:00+09:00"
                value={draft.validUntil} onChangeText={(validUntil) => updateDraft({ validUntil })} editable={!disabled}
                autoCapitalize="none" autoCorrect={false} style={[styles.input, disabled && styles.disabled]}
                placeholder="2026-11-01T18:00:00+09:00" />
              <Text style={styles.hint}>오프셋을 포함해 입력하세요. 선호는 비워 두면 만료 시각이 없습니다.</Text>
            </View>
            <Button label="저장" onPress={save} disabled={disabled} />
            <Text accessibilityRole="header" style={styles.subtitle}>입력된 선호와 상황</Text>
          </View>
        )}
        ListEmptyComponent={load.status === 'success' ? <Text style={styles.hint}>설정된 선호와 상황이 없습니다.</Text> : undefined}
        ListFooterComponent={load.status === 'success' && entries.unset.length > 0 ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.subtitle}>미설정 항목</Text>
            {entries.unset.map((fact) => <Text key={fact.id} style={styles.hint}>{fact.key} · 값 미설정</Text>)}
          </View>
        ) : undefined}
      />
    </KeyboardAvoidingView>
  );
}

export default function MemoryPanel(props: MemoryPanelProps) {
  const connection = useRef({ api: props.api, revision: 0 });
  if (connection.current.api !== props.api) {
    connection.current = { api: props.api, revision: connection.current.revision + 1 };
  }
  const revision = connection.current.revision;
  return <MemoryPanelContent key={revision} {...props} isCurrent={() => connection.current.revision === revision} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 12, paddingBottom: 36 },
  section: { gap: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1, fontSize: 28, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 8 },
  label: { fontWeight: '600', color: colors.text, marginBottom: 6 },
  body: { color: colors.text, lineHeight: 22 },
  hint: { color: colors.muted, lineHeight: 20 },
  input: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 14, color: colors.text },
  valueInput: { minHeight: 76, textAlignVertical: 'top' },
  choices: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 14 },
  chosen: { backgroundColor: colors.primarySoft, borderColor: '#334155' },
  choiceText: { color: colors.text },
  button: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 14, backgroundColor: colors.primary, borderRadius: 14 },
  buttonText: { color: '#fff', fontWeight: '700' },
  secondaryButton: { backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { color: colors.text },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusBlock: { gap: 8 },
  error: { color: '#a01818', lineHeight: 22 },
  success: { color: '#176342', lineHeight: 22 },
  card: { padding: 18, backgroundColor: colors.surface, borderRadius: 20, gap: 8, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontWeight: '700' },
});
