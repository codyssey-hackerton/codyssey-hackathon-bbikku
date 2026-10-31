import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, View,
} from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import type { ChatInput } from '@pikku/domain';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import { Icon } from '../ui/Icon';
import { ScreenBackground } from '../ui/ScreenBackground';
import { ApiError } from '../api/http';
import { useMutation } from '../api/useMutation';
import type { ScheduleClient } from '../schedule/client';
import type { ChatClient, ChatContext, ChatEntryContext, ChatResponse, CoordinationTarget, FormDraft } from './client';
export type { ChatEntryContext } from './client';
import { ChatScheduleSummary } from './ChatScheduleSummary';

type ChatEntry = { id: string; role: 'user' | 'assistant' | 'status'; text: string; phoneTarget?: { itemId: string; expectedRevision: number } };
type Input = Omit<ChatInput, 'requestId'> & { entryContext?: ChatContext };
const fieldLabels: Record<string, string> = { kind: '종류', title: '제목', startsAt: '시작', endsAt: '종료', timezone: '시간대', durationMinutes: '소요 시간(분)', deadline: '마감', flexibility: '유연성', involvement: '참여 범위', completion: '완료 상태', category: '분류', weekdays: '반복 요일', startDate: '시작 날짜', startTime: '시작 시간', endDate: '종료 날짜', endTime: '종료 시간', localTime: '시작 시간', duration: '소요 시간(분)' };
const weekdayLabels: Record<string, string> = { '1': '월', '2': '화', '3': '수', '4': '목', '5': '금', '6': '토', '7': '일' };
export type RecoveryRequest = { key: string; title: string; dateLabel: string; text: string };
export type RevisionRequest = { key: string; proposalId: string; text: string; coordinationTarget?: CoordinationTarget & { title: string } };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthenticated': return '로그인 상태를 확인해 주세요.';
      case 'not_configured': return 'AI 연결이 아직 설정되지 않았어요.';
      case 'not_implemented': return '대화 기능을 아직 사용할 수 없어요.';
      case 'timeout': return '응답 시간이 지나 요청 결과를 확인하지 못했어요.';
      case 'network': return '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.';
      case 'invalid_configuration': return '서버 주소를 확인해 주세요.';
      case 'invalid_response': return '서버 응답을 확인하지 못했어요.';
      case 'provider_unavailable': return 'AI 연결을 사용할 수 없어요. 잠시 후 다시 확인해 주세요.';
      case 'operation_in_progress': return '이전 요청을 처리 중이에요. 잠시 후 다시 확인해 주세요.';
      case 'rate_limited': return '요청이 많아요. 잠시 후 다시 확인해 주세요.';
      case 'invalid_request': return '입력 내용을 확인해 주세요.';
      case 'stale_proposal': case 'conflict': return '기준 정보가 바뀌었어요. 최신 일정을 확인해 주세요.';
      default: return '서버 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    }
  }
  return '요청 결과를 확인할 수 없습니다.';
}

