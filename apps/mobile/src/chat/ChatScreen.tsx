import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import type { ChatInput } from '@pikku/domain';
import { ApiError } from '../api/http';
import { useMutation } from '../api/useMutation';
import type { ScheduleClient } from '../schedule/client';
import type { ChatClient, ChatResponse, CoordinationTarget } from './client';
import { ChatScheduleSummary } from './ChatScheduleSummary';

type ChatEntry = { id: string; role: 'user' | 'assistant' | 'status'; text: string };
type Input = Omit<ChatInput, 'requestId'>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthenticated': return '개발 연결 설정에서 세션 토큰을 확인해 주세요.';
      case 'not_configured': return '필요한 서버 기능이 아직 설정되지 않았습니다.';
      case 'not_implemented': return '대화 기능이 서버에 아직 구현되지 않았습니다.';
      case 'timeout': return '서버 응답 시간이 초과되어 요청 처리 결과를 확인할 수 없습니다.';
      case 'network': return '서버에 연결할 수 없습니다. 서버 주소와 네트워크를 확인해 주세요.';
      case 'invalid_configuration': return 'API 서버 주소를 확인해 주세요.';
      case 'invalid_response': return '서버 응답 형식이 올바르지 않습니다.';
      case 'stale_proposal': case 'conflict': return '기준 정보가 변경되었습니다. 최신 일정을 확인해 주세요.';
      default: return '서버 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    }
  }
  return '요청 결과를 확인할 수 없습니다.';
}

export default function ChatScreen({ client, timezone, scheduleClient, selectedDate, refreshVersion, onOpenProposals, onProposalCreated, onOpenMemory, onOpenReviewSchedule, coordinationTarget, onClearCoordinationTarget }: {
  client: ChatClient;
  timezone: string;
  scheduleClient: ScheduleClient;
  selectedDate: Date;
  refreshVersion: number;
  onOpenProposals: () => void;
  onProposalCreated: () => void;
  onOpenMemory: () => void;
  onOpenReviewSchedule: () => void;
  coordinationTarget?: CoordinationTarget & { title: string };
  onClearCoordinationTarget: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [lastSent, setLastSent] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const counter = useRef(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const action = useMutation<Input, ChatResponse>(
    (operation) => client.sendMessage({ ...operation.input, requestId: operation.requestId, idempotencyKey: operation.idempotencyKey }),
    (response) => {
      setConversationId(response.conversationId);
      const result = response.result;
      if (result.kind === 'failure') {
        setAgentError(result.message);
        return;
      }
      const replyId = `reply-${++counter.current}`;
      setEntries((previous) => [
        ...previous,
        { id: replyId, role: 'assistant', text: result.message },
        ...(result.kind === 'proposal'
          ? [{ id: `${replyId}-status`, role: 'status' as const, text: '제안 목록에서 변경 전후와 이유를 검토하세요. 승인 전에는 적용되지 않습니다.' }]
          : []),
      ]);
      if (result.kind === 'proposal') onProposalCreated();
    },
  );
  useEffect(() => { if (action.state.status === 'success') action.reset(); }, [action.state.status]);

  function send() {
    const message = draft.trim();
    if (!message || action.state.status !== 'idle') return;
    setAgentError(null);
    setLastSent(message);
    setDraft('');
    const userId = `user-${++counter.current}`;
    setEntries((previous) => [
      ...previous,
      { id: userId, role: 'user', text: message },
      ...(coordinationTarget ? [{ id: `${userId}-target`, role: 'status' as const, text: `이 요청의 공동 조정 검토 대상: ${coordinationTarget.title}. 선택은 변경·연락 승인이 아닙니다.` }] : []),
    ]);
    action.submit({ message, conversationId, timezone, ...(coordinationTarget ? { coordinationTarget: { id: coordinationTarget.id, expectedRevision: coordinationTarget.expectedRevision } } : {}) });
  }

  const busy = action.state.status !== 'idle';
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">AI 채팅</Text>
        <View style={styles.links}>
          <Pressable accessibilityRole="button" onPress={onOpenProposals} style={styles.link}><Text>제안 검토</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenMemory} style={styles.link}><Text>선호·상황</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenReviewSchedule} style={styles.link}><Text>자동 검토 설정</Text></Pressable>
        </View>
        {coordinationTarget && <View style={styles.target}>
          <Text>조정 검토 대상: {coordinationTarget.title}</Text>
          <Text>대상 선택은 일정 변경이나 연락 승인이 아닙니다.</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onClearCoordinationTarget} style={styles.link}><Text>대상 선택 해제</Text></Pressable>
        </View>}
      </View>
      <ScrollView ref={scrollRef} style={styles.conversation} contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
        <ChatScheduleSummary client={scheduleClient} selectedDate={selectedDate} timezone={timezone} refreshVersion={refreshVersion} />
        {entries.length === 0 && <Text style={styles.empty}>메시지를 입력해 대화를 시작하세요.</Text>}
        {entries.map((entry) => <View key={entry.id} style={[styles.message, entry.role === 'user' && styles.userMessage]}>
          <Text style={styles.messageRole}>{entry.role === 'user' ? '나' : entry.role === 'assistant' ? 'AI 응답' : '요청 상태'}</Text>
          <Text style={styles.messageText}>{entry.text}</Text>
        </View>)}
        {action.state.status === 'pending' && <View style={styles.loading} accessibilityLiveRegion="polite"><ActivityIndicator size="small" /><Text>서버 응답을 기다리는 중입니다.</Text></View>}
        {agentError && <Text style={styles.error} accessibilityRole="alert">{agentError}</Text>}
        {action.state.status === 'error' && <View style={styles.errorBox}>
          <Text style={styles.error} accessibilityRole="alert">{errorMessage(action.state.error)}</Text>
          {action.state.uncertain && <Text style={styles.error}>결과를 확인할 때까지 같은 요청만 다시 시도합니다.</Text>}
          <Pressable accessibilityRole="button" onPress={action.retry} style={styles.link}><Text>같은 요청 다시 시도</Text></Pressable>
          {!action.state.uncertain && <Pressable accessibilityRole="button" onPress={() => { action.reset(); setDraft(lastSent); }} style={styles.link}><Text>메시지 수정</Text></Pressable>}
        </View>}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput accessibilityLabel="채팅 메시지" multiline placeholder="메시지 입력" value={draft} onChangeText={setDraft} editable={!busy} style={styles.input} />
        <Pressable accessibilityRole="button" accessibilityLabel="메시지 보내기" accessibilityState={{ disabled: busy || !draft.trim() }} disabled={busy || !draft.trim()} onPress={send} style={({ pressed }) => [styles.send, (busy || !draft.trim()) && styles.disabled, pressed && styles.pressed]}><Text style={styles.sendText}>보내기</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heading: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  title: { fontSize: 24, fontWeight: '700', color: '#171717' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, alignSelf: 'flex-start' },
  target: { padding: 10, gap: 4, backgroundColor: '#e7eaf0', borderRadius: 8 },
  conversation: { flex: 1 },
  messages: { paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  empty: { color: '#666', lineHeight: 22 },
  message: { alignSelf: 'stretch', padding: 12, backgroundColor: '#f1f1f1', borderRadius: 8 },
  userMessage: { backgroundColor: '#e7eaf0' },
  messageRole: { color: '#444', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  messageText: { color: '#171717', lineHeight: 22 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorBox: { alignItems: 'flex-start' },
  error: { color: '#a01818', lineHeight: 22 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderColor: '#ddd' },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#aaa', borderRadius: 8, color: '#171717' },
  send: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#333', borderRadius: 8 },
  sendText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
