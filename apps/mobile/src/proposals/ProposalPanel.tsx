import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { ActionButton } from '../ui/ActionButton';
import { Icon } from '../ui/Icon';
import type { ScheduleItem, TimeSlot } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import ContactPanel from '../contacts/ContactPanel';
import { canAccept, createProposalClient, type DecisionInput, type DecisionResult, type Proposal, type ProposalClient, type ProposalPage, type ScheduleFields } from './client';

interface Props {
  api: ApiClient;
  refreshVersion: number;
  onScheduleChanged: () => void;
  onBack: () => void;
  onRequestRevision: (proposal: Proposal) => void;
}

type Load<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'success'; data: T };

const statusText: Record<Proposal['status'], string> = {
  pending: '확인 대기', awaiting_contact: '연락 대기', applied: '적용됨', rejected: '거절됨',
  stale: '기준 변경됨', expired: '만료됨', failed: '처리 실패',
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'stale_proposal': return '일정 또는 맥락이 바뀌어 이 제안을 다시 확인해야 합니다.';
    case 'expired_proposal': return '제안이 만료되었습니다. 다시 조회해 상태를 확인하세요.';
    case 'conflict': return '현재 일정과 충돌하거나 기준이 변경되었습니다. 다시 조회해 확인하세요.';
    case 'idempotency_conflict': return '요청 중복 키가 다른 내용과 충돌했습니다. 다시 조회해 확인하세요.';
    case 'contact_required': return '공동 일정은 별도의 연락 조정이 필요합니다.';
    case 'missing_information': return '처리에 필요한 정보가 부족합니다. 다시 조회해 확인하세요.';
    case 'not_found': return '제안을 찾을 수 없습니다.';
    case 'permission_denied': return '이 제안에 접근할 권한이 없습니다.';
    case 'not_configured': return '제안 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '제안 기능이 아직 구현되지 않았습니다.';
    case 'unauthenticated': return '제안을 보려면 로그인 또는 세션 설정이 필요합니다.';
    case 'invalid_configuration': return '서버 주소를 확인해 주세요.';
    case 'invalid_response': return '서버의 제안 응답을 확인할 수 없습니다.';
    case 'timeout': return '서버 응답 시간이 초과되었습니다.';
    case 'network': return '서버에 연결할 수 없습니다.';
    case 'operation_in_progress': return '같은 요청을 서버에서 처리 중입니다.';
    default: return '서버 요청을 완료하지 못했습니다.';
  }
}

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <ActionButton label={label} onPress={onPress} disabled={disabled} secondary={secondary}
    icon={label === '제안 승인' ? 'check' : label === '제안 거절' ? 'close' : label === '뒤로' || label === '목록으로' ? 'chevronLeft' : undefined} />;
}

function Loading({ text }: { text: string }) {
  return <View style={styles.loading} accessibilityLiveRegion="polite"><ActivityIndicator size="small" /><Text style={styles.text}>{text}</Text></View>;
}

function ErrorNotice({ error }: { error: unknown }) {
  return <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{errorMessage(error)}</Text>;
}

