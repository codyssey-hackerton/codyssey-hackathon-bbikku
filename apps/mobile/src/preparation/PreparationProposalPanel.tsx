import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { AgentResult, ScheduleItem } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { mutationErrorMessage } from '../schedule/MutationStatus';
import { createMemoryClient } from '../memory/client';
import type { MemoryFact } from '../memory/client';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createPreparationClient, parseMinutes } from './client';
import RoutePlanner from './RoutePlanner';
import { isTravelFresh, travelRemainingMs, type TravelFreshness } from '../travel/client';
import SubwayPanel from '../subway/SubwayPanel';
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

function Button({ label, onPress, disabled = false, expanded }: { label: string; onPress: () => void; disabled?: boolean; expanded?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const fields = [
  { key: 'preparationMinutes', label: '준비 시간 (분)' },
  { key: 'travelMinutes', label: '이동 시간 (분)' },
  { key: 'bufferMinutes', label: '여유 시간 (분)' },
] as const;
type FieldKey = typeof fields[number]['key'];
type Field = { value: string; source: 'empty' | 'saved' | 'user' | 'route' | 'route-stale'; validUntil: string | null; freshness?: TravelFreshness };
type Form = Record<FieldKey, Field>;

function savedPreferences(facts: MemoryFact[], now: number): Partial<Record<FieldKey, Field>> {
  const selected: Partial<Record<FieldKey, Field>> = {};
  for (const { key } of fields) {
    const matches = facts.filter((fact) => fact.key === key && fact.kind === 'preference' && fact.source.type === 'user');
    if (matches.length !== 1) continue;
    const fact = matches[0];
    if (typeof fact.value !== 'number' || parseMinutes(String(fact.value)) !== fact.value ||
        Date.parse(fact.recordedAt) > now || (fact.validUntil !== null && Date.parse(fact.validUntil) <= now)) continue;
    selected[key] = { value: String(fact.value), source: 'saved', validUntil: fact.validUntil };
  }
  return selected;
}

export default function PreparationProposalPanel({ target, expectedScheduleRevision, timezone, api, visible = true, onClose, onProposalCreated }: PreparationProposalProps) {
  const client = useMemo(() => createPreparationClient(api), [api]);
  const memoryClient = useMemo(() => createMemoryClient(api), [api]);
  const [form, setForm] = useState<Form>(() => ({
    preparationMinutes: { value: '', source: 'empty', validUntil: null },
    travelMinutes: { value: '', source: 'empty', validUntil: null },
    bufferMinutes: { value: '', source: 'empty', validUntil: null },
  }));
  const [memoryStatus, setMemoryStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [memoryAttempt, setMemoryAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [routeTick, setRouteTick] = useState(0);
  const [appActive, setAppActive] = useState(() => AppState?.currentState === 'active');
  const appActiveRef = useRef(appActive);
  const hasSubmitted = useRef(false);
  const routeLocked = useRef(false);
  const [callbackError, setCallbackError] = useState(false);
  const [subwayOpen, setSubwayOpen] = useState(false);
  const mutation = useMutation<PreparationProposalInput, PreparationResult>(op => client.create(op), result => {
    if (result.kind === 'proposal') {
      try { onProposalCreated(result); } catch { setCallbackError(true); }
    }
  });
  const unresolved = mutation.state.status === 'pending' || (mutation.state.status === 'error' && mutation.state.uncertain);
  useEffect(() => {
    const subscription = AppState?.addEventListener('change', (next) => {
      const active = next === 'active'; appActiveRef.current = active; setAppActive(active);
      if (!active) setForm((current) => current.travelMinutes.source === 'route'
        ? { ...current, travelMinutes: { ...current.travelMinutes, source: 'route-stale' } } : current);
    });
    return () => subscription?.remove();
  }, []);
  useEffect(() => {
    let active = true;
    setMemoryStatus('loading');
    memoryClient.list(new Date().toISOString()).then(({ facts }) => {
      if (!active) return;
      setMemoryStatus('success');
      setForm((current) => {
        if (hasSubmitted.current) return current;
        const selected = savedPreferences(facts, Date.now());
        const next = { ...current };
        for (const { key } of fields) if (current[key].source === 'empty' && current[key].value === '' && selected[key]) next[key] = selected[key]!;
        return next;
      });
    }, () => { if (active) setMemoryStatus('error'); });
    return () => { active = false; };
  }, [memoryClient, memoryAttempt]);
  useEffect(() => {
    const expirations = fields.flatMap(({ key }) => form[key].source === 'saved' && form[key].validUntil !== null ? [Date.parse(form[key].validUntil!)] : []);
    const future = expirations.filter((time) => time > Date.now());
    if (!future.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(1, Math.min(...future) - Date.now() + 1), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [form, now]);
  useEffect(() => {
    const field = form.travelMinutes;
    if (field.source !== 'route' || !field.freshness || !isTravelFresh(field.freshness)) return;
    const timer = setTimeout(() => setRouteTick((value) => value + 1), Math.max(1, travelRemainingMs(field.freshness) + 1));
    return () => clearTimeout(timer);
  }, [form.travelMinutes, routeTick]);
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

  const preparationMinutes = parseMinutes(form.preparationMinutes.value);
  const travelMinutes = parseMinutes(form.travelMinutes.value);
  const bufferMinutes = parseMinutes(form.bufferMinutes.value);
  const complete = preparationMinutes !== null && travelMinutes !== null && bufferMinutes !== null;
  const allZero = complete && preparationMinutes === 0 && travelMinutes === 0 && bufferMinutes === 0;
  const expired = (time: number) => fields.some(({ key }) => form[key].source === 'saved' && form[key].validUntil !== null && Date.parse(form[key].validUntil!) <= time);
  const routeExpired = () => form.travelMinutes.source === 'route' && (!form.travelMinutes.freshness || !isTravelFresh(form.travelMinutes.freshness));
  const staleRoute = form.travelMinutes.source === 'route-stale' || routeExpired();
  const locked = mutation.state.status !== 'idle';
  routeLocked.current = locked;
  function generate() {
    if (locked || operationGuard.hasUnresolved() || !complete || allZero || form.travelMinutes.source === 'route-stale') return;
    if (routeExpired() || (form.travelMinutes.source === 'route' && !appActiveRef.current)) { setRouteTick((value) => value + 1); return; }
    if (expired(Date.now())) { setNow(Date.now()); return; }
    hasSubmitted.current = true;
    routeLocked.current = true;
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
    <Text style={styles.body}>저장된 시간 선호가 있으면 입력란에 표시합니다. 이번 일정에 맞는지 확인하고 필요하면 수정해 주세요.</Text>
    {memoryStatus === 'loading' && <Text style={styles.body}>저장된 시간 선호를 확인하고 있습니다.</Text>}
    {memoryStatus === 'error' && <><Text style={styles.body}>저장된 시간 선호를 불러오지 못했습니다. 직접 입력할 수 있습니다.</Text>
      <Button label="저장된 시간 다시 조회" onPress={() => setMemoryAttempt((value) => value + 1)} disabled={locked} /></>}
    <Text style={styles.body}>제안만 생성합니다. 기존 일정은 그대로이며, 변경 사항은 별도로 검토하고 승인해야 반영됩니다.</Text>
    <RoutePlanner api={api} appointmentAt={target.timeSlot?.startsAt ?? null} disabled={locked || !appActive} canChange={() => !routeLocked.current && appActiveRef.current} onInvalidate={() => {
      if (routeLocked.current) return;
      setForm((current) => current.travelMinutes.source === 'route'
        ? { ...current, travelMinutes: { ...current.travelMinutes, source: 'route-stale' } } : current);
    }} onUse={(result) => {
      if (routeLocked.current || !appActiveRef.current || !isTravelFresh(result.freshness)) return;
      setForm((current) => ({ ...current, travelMinutes: { value: String(result.durationMinutes), source: 'route', validUntil: null, freshness: result.freshness } }));
    }} />
    <Button label={subwayOpen ? '지하철 정보 닫기' : '지하철 정보 열기'} disabled={locked || !appActive} expanded={subwayOpen}
      onPress={() => { if (!routeLocked.current && appActiveRef.current) setSubwayOpen((open) => !open); }} />
    {subwayOpen && <SubwayPanel api={api} disabled={locked || !appActive} canChange={() => !routeLocked.current && appActiveRef.current} />}
    {fields.map(({ key, label }) => <View key={key}>
      <Text style={styles.label}>{label}</Text>
      {form[key].source === 'saved' && <Text style={styles.body}>저장된 선호</Text>}
      {form[key].source === 'route' && <Text style={styles.body}>확인한 경로 조회 결과</Text>}
      <TextInput accessibilityLabel={label} value={form[key].value} editable={!locked} keyboardType="decimal-pad"
        onChangeText={(value) => setForm((current) => ({ ...current, [key]: { value, source: 'user', validUntil: null } }))} style={styles.input} />
    </View>)}
    {expired(now) && <Text accessibilityRole="alert" style={styles.error}>저장된 시간 선호가 만료되었습니다. 해당 값을 직접 확인하고 다시 입력해 주세요.</Text>}
    {staleRoute && <Text accessibilityRole="alert" style={styles.error}>경로 조회 결과가 만료되었거나 장소·수단 또는 앱 상태가 바뀌어 이전 이동시간을 사용할 수 없습니다. 새 결과를 확인하거나 직접 입력해 주세요.</Text>}
    {!complete && <Text style={styles.body}>세 항목 모두 0 이상이며 밀리초 단위로 안전하게 표현할 수 있는 숫자로 입력해 주세요.</Text>}
    {allZero && <Text accessibilityRole="alert" style={styles.error}>세 시간이 모두 0이면 생성할 변경이 없습니다. 하나 이상 0보다 크게 입력해 주세요.</Text>}
    <Button label="제안 생성" onPress={generate} disabled={locked || !complete || allZero || expired(now) || staleRoute} />
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
