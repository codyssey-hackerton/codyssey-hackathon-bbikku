import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { operationGuard } from '../api/operationGuard';
import PreparationProposalPanel from '../preparation/PreparationProposalPanel';
import { createProposalClient } from '../proposals/client';
import type { AttendanceInput, CheckinInput, CheckinResult, ScheduleClient, ScheduleCommandInput, ScheduleCommandResult, ScheduleFields, ScheduleItem, UndoInput } from '../schedule/client';
import { addDays, civilDate, dayRange, formatCivilDate, startOfDay, weekday } from '../schedule/dates';
import { MutationStatus } from '../schedule/MutationStatus';
import { ScheduleForm } from '../schedule/ScheduleForm';
import { canCoordinate } from '../schedule/form';
import { ScheduleError, ScheduleLoading } from '../schedule/ScheduleStatus';
import { useSchedule } from '../schedule/useSchedule';
import { BottomSheet } from '../ui/BottomSheet';
import { PastScheduleStack } from '../ui/PastScheduleStack';
import { ScheduleCard } from '../ui/ScheduleCard';
import { ProfileAvatar } from '../ui/ProfileAvatar';
import { scheduleCardModel } from '../ui/scheduleCardModel';
import { Text } from '../ui/typography';
import { axisTime, dailyProgress, scheduleLayout } from './schedule-display';

export type DayScreenProps = {
  selectedDate: Date; onSelectDate: (date: Date) => void; client: ScheduleClient; timezone: string; refreshVersion: number;
  onScheduleChanged: () => void; onCoordinate: (item: ScheduleItem) => void; onRecovery: (item: ScheduleItem) => void;
  api: ApiClient; onOpenPreparationProposals: () => void; visible?: boolean;
  createRequest?: () => void; editRequest?: (item: ScheduleItem) => void; onAsk?: (item: ScheduleItem) => void;
  onCalendar?: () => void; onOpenProposals?: () => void; onOpenSettings?: () => void;
  presentation?: 'home' | 'day';
};
type Editor = { item: ScheduleItem | null; expectedScheduleRevision: number; client: ScheduleClient };
type Sheet = { kind: 'status' | 'more' | 'detail' | 'delete'; item: ScheduleItem } | null;
const completionChoices = [{ value: 'completed', label: '완료' }, { value: 'incomplete', label: '미완료' }, { value: 'unknown', label: '미확인' }] as const;
const attendanceChoices = [{ value: 'attended', label: '참석' }, { value: 'absent', label: '불참' }, { value: 'unknown', label: '미확인' }] as const;

