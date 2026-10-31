import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { createScheduleClient } from '../schedule/client';
import { civilDate, dayRange, formatCivilDate } from '../schedule/dates';
import { useSchedule } from '../schedule/useSchedule';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';
import { createCalendarSyncClient, type ChangeInput, type ConnectInput, type QueueInput, type SyncCalendar, type SyncConnection, type SyncResult } from './client';

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'success'; data: T };
type Intent = { kind: 'connect'; input: ConnectInput } | { kind: 'queue'; input: QueueInput } | { kind: 'run' | 'disconnect'; input: ChangeInput };
type Outcome = { kind: 'connect' | 'queue'; connection: SyncConnection } | { kind: 'run'; result: SyncResult } | { kind: 'disconnect' };
const reasons: Record<string, string> = {
  both_changed: '양쪽에서 변경됨', delete_not_enabled: '삭제 전파 미동의', delete_requires_review: '삭제 안전성을 확인할 수 없어 검토 필요', contact_required: '공동 일정은 별도 연락 확인 필요',
  unsupported_or_shared: '지원하지 않는 일정 또는 공유 일정', binding_mismatch: '연결 정보 불일치', missing_baseline: '변경 기준 정보 부족',
  duplicate_source: '같은 원본이 여러 일정과 연결됨', unknown_binding: '연결 정보를 확인할 수 없음', schedule_conflict: '일정 충돌',
  unsupported_item: '지원하지 않는 일정', concurrent_change: '동시 변경', remote_missing: '외부 일정 확인 불가', outcome_unknown: '외부 쓰기 결과 불명', provider_unavailable: 'Google 연결 불가',
};
export default function CalendarSyncPanel({ api, timezone, selectedDate, visible, refreshVersion, onBack, onScheduleChanged }: {
  api: ApiClient; timezone: string; selectedDate: Date; visible: boolean; refreshVersion: number; onBack: () => void; onScheduleChanged: () => void;
}) {
  const client = useMemo(() => createCalendarSyncClient(api), [api]);
  const scheduleClient = useMemo(() => createScheduleClient(api), [api]);
  const [calendars, setCalendars] = useState<Load<SyncCalendar[]>>({ status: 'loading' });
  const [connections, setConnections] = useState<Load<SyncConnection[]>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0); const [calendarId, setCalendarId] = useState('');
  const [allowDeletes, setAllowDeletes] = useState(false); const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const lastKind = useRef<Intent['kind'] | null>(null);
  let query: { from: string; to: string; timezone: string; includeUnscheduled: boolean } | null = null;
  try { query = visible ? { ...dayRange(civilDate(selectedDate, timezone), timezone), timezone, includeUnscheduled: false } : null; } catch { /* invalid local day */ }
  const schedule = useSchedule(scheduleClient, query, refreshVersion);
  const dateKey = query?.from ?? '';
  useEffect(() => { setSelectedItems([]); }, [dateKey, refreshVersion]);
  useEffect(() => {
    if (!visible) return;
    let active = true; setCalendars({ status: 'loading' }); setConnections({ status: 'loading' });
    client.calendars().then(data => { if (active) setCalendars({ status: 'success', data }); }, () => { if (active) setCalendars({ status: 'error' }); });
    client.list().then(data => { if (active) setConnections({ status: 'success', data }); }, () => { if (active) setConnections({ status: 'error' }); });
    return () => { active = false; };
  }, [client, attempt, visible]);
  const action = useMutation<Intent, Outcome>(async op => {
    if (op.input.kind === 'connect') return { kind: 'connect', connection: await client.connect({ ...op, input: op.input.input }) };
    if (op.input.kind === 'queue') return { kind: 'queue', connection: await client.addExports({ ...op, input: op.input.input }) };
    if (op.input.kind === 'run') return { kind: 'run', result: await client.run({ ...op, input: op.input.input }) };
    await client.disconnect({ ...op, input: op.input.input }); return { kind: 'disconnect' };
  }, result => { setAttempt(value => value + 1); if (result.kind === 'run') onScheduleChanged(); if (result.kind === 'queue') setSelectedItems([]); if (result.kind === 'connect') { setSelectedItems([]); setCalendarId(''); setAllowDeletes(false); } });
  const blocked = action.state.status === 'pending' || action.state.status === 'error';
  function submit(intent: Intent) {
    if (blocked) return;
    if (action.state.status === 'success') action.reset();
    lastKind.current = intent.kind; action.submit(intent);
  }
  const candidates = schedule.status === 'success' ? schedule.data.items.filter(item => item.kind === 'event' && item.involvement === 'personal' && item.timeSlot !== null && item.sourceRefs.length === 0) : [];
  const selectedCalendar = calendars.status === 'success' ? calendars.data.find(item => item.id === calendarId && (item.accessRole === 'owner' || item.accessRole === 'writer')) : undefined;
  const existing = connections.status === 'success' ? connections.data.find(item => item.calendarId === calendarId) : undefined;
  return <ScrollView contentContainerStyle={styles.container}>
    <ActionButton label="뒤로" onPress={onBack} secondary />
    <Text accessibilityRole="header" style={styles.title}>Google 캘린더 동기화</Text>
    <Text style={styles.text}>Google 연결에서 캘린더 동기화 쓰기 권한을 별도로 연결한 뒤 캘린더를 선택하세요. 읽기 연결만으로는 동기화할 수 없습니다.</Text>
    <Text style={styles.text}>동기화 실행 시 선택한 Google 캘린더의 지원 일정과 기존 연결 일정이 대상입니다. 삐꾸 일정은 아래에서 직접 선택한 항목만 Google로 내보냅니다. 개인 일정 전체를 자동으로 내보내지 않습니다.</Text>
    <Text style={styles.text}>양쪽에서 바뀐 일정과 지원하지 않는 일정은 자동으로 덮어쓰지 않고 확인 대상으로 남깁니다. 변경 이력이 만료되면 전체 조회를 시도합니다.</Text>
    <Text style={styles.text}>내가 소유한 캘린더에서 내가 주최한 기존 공동 약속은 승인된 연락과 응답, 변경 내용 및 원본이 모두 확인되면 시간 변경을 반영할 수 있습니다. 새 공동 약속 내보내기, 삭제, 다른 사람 주최, Google에서 변경된 공동 약속이나 확인되지 않은 변경은 검토 대상으로 남습니다.</Text>
    {(calendars.status === 'loading' || connections.status === 'loading') && <><ActivityIndicator /><Text>연결 상태를 확인하는 중입니다.</Text></>}
    {calendars.status === 'error' && <Text accessibilityRole="alert">캘린더 목록을 확인하지 못했습니다. Google 동기화 권한과 연결을 확인해 주세요.</Text>}
    {connections.status === 'error' && <Text accessibilityRole="alert">동기화 연결 목록을 확인하지 못했습니다.</Text>}
    <ActionButton label="동기화 상태 다시 조회" disabled={action.state.status === 'pending'} onPress={() => setAttempt(value => value + 1)} secondary />
    {connections.status === 'success' && connections.data.map(item => <View style={styles.card} key={item.id}>
      <Text style={styles.text}>캘린더: {calendars.status === 'success' ? calendars.data.find(calendar => calendar.id === item.calendarId)?.summary || item.calendarId : item.calendarId}</Text>
      <Text style={styles.text}>상태: {item.status === 'review_required' ? '검토 필요' : '연결됨'} · 삭제 전파 {item.allowDeletes ? '동의' : '미동의'} · 내보내기 대기 {item.pendingExportCount}건</Text>
      {item.status === 'review_required' && <Text accessibilityRole="alert">처리 결과에 확인이 필요합니다. 외부 변경을 자동으로 다시 전송하지 않습니다.</Text>}
      <ActionButton label={`${item.calendarId} 동기화 실행`} disabled={blocked || item.status !== 'connected'} onPress={() => submit({ kind: 'run', input: { id: item.id, expectedRevision: item.revision } })} />
      <ActionButton label={`${item.calendarId} 동기화 연결 해제`} disabled={blocked || item.status !== 'connected'} onPress={() => submit({ kind: 'disconnect', input: { id: item.id, expectedRevision: item.revision } })} secondary />
    </View>)}
    {connections.status === 'success' && connections.data.length === 0 && <Text>연결된 동기화가 없습니다.</Text>}
    <Text accessibilityRole="header" style={styles.section}>캘린더 선택</Text>
    {calendars.status === 'success' && calendars.data.length === 0 && <Text>조회된 캘린더가 없습니다.</Text>}
    {calendars.status === 'success' && calendars.data.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={`캘린더 ${item.summary || item.id}`} accessibilityState={{ checked: calendarId === item.id, disabled: blocked || !['owner', 'writer'].includes(item.accessRole) }}
      disabled={blocked || !['owner', 'writer'].includes(item.accessRole)} onPress={() => setCalendarId(item.id)} style={styles.choice}><Text>{calendarId === item.id ? '◉' : '○'} {item.summary || item.id} · {item.accessRole}</Text></Pressable>)}
    <Text accessibilityRole="header" style={styles.section}>내보낼 삐꾸 일정 선택</Text>
    <Text style={styles.text}>{formatCivilDate(civilDate(selectedDate, timezone))}의 외부 원본이 없는 시간 지정 개인 이벤트를 최대 100건 선택할 수 있습니다. 할 일과 루틴 회차는 Google로 내보내지 못합니다.</Text>
    {schedule.status === 'loading' && <Text>일정을 불러오는 중입니다.</Text>}
    {schedule.status === 'error' && <><Text accessibilityRole="alert">내보낼 일정을 확인하지 못했습니다.</Text><ActionButton label="일정 다시 조회" onPress={schedule.retry} secondary /></>}
    {schedule.status === 'success' && candidates.length === 0 && <Text>선택할 수 있는 일정이 없습니다.</Text>}
    {candidates.map(item => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityLabel={`내보낼 일정 ${item.title}`} accessibilityState={{ checked: selectedItems.includes(item.id), disabled: blocked || (selectedItems.length >= 100 && !selectedItems.includes(item.id)) }} disabled={blocked || (selectedItems.length >= 100 && !selectedItems.includes(item.id))}
      onPress={() => setSelectedItems(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous, item.id])} style={styles.choice}><Text>{selectedItems.includes(item.id) ? '☑' : '☐'} {item.title}</Text></Pressable>)}
    {!existing && <><Pressable accessibilityRole="checkbox" accessibilityLabel="양방향 삭제 전파 동의" accessibilityState={{ checked: allowDeletes, disabled: blocked }} disabled={blocked} onPress={() => setAllowDeletes(value => !value)} style={styles.choice}>
      <Text>{allowDeletes ? '☑' : '☐'} 양방향 삭제 전파에 동의합니다.</Text></Pressable>
    <Text style={styles.text}>동의하면 연결된 일정의 삭제가 다른 쪽에도 전파될 수 있습니다. 동의하지 않은 삭제는 검토 대상으로 남습니다.</Text></>}
    {existing ? <><Text style={styles.text}>이미 연결된 캘린더입니다. 연결을 다시 만들지 않고 선택한 일정을 대기열에 추가합니다. 삭제 설정은 기존 연결을 따릅니다.</Text>
      <ActionButton label="선택한 일정 추가" disabled={blocked || !selectedCalendar || existing.status !== 'connected' || schedule.status !== 'success' || selectedItems.length === 0} onPress={() => submit({ kind: 'queue', input: { id: existing.id, expectedRevision: existing.revision, exportItemIds: selectedItems } })} />
      {existing.status !== 'connected' && <Text accessibilityRole="alert">이 연결은 검토가 필요하여 일정을 추가할 수 없습니다.</Text>}</> :
      <ActionButton label="동기화 연결" disabled={blocked || connections.status !== 'success' || !selectedCalendar || (selectedItems.length > 0 && schedule.status !== 'success')} onPress={() => submit({ kind: 'connect', input: { calendarId, allowDeletes, exportItemIds: selectedItems } })} />}
    {action.state.status === 'pending' && <Text accessibilityLiveRegion="polite">처리 중입니다.</Text>}
    {action.state.status === 'error' && <><Text accessibilityRole="alert">{action.state.uncertain ? '처리 결과를 확인하지 못했습니다. 외부 변경을 자동으로 다시 전송하지 않습니다.' : '요청을 처리하지 못했습니다. 연결 상태와 권한을 확인해 주세요.'}</Text>
      {action.state.uncertain && lastKind.current === 'run' && <Text>동기화 상태를 다시 조회할 수 있습니다. 결과가 확정되기 전에는 다른 변경과 계정 전환이 제한됩니다.</Text>}
      {action.state.uncertain && lastKind.current === 'run' && <ActionButton label="저장된 동기화 결과 확인" onPress={action.retry} secondary />}
      {lastKind.current !== 'run' && <ActionButton label="같은 동기화 요청 재시도" onPress={action.retry} secondary />}
      {!action.state.uncertain && <ActionButton label="동기화 오류 닫기" onPress={() => { action.reset(); setAttempt(value => value + 1); }} secondary />}</>}
    {action.state.status === 'success' && action.state.result.kind === 'connect' && <Text>동기화 연결을 저장했습니다. 실행은 별도 선택입니다.</Text>}
    {action.state.status === 'success' && action.state.result.kind === 'queue' && <Text>선택한 일정을 대기열에 추가했습니다. Google 전송은 동기화 실행 시 진행합니다.</Text>}
    {action.state.status === 'success' && action.state.result.kind === 'disconnect' && <Text>동기화 연결을 해제했습니다.</Text>}
    {action.state.status === 'success' && action.state.result.kind === 'run' && <View style={styles.card}>
      <Text>가져옴 {action.state.result.result.imported}건 · 내보냄 {action.state.result.result.exported}건 · 삭제 {action.state.result.result.deleted}건</Text>
      {(action.state.result.result.conflicts.length > 0 || action.state.result.result.unsupportedCount > 0) && <Text accessibilityRole="alert">일부 항목은 처리하지 못했거나 검토가 필요합니다. 지원하지 않는 항목 {action.state.result.result.unsupportedCount}건</Text>}
      {action.state.result.result.conflicts.map((item, i) => <Text key={`${item.reason}:${i}`}>{reasons[item.reason] ?? `확인 필요 (${item.reason})`}{item.itemId ? ` · 삐꾸 일정 ${item.itemId}` : ''}{item.eventId ? ` · Google 일정 ${item.eventId}` : ''}</Text>)}
      {action.state.result.result.connection.status === 'review_required' && <Text accessibilityRole="alert">외부 처리 결과를 검토해야 합니다. 자동으로 재전송하지 않습니다.</Text>}
    </View>}
  </ScrollView>;
}
const styles = StyleSheet.create({ container: { padding: 20, gap: 12, paddingBottom: 32 }, title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  section: { color: colors.text, fontSize: 18, fontWeight: '700' }, text: { color: colors.text, lineHeight: 21 }, card: { padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  choice: { minHeight: 44, justifyContent: 'center' } });
