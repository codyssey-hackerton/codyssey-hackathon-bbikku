import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { createMemoryClient } from './client';
import type { MemoryFact, MemoryWriteInput, MemoryWriteResult } from './client';
import { editableMemory, memoryDisplay, parseMemoryDraft, userMemory } from './form';
import type { MemoryDraft } from './form';
import { useMemory } from './useMemory';

interface MemoryPanelProps {
  api: ApiClient;
  onMemoryChanged: () => void;
  onBack: () => void;
}

const initialDraft: MemoryDraft = { kind: 'preference', key: '', value: '', expiry: null };

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
  label: string; options: { value: T; label: string }[]; value: T | null; onChange: (value: T) => void; disabled: boolean;
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

function FactRow({ fact, disabled, expanded, onExpand, onEdit }: { fact: MemoryFact; disabled: boolean; expanded: boolean; onExpand: () => void; onEdit: (fact: MemoryFact) => void }) {
  const display = memoryDisplay(fact);
  const title = fact.key === 'planning_preferences' ? '생활 선호' : display.title;
  const preview = fact.key === 'planning_preferences' && display.lines.length > 1
    ? [display.lines[0], display.lines[display.lines.length - 1]] : display.lines.slice(0, 1);
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title} 상세`} accessibilityState={{ expanded }}
        onPress={onExpand} style={styles.cardContent}>
        <Text numberOfLines={1} style={styles.cardTitle}>{title}</Text>
        {expanded ? display.lines.map((line, index) => <Text key={index} style={styles.body}>{line}</Text>)
          : <Text numberOfLines={2} style={styles.body}>{preview.join(' · ')}</Text>}
        <View style={styles.badges}><Text style={styles.badge}>{fact.kind === 'preference' ? '선호' : '일시 상황'}</Text>
          {fact.validUntil !== null && <Text style={styles.badge}>{new Date(fact.validUntil).toLocaleString('ko-KR')}까지</Text>}</View>
        <Text style={styles.hint}>{expanded ? '접기' : '자세히 보기'}</Text>
      </Pressable>
      {expanded && editableMemory(fact) && <Button label={`${display.title} 수정`} onPress={() => onEdit(fact)} disabled={disabled} secondary />}
    </View>
  );
}

function MemoryPanelContent({ api, onMemoryChanged, onBack, isCurrent }: MemoryPanelProps & { isCurrent: () => boolean }) {
  const client = useMemo(() => createMemoryClient(api), [api]);
  const { load, refresh } = useMemory(client);
  const [draft, setDraft] = useState<MemoryDraft>(initialDraft);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryFact | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const submittedDraft = useRef<MemoryDraft | null>(null);
  const submittedEdit = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [parentRefreshError, setParentRefreshError] = useState(false);
  const mutation = useMutation<MemoryWriteInput, MemoryWriteResult>(
    (operation) => client.save(operation),
    () => {
      if (!isCurrent()) return;
      const submitted = submittedDraft.current;
      if (submitted && draft.kind === submitted.kind && draft.key === submitted.key &&
          draft.value === submitted.value && draft.expiry === submitted.expiry && (editing?.id ?? null) === submittedEdit.current) {
        setDraft(initialDraft);
        setEditing(null);
        setFormOpen(false);
      }
      submittedDraft.current = null;
      submittedEdit.current = null;
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
    if (operationGuard.hasUnresolved()) {
      setFormError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.');
      return;
    }
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* validation below */ }
    const parsed = parseMemoryDraft(draft, load.data.contextRevision, Date.now(), timezone, editing?.validUntil ?? null);
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    const existing = load.data.facts.find((fact) => fact.kind === parsed.input.kind && fact.key === parsed.input.key);
    if (editing && (!existing || existing.id !== editing.id || existing.revision !== editing.revision ||
        existing.source.type !== 'user' || !editableMemory(existing))) {
      setFormError('저장된 내용이 변경되었어요. 목록에서 다시 선택해 주세요.');
      return;
    }
    if (!editing && existing) {
      setFormError('이미 저장된 이름이에요. 기존 내용을 보호하기 위해 다른 이름을 입력해 주세요.');
      return;
    }
    submittedDraft.current = { ...draft };
    submittedEdit.current = editing?.id ?? null;
    if (mutation.state.status === 'success' || mutation.state.status === 'error') mutation.reset();
    mutation.submit(parsed.input);
  }

  function editFact(fact: MemoryFact) {
    if (disabled || !editableMemory(fact) || typeof fact.value !== 'string') return;
    if (editing?.id === fact.id) { setFormOpen(true); return; }
    const original = editing ? { kind: editing.kind, key: editing.key, value: editing.value, expiry: editing.kind === 'situation' ? 'keep' : null } : initialDraft;
    if (draft.kind !== original.kind || draft.key !== original.key || draft.value !== original.value || draft.expiry !== original.expiry) {
      setFormError('작성 중인 내용을 저장하거나 입력을 취소한 뒤 다른 항목을 수정해 주세요.');
      setFormOpen(true);
      return;
    }
    setEditing(fact);
    setDraft({ kind: fact.kind as MemoryDraft['kind'], key: fact.key, value: fact.value,
      expiry: fact.kind === 'situation' ? 'keep' : null });
    setFormError(null);
    setFormOpen(true);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(initialDraft);
    setFormError(null);
    setFormOpen(false);
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
        renderItem={({ item }) => <FactRow fact={item} disabled={disabled} expanded={expandedId === item.id}
          onExpand={() => setExpandedId(value => value === item.id ? null : item.id)} onEdit={editFact} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <View style={styles.section}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>내 선호와 상황</Text>
              <Button label="뒤로" onPress={onBack} secondary />
            </View>
            <Text style={styles.body}>저장된 선호와 일시 상황을 확인할 수 있어요.</Text>
            {load.status === 'loading' && (
              <View style={styles.status} accessibilityLiveRegion="polite"><ActivityIndicator /><Text>메모리를 불러오는 중입니다.</Text></View>
            )}
            {load.status === 'error' && (
              <View style={styles.statusBlock}>
                <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{errorMessage(load.error, '조회')}</Text>
                <Button label="목록 다시 불러오기" onPress={refresh} secondary />
              </View>
            )}
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

            <Text accessibilityRole="header" style={styles.subtitle}>저장된 선호와 상황</Text>
          </View>
        )}
        ListEmptyComponent={load.status === 'success' ? <Text style={styles.hint}>저장된 선호와 상황이 없습니다.</Text> : undefined}
        ListFooterComponent={load.status === 'success' ? (
          <View style={styles.section}>
            {entries.unset.length > 0 && <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.subtitle}>미설정 항목</Text>
              {entries.unset.map((fact) => <Text key={fact.id} style={styles.hint}>{memoryDisplay(fact).title} · 값 미설정</Text>)}
            </View>}
            <Button label={formOpen ? '입력 접기' : editing || draft.key || draft.value || draft.kind !== initialDraft.kind ? '입력 계속하기' : '선호 또는 상황 추가'} onPress={() => setFormOpen(!formOpen)} secondary />
            {formOpen && <>
              {editing && <Text style={styles.body}>{editing.key} 수정 중</Text>}
              <Choice label="종류" value={draft.kind} disabled={disabled || !!editing} onChange={(kind) => updateDraft({ kind, expiry: null })} options={[
                { value: 'preference', label: '선호' }, { value: 'situation', label: '일시 상황' },
              ]} />
              <View>
                <Text style={styles.label}>항목 이름</Text>
                <TextInput accessibilityLabel="항목 이름" value={draft.key} onChangeText={(key) => updateDraft({ key })}
                  editable={!disabled && !editing} autoCapitalize="none" style={[styles.input, (disabled || !!editing) && styles.disabled]} placeholder="예: 공부 시간대" />
              </View>
              <View>
                <Text style={styles.label}>내용</Text>
                <TextInput accessibilityLabel="내용" value={draft.value} onChangeText={(value) => updateDraft({ value })} editable={!disabled} multiline
                  style={[styles.input, styles.valueInput, disabled && styles.disabled]} placeholder="예: 오전이 좋아요" />
              </View>
              {draft.kind === 'situation' && <>
                <Choice label="언제까지 유지할까요?" value={draft.expiry} disabled={disabled} onChange={(expiry) => updateDraft({ expiry })} options={[
                  ...(editing?.validUntil ? [{ value: 'keep' as const, label: `기존 기간 유지 (${new Date(editing.validUntil).toLocaleString('ko-KR')}까지)` }] : []),
                  { value: 'today', label: '오늘까지' }, { value: 'week', label: '7일 동안' },
                ]} />
                <Text style={styles.hint}>기기 시간대 기준이에요. 7일은 오늘을 포함하며 마지막 날이 끝나면 만료돼요.</Text>
              </>}
              {formError && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{formError}</Text>}
              <Button label="저장" onPress={save} disabled={disabled} />
              <Button label={editing ? '수정 취소' : '입력 취소'} onPress={cancelEdit} disabled={disabled} secondary />
            </>}
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
  card: { padding: 12, backgroundColor: colors.surface, borderRadius: 14, gap: 6, borderWidth: 1, borderColor: colors.border },
  cardContent: { gap: 4, minHeight: 44 }, badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { color: colors.muted, backgroundColor: colors.primarySoft, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, fontSize: 12 },
  cardTitle: { color: colors.text, fontWeight: '700' },
});