export default function DayScreen(props: DayScreenProps) {
  const { selectedDate, onSelectDate, client, timezone, refreshVersion, onScheduleChanged, onCoordinate, onRecovery,
    api, onOpenPreparationProposals, visible = true, createRequest, editRequest, onAsk, onCalendar, onOpenProposals, onOpenSettings, presentation = 'day' } = props;
  const selected = useMemo(() => { try { return civilDate(selectedDate, timezone); } catch { return null; } }, [selectedDate.getTime(), timezone]);
  const range = useMemo(() => { try { return selected ? dayRange(selected, timezone) : null; } catch { return null; } },
    [selected?.year, selected?.month, selected?.day, timezone]);
  const result = useSchedule(client, range && { ...range, timezone, includeUnscheduled: presentation === 'day' }, refreshVersion);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const update = () => setNow(Date.now()); update();
    const timer = setInterval(update, 30_000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [visible]);
  const [selectionError, setSelectionError] = useState('');
  const [guardMessage, setGuardMessage] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preparation, setPreparation] = useState<{ item: ScheduleItem; revision: number } | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'personal' | 'work'>('all');
  const [proposal, setProposal] = useState<{ api: ApiClient; version: number; text: string } | null>(null);
  useEffect(() => {
    if (presentation !== 'home' || !visible || !onOpenProposals) return;
    let active = true;
    setProposal(null);
    createProposalClient(api).list().then(page => {
      if (!active) return;
      const pending = page.proposals.find(value => value.status === 'pending');
      setProposal({ api, version: refreshVersion, text: pending ? pending.reason || '확인이 필요한 제안이 있어요.' :
        page.nextCursor ? '제안 화면에서 더 많은 제안을 확인해 주세요.' : '아직 확인할 제안이 없어요.' });
    }).catch(() => { if (active) setProposal({ api, version: refreshVersion, text: '제안을 불러오지 못했어요.' }); });
    return () => { active = false; };
  }, [api, refreshVersion, presentation, visible, onOpenProposals]);
  const commandClient = useRef<ScheduleClient | null>(null), checkinClient = useRef<ScheduleClient | null>(null);
  const attendanceClient = useRef<ScheduleClient | null>(null), undoClient = useRef<ScheduleClient | null>(null);
  const command = useMutation<ScheduleCommandInput, ScheduleCommandResult>(op => commandClient.current!.command(op), () => { setEditor(null); setSheet(null); onScheduleChanged(); });
  const checkin = useMutation<CheckinInput, CheckinResult>(op => checkinClient.current!.checkin(op), () => { setSheet(null); onScheduleChanged(); });
  const attendance = useMutation<AttendanceInput, CheckinResult>(op => attendanceClient.current!.attendance(op), () => { setSheet(null); onScheduleChanged(); });
  const undo = useMutation<UndoInput, CheckinResult>(op => undoClient.current!.undo(op), () => { setSheet(null); onScheduleChanged(); });
  const mutations = [command.state, checkin.state, attendance.state, undo.state];
  const blocked = mutations.some(state => state.status === 'pending' || state.status === 'error');
  const actionDisabled = blocked || editor !== null || preparation !== null;
  useEffect(() => { setExpanded(false); setSheet(null); }, [selected?.year, selected?.month, selected?.day, timezone, client]);
  if (!selected || !range) return <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>날짜 또는 시간대를 확인할 수 없습니다.</Text></View>;

  function clearSuccess() {
    setSelectionError('');
    if (command.state.status === 'success') command.reset();
    if (checkin.state.status === 'success') checkin.reset();
    if (attendance.state.status === 'success') attendance.reset();
    if (undo.state.status === 'success') undo.reset();
  }
  function blockedByOtherRequest() {
    if (!operationGuard.hasUnresolved()) { setGuardMessage(''); return false; }
    setSheet(null); setGuardMessage('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return true;
  }
  function openEditor(item: ScheduleItem | null) {
    if (result.status !== 'success') return;
    if (item && editRequest) { setSheet(null); editRequest(item); return; }
    if (!item && createRequest) { setSheet(null); createRequest(); return; }
    if (blocked || blockedByOtherRequest()) return;
    setSheet(null); clearSuccess();
    setEditor({ item, expectedScheduleRevision: result.data.scheduleRevision, client });
  }
  function save(fields: ScheduleFields) {
    if (!editor || blocked || blockedByOtherRequest() || editor.client !== client) return;
    const changeId = `change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const change = editor.item ? { changeId, operation: 'update' as const, targetId: editor.item.id, expectedRevision: editor.item.revision, after: fields }
      : { changeId, operation: 'create' as const, after: fields };
    commandClient.current = editor.client;
    command.submit({ expectedScheduleRevision: editor.expectedScheduleRevision, changeSet: { changes: [change] } });
  }
  function current(item: ScheduleItem) {
    if (result.status === 'success' && result.data.items.some(value => value.id === item.id && value.revision === item.revision)) return true;
    setSheet(null); setSelectionError('일정이 변경되어 최신 목록을 다시 불러옵니다.'); result.retry(); return false;
  }
  function submitCompletion(item: ScheduleItem, completion: CheckinInput['completion']) {
    if (actionDisabled || blockedByOtherRequest() || !current(item)) return;
    setSheet(null); clearSuccess(); checkinClient.current = client; checkin.submit({ id: item.id, expectedRevision: item.revision, completion });
  }
  function submitAttendance(item: ScheduleItem, value: AttendanceInput['attendance']) {
    if (actionDisabled || blockedByOtherRequest() || !current(item)) return;
    setSheet(null); clearSuccess(); attendanceClient.current = client; attendance.submit({ id: item.id, expectedRevision: item.revision, attendance: value });
  }
  function submitUndo(item: ScheduleItem) {
    if (actionDisabled || blockedByOtherRequest() || !current(item)) return;
    setSheet(null); clearSuccess(); undoClient.current = client; undo.submit({ id: item.id, expectedRevision: item.revision, field: item.kind === 'event' ? 'attendance' : 'completion' });
  }
  function deleteItem(item: ScheduleItem) {
    if (actionDisabled || blockedByOtherRequest() || !current(item) || item.involvement === 'shared' || result.status !== 'success') return;
    setSheet(null); clearSuccess(); commandClient.current = client;
    command.submit({ expectedScheduleRevision: result.data.scheduleRevision, changeSet: { changes: [{
      changeId: `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`, operation: 'delete', targetId: item.id, expectedRevision: item.revision,
    }] } });
  }
  function moveDay(offset: number) {
    if (actionDisabled) return;
    try { onSelectDate(startOfDay(addDays(selected!, offset), timezone)); setSelectionError(''); }
    catch { setSelectionError('이 시간대에서 해당 날짜를 선택할 수 없습니다.'); }
  }
  const items = result.status === 'success' ? result.data.items : [];
  const filtered = items.filter(item => filter === 'all' || item.category === filter);
  const scheduled = filtered.filter(item => item.timeSlot);
  const unscheduled = presentation === 'day' ? filtered.filter(item => item.kind === 'task' && !item.timeSlot) : [];
  const progress = dailyProgress(scheduled);
  const ongoing = scheduled.filter(item => item.kind === 'task' && item.completion !== 'completed' && item.completion !== 'incomplete' &&
    item.timeSlot && Date.parse(item.timeSlot.startsAt) <= now && now < Date.parse(item.timeSlot.endsAt)).length;
  const layout = scheduleLayout(scheduled, now, selectedDate, timezone);
  function card(item: ScheduleItem) {
    return <ScheduleCard item={item} timezone={timezone} now={now} variant={presentation === 'day' ? 'timeline' : 'list'} disabled={actionDisabled}
      onPress={() => setSheet({ kind: 'detail', item })} onStatus={() => setSheet({ kind: 'status', item })} onMore={() => setSheet({ kind: 'more', item })} />;
  }
  function row(item: ScheduleItem, content = card(item)) {
    if (presentation === 'home' || !item.timeSlot) return <View key={item.id} style={styles.rowGap}>{content}</View>;
    const itemLayout = layout.layout.get(item.id);
    return <View key={item.id} style={[styles.timelineRow, { marginTop: itemLayout?.gap ?? 8 }]}>
      <View style={styles.axis}><Text style={styles.axisText}>{axisTime(item.timeSlot.startsAt, selectedDate, timezone)}</Text>
        <Text style={styles.axisText}>{axisTime(item.timeSlot.endsAt, selectedDate, timezone)}</Text></View>
      <View style={[styles.timelineCard, { minHeight: itemLayout?.height ?? 72 }, scheduleCardModel(item, now).active &&
        !scheduleCardModel(item, now).recorded && styles.timelineActive]}>{content}
        {itemLayout?.overlap && <Text style={styles.overlap}>시간 겹침</Text>}</View>
    </View>;
  }
  let rows: React.ReactNode[] = [];
  if (layout.front) {
    const front = layout.front;
    rows = [<PastScheduleStack key={front.id} front={row(front)} count={layout.past.length} expanded={expanded}
      onToggle={() => setExpanded(value => !value)} disabled={actionDisabled} insetLeft={presentation === 'day' ? 60 : 0}>{layout.past.map(item => row(item))}</PastScheduleStack>, ...layout.remaining.map(item => row(item))];
  } else rows = layout.remaining.map(item => row(item));
  if (preparation) return <PreparationProposalPanel target={preparation.item} expectedScheduleRevision={preparation.revision}
    timezone={timezone} api={api} visible={visible} onClose={() => setPreparation(null)}
    onProposalCreated={() => { setPreparation(null); onOpenPreparationProposals(); }} />;
  const undoNoHistory = undo.state.status === 'error' && !undo.state.uncertain &&
    typeof undo.state.error === 'object' && undo.state.error !== null && 'code' in undo.state.error && undo.state.error.code === 'no_undo';
  const activeSheet = sheet && result.status === 'success' && filtered.some(value => value.id === sheet.item.id && value.revision === sheet.item.revision) ? sheet : null;
  const item = activeSheet?.item;
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable key={label} accessibilityRole="button"
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.sheetButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.sheetButtonText}>{label}</Text></Pressable>;
  return <>
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {presentation === 'home' ? <View style={styles.headingRow}><View><Text style={styles.dateLabel}>{formatCivilDate(selected)}</Text><Text accessibilityRole="header" style={styles.title}>오늘도 함께해요</Text></View>
        {onOpenSettings && <Pressable accessibilityRole="button" accessibilityLabel="설정 열기" accessibilityHint="기본 프로필 그림" onPress={onOpenSettings} style={styles.profile}><ProfileAvatar size={39} /></Pressable>}</View>
        : <View style={styles.dateHeader}><Pressable accessibilityRole="button" accessibilityLabel="이전 날짜" disabled={actionDisabled} onPress={() => moveDay(-1)} style={styles.nav}><Text>‹</Text></Pressable>
          <Text accessibilityRole="header" style={styles.dateTitle}>{formatCivilDate(selected)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="다음 날짜" disabled={actionDisabled} onPress={() => moveDay(1)} style={styles.nav}><Text>›</Text></Pressable></View>}
      {presentation === 'day' && <><View style={styles.weekHeader}>{onCalendar && button('월간 보기', onCalendar, actionDisabled)}</View>
        <View style={styles.weekStrip}>{Array.from({ length: 7 }, (_, index) => {
          const date = addDays(selected, index - ((weekday(selected) + 1) % 7));
          const chosen = date.year === selected.year && date.month === selected.month && date.day === selected.day;
          return <View key={`${date.year}-${date.month}-${date.day}`} style={styles.weekColumn}><Text style={styles.weekLabel}>{['일','월','화','수','목','금','토'][weekday(date)]}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={formatCivilDate(date)} accessibilityState={{ selected: chosen, disabled: actionDisabled }}
              disabled={actionDisabled} onPress={() => { try { onSelectDate(startOfDay(date, timezone)); setSelectionError(''); } catch { setSelectionError('이 시간대에서 해당 날짜를 선택할 수 없습니다.'); } }}
              style={[styles.weekDay, chosen && styles.weekSelected]}><Text style={chosen ? styles.weekSelectedText : undefined}>{date.day}</Text></Pressable></View>;
        })}</View></>}
      {presentation === 'home' && <View style={styles.filters}>{([['all','전체'],['personal','개인'],['work','업무']] as const).map(([key, label]) =>
        <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: filter === key }} onPress={() => { setSheet(null); setFilter(key); }} style={[styles.filter, filter === key && styles.filterSelected]}><Text>{label}</Text></Pressable>)}</View>}
      {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
      {!!guardMessage && <Text accessibilityRole="alert" style={styles.error}>{guardMessage}</Text>}
      <MutationStatus state={command.state} retry={command.retry} reset={() => { command.reset(); result.retry(); }} refresh={result.retry} canRetry={commandClient.current === client} success="일정을 저장했습니다." />
      <MutationStatus state={checkin.state} retry={checkin.retry} reset={() => { checkin.reset(); result.retry(); }} refresh={result.retry} canRetry={checkinClient.current === client} success="상태를 기록했습니다." />
      <MutationStatus state={attendance.state} retry={attendance.retry} reset={() => { attendance.reset(); result.retry(); }} refresh={result.retry} canRetry={attendanceClient.current === client} success="참석 여부를 기록했습니다." />
      {undoNoHistory ? <View style={styles.statusBox}><Text accessibilityRole="alert" style={styles.error}>이전 상태를 확인할 수 없어 되돌릴 수 없습니다. 상태를 직접 선택해 주세요.</Text>
        {button('닫고 최신 목록 확인', () => { undo.reset(); setSheet(null); result.retry(); })}</View>
        : <MutationStatus state={undo.state} retry={undo.retry} reset={() => { undo.reset(); result.retry(); }} refresh={result.retry} canRetry={undoClient.current === client} success="이전 상태로 되돌렸습니다." />}
      {editor && editor.client !== client && <Text accessibilityRole="alert" style={styles.error}>연결이 변경되어 기존 편집을 저장할 수 없습니다. 편집을 취소한 뒤 다시 열어 주세요.</Text>}
      {editor && <View style={styles.panel}><ScheduleForm key={editor.item ? `${editor.item.id}:${editor.item.revision}` : 'create'} item={editor.item} timezone={timezone}
        disabled={blocked || editor.client !== client} cancelDisabled={blocked} onCancel={() => setEditor(null)} onSave={save} /></View>}
      {result.status === 'loading' && <ScheduleLoading />}
      {result.status === 'error' && <ScheduleError error={result.error} retry={result.retry} />}
      {result.status === 'success' && <>
        {presentation === 'home' && <><View style={styles.sectionTitleRow}><Text accessibilityRole="header" style={styles.sectionTitle}>오늘의 일정 {scheduled.length}개</Text>
          {onCalendar && button('캘린더', onCalendar, actionDisabled)}</View>
          <View style={styles.summary}><View accessible accessibilityLabel={progress.percent === null ? '완료를 기록할 할 일이 없어요' : `할 일과 루틴 ${progress.total}개 중 ${progress.done}개 완료, ${progress.percent}퍼센트`} style={styles.summaryRing}>
            <Text style={styles.ringText}>{progress.percent === null ? '–' : `${progress.percent}%`}</Text></View>
            <View style={styles.summaryMetrics}><Text style={styles.summaryLabel}>완료 <Text style={styles.summaryValue}>{progress.done}개</Text></Text>
              <Text style={styles.summaryLabel}>진행 중 <Text style={styles.summaryValue}>{ongoing}개</Text></Text>
              <Text style={styles.summaryLabel}>남은 할 일 <Text style={styles.summaryValue}>{Math.max(0, progress.total - progress.done - ongoing)}개</Text></Text></View></View>
          <Text style={styles.muted}>{progress.percent === null ? '완료를 기록할 할 일이 없어요.' : `할 일·루틴 ${progress.total}개 중 ${progress.done}개 완료`}</Text>
          {onOpenProposals && <View style={styles.panel}><Text accessibilityRole="header" style={styles.sectionTitle}>AI 제안</Text>
            <Text style={styles.muted}>{proposal?.api === api && proposal.version === refreshVersion ? proposal.text : '제안을 불러오는 중입니다.'}</Text>
            {button('제안 확인', onOpenProposals, actionDisabled)}</View>}</>}
        {presentation === 'day' && <View style={styles.sectionTitleRow}><Text accessibilityRole="header" style={styles.sectionTitle}>일간 일정</Text>{button('추가', () => openEditor(null), !createRequest && actionDisabled)}</View>}
        {!scheduled.length && <View style={styles.panel}><Text style={styles.muted}>{presentation === 'home'
          ? '해당하는 시간 지정 일정이 없어요.' : '이 날짜에 시간이 정해진 일정이 없어요.'}</Text></View>}
        {rows}
        {unscheduled.length > 0 && <><Text accessibilityRole="header" style={styles.sectionTitle}>미배치 할 일</Text>{unscheduled.map(item => row(item))}</>}
      </>}
    </ScrollView>
    <BottomSheet visible={activeSheet !== null} title={item?.title ?? ''} onClose={() => { if (!blocked) setSheet(null); }}>
      {item && activeSheet?.kind === 'detail' && <View style={styles.sheetContent}>
        <Text style={styles.muted}>{item.timeSlot ? `${axisTime(item.timeSlot.startsAt, selectedDate, timezone)} – ${axisTime(item.timeSlot.endsAt, selectedDate, timezone)}` : '시간 미정'}</Text>
        <Text style={styles.muted}>{item.kind === 'event' ? '약속' : item.sourceRefs.some(ref => ref.provider === 'routine') ? '루틴' : '할 일'} · {item.involvement === 'shared' ? '공동' : '개인'}</Text>
        {button('상태 변경', () => setSheet({ kind: 'status', item }), actionDisabled)}{button('더보기', () => setSheet({ kind: 'more', item }), actionDisabled)}
      </View>}
      {item && activeSheet?.kind === 'status' && <View style={styles.sheetContent}>
        <Text style={styles.muted}>{item.kind === 'event' ? '참석 여부를 선택해 주세요.' : '수행 상태를 선택해 주세요.'}</Text>
        {item.kind === 'event' ? attendanceChoices.map(choice => button(choice.label, () => submitAttendance(item, choice.value), actionDisabled))
          : completionChoices.map(choice => button(choice.label, () => submitCompletion(item, choice.value), actionDisabled))}
        {button('이전 상태로 되돌리기', () => submitUndo(item), actionDisabled)}
      </View>}
      {item && activeSheet?.kind === 'more' && <View style={styles.sheetContent}>
        {button('수정', () => openEditor(item), actionDisabled)}
        {onAsk && button('AI에게 문의', () => { setSheet(null); onAsk(item); }, actionDisabled)}
        {item.kind === 'event' && item.completion !== 'completed' && button('준비계획', () => { if (result.status === 'success') { setSheet(null); setPreparation({ item, revision: result.data.scheduleRevision }); } }, actionDisabled)}
        {item.kind === 'task' && item.completion === 'incomplete' && button('복구 상담', () => { setSheet(null); onRecovery(item); }, actionDisabled)}
        {canCoordinate(item) && button('공동 약속 조정 검토', () => { setSheet(null); onCoordinate(item); }, actionDisabled)}
        {item.involvement === 'shared' ? <Text style={styles.muted}>공동 일정은 직접 삭제할 수 없습니다.</Text> : button('삭제', () => setSheet({ kind: 'delete', item }), actionDisabled)}
      </View>}
      {item && activeSheet?.kind === 'delete' && <View style={styles.sheetContent}><Text>이 일정을 삭제할까요?</Text>
        {button('취소', () => setSheet({ kind: 'more', item }), actionDisabled)}{button('삭제 확인', () => deleteItem(item), actionDisabled)}</View>}
    </BottomSheet>
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' }, content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 100 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, dateLabel: { color: '#626B80', fontSize: 13 },
  title: { color: '#14151A', fontSize: 24, fontWeight: '700', marginTop: 6 }, profile: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  dateHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, dateTitle: { flex: 1, textAlign: 'center', color: '#14151A', fontSize: 17, fontWeight: '700' },
  nav: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: '#fff' },
  weekHeader: { alignItems: 'flex-end', marginTop: 8 }, weekStrip: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  weekColumn: { alignItems: 'center', gap: 4 }, weekLabel: { color: '#626B80', fontSize: 12 }, weekDay: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  weekSelected: { backgroundColor: '#5369CA' }, weekSelectedText: { color: '#fff', fontWeight: '700' },
  filters: { flexDirection: 'row', gap: 8, marginTop: 22 }, filter: { minWidth: 62, minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', borderRadius: 24, backgroundColor: '#F3F5FC' },
  filterSelected: { backgroundColor: '#C4D0FF' }, sectionTitleRow: { marginTop: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { color: '#14151A', fontSize: 18, fontWeight: '700', marginTop: 10 }, summary: { marginTop: 12, padding: 20, gap: 24, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 20 },
  summaryRing: { width: 92, height: 92, borderRadius: 46, borderWidth: 9, borderColor: '#C4D0FF', alignItems: 'center', justifyContent: 'center' },
  ringText: { color: '#14151A', fontSize: 17, fontWeight: '700' }, summaryMetrics: { flex: 1, gap: 8 },
  summaryLabel: { color: '#626B80', fontSize: 14 }, summaryValue: { color: '#14151A', fontSize: 14, fontWeight: '700' },
  rowGap: { marginTop: 10 }, timelineRow: { flexDirection: 'row', alignItems: 'stretch', gap: 10 }, axis: { width: 50, justifyContent: 'space-between', paddingVertical: 4 }, axisText: { fontSize: 12, color: '#626B80' },
  timelineCard: { flex: 1, minWidth: 0, borderRadius: 13, backgroundColor: '#fff' }, timelineActive: { backgroundColor: '#5369CA' },
  overlap: { color: '#A54720', fontSize: 12, marginTop: 4 }, panel: { marginTop: 16, padding: 16, backgroundColor: '#fff', borderRadius: 18 },
  sheetContent: { gap: 8 }, sheetButton: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, backgroundColor: '#F3F5FC' }, sheetButtonText: { color: '#14151A', fontWeight: '600' },
  statusBox: { marginTop: 12, gap: 8 }, muted: { color: '#626B80', lineHeight: 20 }, error: { color: '#A01818', lineHeight: 20 }, disabled: { opacity: 0.5 }, pressed: { opacity: 0.7 },
});
