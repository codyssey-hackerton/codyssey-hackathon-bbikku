import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { isUncertainMutationError } from '../api/mutation';
import { operationGuard } from '../api/operationGuard';
import type { Proposal, ProposalClient } from '../proposals/client';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createContactClient } from './client';
import { proposalDraft } from './draft';
import type { ContactClient, ContactCallInput, ContactDecisionInput, ContactDraftInput, ContactRequest, ContactResponse, ContactResults, ContactSendInput, EmailConnection, PhoneConnection, RecipientInput } from './client';

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'success'; data: T };
type Props = {
  api: ApiClient;
  proposal: Proposal;
  proposalClient: ProposalClient;
  renderProposal: (proposal: Proposal) => ReactNode;
  onScheduleChanged?: () => void;
  onBack: () => void;
};

const deliveryText: Record<ContactRequest['deliveryStatus'], string> = {
  pending_approval: '승인 대기', rejected: '승인 거절', ready: '발송 준비', submitting: '발송 처리 중',
  sent_or_connected: '발송됨', failed: '발송 실패', outcome_unknown: '발송 결과 불명',
};
function deliveryLabel(contact: ContactRequest): string {
  return contact.channel === 'phone' && contact.deliveryStatus === 'sent_or_connected'
    ? '전화 요청 접수, 연결·응답 미확인' : deliveryText[contact.deliveryStatus];
}
const negotiationText: Record<ContactRequest['negotiationStatus'], string> = {
  not_started: '상대 응답 전', awaiting_response: '상대 응답 대기', accepted: '상대 수락 확인',
  declined: '상대 거절 확인', alternative_proposed: '상대 대안 제시', needs_user_review: '사용자 확인 필요', applied: '일정 반영됨',
};

function Button({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <ActionButton label={label} onPress={onPress} disabled={disabled} secondary={secondary} />;
}

function Loading({ children }: { children: string }) {
  return <View style={styles.row} accessibilityLiveRegion="polite"><ActivityIndicator size="small" /><Text style={styles.text}>{children}</Text></View>;
}

function ErrorNotice({ error }: { error?: unknown }) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const message = code === 'not_configured' ? '연락에 필요한 연결 또는 기능이 설정되지 않았습니다. 개발 환경의 설정을 확인해 주세요.' :
    code === 'stale_proposal' || code === 'expired_proposal' || code === 'conflict' ? '일정, 제안 또는 연락 상태가 변경되었습니다. 다시 조회해 확인해 주세요.' :
      code === 'invalid_response' ? '서버 응답의 연락 내용이나 상태를 확인할 수 없습니다.' :
      code === 'operation_in_progress' ? '같은 요청을 서버에서 처리 중입니다. 상태를 조회해 주세요.' :
        code === 'unauthenticated' ? '연결된 세션을 확인해 주세요.' : '요청을 완료하지 못했습니다. 연결과 상태를 확인해 주세요.';
  return <Text style={styles.error} accessibilityRole="alert">{message}</Text>;
}

function sameSubject(before: ContactRequest, after: ContactRequest): boolean {
  return before.id === after.id && before.revision === after.revision && before.recipientRef === after.recipientRef &&
    before.baseScheduleRevision === after.baseScheduleRevision && before.baseContextRevision === after.baseContextRevision &&
    before.executionKey === after.executionKey && before.createdAt === after.createdAt && before.channel === after.channel &&
    before.recipientSnapshot.displayName === after.recipientSnapshot.displayName && before.recipientSnapshot.address === after.recipientSnapshot.address &&
    before.recipientSnapshot.channel === after.recipientSnapshot.channel && before.purpose === after.purpose && before.messageOrCallBrief === after.messageOrCallBrief &&
    (before.approvalId === null || before.approvalId === after.approvalId) && before.allowedOptions.length === after.allowedOptions.length &&
    before.allowedOptions.every((option, index) => option.optionId === after.allowedOptions[index].optionId &&
      option.proposalId === after.allowedOptions[index].proposalId && option.proposalRevision === after.allowedOptions[index].proposalRevision);
}

function requireSameSubject(before: ContactRequest, after: ContactRequest): ContactRequest {
  if (!sameSubject(before, after)) throw new ApiError('invalid_response', '연락 내용이 변경되어 다시 확인해야 합니다.');
  return after;
}

