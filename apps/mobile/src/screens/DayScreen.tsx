import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { Icon } from '../ui/Icon';
import { useMutation } from '../api/useMutation';
import type { ApiClient } from '../api/http';
import PreparationProposalPanel from '../preparation/PreparationProposalPanel';
import { compareTimestamps } from '../schedule/client';
import type { CheckinInput, CheckinResult, ScheduleClient, ScheduleCommandInput, ScheduleCommandResult, ScheduleFields, ScheduleItem } from '../schedule/client';
import { addDays, civilDate, dayRange, formatCivilDate, startOfDay } from '../schedule/dates';
import { MutationStatus } from '../schedule/MutationStatus';
import { ScheduleForm } from '../schedule/ScheduleForm';
import { canCoordinate } from '../schedule/form';
import { ScheduleError, ScheduleLoading } from '../schedule/ScheduleStatus';
import { useSchedule } from '../schedule/useSchedule';
import { selectNextActions } from '../schedule/nextAction';

export type DayScreenProps = {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  client: ScheduleClient;
  timezone: string;
  refreshVersion: number;
  onScheduleChanged: () => void;
  onCoordinate: (item: ScheduleItem) => void;
  onRecovery: (item: ScheduleItem) => void;
  api: ApiClient;
  onOpenPreparationProposals: () => void;
  visible?: boolean;
};

type Editor = {
  item: ScheduleItem | null;
  expectedScheduleRevision: number;
  client: ScheduleClient;
};

const COMPLETION_LABELS: Record<ScheduleItem['completion'], string> = {
  pending: '대기', completed: '완료', incomplete: '미완료', unknown: '상태 미확인',
};

function formatTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(instant));
}

function formatTimeRange(start: string, end: string, timezone: string): string {
  const startDate = civilDate(new Date(start), timezone);
  const endDate = civilDate(new Date(end), timezone);
  if (startDate.year === endDate.year && startDate.month === endDate.month && startDate.day === endDate.day) {
    const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
    return `${clock.format(new Date(start))} – ${clock.format(new Date(end))}`;
  }
  return `${formatTime(start, timezone)} – ${formatTime(end, timezone)}`;
}

