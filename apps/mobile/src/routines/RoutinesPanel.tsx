import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createRoutineClient, validDate, validPeriod, type MaterializeInput, type MaterializeResult, type Routine, type RoutineInput, type RoutineUpdate } from './client';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'success'; routines: Routine[] };
type Intent = { kind: 'create'; input: RoutineInput } | { kind: 'update'; input: RoutineUpdate } | { kind: 'materialize'; input: MaterializeInput };
type Outcome = { kind: 'routine'; routine: Routine } | { kind: 'materialize'; result: MaterializeResult; fromDate: string };
const weekdays = ['월', '화', '수', '목', '금', '토', '일'];
const empty = (date: string): Omit<RoutineInput, 'timezone' | 'durationMinutes'> & { duration: string } => ({ title: '', weekdays: [], startDate: date, localTime: '09:00', duration: '30' });

export default function RoutinesPanel({ api, timezone, selectedDate, onBack, onDay, onScheduleChanged }: {
  api: ApiClient; timezone: string; selectedDate: string; onBack: () => void; onDay: (date: string) => void; onScheduleChanged: () => void;
}) {
  const client = useMemo(() => createRoutineClient(api), [api]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [form, setForm] = useState(() => empty(selectedDate));
  const [fromDate, setFromDate] = useState(selectedDate);
  const [toDate, setToDate] = useState(selectedDate);
  const [dayError, setDayError] = useState(false);
  const action = useMutation<Intent, Outcome>(async op => {
    if (op.input.kind === 'create') return { kind: 'routine', routine: await client.create({ ...op, input: op.input.input }) };
    if (op.input.kind === 'update') return { kind: 'routine', routine: await client.update({ ...op, input: op.input.input }) };
    return { kind: 'materialize', result: await client.materialize({ ...op, input: op.input.input }), fromDate: op.input.input.fromDate };
  }, result => {
    setAttempt(value => value + 1);
    if (result.kind === 'materialize') onScheduleChanged();
    else { setEditing(null); setForm(empty(selectedDate)); }
  });
  useEffect(() => {
    let active = true; setLoad({ status: 'loading' });
    client.list().then(routines => { if (active) setLoad({ status: 'success', routines }); }, () => { if (active) setLoad({ status: 'error' }); });
    return () => { active = false; };
  }, [client, attempt]);
  const blocked = action.state.status === 'pending' || action.state.status === 'error';
  const duration = Number(form.duration);
  const valid = !!form.title.trim() && form.weekdays.length > 0 && validDate(form.startDate) && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.localTime) &&
    /^\d+$/.test(form.duration) && Number.isInteger(duration) && duration >= 1 && duration <= 1440;
  function beginEdit(item: Routine) {
    if (blocked) return;
    if (action.state.status === 'success') action.reset();
    setEditing(item); setForm({ title: item.title, weekdays: item.weekdays, startDate: item.startDate, localTime: item.localTime, duration: String(item.durationMinutes) });
  }
  function submitForm() {
    if (!valid || blocked) return;
    if (action.state.status === 'success') { action.reset(); }
    const input: RoutineInput = { title: form.title.trim(), weekdays: [...form.weekdays].sort((a, b) => a - b), timezone: editing?.timezone ?? timezone,
      startDate: form.startDate, localTime: form.localTime, durationMinutes: duration };
    action.submit(editing ? { kind: 'update', input: { id: editing.id, expectedRevision: editing.revision, changes: input } } : { kind: 'create', input });
  }
  function materialize() {
    if (blocked || !validPeriod(fromDate, toDate)) return;
    if (action.state.status === 'success') action.reset();
    action.submit({ kind: 'materialize', input: { fromDate, toDate } });
  }
  return <ScrollView contentContainerStyle={styles.container}>
    <ActionButton label="뒤로" onPress={onBack} secondary />
    <Text accessibilityRole="header" style={styles.title}>루틴</Text>
    <Text style={styles.text}>요일과 시간을 정하고 날짜를 선택해 할 일 회차를 만듭니다. 수정하거나 비활성화해도 이미 생성한 회차는 미래 일정까지 그대로 유지됩니다.</Text>
    {load.status === 'loading' && <><ActivityIndicator /><Text>루틴을 불러오는 중입니다.</Text></>}
    {load.status === 'error' && <><Text accessibilityRole="alert">루틴을 불러오지 못했습니다.</Text><ActionButton label="루틴 다시 조회" onPress={() => setAttempt(value => value + 1)} secondary /></>}
    {load.status === 'success' && load.routines.length === 0 && <Text>등록된 루틴이 없습니다.</Text>}
    {load.status === 'success' && load.routines.map(item => <View key={item.id} style={styles.card}>
      <Text style={styles.text}>{item.title} · {item.active ? '활성' : '비활성'}</Text>
      <Text style={styles.text}>{item.weekdays.map(day => weekdays[day - 1]).join('·')} {item.localTime} · {item.durationMinutes}분 · {item.timezone}</Text>
      <ActionButton label={`${item.title} 편집`} disabled={blocked} onPress={() => beginEdit(item)} secondary />
      {item.active && <ActionButton label={`${item.title} 비활성화`} disabled={blocked} onPress={() => {
        if (action.state.status === 'success') action.reset();
        action.submit({ kind: 'update', input: { id: item.id, expectedRevision: item.revision, changes: { active: false } } });
      }} secondary />}
    </View>)}
    <Text accessibilityRole="header" style={styles.section}>{editing ? '루틴 편집' : '루틴 등록'}</Text>
    <TextInput accessibilityLabel="루틴 이름" placeholder="루틴 이름" maxLength={2000} value={form.title} onChangeText={title => setForm(value => ({ ...value, title }))} editable={!blocked} style={styles.input} />
    <Text>요일</Text><View style={styles.row}>{weekdays.map((day, index) => <Pressable key={day} accessibilityRole="checkbox" accessibilityLabel={`${day}요일`} accessibilityState={{ checked: form.weekdays.includes(index + 1), disabled: blocked }} disabled={blocked} onPress={() => setForm(value => ({ ...value, weekdays: value.weekdays.includes(index + 1) ? value.weekdays.filter(d => d !== index + 1) : [...value.weekdays, index + 1] }))} style={styles.day}><Text>{form.weekdays.includes(index + 1) ? '☑' : '☐'}{day}</Text></Pressable>)}</View>
    <Text>시작일 (YYYY-MM-DD)</Text><TextInput accessibilityLabel="루틴 시작일" value={form.startDate} onChangeText={startDate => setForm(value => ({ ...value, startDate }))} editable={!blocked} style={styles.input} />
    <Text>시작 시각 (HH:mm)</Text><TextInput accessibilityLabel="루틴 시작 시각" value={form.localTime} onChangeText={localTime => setForm(value => ({ ...value, localTime }))} editable={!blocked} style={styles.input} />
    <Text>소요 시간 (분)</Text><TextInput accessibilityLabel="루틴 소요 시간" value={form.duration} onChangeText={duration => setForm(value => ({ ...value, duration }))} keyboardType="number-pad" editable={!blocked} style={styles.input} />
    <Text style={styles.text}>시간대: {editing?.timezone ?? timezone} · 소요 시간은 1~1440분</Text>
    <ActionButton label={editing ? '루틴 변경 저장' : '루틴 등록'} disabled={blocked || !valid} onPress={submitForm} />
    {editing && <ActionButton label="편집 취소" disabled={blocked} onPress={() => { setEditing(null); setForm(empty(selectedDate)); }} secondary />}
    <Text accessibilityRole="header" style={styles.section}>회차 생성</Text>
    <Text style={styles.text}>양 끝 날짜를 포함해 최대 31일을 생성합니다. 생성된 할 일은 하루 일정에서 확인하고 체크인할 수 있습니다.</Text>
    <TextInput accessibilityLabel="회차 시작일" value={fromDate} onChangeText={setFromDate} editable={!blocked} style={styles.input} />
    <TextInput accessibilityLabel="회차 종료일" value={toDate} onChangeText={setToDate} editable={!blocked} style={styles.input} />
    <ActionButton label="회차 생성" disabled={blocked || !validPeriod(fromDate, toDate)} onPress={materialize} />
    {action.state.status === 'pending' && <Text accessibilityLiveRegion="polite">처리 중입니다.</Text>}
    {action.state.status === 'error' && <><Text accessibilityRole="alert">{action.state.uncertain ? '결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.' : action.state.error instanceof ApiError && action.state.error.code === 'conflict' ? '루틴이 변경되어 다시 조회해야 합니다.' : '요청을 처리하지 못했습니다.'}</Text>
      <ActionButton label="같은 루틴 요청 재시도" onPress={action.retry} secondary />
      {!action.state.uncertain && <ActionButton label="오류 닫고 다시 조회" onPress={() => { action.reset(); setAttempt(value => value + 1); }} secondary />}</>}
    {action.state.status === 'success' && action.state.result.kind === 'materialize' && <View style={styles.card}>
      <Text>생성 {action.state.result.result.createdCount}건 · 기존 {action.state.result.result.existingCount}건</Text>
      {action.state.result.result.conflicts.map((item, i) => <Text key={`${item.routineId}:${item.date}:${i}`}>{item.date}: {item.code === 'schedule_conflict' ? '일정 충돌' : '해당 지역 시각을 확정할 수 없음'}</Text>)}
      <ActionButton label="하루 일정 보기" onPress={() => { if (action.state.status === 'success' && action.state.result.kind === 'materialize') { try { setDayError(false); onDay(action.state.result.fromDate); } catch { setDayError(true); } } }} secondary />
      {dayError && <Text accessibilityRole="alert">이 시간대에서 선택한 날짜를 열 수 없습니다.</Text>}
    </View>}
    {action.state.status === 'success' && action.state.result.kind === 'routine' && <Text accessibilityLiveRegion="polite">루틴을 저장했습니다.</Text>}
  </ScrollView>;
}
const styles = StyleSheet.create({ container: { padding: 20, gap: 12, paddingBottom: 32 }, title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  section: { color: colors.text, fontSize: 18, fontWeight: '700' }, text: { color: colors.text, lineHeight: 21 }, card: { padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 }, day: { minHeight: 44, minWidth: 40, justifyContent: 'center' } });