function validPhoneMessage(value: string): boolean {
  if (!value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffe\uffff]/u.test(value) ||
      Array.from(value).some((char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) return false;
  const escaped = value.replace(/[&<>"'\r]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[char]!);
  return `<Response><Say voice="Google.ko-KR-Standard-A" language="ko-KR">${escaped}</Say></Response>`.length <= 4000;
}

function ContactDraft({ client, proposal, onSaved, onCancel }: {
  client: ContactClient; proposal: Proposal; onSaved: (contact: ContactRequest) => void; onCancel: () => void;
}) {
  const [channel, setChannel] = useState<'email' | 'phone'>('email');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [suggestion] = useState(() => proposalDraft(proposal));
  const [purpose, setPurpose] = useState(suggestion.purpose);
  const [body, setBody] = useState(suggestion.messageOrCallBrief);
  const [confirmed, setConfirmed] = useState(false);
  const intent = useRef<Omit<ContactDraftInput, 'recipientRef'> | null>(null);
  const draft = useMutation<ContactDraftInput, ContactRequest>(async (op) => {
    const result = await client.createDraft(op);
    if (result.recipientSnapshot.displayName !== name.trim() || result.recipientSnapshot.address !== address.trim()) {
      throw new ApiError('invalid_response', '확인한 수신자와 저장된 수신자가 다릅니다.');
    }
    return result;
  }, onSaved);
  const recipient = useMutation<RecipientInput, Awaited<ReturnType<ContactClient['createRecipient']>>>(
    (op) => client.createRecipient(op),
    (result) => { if (intent.current) draft.submit({ ...intent.current, recipientRef: result.id }); },
  );
  const blocked = recipient.state.status !== 'idle' || draft.state.status !== 'idle';
  const valid = name.trim().length > 0 && (channel === 'email' ? address.trim().length > 0 : /^\+[1-9]\d{1,14}$/.test(address.trim())) && purpose.trim().length > 0 &&
    (channel === 'phone' ? validPhoneMessage(body) : body.trim().length > 0) && confirmed;

  function save() {
    if (blocked || !valid) return;
    intent.current = { channel, purpose: purpose.trim(), messageOrCallBrief: body,
      allowedOptions: [{ optionId: 'option-1', proposalId: proposal.id, proposalRevision: proposal.revision }] };
    recipient.submit({ displayName: name.trim(), address: address.trim(), channel, confirmed: true });
  }

  function editAgain() {
    if ((recipient.state.status === 'error' && recipient.state.uncertain) || (draft.state.status === 'error' && draft.state.uncertain)) return;
    recipient.reset();
    draft.reset();
  }

  return <>
    <View style={styles.row}><Text accessibilityRole="header" style={styles.title}>연락 초안 작성</Text>
      <Button label="작성 취소" onPress={onCancel} disabled={blocked} secondary /></View>
    <Text style={styles.notice}>초안 저장은 연락 발송이나 일정 변경이 아닙니다. 수신자와 내용을 직접 확인해 주세요.</Text>
    <Text style={styles.text}>제안 기반 초안입니다. 제목과 본문을 직접 수정할 수 있습니다.</Text>
    <View style={styles.actions}>
      <Button label={channel === 'email' ? '이메일 선택됨' : '이메일 선택'} disabled={blocked} onPress={() => { setChannel('email'); setAddress(''); setConfirmed(false); }} secondary />
      <Button label={channel === 'phone' ? '전화 선택됨' : '전화 선택'} disabled={blocked} onPress={() => { setChannel('phone'); setAddress(''); setConfirmed(false); }} secondary />
    </View>
    <Text style={styles.label}>수신자 이름</Text>
    <TextInput accessibilityLabel="수신자 이름" editable={!blocked} maxLength={200} value={name}
      onChangeText={(value) => { setName(value); setConfirmed(false); }} style={styles.input} />
    <Text style={styles.label}>{channel === 'email' ? '수신자 이메일' : '수신자 전화번호 (E.164)'}</Text>
    <TextInput accessibilityLabel={channel === 'email' ? '수신자 이메일' : '수신자 전화번호'} editable={!blocked} maxLength={254} value={address} autoCapitalize="none" autoCorrect={false} keyboardType={channel === 'email' ? 'email-address' : 'phone-pad'}
      onChangeText={(value) => { setAddress(value); setConfirmed(false); }} style={styles.input} />
    <Button label={confirmed ? '수신자 확인됨' : channel === 'email' ? '입력한 수신자 이름과 이메일 확인' : '입력한 수신자 이름과 전화번호 확인'} onPress={() => setConfirmed(!confirmed)} disabled={blocked || !name.trim() || !address.trim()} secondary />
    <Text style={styles.label}>{channel === 'email' ? '메일 제목' : '전화 목적'}</Text>
    <TextInput accessibilityLabel={channel === 'email' ? '메일 제목' : '전화 목적'} editable={!blocked} maxLength={200} value={purpose} onChangeText={setPurpose} style={styles.input} />
    <Text style={styles.label}>{channel === 'email' ? '메일 본문' : '읽을 전화 내용'}</Text>
    <TextInput accessibilityLabel={channel === 'email' ? '메일 본문' : '읽을 전화 내용'} editable={!blocked} multiline maxLength={20000} value={body} onChangeText={setBody} style={[styles.input, styles.body]} />
    {channel === 'phone' && !validPhoneMessage(body) && <Text accessibilityRole="alert" style={styles.error}>전화 내용에서 지원하지 않는 제어문자를 지우거나 길이를 줄여 주세요.</Text>}
    <Text style={styles.text}>선택한 제안: {proposal.id} · 버전 {proposal.revision}</Text>
    {!blocked && <Button label="연락 초안 저장" onPress={save} disabled={!valid} />}
    {(recipient.state.status === 'pending' || draft.state.status === 'pending') && <Loading>초안을 저장하는 중입니다.</Loading>}
    {recipient.state.status === 'error' && <><ErrorNotice error={recipient.state.error} />
      {recipient.state.uncertain && <Text style={styles.notice}>수신자 저장 결과를 확인하지 못했습니다. 동일한 요청만 다시 시도합니다.</Text>}
      <Button label="수신자 저장 동일 요청 재시도" onPress={recipient.retry} />
      {!recipient.state.uncertain && <Button label="입력 수정" onPress={editAgain} secondary />}</>}
    {draft.state.status === 'error' && <><ErrorNotice error={draft.state.error} />
      {draft.state.uncertain && <Text style={styles.notice}>초안 저장 결과를 확인하지 못했습니다. 동일한 요청만 다시 시도합니다.</Text>}
      <Button label="초안 저장 동일 요청 재시도" onPress={draft.retry} />
      {!draft.state.uncertain && <Button label="입력 수정" onPress={editAgain} secondary />}</>}
  </>;
}

function ContactDetail({ client, proposalClient, contact, renderProposal, onChange, onReconcile, onScheduleChanged, onBack }: {
  client: ContactClient; proposalClient: ProposalClient; contact: ContactRequest;
  renderProposal: (proposal: Proposal) => ReactNode; onChange: (contact: ContactRequest) => void;
  onReconcile: (contact: ContactRequest) => void; onScheduleChanged?: () => void; onBack: () => void;
}) {
  const [preview, setPreview] = useState<Load<Proposal[]>>({ status: 'loading' });
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [connection, setConnection] = useState<Load<EmailConnection | PhoneConnection>>({ status: 'loading' });
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [setup, setSetup] = useState<'idle' | 'pending' | 'uncertain' | 'error'>('idle');
  const setupOwner = useRef<object>({});
  const setupLock = useRef(false);
  const setupNumber = useRef('');
  const setupRequestId = useRef('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operationGuard.clear(setupOwner.current); }; }, []);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [senderNeedsReview, setSenderNeedsReview] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState(false);
  const [readyAfterLookup, setReadyAfterLookup] = useState(false);
  const [replyConnection, setReplyConnection] = useState<Load<EmailConnection>>({ status: 'loading' });
  const [replyConnectionAttempt, setReplyConnectionAttempt] = useState(0);
  const [results, setResults] = useState<Load<ContactResponse[]> | null>(null);
  const [resultChoice, setResultChoice] = useState<{ responseId: string; optionId: string } | null>(null);
  const [requiresNewProposal, setRequiresNewProposal] = useState(false);
  const [resultsBusy, setResultsBusy] = useState(false);
  const lookupLock = useRef(false);
  const resultsLock = useRef(false);
  const resultVersion = useRef(0);
  const changed = (item: ContactRequest) => { resultVersion.current += 1; onChange(item); };
  const decision = useMutation<ContactDecisionInput, ContactRequest>(async (op) => requireSameSubject(contact, await client.decide(op)), changed);
  const send = useMutation<ContactSendInput | ContactCallInput, ContactRequest>(async (op) => requireSameSubject(contact, await ('expectedSenderNumber' in op.input ? client.call({ ...op, input: op.input }) : client.send({ ...op, input: op.input }))), changed);
  const applyResults = (result: ContactResults) => {
    const latest = requireSameSubject(contact, result.contactRequest);
    setResults({ status: 'success', data: result.responses }); setResultChoice(null); changed(latest); onScheduleChanged?.();
  };
  const checkReplies = useMutation<{ id: string; contactRevision: number }, Awaited<ReturnType<ContactClient['checkReplies']>>>(
    async (op) => { const result = await client.checkReplies(op); requireSameSubject(contact, result.contactRequest); return result; }, applyResults);
  const confirmResponse = useMutation<{ id: string; responseId: string; contactRevision: number; selectedOptionId: string }, Awaited<ReturnType<ContactClient['confirmResponse']>>>(
    async (op) => { const result = await client.confirmResponse(op); requireSameSubject(contact, result.contactRequest); return result; },
    (result) => { changed(result.contactRequest); setResultChoice(null); setResults(null); if (!result.changed) setRequiresNewProposal(true); onScheduleChanged?.(); });
  const locked = decision.state.status === 'pending' || decision.state.status === 'error' ||
    send.state.status === 'pending' || send.state.status === 'error' || lookupBusy || resultsBusy ||
    checkReplies.state.status === 'pending' || (checkReplies.state.status === 'error' && checkReplies.state.uncertain) ||
    confirmResponse.state.status === 'pending' || (confirmResponse.state.status === 'error' && confirmResponse.state.uncertain) ||
    setup === 'pending' || setup === 'uncertain';

  useEffect(() => {
    if (contact.channel !== 'email' || contact.deliveryStatus !== 'sent_or_connected') return;
    let active = true; setReplyConnection({ status: 'loading' });
    client.emailReplyConnection().then((data) => { if (active) setReplyConnection({ status: 'success', data }); },
      () => { if (active) setReplyConnection({ status: 'error' }); });
    return () => { active = false; };
  }, [client, contact.channel, contact.deliveryStatus, replyConnectionAttempt]);

  useEffect(() => {
    let active = true;
    setPreview({ status: 'loading' });
    Promise.all(contact.allowedOptions.map(async (option) => {
      const item = await proposalClient.get(option.proposalId);
      if (item.revision !== option.proposalRevision || item.mode !== 'coordination') throw new Error('Proposal revision changed');
      return item;
    })).then((items) => { if (active) setPreview({ status: 'success', data: items }); },
      () => { if (active) setPreview({ status: 'error' }); });
    return () => { active = false; };
  }, [contact.id, contact.revision, proposalClient, previewAttempt]);

  useEffect(() => {
    let active = true;
    setConnection({ status: 'loading' });
    (contact.channel === 'phone' ? client.phoneConnection() : client.emailConnection()).then((data) => { if (active) {
      setConnection({ status: 'success', data }); setSenderNeedsReview(false);
      if (setupLock.current && data.status === 'available' && 'senderNumber' in data && data.senderNumber === setupNumber.current &&
          data.lastRequestId === setupRequestId.current) {
        setupLock.current = false; setupNumber.current = ''; setupRequestId.current = ''; operationGuard.clear(setupOwner.current); setSetup('idle');
      }
    } },
      () => { if (active) setConnection({ status: 'error' }); });
    return () => { active = false; };
  }, [client, contact.channel, connectionAttempt]);

  async function connectPhone() {
    if (setupLock.current || !accountSid.trim() || !authToken.trim() || !/^\+[1-9]\d{1,14}$/.test(fromNumber.trim())) return;
    setupLock.current = true;
    const input = { accountSid: accountSid.trim(), authToken: authToken.trim(), fromNumber: fromNumber.trim() };
    setupNumber.current = input.fromNumber;
    setAccountSid(''); setAuthToken(''); setFromNumber(''); setSetup('pending');
    operationGuard.update(setupOwner.current, { status: 'pending' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setupRequestId.current = `request-${id}`;
    try {
      const data = await client.connectPhone({ input, requestId: setupRequestId.current, idempotencyKey: `operation-${id}` });
      if (!mounted.current) return;
      if (data.status !== 'available' || data.senderNumber !== setupNumber.current) throw new ApiError('invalid_response', '발신 번호를 확인할 수 없습니다.');
      setupLock.current = false; setupNumber.current = ''; setupRequestId.current = ''; operationGuard.clear(setupOwner.current);
      setConnection({ status: 'success', data }); setSenderNeedsReview(false); setSetup('idle');
    } catch (error) {
      if (!mounted.current) return;
      const uncertain = isUncertainMutationError(error);
      if (!uncertain) { setupLock.current = false; setupNumber.current = ''; setupRequestId.current = ''; operationGuard.clear(setupOwner.current); }
      else operationGuard.update(setupOwner.current, { status: 'error', error: undefined, uncertain: true });
      setSetup(uncertain ? 'uncertain' : 'error');
    }
  }

  async function lookup() {
    if (lookupLock.current) return;
    lookupLock.current = true;
    const version = resultVersion.current;
    setLookupBusy(true);
    setLookupError(false);
    try {
      const latest = requireSameSubject(contact, await client.get(contact.id));
      if (version !== resultVersion.current) return;
      if (latest.negotiationStatus !== contact.negotiationStatus) onScheduleChanged?.();
      if ((send.state.status === 'pending' || (send.state.status === 'error' && send.state.uncertain)) && latest.deliveryStatus === 'ready') {
        setReadyAfterLookup(send.state.status === 'error');
      } else if ((decision.state.status === 'pending' || (decision.state.status === 'error' && decision.state.uncertain)) && latest.deliveryStatus === 'pending_approval') {
        // A still-pending draft does not resolve the in-flight approval request.
      } else {
        if (send.state.status === 'error' && !send.state.uncertain) {
          if (send.state.error instanceof ApiError && send.state.error.code === 'conflict') setSenderNeedsReview(true);
          send.reset();
        }
        if (decision.state.status === 'error' && !decision.state.uncertain) decision.reset();
        if ((send.state.status === 'error' && send.state.uncertain) || (decision.state.status === 'error' && decision.state.uncertain)) {
          resultVersion.current += 1;
          onReconcile(latest);
        } else {
          changed(latest);
        }
      }
    } catch { if (version === resultVersion.current) setLookupError(true); } finally { lookupLock.current = false; setLookupBusy(false); }
  }

  async function lookupResponses() {
    if (resultsLock.current) return;
    resultsLock.current = true; setResultsBusy(true); setResults({ status: 'loading' });
    const version = resultVersion.current;
    try {
      const result = await client.responses(contact.id);
      if (mounted.current && version === resultVersion.current) applyResults(result);
    } catch { if (mounted.current && version === resultVersion.current) setResults({ status: 'error' }); }
    finally { resultsLock.current = false; if (mounted.current) setResultsBusy(false); }
  }

  const canSend = contact.deliveryStatus === 'ready' && connection.status === 'success' && connection.data.status === 'available' && !senderNeedsReview;
  const shownDelivery = send.state.status === 'pending' ? '발송 요청 처리 중' :
    send.state.status === 'error' && send.state.uncertain ? '발송 결과 확인 필요' :
    deliveryLabel(contact);
  return <>
    <View style={styles.row}><Text accessibilityRole="header" style={styles.title}>연락 승인과 발송</Text>
      <Button label="연락 목록" onPress={onBack} disabled={locked} secondary /></View>
    <Text accessibilityLiveRegion="polite" style={styles.notice}>발송 상태: {shownDelivery} · 상대 응답: {negotiationText[contact.negotiationStatus]}</Text>
    <Text style={styles.text}>{contact.channel === 'phone' ? '전화 요청 접수는 통화 연결이나 상대 수락의 증거가 아닙니다.' : 'Gmail 발송은 상대의 수락이 아닙니다.'}</Text>
    <Text accessibilityRole="header" style={styles.section}>승인할 내용 미리보기</Text>
    <View style={styles.card}>
      <Text style={styles.text}>수신자: {contact.recipientSnapshot.displayName}</Text>
      <Text style={styles.text}>{contact.channel === 'email' ? '이메일' : '전화번호'}: {contact.recipientSnapshot.address}</Text>
      <Text style={styles.text}>{contact.channel === 'email' ? '제목' : '전화 목적'}: {contact.purpose}</Text>
      <Text style={styles.text}>{contact.channel === 'email' ? '본문:' : '읽을 내용:'}</Text><Text style={styles.text}>{contact.messageOrCallBrief}</Text>
      <Text style={styles.muted}>연락 요청 {contact.id} · 버전 {contact.revision}</Text>
    </View>
    <Text accessibilityRole="header" style={styles.section}>승인 범위: 선택한 제안의 전체 변경</Text>
    <Text style={styles.text}>상대가 아래 승인된 시간 대안 중 하나를 명확히 수락하고 현재 일정을 다시 검증한 경우에만 해당 대안을 반영할 수 있습니다.</Text>
    {preview.status === 'loading' && <Loading>승인할 제안을 불러오는 중입니다.</Loading>}
    {preview.status === 'error' && <><Text style={styles.error} accessibilityRole="alert">선택한 제안의 같은 버전을 확인할 수 없어 승인할 수 없습니다.</Text>
      <Button label="승인 범위 다시 조회" onPress={() => setPreviewAttempt((value) => value + 1)} secondary /></>}
    {preview.status === 'success' && preview.data.map((item) => <View key={item.id}>{renderProposal(item)}</View>)}
    {contact.deliveryStatus === 'pending_approval' && decision.state.status === 'idle' && <View style={styles.actions}>
      <Button label="연락 내용 승인" disabled={preview.status !== 'success' || locked} onPress={() => decision.submit({ id: contact.id, contactRevision: contact.revision, decision: 'accept' })} />
      <Button label="연락 거절" disabled={locked} onPress={() => decision.submit({ id: contact.id, contactRevision: contact.revision, decision: 'reject' })} secondary />
    </View>}
    {decision.state.status === 'pending' && <Loading>연락 승인 결과를 확인하는 중입니다.</Loading>}
    {decision.state.status === 'error' && <><ErrorNotice error={decision.state.error} />
      {decision.state.uncertain && <Text style={styles.notice}>승인 처리 여부를 확인하지 못했습니다. 같은 요청만 다시 시도할 수 있습니다.</Text>}
      <Button label="연락 결정 동일 요청 재시도" onPress={decision.retry} />
      {!decision.state.uncertain && <Button label="결정 오류 닫기" onPress={decision.reset} secondary />}</>}
    {contact.deliveryStatus === 'ready' && <>
      <Text accessibilityRole="header" style={styles.section}>{contact.channel === 'phone' ? '전화 요청' : 'Gmail 발송'}</Text>
      {connection.status === 'loading' && <Loading>발신 계정 설정을 확인하는 중입니다.</Loading>}
      {connection.status === 'error' && <ErrorNotice />}
      {connection.status === 'success' && (connection.data.status === 'available'
        ? <Text style={styles.text}>{contact.channel === 'phone' ? '발신 번호' : '발신 계정'}: {'senderNumber' in connection.data ? connection.data.senderNumber : connection.data.senderAddress}</Text>
        : <Text style={styles.notice}>{contact.channel === 'phone' ? '발신 전화번호가 설정되지 않았습니다.' : '발신 Gmail 계정이 설정되지 않았습니다. 개발 환경의 계정 연결 설정을 완료한 뒤 다시 확인해 주세요.'}</Text>)}
      {contact.channel === 'phone' && connection.status === 'success' && connection.data.status === 'not_configured' && setup !== 'uncertain' && <>
        <TextInput accessibilityLabel="전화 계정 SID" placeholder="계정 SID" value={accountSid} onChangeText={setAccountSid} editable={!locked} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <TextInput accessibilityLabel="전화 인증 토큰" placeholder="인증 토큰" value={authToken} onChangeText={setAuthToken} editable={!locked} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <TextInput accessibilityLabel="발신 전화번호" placeholder="발신 번호 (E.164)" value={fromNumber} onChangeText={setFromNumber} editable={!locked} keyboardType="phone-pad" style={styles.input} />
        <Button label="전화 연결 설정" onPress={connectPhone} disabled={locked || !accountSid.trim() || !authToken.trim() || !/^\+[1-9]\d{1,14}$/.test(fromNumber.trim())} />
      </>}
      {setup === 'pending' && <Loading>전화 연결 설정을 확인하는 중입니다.</Loading>}
      {setup === 'error' && <Text style={styles.error}>전화 연결 설정에 실패했습니다. 값을 다시 입력해 주세요.</Text>}
      {setup === 'uncertain' && <Text style={styles.notice}>전화 연결 설정 결과를 확인하지 못했습니다. 발신 번호를 다시 확인해 주세요.</Text>}
      {senderNeedsReview && <Text style={styles.notice}>발신 계정을 다시 확인한 뒤 발송해 주세요.</Text>}
      {connection.status !== 'loading' && <Button label={contact.channel === 'phone' ? '발신 번호 다시 확인' : '발신 계정 다시 확인'} disabled={locked && setup !== 'uncertain'} onPress={() => {
        setSenderNeedsReview(true); setConnection({ status: 'loading' }); setConnectionAttempt((value) => value + 1);
      }} secondary />}
      {send.state.status === 'idle' && <Button label={contact.channel === 'phone' ? '전화 요청' : 'Gmail 발송'} disabled={!canSend || locked} onPress={() => {
        if (connection.status === 'success' && connection.data.status === 'available' && !senderNeedsReview) {
          if ('senderNumber' in connection.data) send.submit({ id: contact.id, contactRevision: contact.revision, expectedSenderNumber: connection.data.senderNumber });
          else send.submit({ id: contact.id, contactRevision: contact.revision, expectedSenderAddress: connection.data.senderAddress });
        }
      }} /> }
    </>}
    {send.state.status === 'pending' && <Loading>발송 처리 상태를 확인하는 중입니다.</Loading>}
    {send.state.status === 'error' && <><ErrorNotice error={send.state.error} />
      {send.state.uncertain && <Text style={styles.notice}>발송 결과를 확인하지 못했습니다. 먼저 상태를 조회해 주세요.</Text>}
      {send.state.uncertain && readyAfterLookup &&
        <Button label="동일 발송 요청 재시도" disabled={!canSend || lookupBusy} onPress={() => { setReadyAfterLookup(false); send.retry(); }} />}
      {!send.state.uncertain && <Button label="발송 오류 닫기" onPress={() => {
        if (send.state.status === 'error' && send.state.error instanceof ApiError && send.state.error.code === 'conflict') setSenderNeedsReview(true);
        send.reset();
      }} secondary />}</>}
    {contact.deliveryStatus === 'sent_or_connected' && <>
      <Text accessibilityRole="header" style={styles.section}>상대 응답 확인</Text>
      {contact.channel === 'email' && <>
        {replyConnection.status === 'loading' && <Loading>Gmail 회신 조회 설정을 확인하는 중입니다.</Loading>}
        {replyConnection.status === 'error' && <Text style={styles.error} accessibilityRole="alert">Gmail 회신 조회 설정을 확인하지 못했습니다.</Text>}
        {replyConnection.status === 'success' && replyConnection.data.status === 'not_configured' &&
          <Text style={styles.notice}>Gmail 회신 읽기 권한이 설정되지 않았습니다. 발송 연결과 별도로 설정해 주세요.</Text>}
        {replyConnection.status !== 'loading' && <Button label="회신 조회 설정 다시 확인" disabled={locked} onPress={() => setReplyConnectionAttempt((value) => value + 1)} secondary />}
        {(checkReplies.state.status === 'idle' || checkReplies.state.status === 'success') && <Button label="회신 확인" disabled={locked || replyConnection.status !== 'success' || replyConnection.data.status !== 'available'} onPress={() => {
          if (checkReplies.state.status === 'success') checkReplies.reset();
          checkReplies.submit({ id: contact.id, contactRevision: contact.revision });
        }} />}
        {checkReplies.state.status === 'pending' && <Loading>Gmail 회신을 확인하는 중입니다.</Loading>}
        {checkReplies.state.status === 'error' && <><Text style={styles.error} accessibilityRole="alert">Gmail 회신 조회에 실패했습니다. 회신이 없다는 뜻은 아닙니다.</Text>
          {checkReplies.state.uncertain && <Text style={styles.notice}>처리 결과가 불명확합니다. 동일한 요청으로 다시 확인해 주세요.</Text>}
          <Button label="동일 회신 조회 재시도" onPress={checkReplies.retry} />
          {!checkReplies.state.uncertain && <Button label="회신 조회 오류 닫기" onPress={checkReplies.reset} secondary />}</>}
        {checkReplies.state.status === 'success' && <Text style={styles.text}>확인된 회신: {checkReplies.state.result.checkedCount}건</Text>}
        {checkReplies.state.status === 'success' && checkReplies.state.result.unmatchedCount > 0 && <Text style={styles.notice}>연관 여부를 판단할 수 없는 메일 {checkReplies.state.result.unmatchedCount}건이 있습니다. 메일함에서 별도로 확인해 주세요.</Text>}
      </>}
      <Button label={contact.channel === 'phone' ? '통화 결과 조회' : '저장된 응답 조회'} disabled={locked} onPress={lookupResponses} secondary />
      {results?.status === 'loading' && <Loading>저장된 응답을 불러오는 중입니다.</Loading>}
      {results?.status === 'error' && <Text style={styles.error} accessibilityRole="alert">저장된 응답을 조회하지 못했습니다.</Text>}
      {results?.status === 'success' && results.data.length === 0 && <Text style={styles.muted}>저장된 응답이 없습니다.</Text>}
      {results?.status === 'success' && results.data.map((response) => <View style={styles.card} key={response.id}>
        <Text style={styles.text}>응답 {response.id} · {response.receivedAt}</Text>
        <Text style={styles.text}>상태: {response.outcome === 'unclear' ? '사용자 확인 필요' : response.outcome === 'accepted' ? '수락' : response.outcome === 'declined' ? '거절' : '대안 제시'}</Text>
        {response.displayText?.trim() ? <><Text style={styles.notice}>회신 원문의 일부입니다. 메일 헤더만으로 상대의 신원은 확인되지 않습니다.</Text><Text style={styles.text}>{response.displayText}</Text></>
          : <Text style={styles.muted}>확인할 수 있는 회신 본문이 없습니다.</Text>}
        {!requiresNewProposal && contact.channel === 'email' && contact.negotiationStatus === 'needs_user_review' && response.outcome === 'unclear' && response.displayText?.trim() && response.reviewReason === 'sender_unverified' && <>
          <Text style={styles.text}>회신을 직접 확인한 뒤 상대가 수락한 허용 대안을 선택해 주세요.</Text>
          {contact.allowedOptions.map((option) => <Button key={option.optionId} label={`${resultChoice?.responseId === response.id && resultChoice.optionId === option.optionId ? '선택됨: ' : '선택: '}${option.optionId} · 제안 ${option.proposalId}`} disabled={locked} onPress={() => setResultChoice({ responseId: response.id, optionId: option.optionId })} secondary />)}
          {resultChoice?.responseId === response.id && <Button label="회신 확인 후 선택한 대안 재승인" disabled={locked || confirmResponse.state.status !== 'idle'} onPress={() => confirmResponse.submit({ id: contact.id, responseId: response.id, contactRevision: contact.revision, selectedOptionId: resultChoice.optionId })} />}
        </>}
      </View>)}
      {confirmResponse.state.status === 'pending' && <Loading>재승인과 현재 일정을 확인하는 중입니다.</Loading>}
      {requiresNewProposal && <>
        <Text style={styles.notice}>일정이나 승인 내용이 변경되었거나 대안이 만료되어 반영하지 않았습니다. 현재 일정으로 새 제안을 요청해 주세요.</Text>
        <Button label="저장된 회신 다시 조회" onPress={() => { confirmResponse.reset(); void lookupResponses(); }} secondary />
      </>}
      {confirmResponse.state.status === 'error' && <><ErrorNotice error={confirmResponse.state.error} />
        {confirmResponse.state.uncertain && <Text style={styles.notice}>일정 반영 결과를 확인하지 못했습니다. 같은 요청으로 확인해 주세요.</Text>}
        <Button label="동일 재승인 요청 재시도" onPress={confirmResponse.retry} />
        {!confirmResponse.state.uncertain && <Button label="재승인 오류 닫기" onPress={confirmResponse.reset} secondary />}</>}
    </>}
    {lookupError && <Text style={styles.error} accessibilityRole="alert">연락 상태를 조회하지 못했습니다.</Text>}
    <Button label="연락 상태 조회" onPress={lookup} disabled={lookupBusy || resultsBusy || checkReplies.state.status === 'pending' || confirmResponse.state.status === 'pending'} secondary />
  </>;
}

export default function ContactPanel({ api, proposal, proposalClient, renderProposal, onScheduleChanged, onBack }: Props) {
  const client = useMemo(() => createContactClient(api), [api]);
  const [list, setList] = useState<Load<ContactRequest[]>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'list' | 'draft' | 'detail-loading' | 'detail-error' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<ContactRequest | null>(null);
  const [detailGeneration, setDetailGeneration] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    setList({ status: 'loading' });
    client.list(proposal.id).then((data) => { if (active) setList({ status: 'success', data }); },
      () => { if (active) setList({ status: 'error' }); });
    return () => { active = false; };
  }, [client, proposal.id, attempt]);
  useEffect(() => () => { generation.current += 1; }, []);

  function open(id: string) {
    const token = ++generation.current;
    setSelectedId(id);
    setView('detail-loading');
    client.get(id).then((item) => {
      if (generation.current === token) { setSelected(item); setView('detail'); }
    }, () => { if (generation.current === token) setView('detail-error'); });
  }
  function backToList() {
    generation.current += 1;
    setSelected(null);
    setView('list');
    setAttempt((value) => value + 1);
  }
  const unresolvedDelivery = list.status === 'success' && list.data.some((item) =>
    item.deliveryStatus === 'submitting' || item.deliveryStatus === 'outcome_unknown');
  const incompleteHistory = list.status === 'success' && list.data.length >= 100;
  return <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    {view === 'list' && <>
      <View style={styles.row}><Text accessibilityRole="header" style={styles.title}>연락 준비</Text><Button label="제안으로" onPress={onBack} secondary /></View>
      <Text style={styles.text}>이 제안에 연결된 연락을 확인하거나 새 초안을 작성합니다.</Text>
      <Button label="새 연락 초안 작성" onPress={() => setView('draft')} disabled={list.status !== 'success' || unresolvedDelivery || incompleteHistory} />
      {unresolvedDelivery && <Text style={styles.notice}>처리 중이거나 결과가 불명인 발송이 있습니다. 기존 연락의 상태만 조회해 주세요.</Text>}
      {incompleteHistory && <Text style={styles.notice}>최근 100건만 조회되어 이전 발송 상태를 확인할 수 없습니다. 새 초안은 만들 수 없습니다.</Text>}
      {list.status === 'loading' && <Loading>연락 목록을 불러오는 중입니다.</Loading>}
      {list.status === 'error' && <><ErrorNotice /><Button label="연락 목록 다시 조회" onPress={() => setAttempt((value) => value + 1)} secondary /></>}
      {list.status === 'success' && <>
        {list.data.length === 0 && <Text style={styles.muted}>저장된 연락이 없습니다.</Text>}
        {list.data.map((item) => <View style={styles.card} key={item.id}>
          <Text style={styles.text}>{item.recipientSnapshot.displayName} · {deliveryLabel(item)}</Text>
          <Text style={styles.muted}>{item.purpose} · {item.createdAt}</Text>
          <Button label={`연락 ${item.id} 상세`} onPress={() => open(item.id)} secondary />
        </View>)}
        <Button label="연락 목록 새로고침" onPress={() => setAttempt((value) => value + 1)} secondary />
      </>}
    </>}
    {view === 'draft' && <ContactDraft client={client} proposal={proposal} onCancel={backToList}
      onSaved={(item) => { setSelected(item); setView('detail'); }} />}
    {view === 'detail-loading' && <Loading>연락 상태를 불러오는 중입니다.</Loading>}
    {view === 'detail-error' && <><ErrorNotice /><Button label="연락 다시 조회" onPress={() => open(selectedId)} />
      <Button label="연락 목록" onPress={backToList} secondary /></>}
    {view === 'detail' && selected && <ContactDetail key={`${selected.id}:${detailGeneration}`}
      client={client} proposalClient={proposalClient} contact={selected} renderProposal={renderProposal} onChange={setSelected}
      onReconcile={(item) => { setSelected(item); setDetailGeneration((value) => value + 1); }} onScheduleChanged={onScheduleChanged} onBack={backToList} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { color: colors.text, fontSize: 25, fontWeight: '700', flexShrink: 1 },
  section: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 12 },
  label: { color: colors.text, fontWeight: '700', marginTop: 6 },
  text: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  error: { color: colors.error, lineHeight: 22 },
  notice: { color: '#713f12', backgroundColor: '#fef3c7', padding: 10, lineHeight: 22, borderRadius: 12 },
  card: { padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 20, gap: 8, backgroundColor: colors.surface },
  input: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#7C879B', borderRadius: 12, color: colors.text, backgroundColor: colors.surface },
  body: { minHeight: 120, textAlignVertical: 'top' },
});
