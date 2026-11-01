import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { ActionButton } from '../ui/ActionButton';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import { ContactPicker } from './ContactPicker';
import { createScheduleCallClient, normalizeScheduleCallNumber } from './schedule-call-client';
import type { ScheduleCall, ScheduleCallOperation } from './schedule-call-client';

export type ScheduleCallPanelProps = { api: ApiClient; itemId: string; expectedRevision: number; onClose: () => void; onFinish: () => void; onScheduleChanged: () => void; onOpenPhoneSettings: () => void; onOpenGoogleContacts?: () => void };
export default function ScheduleCallPanel({ api, itemId, expectedRevision, onClose, onFinish, onScheduleChanged, onOpenPhoneSettings, onOpenGoogleContacts }: ScheduleCallPanelProps) {
  const client = useMemo(() => createScheduleCallClient(api), [api]);
  const requestClient = useRef<typeof client | null>(null), readLock = useRef(false);
  const lastKind = useRef<ScheduleCallOperation['kind'] | null>(null);
  const [number, setNumber] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [call, setCall] = useState<ScheduleCall | null>(null);
  const [readback, setReadback] = useState<ScheduleCall | null>(null);
  const [message, setMessage] = useState('');
  const [reading, setReading] = useState(false);
  const [approvalRead, setApprovalRead] = useState(false);
  const action = useMutation<ScheduleCallOperation, ScheduleCall>(op => requestClient.current!.execute(op), result => {
    setCall(result); setReadback(null); setMessage('');
    if (result.status === 'applied') onScheduleChanged();
  });
  const pending = action.state.status === 'pending', uncertain = action.state.status === 'error' && action.state.uncertain;
  const locked = pending || action.state.status === 'error' || reading;
  function submit(input: ScheduleCallOperation) {
    if (locked || readLock.current) return;
    if (operationGuard.hasUnresolved()) { setMessage('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    if (action.state.status === 'success') action.reset();
    requestClient.current = client; lastKind.current = input.kind; setApprovalRead(false); setMessage(''); action.submit(input);
  }
  async function readStatus() {
    if (!call || readLock.current) return;
    readLock.current = true; setReading(true); setMessage('');
    try {
      const latest = await client.get(call);
      if (pending || uncertain) setReadback(latest);
      else { setCall(latest); setApprovalRead(true); if (latest.status === 'applied' && call.status !== 'applied') onScheduleChanged(); }
    } catch { setMessage('상태를 확인하지 못했습니다. 전화가 발신되지 않았다는 뜻은 아닙니다.'); }
    finally { readLock.current = false; setReading(false); }
  }
  const canClose = !pending && !uncertain && !reading;
  const errorCode = action.state.status === 'error' && action.state.error instanceof ApiError ? action.state.error.code : null;
  const phoneSetup = errorCode === 'not_configured' && (lastKind.current === 'create' || lastKind.current === 'approve');
  const approvalNeedsRead = action.state.status === 'error' && lastKind.current === 'approve' && !phoneSetup && !approvalRead;
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header" style={styles.title}>일정 장소 전화 확인</Text>
    <Text style={styles.hint}>전화 내용과 번호를 확인한 뒤 직접 승인해야 발신합니다.</Text>
    {!call && <View style={styles.card}><Text style={styles.label}>받는 전화번호</Text>
      <TextInput accessibilityLabel="받는 전화번호" keyboardType="phone-pad" value={number} onChangeText={value => { setNumber(value); setRecipientName(''); }}
        editable={!locked} placeholder="예: 01012345678 또는 +821012345678" style={styles.input} />
      <Text style={styles.hint}>확인할 상대의 번호를 직접 입력해 주세요.</Text>
      <ContactPicker api={api} disabled={locked} onOpenGoogleContacts={onOpenGoogleContacts} onSelect={value => { setRecipientName(value.name); setNumber(value.number); }} />
      {!!recipientName && <Text>선택한 상대: {recipientName}</Text>}
      <ActionButton label="전화 내용 확인" disabled={locked || !normalizeScheduleCallNumber(number)} onPress={() => submit({ kind: 'create', itemId, expectedRevision, toNumber: number })} />
    </View>}
    {call && <>
      <View style={styles.card}><Text accessibilityRole="header" style={styles.label}>확인할 일정과 질문</Text>
        <Text>일정: {call.title}</Text>{!!recipientName && <Text>선택한 상대: {recipientName}</Text>}<Text>받는 번호: {call.toNumber}</Text><Text>질문: {call.question}</Text>
        <Text style={styles.hint}>전화 요청 접수는 통화 연결이나 상대의 응답을 보장하지 않습니다.</Text></View>
      <Text accessibilityLiveRegion="polite">전화 상태: {statusLabel[call.status]}</Text>
      {call.status === 'pending' && <ActionButton label="승인하고 전화" disabled={locked} onPress={() => submit({ kind: 'approve', call })} />}
      {call.status === 'submitted' && <ActionButton label="통화 결과 확인" disabled={locked} onPress={() => submit({ kind: 'check', call })} />}
      {call.status === 'completed' && <ActionButton label="장소 정정 검토" disabled={locked} onPress={() => submit({ kind: 'propose', call })} />}
      {call.transcript && <View style={styles.card}><Text accessibilityRole="header" style={styles.label}>통화 내용</Text>
        <Text style={styles.hint}>전사는 외부 발화이며, 실제 내용과 다를 수 있습니다. 직접 확인해 주세요.</Text>
        {call.transcript.map((entry, index) => <Text key={index}>{entry.role === 'agent' ? 'PIKKU' : '상대방'}: {entry.text}</Text>)}</View>}
      {call.status === 'review_pending' && <View style={styles.card}><Text accessibilityRole="header" style={styles.label}>장소 정정 검토</Text>
        {!!call.reviewNote && <Text>{call.reviewNote}</Text>}
        {call.correction ? <><Text>변경 전: {call.correction.beforeLocation ?? '장소 미설정'}</Text><Text>변경 제안: {call.correction.afterLocation}</Text>
          <Text>통화 요약: {call.correction.summary}</Text>
          <Text style={styles.hint}>승인하면 앱 일정의 장소만 바뀝니다. Google 원본 장소와는 동기화되지 않습니다.</Text>
          <ActionButton label="장소 변경 승인" disabled={locked} onPress={() => submit({ kind: 'decision', call, decision: 'accept' })} /></>
          : <Text>변경할 장소가 확인되지 않았습니다.</Text>}
        <ActionButton label="변경 거절" secondary disabled={locked} onPress={() => submit({ kind: 'decision', call, decision: 'reject' })} /></View>}
      <ActionButton label={reading ? '전화 상태 확인 중' : '저장된 전화 상태 조회'} secondary disabled={reading} onPress={() => void readStatus()} />
      {readback && <Text>조회된 전화 상태: {statusLabel[readback.status]}. 이전 요청의 결과를 확인할 때까지 새 변경은 잠깁니다.</Text>}
    </>}
    {!!message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
    {pending && <Text accessibilityLiveRegion="polite">요청을 처리하고 있습니다.</Text>}
    {action.state.status === 'error' && <View style={styles.card}><Text accessibilityRole="alert" style={styles.error}>{phoneSetup
      ? '전화 계정 연결 또는 서버 저장소 설정이 필요합니다. 연결 설정을 확인해 주세요.' : errorCode === 'not_configured'
        ? '통화 검토에 필요한 서비스가 설정되지 않았습니다.' : errorCode === 'conflict'
          ? '일정이나 전화 요청이 변경되었습니다. 최신 일정을 다시 조회해 주세요.' : errorCode === 'provider_unavailable'
            ? '전화 서비스를 이용할 수 없습니다. 직접 연락하거나 나중에 다시 확인해 주세요.'
            : '요청을 처리하지 못했습니다. 내용을 확인해 주세요.'}</Text>
      {uncertain && <Text style={styles.hint}>요청 결과를 확인하지 못했습니다. 같은 요청만 다시 확인할 수 있습니다.</Text>}
      {approvalNeedsRead && !uncertain && <Text style={styles.hint}>새 전화 요청 전에 저장된 전화 상태를 조회해 주세요.</Text>}
      {phoneSetup && !uncertain && <Text style={styles.hint}>연결한 뒤 돌아와 오류를 닫고 다시 확인해 주세요.</Text>}
      {phoneSetup && !uncertain && <ActionButton label="전화 연결 설정 열기" secondary onPress={onOpenPhoneSettings} />}
      {errorCode === 'conflict' && !uncertain && <ActionButton label="일정 다시 조회" secondary onPress={() => { onScheduleChanged(); if (call) onClose(); else onFinish(); }} />}
      <ActionButton label="같은 요청 다시 시도" disabled={reading || requestClient.current !== client} onPress={action.retry} />
      {!uncertain && <ActionButton label="오류 닫기" secondary disabled={approvalNeedsRead || reading} onPress={action.reset} />}</View>}
    {(!call || ['pending', 'failed', 'no_answer', 'applied', 'rejected'].includes(call.status)) &&
      <ActionButton label="이 전화 요청 닫기" secondary disabled={!canClose || approvalNeedsRead} onPress={onFinish} />}
    <ActionButton label="대화로 돌아가기" secondary disabled={!canClose} onPress={onClose} />
  </ScrollView>;
}
const statusLabel: Record<ScheduleCall['status'], string> = { pending: '승인 대기', dispatching: '발신 요청 중', submitted: '전화 요청 접수', outcome_unknown: '발신 결과 불명',
  failed: '요청 실패', completed: '통화 내용 확인됨', no_answer: '응답 없음', review_pending: '변경 검토 필요', applied: '장소 변경 반영됨', rejected: '변경 거절됨' };
const styles = StyleSheet.create({ content: { padding: 20, paddingBottom: 40, gap: 12 }, title: { fontSize: 22, fontWeight: '700', color: colors.text },
  card: { padding: 16, gap: 10, borderRadius: 18, backgroundColor: colors.surface }, label: { fontWeight: '700', color: colors.text },
  hint: { color: colors.muted, lineHeight: 20 }, input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12 },
  error: { color: colors.error, lineHeight: 20 } });