function ProposalList({ client, refreshVersion, onSelect, onBack }: {
  client: ProposalClient; refreshVersion: number; onSelect: (id: string) => void; onBack: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{ version: number; attempt: number; result: Load<ProposalPage> }>(
    { version: refreshVersion, attempt: 0, result: { status: 'loading' } },
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<unknown>(null);
  const generation = useRef(0);
  const pendingPage = useRef<symbol | null>(null);
  const visitedCursors = useRef(new Set<string>());
  const current = load.version === refreshVersion && load.attempt === attempt ? load.result : { status: 'loading' as const };

  useEffect(() => {
    const token = ++generation.current;
    pendingPage.current = null;
    visitedCursors.current = new Set();
    setLoadingMore(false);
    setPageError(null);
    setLoad({ version: refreshVersion, attempt, result: { status: 'loading' } });
    client.list().then(
      (data) => { if (generation.current === token) setLoad({ version: refreshVersion, attempt, result: { status: 'success', data } }); },
      (error: unknown) => { if (generation.current === token) setLoad({ version: refreshVersion, attempt, result: { status: 'error', error } }); },
    );
    return () => { if (generation.current === token) generation.current += 1; };
  }, [client, refreshVersion, attempt]);

  function reload() {
    generation.current += 1;
    setAttempt((value) => value + 1);
  }

  async function more() {
    if (current.status !== 'success' || current.data.nextCursor === null || pendingPage.current) return;
    const cursor = current.data.nextCursor;
    const request = Symbol('page');
    const token = generation.current;
    pendingPage.current = request;
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await client.list(cursor);
      if (generation.current !== token) return;
      if (page.nextCursor !== null && visitedCursors.current.has(page.nextCursor)) throw new Error('Repeated proposal cursor');
      visitedCursors.current.add(cursor);
      setLoad((previous) => {
        if (previous.version !== refreshVersion || previous.attempt !== attempt || previous.result.status !== 'success') return previous;
        const ids = new Set(previous.result.data.proposals.map((proposal) => proposal.id));
        const added = page.proposals.filter((proposal) => {
          if (ids.has(proposal.id)) return false;
          ids.add(proposal.id);
          return true;
        });
        return { ...previous, result: { status: 'success', data: { proposals: [...previous.result.data.proposals, ...added], nextCursor: page.nextCursor } } };
      });
    } catch (error) {
      if (generation.current === token) setPageError(error);
    } finally {
      if (pendingPage.current === request) {
        pendingPage.current = null;
        if (generation.current === token) setLoadingMore(false);
      }
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.row}><Text style={styles.title} accessibilityRole="header">제안 목록</Text><Button label="뒤로" onPress={onBack} secondary /></View>
      <Text style={styles.text}>제안의 전체 변경 내용과 검증 결과를 확인한 뒤 결정할 수 있습니다.</Text>
      {current.status === 'loading' && <Loading text="제안 목록을 불러오는 중입니다." />}
      {current.status === 'error' && <><ErrorNotice error={current.error} /><Button label="목록 다시 조회" onPress={reload} secondary /></>}
      {current.status === 'success' && <>
        {current.data.proposals.length === 0 && current.data.nextCursor === null && <Text style={styles.text}>표시할 제안이 없습니다.</Text>}
        {current.data.proposals.map((proposal) => (
          <Pressable key={proposal.id} accessibilityRole="button" accessibilityLabel={`제안 ${proposal.reason || proposal.id}, ${statusText[proposal.status]}, 상세 보기`}
            onPress={() => onSelect(proposal.id)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
            <View style={styles.row}><Icon name="sparkles" color={colors.primary} /><Text style={[styles.cardTitle, { flex: 1 }]}>{proposal.reason || '이유 없음'}</Text><Icon name="chevronRight" size={18} /></View>
            <Text style={styles.text}>{proposal.mode === 'personal' ? '개인 일정' : '공동 일정 조정'} · {statusText[proposal.status]}</Text>
            <Text style={styles.muted}>제안 ID: {proposal.id} · 버전: {proposal.revision}</Text>
            <Text style={styles.muted}>생성: {proposal.createdAt}</Text>
          </Pressable>
        ))}
        {loadingMore && <Loading text="다음 제안을 불러오는 중입니다." />}
        {pageError !== null && <ErrorNotice error={pageError} />}
        {current.data.nextCursor !== null && <Button label={pageError !== null ? '다음 페이지 다시 조회' : '제안 더 보기'} onPress={more} disabled={loadingMore} secondary />}
        <Button label="목록 새로고침" onPress={reload} disabled={loadingMore} secondary />
      </>}
    </ScrollView>
  );
}

function slotText(slot: TimeSlot | null): string {
  return slot === null ? '미배치' : `${slot.startsAt} ~ ${slot.endsAt} (${slot.timezone})`;
}

function Fields({ item }: { item: ScheduleFields }) {
  const completion = { pending: '대기', completed: '완료', incomplete: '미완료', unknown: '알 수 없음' };
  return <View style={styles.fieldGroup}>
    <Text style={styles.text}>종류: {item.kind === 'event' ? '일정' : '할 일'}</Text>
    <Text style={styles.text}>제목: {item.title || '(빈 제목)'}</Text>
    <Text style={styles.text}>시간: {slotText(item.timeSlot)}</Text>
    <Text style={styles.text}>소요 시간: {item.durationMinutes === null ? '미설정' : `${item.durationMinutes}분`}</Text>
    <Text style={styles.text}>마감: {item.deadline ?? '미설정'}</Text>
    <Text style={styles.text}>유연성: {item.flexibility === 'fixed' ? '고정' : '유연'}</Text>
    <Text style={styles.text}>참여: {item.involvement === 'personal' ? '개인' : '공동'}</Text>
    <Text style={styles.text}>완료 상태: {completion[item.completion]}</Text>
  </View>;
}

function BeforeItem({ item }: { item: ScheduleItem }) {
  return <>
    <Text style={styles.muted}>일정 ID: {item.id} · 변경 전 스냅샷 버전: {item.revision}</Text>
    <Fields item={item} />
    <Text style={styles.muted}>연결된 원본: {item.sourceRefs.length === 0 ? '없음' : `${item.sourceRefs.length}개`}</Text>
    {item.sourceRefs.map((source, index) => <Text key={index} style={styles.muted}>
      {`원본 ${index + 1}: 제공자 ${source.provider}, 계정 참조 ${source.accountRef}, 캘린더 ${source.calendarId}, 외부 일정 ${source.externalEventId}, 동기화 ${source.lastSyncedAt}${source.occurrenceKey === undefined ? '' : `, 반복 회차 ${source.occurrenceKey}`}${source.sourceVersion === undefined ? '' : `, 원본 버전 ${source.sourceVersion}`}`}
    </Text>)}
  </>;
}

function ProposalContent({ proposal }: { proposal: Proposal }) {
  const { validation } = proposal;
  return <>
    <Text style={styles.sectionTitle} accessibilityRole="header">제안 상태</Text>
    <Text style={styles.text}>상태: {statusText[proposal.status]} · 유형: {proposal.mode === 'personal' ? '개인 일정' : '공동 일정 조정'}</Text>
    <Text style={styles.text}>제안 ID: {proposal.id} · 버전: {proposal.revision}</Text>
    <Text style={styles.text}>생성: {proposal.createdAt} · 만료: {proposal.expiresAt ?? '미설정'}</Text>
    <Text style={styles.text}>기준 일정 버전: {proposal.baseScheduleRevision} · 기준 맥락 버전: {proposal.baseContextRevision}</Text>
    {proposal.coordinationTarget && <Text style={styles.text}>조정 대상: {proposal.coordinationTarget.id} · 예상 버전: {proposal.coordinationTarget.expectedRevision}</Text>}
    {proposal.status === 'awaiting_contact' && <Text style={styles.notice}>원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.</Text>}
    {proposal.status === 'stale' && <Text style={styles.notice}>기준이 바뀐 제안입니다. 새로 검증된 제안을 확인해 주세요.</Text>}
    {proposal.status === 'expired' && <Text style={styles.notice}>만료된 제안입니다. 새 제안을 확인해 주세요.</Text>}

    <Text style={styles.sectionTitle} accessibilityRole="header">변경 이유</Text>
    <Text style={styles.text}>{proposal.reason || '이유가 제공되지 않았습니다.'}</Text>
    <Text style={styles.text}>근거 참조: {proposal.evidenceRefs.length === 0 ? '없음' : proposal.evidenceRefs.join(', ')}</Text>

    <Text style={styles.sectionTitle} accessibilityRole="header">전체 변경 내용</Text>
    {proposal.changeSet.changes.length === 0 && <Text style={styles.text}>변경 내용이 없습니다.</Text>}
    {proposal.changeSet.changes.map((change, index) => {
      const before = change.operation === 'create' ? undefined : proposal.beforeItems.find((item) => item.id === change.targetId);
      return <View style={styles.card} key={change.changeId}>
        <Text style={styles.cardTitle}>{index + 1}. {change.operation === 'create' ? '생성' : change.operation === 'update' ? '수정' : '삭제'}</Text>
        <Text style={styles.muted}>변경 ID: {change.changeId}</Text>
        {change.operation !== 'create' && <Text style={styles.muted}>대상: {change.targetId} · 예상 버전: {change.expectedRevision}</Text>}
        <Text style={styles.subheading}>변경 전</Text>
        {before ? <BeforeItem item={before} /> : <Text style={styles.text}>없음 (새 일정)</Text>}
        <Text style={styles.subheading}>변경 후</Text>
        {change.operation === 'delete' ? <Text style={styles.text}>없음 (삭제)</Text> : <Fields item={change.after} />}
      </View>;
    })}

    <Text style={styles.sectionTitle} accessibilityRole="header">서버 검증 결과</Text>
    <Text style={styles.text}>결과: {validation.valid ? '유효' : '유효하지 않음'}</Text>
    <Text style={styles.text}>검증 시각: {validation.checkedAt}</Text>
    <Text style={styles.text}>검증한 일정 버전: {validation.checkedScheduleRevision} · 맥락 버전: {validation.checkedContextRevision}</Text>
    <Text style={styles.text}>부족한 정보: {validation.missingFields.length ? validation.missingFields.join(', ') : '없음'}</Text>
    <Text style={styles.text}>보호 대상: {validation.protectedTargets.length ? validation.protectedTargets.join(', ') : '없음'}</Text>
    <Text style={styles.text}>충돌: {validation.conflicts.length ? `${validation.conflicts.length}건` : '없음'}</Text>
    {validation.conflicts.map((conflict, index) => <Text style={styles.text} key={index}>
      {`${index + 1}. 대상: ${conflict.targetIds.join(', ') || '없음'} · 이유: ${conflict.reason}${conflict.timeSlot ? ` · 시간: ${slotText(conflict.timeSlot)}` : ''}`}
    </Text>)}
  </>;
}

function ProposalDetail({ api, client, id, refreshVersion, onScheduleChanged, onBack, onRequestRevision }: {
  api: ApiClient; client: ProposalClient; id: string; refreshVersion: number; onScheduleChanged: () => void; onBack: () => void; onRequestRevision: (proposal: Proposal) => void;
}) {
  const [contactProposal, setContactProposal] = useState<Proposal | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const mutation = useMutation<DecisionInput, DecisionResult>(
    (op) => client.decide(op),
    () => { if (mounted.current) onScheduleChanged(); },
  );
  const uncertain = mutation.state.status === 'error' && mutation.state.uncertain;
  const [frozenVersion, setFrozenVersion] = useState(refreshVersion);
  const [attempt, setAttempt] = useState(0);
  const version = mutation.state.status === 'idle' ? refreshVersion : frozenVersion;
  const [load, setLoad] = useState<{ version: number; attempt: number; result: Load<Proposal> }>(
    { version, attempt: 0, result: { status: 'loading' } },
  );
  const current = load.version === version && load.attempt === attempt ? load.result : { status: 'loading' as const };

  useEffect(() => {
    let active = true;
    setLoad({ version, attempt, result: { status: 'loading' } });
    client.get(id).then(
      (data) => { if (active) setLoad({ version, attempt, result: { status: 'success', data } }); },
      (error: unknown) => { if (active) setLoad({ version, attempt, result: { status: 'error', error } }); },
    );
    return () => { active = false; };
  }, [client, id, version, attempt]);

  function reload() {
    if (mutation.state.status === 'pending' || uncertain) return;
    mutation.reset();
    setAttempt((value) => value + 1);
  }

  function decide(proposal: Proposal, decision: DecisionInput['decision']) {
    if (mutation.state.status !== 'idle' || proposal.status !== 'pending') return;
    if (decision === 'accept' && !canAccept(proposal)) return;
    setFrozenVersion(refreshVersion);
    mutation.submit({ id: proposal.id, proposalRevision: proposal.revision, mode: proposal.mode, decision });
  }

  const state = mutation.state;
  // Keep the operation in memory until its error is retried or explicitly cleared.
  const locked = state.status === 'pending' || state.status === 'error';
  const shown = state.status === 'success' ? state.result.proposal : current.status === 'success' ? current.data : null;
  if (contactProposal) return <ContactPanel api={api} proposalClient={client} proposal={contactProposal}
    renderProposal={(item) => <ProposalContent proposal={item} />} onScheduleChanged={onScheduleChanged} onBack={() => setContactProposal(null)} />;
  return <ScrollView contentContainerStyle={styles.container}>
    <View style={styles.row}>
      <Text style={styles.title} accessibilityRole="header">제안 상세</Text>
      <Button label="목록으로" onPress={onBack} disabled={locked} secondary />
    </View>
    {current.status === 'loading' && state.status !== 'success' && <Loading text="제안 상세를 불러오는 중입니다." />}
    {current.status === 'error' && state.status === 'idle' && <><ErrorNotice error={current.error} /><Button label="제안 다시 조회" onPress={reload} secondary /></>}
    {state.status === 'success' && <View accessibilityLiveRegion="polite">
      <Text style={styles.notice}>
        {state.result.outcome === 'applied' ? '서버가 개인 일정 적용을 확인했습니다.' :
          state.result.outcome === 'rejected' ? '서버가 제안 거절을 확인했습니다.' :
            '원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.'}
      </Text>
      <Text style={styles.muted}>서버 일정 버전: {state.result.scheduleRevision}</Text>
    </View>}
    {shown && <ProposalContent proposal={shown} />}
    {state.status === 'pending' && <Loading text="결정 결과를 확인하는 중입니다." />}
    {state.status === 'error' && <>
      <ErrorNotice error={state.error} />
      {uncertain && <Text style={styles.notice}>서버의 처리 여부를 확인하지 못했습니다. 동일한 요청만 다시 시도할 수 있습니다.</Text>}
      <Button label="동일 요청 다시 시도" onPress={mutation.retry} />
      {!uncertain && <Button label="제안 다시 조회" onPress={reload} secondary />}
    </>}
    {shown && state.status === 'idle' && <>
      <Button label="수정 요청" onPress={() => onRequestRevision(shown)} secondary />
      <Text style={styles.notice}>수정 요청은 새 제안을 위한 대화 초안입니다. 기존 제안은 그대로이며 새 제안에는 별도 승인이 필요합니다.</Text>
      {shown.status === 'pending' ? <>
        {shown.mode === 'coordination' && <Text style={styles.notice}>승인해도 원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.</Text>}
        {!canAccept(shown) && <Text style={styles.notice}>검증 결과가 유효하지 않거나 일관되지 않아 승인할 수 없습니다. 거절은 가능합니다.</Text>}
        <View style={styles.actions}>
          <Button label="제안 승인" onPress={() => decide(shown, 'accept')} disabled={!canAccept(shown)} />
          <Button label="제안 거절" onPress={() => decide(shown, 'reject')} secondary />
        </View>
      </> : <Button label="제안 다시 조회" onPress={reload} secondary />}
    </>}
    {shown && !locked && shown.mode === 'coordination' && (shown.status === 'pending' || shown.status === 'awaiting_contact') &&
      <Button label="연락 준비" onPress={() => setContactProposal(shown)} />}
  </ScrollView>;
}

function ProposalSession({ api, refreshVersion, onScheduleChanged, onBack, onRequestRevision }: Props) {
  const client = useMemo(() => createProposalClient(api), [api]);
  const [selected, setSelected] = useState<string | null>(null);
  return selected === null
    ? <ProposalList client={client} refreshVersion={refreshVersion} onSelect={setSelected} onBack={onBack} />
    : <ProposalDetail key={selected} api={api} client={client} id={selected} refreshVersion={refreshVersion} onScheduleChanged={onScheduleChanged} onBack={() => setSelected(null)} onRequestRevision={onRequestRevision} />;
}

export default function ProposalPanel(props: Props) {
  const [connection, setConnection] = useState({ api: props.api, key: 0 });
  if (connection.api !== props.api) {
    const next = { api: props.api, key: connection.key + 1 };
    setConnection(next);
    return <ProposalSession key={next.key} {...props} />;
  }
  return <ProposalSession key={connection.key} {...props} />;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, flexShrink: 1 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 12 },
  subheading: { fontWeight: '700', color: colors.text, marginTop: 8 },
  card: { padding: 18, borderWidth: 1, borderColor: colors.border, borderRadius: 20, gap: 8, backgroundColor: colors.surface },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  fieldGroup: { gap: 3 },
  text: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  notice: { color: '#713f12', backgroundColor: '#fef3c7', padding: 10, lineHeight: 22, borderRadius: 12 },
  error: { color: '#a01818', lineHeight: 22 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: colors.primary, alignSelf: 'flex-start' },
  secondaryButton: { backgroundColor: colors.primarySoft },
  buttonText: { color: '#fff', fontWeight: '700' },
  secondaryText: { color: colors.text },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