export default function ChatScreen({ client, timezone, scheduleClient, selectedDate, refreshVersion, onOpenProposals, onProposalCreated, onOpenReviewSchedule, coordinationTarget, onClearCoordinationTarget, recoveryRequest, revisionRequest, entryContext, onClearEntryContext, onApplyDraft, onOpenScheduleCall }: {
  client: ChatClient;
  timezone: string;
  scheduleClient: ScheduleClient;
  selectedDate: Date;
  refreshVersion: number;
  onOpenProposals: () => void;
  onProposalCreated: () => void;
  onOpenReviewSchedule: () => void;
  coordinationTarget?: CoordinationTarget & { title: string };
  onClearCoordinationTarget: () => void;
  recoveryRequest?: RecoveryRequest;
  revisionRequest?: RevisionRequest;
  entryContext?: ChatEntryContext;
  onClearEntryContext?: () => void;
  onApplyDraft?: (draft: FormDraft) => void;
  onOpenScheduleCall?: (target: { itemId: string; expectedRevision: number }) => void;
}) {
  const [draft, setDraft] = useState('');
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoveryRequest[]>([]);
  const [revisionDrafts, setRevisionDrafts] = useState<RevisionRequest[]>([]);
  const [activeRecoveryKey, setActiveRecoveryKey] = useState<string | null>(null);
  const [requestedMode, setRequestedMode] = useState<string | null | undefined>(undefined);
  const [lastSent, setLastSent] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [activeEntry, setActiveEntry] = useState<ChatEntryContext | undefined>();
  const [suggestedDraft, setSuggestedDraft] = useState<{ key: string; draft: FormDraft } | null>(null);
  const [longWait, setLongWait] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState('');
  const counter = useRef(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const sentRecovery = useRef<string | null>(null);
  const sentRevision = useRef<string | null>(null);
  const sentTarget = useRef<(CoordinationTarget & { title: string }) | undefined>(undefined);
  const sentEntry = useRef<ChatEntryContext | undefined>(undefined);
  const previousTarget = useRef(coordinationTarget);
  const requestClient = useRef<ChatClient | null>(null);
  const currentClient = useRef(client); currentClient.current = client;
  const checkingRef = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const action = useMutation<Input, ChatResponse>(
    (operation) => requestClient.current!.sendMessage({ ...operation.input, requestId: operation.requestId, idempotencyKey: operation.idempotencyKey }),
    (response) => {
      setConversationId(response.conversationId);
      const result = response.result;
      if (result.kind === 'failure') {
        setAgentError(result.message);
        sentRecovery.current = null;
        sentRevision.current = null;
        return;
      }
      if (result.kind === 'reply' && 'draft' in result && (sentEntry.current?.kind === 'create' ||
          (sentEntry.current?.kind === 'form' && result.draft.kind === sentEntry.current.draft.kind))) {
        setSuggestedDraft({ key: sentEntry.current.key, draft: result.draft });
      }
      if (sentRecovery.current !== null) {
        const key = sentRecovery.current;
        setRecoveryDrafts((previous) => previous.map((item) => item.key === key ? { ...item, text: '' } : item));
        sentRecovery.current = null;
      }
      if (sentRevision.current !== null) {
        const key = sentRevision.current;
        setRevisionDrafts((previous) => previous.map((item) => item.key === key ? { ...item, text: '' } : item));
        sentRevision.current = null;
      }
      const replyId = `reply-${++counter.current}`;
      setEntries((previous) => [
        ...previous,
        { id: replyId, role: 'assistant', text: result.message, ...(result.kind === 'phone_request' ? { phoneTarget: { itemId: result.itemId, expectedRevision: result.expectedRevision } } : {}) },
        ...(result.kind === 'proposal'
          ? [{ id: `${replyId}-status`, role: 'status' as const, text: '제안 목록에서 변경 전후와 이유를 검토하세요. 승인 전에는 적용되지 않습니다.' }]
          : []),
      ]);
      if (result.kind === 'proposal') onProposalCreated();
    },
  );
  const busy = action.state.status !== 'idle';
  const entryChanging = activeEntry !== entryContext;
  const activeRecovery = recoveryDrafts.find((item) => item.key === activeRecoveryKey);
  const activeRevision = revisionDrafts.find((item) => `revision:${item.key}` === activeRecoveryKey);
  const messageDraft = activeRecovery?.text ?? activeRevision?.text ?? draft;
  const displayedTarget = busy ? sentTarget.current : activeRevision ? activeRevision.coordinationTarget : coordinationTarget;
  useEffect(() => { if (action.state.status === 'success') action.reset(); }, [action.state.status]);
  useEffect(() => {
    setLongWait(false);
    if (action.state.status !== 'pending') return;
    const timer = setTimeout(() => setLongWait(true), 15_000);
    return () => clearTimeout(timer);
  }, [action.state.status]);
  useEffect(() => {
    if (busy || activeEntry === entryContext) return;
    const changedKey = activeEntry?.key !== entryContext?.key;
    setActiveEntry(entryContext);
    if (!changedKey) return;
    setActiveRecoveryKey(null);
    setSuggestedDraft(null);
    setConversationId(null);
    setEntries([]);
    setAgentError(null);
  }, [busy, entryContext, activeEntry]);
  useEffect(() => {
    if (!recoveryRequest) return;
    setRecoveryDrafts((previous) => previous.some((item) => item.key === recoveryRequest.key) ? previous : [...previous, recoveryRequest]);
    setRequestedMode(recoveryRequest.key);
  }, [recoveryRequest]);
  useEffect(() => {
    if (!revisionRequest) return;
    setRevisionDrafts((previous) => previous.some((item) => item.key === revisionRequest.key) ? previous : [...previous, revisionRequest]);
    setRequestedMode(`revision:${revisionRequest.key}`);
  }, [revisionRequest]);
  useEffect(() => {
    if (previousTarget.current !== coordinationTarget) {
      previousTarget.current = coordinationTarget;
      if (coordinationTarget) setRequestedMode(null);
    }
  }, [coordinationTarget]);
  useEffect(() => {
    if (busy || requestedMode === undefined) return;
    setActiveRecoveryKey(requestedMode);
    setRequestedMode(undefined);
  }, [busy, requestedMode]);

  function editMessage(value: string) {
    if (activeRecovery) {
      setRecoveryDrafts((previous) => previous.map((item) => item.key === activeRecovery.key ? { ...item, text: value } : item));
    } else if (activeRevision) {
      setRevisionDrafts((previous) => previous.map((item) => item.key === activeRevision.key ? { ...item, text: value } : item));
    } else setDraft(value);
  }

  function send() {
    const message = messageDraft.trim();
    if (!message || action.state.status !== 'idle' || entryChanging) return;
    setAgentError(null);
    setLastSent(message);
    sentRecovery.current = activeRecovery?.key ?? null;
    sentRevision.current = activeRevision?.key ?? null;
    if (!activeRecovery && !activeRevision) setDraft('');
    const userId = `user-${++counter.current}`;
    const selectedEntry = activeRevision || (activeRecovery && activeEntry?.key !== activeRecovery.key) ? undefined : activeEntry;
    const target = activeRecovery || selectedEntry ? undefined : activeRevision ? activeRevision.coordinationTarget : coordinationTarget;
    sentTarget.current = target;
    sentEntry.current = selectedEntry;
    setSuggestedDraft(null);
    setEntries((previous) => [
      ...previous,
      { id: userId, role: 'user', text: message },
      ...(target ? [{ id: `${userId}-target`, role: 'status' as const, text: `이 요청의 공동 조정 검토 대상: ${target.title}. 선택은 변경·연락 승인이 아닙니다.` }] : []),
    ]);
    const context: ChatContext | undefined = selectedEntry?.kind === 'item'
      ? { kind: 'item', id: selectedEntry.id, expectedRevision: selectedEntry.expectedRevision }
      : selectedEntry?.kind === 'form' ? { kind: 'form', draft: selectedEntry.draft }
      : selectedEntry?.kind === 'create' ? { kind: 'create' } : undefined;
    requestClient.current = client; setCheckMessage('');
    action.submit({ message, conversationId, timezone, ...(target ? { coordinationTarget: { id: target.id, expectedRevision: target.expectedRevision } } : {}), ...(context ? { entryContext: context } : {}) });
  }

  async function checkResult() {
    const original = requestClient.current;
    if (checkingRef.current || !original?.checkRequest || original !== currentClient.current) return;
    checkingRef.current = true; setChecking(true); setCheckMessage('');
    try {
      const status = await action.check(async operation => {
        const result = await original.checkRequest!({ requestId: operation.requestId, idempotencyKey: operation.idempotencyKey, conversationId: operation.input.conversationId });
        if (currentClient.current !== original) throw new Error('connection_changed');
        return result;
      }, result => result.status !== 'completed' ? null : 'response' in result.result
        ? { result: result.result.response } : { error: result.result.error });
      if (!mounted.current || !status) return;
      if (status.status === 'running') setCheckMessage('서버에서 요청을 처리 중입니다. 잠시 후 다시 확인해 주세요.');
      else if (status.status === 'retryable') setCheckMessage('같은 요청을 다시 시도할 수 있습니다.');
      else if (status.status === 'completed' && 'error' in status.result) setCheckMessage('서버에 저장된 요청 오류를 확인했습니다.');
    } catch {
      if (mounted.current) setCheckMessage('결과를 확인하지 못했습니다. 기존 요청은 계속 보존됩니다.');
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  return (
    <ScreenBackground variant="ai">
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">AI 비서</Text>
        <View style={styles.links}>
          <Pressable accessibilityRole="button" onPress={onOpenProposals} style={styles.pill}><Icon name="shield" size={16} /><Text style={styles.pillText}>제안 검토</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenReviewSchedule} style={styles.pill}><Icon name="clock" size={16} /><Text style={styles.pillText}>자동 검토 설정</Text></Pressable>
        </View>
        {activeEntry && !activeRecovery && !activeRevision && <View style={styles.target}>
          <Text style={styles.targetTitle}>{activeEntry.kind === 'item' ? `선택한 일정: ${activeEntry.title}` : activeEntry.kind === 'form' ? '작성 중인 입력 초안' : '새 일정 만들기'}</Text>
          <Text style={styles.targetHint}>{activeEntry.kind === 'form' ? '기존 입력을 보관하며 제안은 확인 후 선택해요. 일정은 자동 저장되지 않아요.' : '제안은 확인하고 승인하기 전까지 일정에 반영되지 않아요.'}</Text>
          {onClearEntryContext && <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={onClearEntryContext} style={styles.link}><Text style={styles.linkText}>맥락 닫기</Text></Pressable>}
        </View>}
        {displayedTarget && !activeEntry && !activeRecovery && <View style={styles.target}>
          <Text style={styles.targetTitle}>조정 검토 대상: {displayedTarget.title}</Text>
          <Text style={styles.targetHint}>대상 선택은 일정 변경이나 연락 승인이 아닙니다.</Text>
          {!activeRevision && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onClearCoordinationTarget} style={styles.link}><Text style={styles.linkText}>대상 선택 해제</Text></Pressable>}
        </View>}
      </View>
      <ScrollView ref={scrollRef} style={styles.conversation} contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
        {(recoveryDrafts.length > 0 || revisionDrafts.length > 0) && <View style={styles.target}>
          <Text style={styles.targetTitle}>{activeRevision ? '제안 수정 요청 초안' : activeRecovery ? '복구 상담 초안' : '보관된 대화 초안'}</Text>
          <Text style={styles.targetHint}>기존 대화 초안은 보관됩니다. 복구 상담은 보내기 전 수정할 수 있고 공동 조정 대상은 포함되지 않습니다.</Text>
          {activeRevision && <Text style={styles.targetHint}>제안 {activeRevision.proposalId}의 수정 요청입니다. 보내기 전 수정할 수 있으며, 새 제안에는 별도 승인이 필요합니다.</Text>}
          {busy && requestedMode !== undefined && <Text style={styles.targetHint}>현재 요청이 끝나면 선택한 초안으로 이동합니다.</Text>}
          <View style={styles.links}>
            {recoveryDrafts.map((item) => <Pressable key={item.key} accessibilityRole="button"
              accessibilityLabel={`${item.title} ${item.dateLabel} 복구 상담 초안`}
              accessibilityState={{ disabled: busy, selected: item.key === activeRecoveryKey }} disabled={busy}
              onPress={() => { setRequestedMode(undefined); setActiveRecoveryKey(item.key); }} style={[styles.pill, busy && styles.disabled]}>
              <Text style={styles.pillText}>{item.title} 복구 상담</Text>
            </Pressable>)}
            {revisionDrafts.map((item) => <Pressable key={`revision:${item.key}`} accessibilityRole="button"
              accessibilityLabel={`제안 ${item.proposalId} 수정 요청 초안`}
              accessibilityState={{ disabled: busy, selected: `revision:${item.key}` === activeRecoveryKey }} disabled={busy}
              onPress={() => { setRequestedMode(undefined); setActiveRecoveryKey(`revision:${item.key}`); }} style={[styles.pill, busy && styles.disabled]}>
              <Text style={styles.pillText}>제안 {item.proposalId} 수정 요청</Text>
            </Pressable>)}
            {(activeRecovery || activeRevision) && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
              onPress={() => { setRequestedMode(undefined); setActiveRecoveryKey(null); }} style={[styles.pill, busy && styles.disabled]}>
              <Text style={styles.pillText}>기존 대화 초안으로</Text>
            </Pressable>}
          </View>
        </View>}
        <ChatScheduleSummary client={scheduleClient} selectedDate={selectedDate} timezone={timezone} refreshVersion={refreshVersion} />
        {entries.length === 0 && <View style={styles.welcome}>
          <View style={styles.welcomeMark}><Icon name="sparkles" size={24} color={colors.primary} /></View>
          <Text style={styles.welcomeTitle}>어떤 하루를 보내고 싶으세요?</Text>
          <Text style={styles.empty}>할 일이나 달라진 상황을 편하게 이야기해 주세요.
일정 변경은 제안을 확인하고 승인한 뒤 반영해요.</Text>
          {!messageDraft.trim() && !activeRecovery && !activeRevision && <View style={styles.starters}>
            {['오늘 일정을 함께 정리해줘.', '지금 상황에 맞게 계획을 검토해줘.'].map((message) =>
              <Pressable key={message} accessibilityRole="button" accessibilityLabel={`${message} 입력`} disabled={busy}
                accessibilityState={{ disabled: busy }} onPress={() => setDraft(message)} style={[styles.starter, busy && styles.disabled]}>
                <Text style={styles.starterText}>{message}</Text><Icon name="arrowRight" size={16} color={colors.primary} />
              </Pressable>)}
          </View>}
        </View>}
        {entries.map((entry) => <View key={entry.id} style={[styles.message, entry.role === 'user' && styles.userMessage, entry.role === 'status' && styles.statusMessage]}>
          <View style={styles.messageHeading}>{entry.role !== 'user' && <Icon name={entry.role === 'assistant' ? 'sparkles' : 'shield'} size={14} color={colors.primary} />}<Text style={[styles.messageRole, entry.role === 'user' && styles.userMessageRole]}>{entry.role === 'user' ? '나' : entry.role === 'assistant' ? 'AI 응답' : '요청 상태'}</Text></View>
          <Text style={[styles.messageText, entry.role === 'user' && styles.userMessageText]}>{entry.text}</Text>
          {entry.phoneTarget && onOpenScheduleCall && <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}
            onPress={() => onOpenScheduleCall(entry.phoneTarget!)} style={styles.link}><Text style={styles.linkText}>전화 요청 확인</Text></Pressable>}
        </View>)}
        {suggestedDraft && (activeEntry?.kind === 'form' || activeEntry?.kind === 'create') && suggestedDraft.key === activeEntry.key && activeEntry.key === entryContext?.key && !activeRecovery && !activeRevision && <View style={styles.draftCard}>
          <Text style={styles.targetTitle}>입력 제안 · 아직 반영되지 않음</Text>
          {Object.entries(suggestedDraft.draft.fields).map(([key, value]) => <Text key={key} style={styles.targetHint}>{fieldLabels[key] ?? key}: {Array.isArray(value) ? value.map(day => weekdayLabels[day] ?? day).join(', ') : value || '비움'}</Text>)}
          <Text style={styles.targetHint}>입력 화면에서 기존 값과 비교하고 반영할 항목을 선택하세요.</Text>
          {onApplyDraft && <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => onApplyDraft(suggestedDraft.draft)} style={styles.draftButton}><Text style={styles.draftButtonText}>입력 화면에서 검토</Text></Pressable>}
        </View>}
        {action.state.status === 'pending' && <View style={styles.loading} accessibilityLiveRegion="polite"><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.loadingText}>{longWait ? '답변이 오래 걸리고 있어요. 다른 화면을 확인해도 요청은 취소되지 않아요.' : '답변을 준비하고 있어요.'}</Text></View>}
        {agentError && <Text style={styles.error} accessibilityRole="alert">{agentError}</Text>}
        {action.state.status === 'error' && <View style={styles.errorBox}>
          <Text style={styles.error} accessibilityRole="alert">{errorMessage(action.state.error)}</Text>
          {action.state.uncertain && <Text style={styles.error}>결과를 확인할 때까지 같은 요청만 다시 시도합니다.</Text>}
          {!!checkMessage && <Text accessibilityLiveRegion="polite" style={styles.error}>{checkMessage}</Text>}
          {action.state.uncertain && requestClient.current?.checkRequest && <Pressable accessibilityRole="button" accessibilityState={{ disabled: checking || requestClient.current !== client }}
            disabled={checking || requestClient.current !== client} onPress={checkResult} style={styles.link}><Text style={styles.linkText}>{checking ? '처리 결과 확인 중' : '처리 결과 확인'}</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: checking || requestClient.current !== client }}
            disabled={checking || requestClient.current !== client} onPress={action.retry} style={styles.link}><Text style={styles.linkText}>같은 요청 다시 시도</Text></Pressable>
          {!action.state.uncertain && <Pressable accessibilityRole="button" onPress={() => {
            action.reset(); if (sentRecovery.current === null && sentRevision.current === null) setDraft(lastSent); sentRecovery.current = null; sentRevision.current = null;
          }} style={styles.link}><Text style={styles.linkText}>메시지 수정</Text></Pressable>}
        </View>}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput accessibilityLabel="채팅 메시지" multiline placeholder="메시지 입력" placeholderTextColor="#58667E" selectionColor="#3563E9" value={messageDraft} onChangeText={editMessage} editable={!busy} style={styles.input} />
        <Pressable accessibilityRole="button" accessibilityLabel="메시지 보내기" accessibilityState={{ disabled: busy || entryChanging || !messageDraft.trim() }} disabled={busy || entryChanging || !messageDraft.trim()} onPress={send} style={({ pressed }) => [styles.send, (busy || entryChanging || !messageDraft.trim()) && styles.disabled, pressed && styles.pressed]}><Icon name="arrowUp" size={20} color={colors.surface} /><Text style={styles.sendText}>보내기</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  welcomeMark: { width: 48, height: 48, borderRadius: 17, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  messageHeading: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  welcomeTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  starters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  starter: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: 12, borderRadius: 16, backgroundColor: colors.primarySoft },
  starterText: { flexShrink: 1, color: colors.primary, fontSize: 13, fontWeight: '600' },
  container: { flex: 1 },
  heading: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 26, fontWeight: '700', color: colors.text },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  pill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', paddingHorizontal: 13, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#E8EDF6', borderRadius: 16 },
  pillText: { color: '#34435D', fontSize: 13, fontWeight: '600' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, alignSelf: 'flex-start' },
  linkText: { color: '#2851C7', fontSize: 14, fontWeight: '700' },
  target: { marginTop: 12, padding: 14, gap: 4, backgroundColor: '#EEF3FF', borderRadius: 18 },
  targetTitle: { color: colors.text, fontWeight: '700' },
  targetHint: { color: '#52627C', fontSize: 13, lineHeight: 20 },
  conversation: { flex: 1 },
  messages: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 18, gap: 12 },
  welcome: { paddingHorizontal: 4, paddingVertical: 8 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  message: { alignSelf: 'stretch', padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#EDF0F7', borderRadius: 20 },
  userMessage: { alignSelf: 'flex-end', maxWidth: '90%', backgroundColor: '#17191D', borderColor: '#17191D', borderBottomRightRadius: 7 },
  statusMessage: { backgroundColor: '#EEF3FF', borderColor: '#E5ECFF' },
  messageRole: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  userMessageRole: { color: '#F2F5FF' },
  messageText: { color: colors.text, fontSize: 15, lineHeight: 23 },
  userMessageText: { color: colors.surface },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, backgroundColor: colors.surface, borderRadius: 18 },
  loadingText: { color: colors.muted, fontSize: 14 },
  errorBox: { alignItems: 'flex-start', padding: 14, backgroundColor: '#FFF5F5', borderRadius: 18 },
  error: { color: '#A01818', lineHeight: 22 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 },
  input: { flex: 1, minHeight: 50, maxHeight: 120, paddingHorizontal: 16, paddingVertical: 13, borderWidth: 1, borderColor: '#E4EAF4', borderRadius: 18, backgroundColor: colors.surface, color: colors.text },
  send: { minHeight: 50, minWidth: 50, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, backgroundColor: '#5369CA', borderRadius: 18 },
  draftCard: { padding: 16, gap: 6, borderRadius: 16, backgroundColor: '#EEEFFF', borderWidth: 1, borderColor: '#FFFFFF' },
  draftButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#5369CA', borderRadius: 12, paddingHorizontal: 12 },
  draftButtonText: { color: '#FFFFFF', fontWeight: '700' },
  sendText: { color: colors.surface, fontSize: 10, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