export default function DayScreen({ selectedDate, onSelectDate, client, timezone, refreshVersion, onScheduleChanged, onCoordinate, onRecovery, api, onOpenPreparationProposals, visible = true }: DayScreenProps) {
  const selected = useMemo(() => {
    try { return civilDate(selectedDate, timezone); } catch { return null; }
  }, [selectedDate.getTime(), timezone]);
  const year = selected?.year;
  const month = selected?.month;
  const day = selected?.day;
  const range = useMemo(() => {
    if (year === undefined || month === undefined || day === undefined) return null;
    try { return dayRange({ year, month, day }, timezone); } catch { return null; }
  }, [year, month, day, timezone]);
  const result = useSchedule(client, range && { ...range, timezone, includeUnscheduled: true }, refreshVersion);
  const [selectionError, setSelectionError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 30_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') update(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [visible]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preparation, setPreparation] = useState<{ item: ScheduleItem; revision: number } | null>(null);
  const commandClient = useRef<ScheduleClient | null>(null);
  const checkinClient = useRef<ScheduleClient | null>(null);
  const command = useMutation<ScheduleCommandInput, ScheduleCommandResult>(
    (op) => commandClient.current!.command(op),
    () => { setEditor(null); onScheduleChanged(); },
  );
  const checkin = useMutation<CheckinInput, CheckinResult>(
    (op) => checkinClient.current!.checkin(op),
    () => onScheduleChanged(),
  );
  const blocked = command.state.status === 'pending' || command.state.status === 'error' ||
    checkin.state.status === 'pending' || checkin.state.status === 'error';
  const actionDisabled = blocked || editor !== null || preparation !== null;

  if (!selected || !range) {
    return <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>날짜 또는 시간대를 확인할 수 없습니다.</Text></View>;
  }

  function moveDay(offset: number) {
    try {
      const next = startOfDay(addDays(selected!, offset), timezone);
      setSelectionError('');
      onSelectDate(next);
    } catch {
      setSelectionError('이 시간대에서 해당 날짜를 선택할 수 없습니다.');
    }
  }

  function clearSuccess() {
    if (command.state.status === 'success') command.reset();
    if (checkin.state.status === 'success') checkin.reset();
  }

  function openEditor(item: ScheduleItem | null) {
    if (blocked || result.status !== 'success') return;
    clearSuccess();
    setEditor({ item, expectedScheduleRevision: result.data.scheduleRevision, client });
  }

  function save(fields: ScheduleFields) {
    if (!editor || blocked || editor.client !== client) return;
    const changeId = `change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const change = editor.item
      ? { changeId, operation: 'update' as const, targetId: editor.item.id, expectedRevision: editor.item.revision, after: fields }
      : { changeId, operation: 'create' as const, after: fields };
    commandClient.current = editor.client;
    command.submit({ expectedScheduleRevision: editor.expectedScheduleRevision, changeSet: { changes: [change] } });
  }

  function submitCheckin(item: ScheduleItem, completion: CheckinInput['completion']) {
    if (actionDisabled) return;
    clearSuccess();
    checkinClient.current = client;
    checkin.submit({ id: item.id, expectedRevision: item.revision, completion });
  }

  function renderItem(item: ScheduleItem) {
    const eligibleForCoordination = canCoordinate(item);
    const choices: { completion: CheckinInput['completion']; label: string }[] = [
      { completion: 'completed', label: '완료' },
      { completion: 'incomplete', label: '미완료' },
      { completion: 'unknown', label: '미확인' },
    ];
    return (
      <View key={item.id} style={styles.item}>
        <View style={styles.itemHeader}>
          <View style={styles.timeRow}>
            <Icon name="clock" size={15} color={item.completion === 'completed' ? '#14734C'
              : item.completion === 'incomplete' ? '#9A4B14' : item.completion === 'unknown' ? colors.muted : colors.primary} />
            {item.timeSlot ? <Text style={styles.itemTime}>{formatTimeRange(item.timeSlot.startsAt, item.timeSlot.endsAt, timezone)}</Text>
              : <Text style={styles.itemTime}>미배치 · {item.durationMinutes}분</Text>}
          </View>
          <View style={[styles.stateBadge, item.completion === 'completed' && styles.completedBadge,
            item.completion === 'incomplete' && styles.incompleteBadge, item.completion === 'unknown' && styles.unknownBadge]}>
            {item.completion === 'completed' && <Icon name="check" size={13} color="#14734C" />}
            <Text style={[styles.stateText, item.completion === 'completed' && styles.completedText,
              item.completion === 'incomplete' && styles.incompleteText, item.completion === 'unknown' && styles.unknownText]}>{COMPLETION_LABELS[item.completion]}</Text>
          </View>
        </View>
        <Text style={[styles.itemTitle, item.completion === 'completed' && styles.completedTitle]}>{item.title}</Text>
        <Text style={styles.itemDetail}>{item.kind === 'event' ? '일정' : '할 일'} · {item.flexibility === 'fixed' ? '고정' : '유동'} · {item.involvement === 'shared' ? '공동' : '개인'}</Text>
        <View style={styles.itemActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 수정`}
            accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled} onPress={() => openEditor(item)}
            style={[styles.actionButton, actionDisabled && styles.disabled]}><Text style={styles.actionText}>수정</Text></Pressable>
          {choices.map(({ completion, label }) => (
            <Pressable key={completion} accessibilityRole="button" accessibilityLabel={`${item.title} ${label} 체크인`}
              accessibilityState={{ disabled: actionDisabled, selected: item.completion === completion }}
              disabled={actionDisabled} onPress={() => submitCheckin(item, completion)}
              style={[styles.actionButton, item.completion === completion && styles.activeAction,
                item.completion === completion && completion === 'completed' && styles.activeCompletedAction,
                item.completion === completion && completion === 'incomplete' && styles.activeIncompleteAction,
                item.completion === completion && completion === 'unknown' && styles.activeUnknownAction,
                actionDisabled && styles.disabled]}>
              {completion === 'completed' && <Icon name="check" size={15} color={item.completion === completion ? '#14734C' : '#34435D'} />}
              <Text style={[styles.actionText, item.completion === completion && styles.activeActionText,
                item.completion === completion && completion === 'completed' && styles.completedText,
                item.completion === completion && completion === 'incomplete' && styles.incompleteText,
                item.completion === completion && completion === 'unknown' && styles.unknownText]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {item.kind === 'event' && item.completion !== 'completed' && <Pressable accessibilityRole="button"
          accessibilityLabel={`${item.title} 준비계획`} accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled}
          onPress={() => { if (result.status === 'success' && !actionDisabled) setPreparation({ item, revision: result.data.scheduleRevision }); }}
          style={[styles.coordinateButton, actionDisabled && styles.disabled]}>
          <Text style={styles.actionText}>준비계획</Text><Icon name="arrowRight" size={15} color="#34435D" />
        </Pressable>}
        {item.kind === 'task' && item.completion === 'incomplete' && <Pressable accessibilityRole="button"
          accessibilityLabel={`${item.title} 복구 상담`} accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled}
          onPress={() => onRecovery(item)} style={[styles.coordinateButton, actionDisabled && styles.disabled]}>
          <Text style={styles.actionText}>복구 상담</Text><Icon name="arrowRight" size={15} color="#34435D" />
        </Pressable>}
        {eligibleForCoordination && <>
          <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 공동 약속 조정 검토`}
            accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled} onPress={() => onCoordinate(item)}
            style={[styles.coordinateButton, actionDisabled && styles.disabled]}><Text style={styles.actionText}>공동 약속 조정 검토</Text><Icon name="arrowRight" size={15} color="#34435D" /></Pressable>
          <Text style={styles.hint}>선택은 채팅의 조정 검토 대상 지정이며 승인, 일정 반영 또는 연락이 아닙니다.</Text>
        </>}
      </View>
    );
  }

  const scheduled = result.status === 'success'
    ? result.data.items.filter((item) => item.timeSlot !== null)
      .slice().sort((a, b) => compareTimestamps(a.timeSlot!.startsAt, b.timeSlot!.startsAt)) : [];
  const unscheduled = result.status === 'success'
    ? result.data.items.filter((item) => item.kind === 'task' && item.timeSlot === null) : [];
  const completedCount = scheduled.filter((item) => item.completion === 'completed').length;
  const remainingCount = scheduled.filter((item) => item.completion === 'pending' || item.completion === 'incomplete').length;
  const unknownCount = scheduled.filter((item) => item.completion === 'unknown').length;
  const actions = selectNextActions(scheduled, selected, timezone, new Date(now));

  if (preparation) return <PreparationProposalPanel target={preparation.item} expectedScheduleRevision={preparation.revision}
    timezone={timezone} api={api} visible={visible} onClose={() => setPreparation(null)}
    onProposalCreated={() => { setPreparation(null); onOpenPreparationProposals(); }} />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>일간</Text>
        <Text style={styles.subtitle}>선택한 날짜의 일정과 할 일</Text>
      </View>
      <View style={styles.dateHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 날짜" accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled} onPress={() => moveDay(-1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed, actionDisabled && styles.disabled]}>
          <Icon name="chevronLeft" size={20} color={colors.primary} />
        </Pressable>
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.dateTitle}>{formatCivilDate(selected)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="다음 날짜" accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled} onPress={() => moveDay(1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed, actionDisabled && styles.disabled]}>
          <Icon name="chevronRight" size={20} color={colors.primary} />
        </Pressable>
      </View>
      {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
      <MutationStatus state={command.state} retry={command.retry} reset={command.reset} refresh={result.retry}
        canRetry={commandClient.current === client} success="일정을 저장했습니다." />
      <MutationStatus state={checkin.state} retry={checkin.retry} reset={checkin.reset} refresh={result.retry}
        canRetry={checkinClient.current === client} success="체크인을 기록했습니다." />
      {editor && editor.client !== client && <Text accessibilityRole="alert" style={styles.error}>연결이 변경되어 기존 편집을 저장할 수 없습니다. 편집을 취소한 뒤 다시 열어 주세요.</Text>}
      {editor && <View style={styles.editorCard}><ScheduleForm key={editor.item ? `${editor.item.id}:${editor.item.revision}` : 'create'}
        item={editor.item} timezone={timezone} disabled={blocked || editor.client !== client} cancelDisabled={blocked}
        onCancel={() => setEditor(null)} onSave={save} /></View>}
      {result.status === 'loading' && <View style={styles.statusCard}><ScheduleLoading /></View>}
      {result.status === 'error' && <View style={styles.statusCard}><ScheduleError error={result.error} retry={result.retry} /></View>}
      {result.status === 'success' && (
        <View style={styles.sections}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeadingMain}>
              <Icon name="clock" size={19} color={colors.primary} />
              <Text accessibilityRole="header" style={styles.summaryTitle}>현재와 다음 행동</Text>
            </View>
            {actions.current && <View style={styles.nextAction}>
              <Text style={styles.nextActionLabel}>이 시간의 일정</Text>
              <Text style={styles.itemTitle}>{actions.current.title}</Text>
              <Text style={styles.itemTime}>{formatTimeRange(actions.current.timeSlot!.startsAt, actions.current.timeSlot!.endsAt, timezone)}</Text>
              <Text style={styles.summaryHint}>수행 상태: {COMPLETION_LABELS[actions.current.completion]}</Text>
            </View>}
            {actions.next && <View style={styles.nextAction}>
              <Text style={styles.nextActionLabel}>다음 행동</Text>
              <Text style={styles.itemTitle}>{actions.next.title}</Text>
              <Text style={styles.itemTime}>{formatTimeRange(actions.next.timeSlot!.startsAt, actions.next.timeSlot!.endsAt, timezone)}</Text>
              <Text style={styles.summaryHint}>수행 상태: {COMPLETION_LABELS[actions.next.completion]}</Text>
            </View>}
            {!actions.current && !actions.next && <Text style={styles.summaryHint}>선택한 날짜에 지금 진행 중이거나 앞으로 시작할 배치된 일정이 없습니다.</Text>}
            {(actions.current || actions.next) && <Text style={styles.summaryHint}>저장된 일정 시간 기준이며 수행 상태는 자동으로 바뀌지 않습니다.</Text>}
          </View>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeading}>
              <View style={styles.summaryHeadingMain}>
                <Icon name="calendar" size={19} color={colors.primary} />
                <Text accessibilityRole="header" style={styles.summaryTitle}>선택한 날짜 요약</Text>
              </View>
              <Text style={styles.summaryTotal}>배치된 일정 {scheduled.length}건</Text>
            </View>
            <View style={styles.summaryMetrics}>
              <View accessible accessibilityLabel={`완료 ${completedCount}건`} style={styles.metric}>
                <Text style={[styles.metricValue, styles.completedText]}>{completedCount}</Text><Text style={styles.metricLabel}>완료</Text>
              </View>
              <View accessible accessibilityLabel={`남은 일정 ${remainingCount}건`} style={styles.metric}>
                <Text style={[styles.metricValue, styles.remainingValue]}>{remainingCount}</Text><Text style={styles.metricLabel}>남은 일정</Text>
              </View>
              <View accessible accessibilityLabel={`상태 미확인 ${unknownCount}건`} style={styles.metric}>
                <Text style={styles.metricValue}>{unknownCount}</Text><Text style={styles.metricLabel}>상태 미확인</Text>
              </View>
            </View>
            <Text style={styles.summaryHint}>남은 일정은 대기·미완료 기준이며 미배치 할 일은 제외됩니다.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled}
            onPress={() => openEditor(null)} style={[styles.addButton, actionDisabled && styles.disabled]}>
            <Icon name="plus" size={18} color={colors.surface} />
            <Text style={styles.addText}>일정 또는 할 일 추가</Text>
          </Pressable>
          {scheduled.length === 0 && unscheduled.length === 0 ? (
            <View style={styles.emptyCard}><Text style={styles.emptyText}>등록된 일정과 미배치 할 일이 없습니다.</Text></View>
          ) : (
            <>
              <View style={styles.sectionHeading}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>배치된 일정</Text>
                <Text style={styles.sectionCount}>{scheduled.length}건</Text>
              </View>
              {scheduled.length === 0 ? <View style={styles.emptyCard}><Text style={styles.emptyText}>이 날짜에 배치된 일정이 없습니다.</Text></View> :
                scheduled.map(renderItem)}
              {unscheduled.length > 0 && (
                <>
                  <View style={styles.sectionHeading}>
                    <Text accessibilityRole="header" style={styles.sectionTitle}>미배치 할 일</Text>
                    <Text style={styles.sectionCount}>{unscheduled.length}건</Text>
                  </View>
                  <Text style={styles.hint}>날짜나 시간이 정해지지 않은 할 일입니다.</Text>
                  {unscheduled.map(renderItem)}
                </>
              )}
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 36 },
  heading: { gap: 6 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 14 },
  dateHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, padding: 10, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: '#EDF0F7' },
  dateTitle: { flex: 1, marginHorizontal: 8, color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  navigationButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: '#F5F7FC' },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.5 },
  editorCard: { marginTop: 16, paddingHorizontal: 14, paddingBottom: 14, backgroundColor: colors.surface, borderRadius: 20 },
  statusCard: { marginTop: 16, paddingHorizontal: 16, backgroundColor: colors.surface, borderRadius: 20 },
  sections: { marginTop: 20, gap: 12 },
  summaryCard: { padding: 16, gap: 14, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border },
  nextAction: { gap: 3 },
  nextActionLabel: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  summaryHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  summaryHeadingMain: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  summaryTotal: { color: colors.muted, fontSize: 13 },
  summaryMetrics: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 8, gap: 3, backgroundColor: colors.background, borderRadius: 14 },
  metricValue: { color: colors.text, fontSize: 20, fontWeight: '700' },
  remainingValue: { color: colors.primary },
  metricLabel: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  summaryHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  sectionCount: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  item: { padding: 18, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#EDF0F7', gap: 6 },
  itemHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  timeRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  itemTitle: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 23 },
  completedTitle: { color: colors.muted, textDecorationLine: 'line-through' },
  stateBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: '#EEF3FF', borderRadius: 10 },
  stateText: { color: '#3155B8', fontSize: 12, fontWeight: '700' },
  completedBadge: { backgroundColor: '#E7F5ED' },
  completedText: { color: '#14734C' },
  incompleteBadge: { backgroundColor: '#FFF1E5' },
  incompleteText: { color: '#9A4B14' },
  unknownBadge: { backgroundColor: '#F0F2F6' },
  unknownText: { color: colors.muted },
  itemTime: { flexShrink: 1, color: colors.primary, fontSize: 13, fontWeight: '600', lineHeight: 20 },
  itemDetail: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  actionButton: { flexGrow: 1, minWidth: 60, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 10, borderWidth: 1, borderColor: '#E3E8F2', borderRadius: 14, backgroundColor: '#F8F9FD' },
  activeAction: { borderColor: colors.primary, backgroundColor: '#EEF3FF' },
  activeCompletedAction: { borderColor: '#14734C', backgroundColor: '#E7F5ED' },
  activeIncompleteAction: { borderColor: '#9A4B14', backgroundColor: '#FFF1E5' },
  activeUnknownAction: { borderColor: colors.muted, backgroundColor: '#F0F2F6' },
  actionText: { color: '#34435D', fontSize: 13, fontWeight: '600' },
  activeActionText: { color: '#2851C7', fontWeight: '700' },
  coordinateButton: { alignSelf: 'flex-start', minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, marginTop: 4, borderRadius: 14, backgroundColor: '#EEF3FF' },
  addButton: { alignSelf: 'stretch', minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.primary },
  addText: { color: colors.surface, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  emptyCard: { padding: 18, backgroundColor: colors.surface, borderRadius: 20 },
  emptyText: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  error: { color: colors.error, marginTop: 12 },
});
