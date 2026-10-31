import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMutation } from '../api/useMutation';
import { compareTimestamps } from '../schedule/client';
import type { CheckinInput, CheckinResult, ScheduleClient, ScheduleCommandInput, ScheduleCommandResult, ScheduleFields, ScheduleItem } from '../schedule/client';
import { addDays, civilDate, dayRange, formatCivilDate, startOfDay } from '../schedule/dates';
import { MutationStatus } from '../schedule/MutationStatus';
import { ScheduleForm } from '../schedule/ScheduleForm';
import { canCoordinate } from '../schedule/form';
import { ScheduleError, ScheduleLoading } from '../schedule/ScheduleStatus';
import { useSchedule } from '../schedule/useSchedule';

export type DayScreenProps = {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  client: ScheduleClient;
  timezone: string;
  refreshVersion: number;
  onScheduleChanged: () => void;
  onCoordinate: (item: ScheduleItem) => void;
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

export default function DayScreen({ selectedDate, onSelectDate, client, timezone, refreshVersion, onScheduleChanged, onCoordinate }: DayScreenProps) {
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
  const [editor, setEditor] = useState<Editor | null>(null);
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
  const actionDisabled = blocked || editor !== null;

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
        <Text style={styles.itemTitle}>{item.title}</Text>
        {item.timeSlot ? <Text style={styles.itemDetail}>{formatTime(item.timeSlot.startsAt, timezone)} – {formatTime(item.timeSlot.endsAt, timezone)}</Text>
          : <Text style={styles.itemDetail}>미배치 · {item.durationMinutes}분</Text>}
        <Text style={styles.itemDetail}>{item.kind === 'event' ? '일정' : '할 일'} · {item.flexibility === 'fixed' ? '고정' : '유동'} · {item.involvement === 'shared' ? '공동' : '개인'} · {COMPLETION_LABELS[item.completion]}</Text>
        <View style={styles.itemActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 수정`}
            accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled} onPress={() => openEditor(item)}
            style={[styles.actionButton, actionDisabled && styles.disabled]}><Text style={styles.actionText}>수정</Text></Pressable>
          {choices.map(({ completion, label }) => (
            <Pressable key={completion} accessibilityRole="button" accessibilityLabel={`${item.title} ${label} 체크인`}
              accessibilityState={{ disabled: actionDisabled, selected: item.completion === completion }}
              disabled={actionDisabled} onPress={() => submitCheckin(item, completion)}
              style={[styles.actionButton, item.completion === completion && styles.activeAction, actionDisabled && styles.disabled]}>
              <Text style={styles.actionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {eligibleForCoordination && <>
          <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 공동 약속 조정 검토`}
            accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled} onPress={() => onCoordinate(item)}
            style={[styles.coordinateButton, actionDisabled && styles.disabled]}><Text style={styles.actionText}>공동 약속 조정 검토</Text></Pressable>
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>일간</Text>
      <View style={styles.dateHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 날짜" accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled} onPress={() => moveDay(-1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed, actionDisabled && styles.disabled]}>
          <Text style={styles.navigationText}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.dateTitle}>{formatCivilDate(selected)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="다음 날짜" accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled} onPress={() => moveDay(1)}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed, actionDisabled && styles.disabled]}>
          <Text style={styles.navigationText}>›</Text>
        </Pressable>
      </View>
      {!!selectionError && <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text>}
      <MutationStatus state={command.state} retry={command.retry} reset={command.reset} refresh={result.retry}
        canRetry={commandClient.current === client} success="일정을 저장했습니다." />
      <MutationStatus state={checkin.state} retry={checkin.retry} reset={checkin.reset} refresh={result.retry}
        canRetry={checkinClient.current === client} success="체크인을 기록했습니다." />
      {editor && editor.client !== client && <Text accessibilityRole="alert" style={styles.error}>연결이 변경되어 기존 편집을 저장할 수 없습니다. 편집을 취소한 뒤 다시 열어 주세요.</Text>}
      {editor && <ScheduleForm key={editor.item ? `${editor.item.id}:${editor.item.revision}` : 'create'}
        item={editor.item} timezone={timezone} disabled={blocked || editor.client !== client} cancelDisabled={blocked}
        onCancel={() => setEditor(null)} onSave={save} />}
      {result.status === 'loading' && <ScheduleLoading />}
      {result.status === 'error' && <ScheduleError error={result.error} retry={result.retry} />}
      {result.status === 'success' && (
        <View style={styles.sections}>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: actionDisabled }} disabled={actionDisabled}
            onPress={() => openEditor(null)} style={[styles.addButton, actionDisabled && styles.disabled]}>
            <Text style={styles.addText}>일정 또는 할 일 추가</Text>
          </Pressable>
          {scheduled.length === 0 && unscheduled.length === 0 ? (
            <Text style={styles.emptyText}>등록된 일정과 미배치 할 일이 없습니다.</Text>
          ) : (
            <>
              <Text accessibilityRole="header" style={styles.sectionTitle}>배치된 일정</Text>
              {scheduled.length === 0 ? <Text style={styles.emptyText}>이 날짜에 배치된 일정이 없습니다.</Text> :
                scheduled.map(renderItem)}
              {unscheduled.length > 0 && (
                <>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>미배치 할 일</Text>
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
  screen: { flex: 1, backgroundColor: '#ffffff' },
  content: { flexGrow: 1, padding: 16, paddingBottom: 32 },
  title: { color: '#172033', fontSize: 24, fontWeight: '700' },
  dateHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24 },
  dateTitle: { flex: 1, marginHorizontal: 8, color: '#172033', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  navigationButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#f1f5f9' },
  navigationText: { color: '#172033', fontSize: 28 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.5 },
  sections: { marginTop: 24, gap: 10 },
  sectionTitle: { color: '#172033', fontSize: 18, fontWeight: '700', marginTop: 8 },
  item: { padding: 12, borderRadius: 8, backgroundColor: '#f1f5f9', gap: 4 },
  itemTitle: { color: '#172033', fontSize: 16, fontWeight: '700' },
  itemDetail: { color: '#475569', fontSize: 14 },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  actionButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: '#94a3b8', borderRadius: 6, backgroundColor: '#ffffff' },
  activeAction: { borderColor: '#1d4ed8', backgroundColor: '#dbeafe' },
  actionText: { color: '#172033', fontWeight: '600' },
  coordinateButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, marginTop: 4, borderRadius: 6, backgroundColor: '#dbeafe' },
  addButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 6, backgroundColor: '#1d4ed8' },
  addText: { color: '#ffffff', fontWeight: '700' },
  hint: { color: '#475569', fontSize: 14 },
  emptyText: { color: '#475569', fontSize: 16 },
  error: { color: '#a01818', marginTop: 12 },
});
