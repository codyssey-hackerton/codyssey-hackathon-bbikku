import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { ActionButton } from '../ui/ActionButton';
import { Icon } from '../ui/Icon';
import type { TimeSlot } from '@pikku/domain';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import { operationGuard } from '../api/operationGuard';
import ContactPanel from '../contacts/ContactPanel';
import { canAccept, createProposalClient, type DecisionInput, type DecisionResult, type Proposal, type ProposalClient, type ProposalPage, type ScheduleFields } from './client';

interface Props {
  api: ApiClient;
  refreshVersion: number;
  onScheduleChanged: () => void;
  onBack: () => void;
  onRequestRevision: (proposal: Proposal) => void;
  onOpenGoogleContacts?: () => void;
}

type Load<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'success'; data: T };

const statusText: Record<Proposal['status'], string> = {
  pending: '확인 대기', awaiting_contact: '연락 대기', applied: '적용됨', rejected: '거절됨',
  stale: '다시 확인 필요', expired: '만료됨', failed: '처리 실패',
};

function proposalTitle(proposal: Proposal): string {
  const first = proposal.changeSet.changes[0];
  const title = first && (first.operation === 'delete' ? proposal.beforeItems.find(item => item.id === first.targetId)?.title : first.after.title);
  const characters = Array.from(title?.trim().replace(/\s+/g, ' ') || '일정 제안');
  const short = characters.slice(0, 40).join('') + (characters.length > 40 ? '…' : '');
  return proposal.changeSet.changes.length > 1 ? `${short} 외 ${proposal.changeSet.changes.length - 1}개` : short;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'stale_proposal': return '일정 또는 맥락이 바뀌어 이 제안을 다시 확인해야 합니다.';
    case 'expired_proposal': return '제안이 만료되었습니다. 다시 조회해 상태를 확인하세요.';
    case 'conflict': return '현재 일정과 충돌하거나 기준이 변경되었습니다. 다시 조회해 확인하세요.';
    case 'idempotency_conflict': return '이전 요청과 내용이 달라 다시 확인해야 합니다.';
    case 'contact_required': return '공동 일정은 별도의 연락 조정이 필요합니다.';
    case 'missing_information': return '처리에 필요한 정보가 부족합니다. 다시 조회해 확인하세요.';
    case 'not_found': return '제안을 찾을 수 없습니다.';
    case 'permission_denied': return '이 제안에 접근할 권한이 없습니다.';
    case 'not_configured': return '제안 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '제안 기능을 아직 사용할 수 없습니다.';
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
      <Text style={styles.text}>변경 내용을 확인하고 결정해 주세요.</Text>
      {current.status === 'loading' && <Loading text="제안 목록을 불러오는 중입니다." />}
      {current.status === 'error' && <><ErrorNotice error={current.error} /><Button label="목록 다시 조회" onPress={reload} secondary /></>}
      {current.status === 'success' && <>
        {current.data.proposals.length === 0 && current.data.nextCursor === null && <Text style={styles.text}>표시할 제안이 없습니다.</Text>}
        {current.data.proposals.map((proposal) => (
          <Pressable key={proposal.id} accessibilityRole="button" accessibilityLabel={`제안 ${proposalTitle(proposal)}, ${statusText[proposal.status]}, 상세 보기`}
            onPress={() => onSelect(proposal.id)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
            <View style={styles.row}><Icon name="sparkles" color={colors.primary} /><Text numberOfLines={2} style={[styles.cardTitle, { flex: 1 }]}>{proposalTitle(proposal)}</Text><Icon name="chevronRight" size={18} /></View>
            <Text style={styles.text}>{proposal.mode === 'personal' ? '개인 일정' : '공동 일정 조정'} · {statusText[proposal.status]}</Text>
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

function localTime(value: string): { date: string; time: string } | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    if (!parts.year || !parts.month || !parts.day || !parts.dayPeriod || !parts.hour || !parts.minute || !parts.second) return null;
    const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
    const seconds = parts.second !== '00' || (fraction && /[1-9]/.test(fraction)) ? `:${parts.second}${fraction && /[1-9]/.test(fraction) ? `.${fraction}` : ''}` : '';
    return { date: `${parts.year}년 ${parts.month}월 ${parts.day}일`, time: `${parts.dayPeriod} ${parts.hour}:${parts.minute}${seconds}` };
  } catch { return null; }
}

function instantText(value: string): string {
  const local = localTime(value);
  return local ? `${local.date} ${local.time}` : '시간 확인 필요';
}

function slotText(slot: TimeSlot | null): string {
  if (slot === null) return '시간 미정';
  const start = localTime(slot.startsAt), end = localTime(slot.endsAt);
  return start && end ? `${start.date} ${start.time} ~ ${start.date === end.date ? '' : `${end.date} `}${end.time}` : '시간 확인 필요';
}

const completionText = { pending: '대기', completed: '완료', incomplete: '미완료', unknown: '미확인' } as const;
const categoryText = (value: ScheduleFields['category']) => value === 'personal' ? '개인' : value === 'work' ? '업무' : '미분류';
const attendanceText = (value: ScheduleFields['attendance']) => value === 'attended' ? '참석' : value === 'absent' ? '불참' : value === 'unknown' ? '미확인' : '미기록';
const kindText = (item: ScheduleFields) => item.kind === 'event' ? '일정' : '할 일';
const durationText = (value: number | null) => value === null ? '미설정' : `${value}분`;
const deadlineText = (item: ScheduleFields) => item.deadline === null ? '미설정' : instantText(item.deadline);

function Fields({ item }: { item: ScheduleFields }) {
  return <View style={styles.fieldGroup}>
    <Text style={styles.cardTitle}>{item.title || '(빈 제목)'}</Text>
    <Text style={styles.text}>{slotText(item.timeSlot)}</Text>
  </View>;
}

function FieldDetails({ item }: { item: ScheduleFields }) {
  return <View style={styles.fieldGroup}>
    <Text style={styles.muted}>{kindText(item)} · {item.involvement === 'personal' ? '개인' : '공동'} · {item.flexibility === 'fixed' ? '고정' : '유연'}</Text>
    <Text style={styles.muted}>소요 {durationText(item.durationMinutes)} · 마감 {deadlineText(item)} · 분류 {categoryText(item.category)}</Text>
    <Text style={styles.muted}>완료 {completionText[item.completion]}{item.kind === 'event' ? ` · 참석 ${attendanceText(item.attendance)}` : ''}</Text>
  </View>;
}

function ChangedDetails({ before, after }: { before?: ScheduleFields; after?: ScheduleFields }) {
  if (!before || !after) {
    const item = (after ?? before)!;
    const details = [
      kindText(item),
      item.involvement === 'shared' && '공동',
      item.flexibility === 'fixed' && '고정',
      item.durationMinutes !== null && `소요 ${durationText(item.durationMinutes)}`,
      item.deadline !== null && `마감 ${deadlineText(item)}`,
      item.category != null && `분류 ${categoryText(item.category)}`,
      item.location != null && `장소 ${item.location}`,
      (item.completion === 'completed' || item.completion === 'incomplete') && `완료 ${completionText[item.completion]}`,
      item.kind === 'event' && (item.attendance === 'attended' || item.attendance === 'absent') && `참석 ${attendanceText(item.attendance)}`,
    ].filter(Boolean);
    return <Text style={styles.muted}>{details.join(' · ')}</Text>;
  }
  const effectiveCategory = after.category === undefined ? before.category : after.category;
  const effectiveAttendance = after.attendance === undefined ? before.attendance : after.attendance;
  const changes = [
    before.kind !== after.kind && `종류: ${kindText(before)} → ${kindText(after)}`,
    before.durationMinutes !== after.durationMinutes && `소요 시간: ${durationText(before.durationMinutes)} → ${durationText(after.durationMinutes)}`,
    before.deadline !== after.deadline && `마감: ${deadlineText(before)} → ${deadlineText(after)}`,
    before.flexibility !== after.flexibility && `시간 조정: ${before.flexibility === 'fixed' ? '고정' : '유연'} → ${after.flexibility === 'fixed' ? '고정' : '유연'}`,
    before.involvement !== after.involvement && `참여 범위: ${before.involvement === 'personal' ? '개인' : '공동'} → ${after.involvement === 'personal' ? '개인' : '공동'}`,
    (before.category ?? null) !== (effectiveCategory ?? null) && `분류: ${categoryText(before.category)} → ${categoryText(effectiveCategory)}`,
    after.location !== undefined && (before.location ?? null) !== (after.location ?? null) && `장소: ${before.location ?? '미설정'} → ${after.location ?? '미설정'}`,
    before.completion !== after.completion && `완료 상태: ${completionText[before.completion]} → ${completionText[after.completion]}`,
    (before.attendance ?? null) !== (effectiveAttendance ?? null) && `참석 상태: ${attendanceText(before.attendance)} → ${attendanceText(effectiveAttendance)}`,
  ].filter((line): line is string => !!line);
  return changes.length ? <View style={styles.fieldGroup}>{changes.map((line, index) => <Text key={index} style={styles.text}>{line}</Text>)}</View> : null;
}

function conflictText(reason: string): string {
  const code = reason.split(':', 1)[0];
  const messages: Record<string, string> = {
    overlap: '다른 일정과 시간이 겹칩니다.', deadline_exceeded: '제안 시간이 마감을 넘습니다.',
    insufficient_task_duration: '배정 시간이 필요한 소요 시간보다 짧습니다.', past_placement: '지난 시간에 일정을 배치할 수 없습니다.',
    contact_required: '공동 일정은 별도의 연락 조정이 필요합니다.', stale_target: '기존 일정이 바뀌어 다시 확인해야 합니다.',
    stale_coordination_target: '기존 약속이 바뀌어 다시 확인해야 합니다.', no_effective_change: '기존 일정과 달라진 내용이 없습니다.',
    invalid_field: '일정에 필요한 정보가 올바르지 않습니다.', target_not_found: '대상 일정을 찾을 수 없습니다.',
  };
  return messages[code] ?? (/[가-힣]/.test(reason) ? reason : '변경 내용을 다시 확인해 주세요.');
}

function missingFieldText(path: string): string {
  const fields: [RegExp, string][] = [
    [/deadline/i, '마감'], [/duration/i, '소요 시간'], [/start|end|timeSlot/i, '일정 시간'],
    [/title/i, '제목'], [/preparation/i, '준비 시간'], [/travel/i, '이동 시간'], [/buffer/i, '여유 시간'],
    [/attendance/i, '참석 상태'], [/involvement/i, '참여 범위'], [/flexibility/i, '시간 조정 여부'],
  ];
  return fields.find(([pattern]) => pattern.test(path))?.[1] ?? '필요한 정보';
}

function ProposalContent({ proposal }: { proposal: Proposal }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { validation } = proposal;
  const needsReview = !validation.valid || validation.conflicts.length > 0 || validation.missingFields.length > 0 || validation.protectedTargets.length > 0;
  const titleFor = (id: string) => proposal.beforeItems.find(item => item.id === id)?.title || '관련 일정 확인 필요';
  const segmentText = (id: string | null) => {
    if (id === null) return '별도 일정 없음';
    const change = proposal.changeSet.changes.find(item => item.changeId === id);
    if (!change) return '연결된 일정 확인 필요';
    const item = change.operation === 'delete' ? proposal.beforeItems.find(before => before.id === change.targetId) : change.after;
    return item ? `${item.title || '(빈 제목)'} · ${slotText(item.timeSlot)}${change.operation === 'delete' ? ' (삭제)' : ''}` : '연결된 일정 확인 필요';
  };
  return <>
    {proposal.status === 'applied' && <Text style={styles.text}>일정에 반영된 제안입니다.</Text>}
    {proposal.status === 'rejected' && <Text style={styles.text}>거절한 제안입니다.</Text>}
    {proposal.status === 'awaiting_contact' && <Text style={styles.notice}>원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.</Text>}
    {proposal.status === 'stale' && <Text style={styles.notice}>일정이 바뀌어 새 제안을 확인해야 합니다.</Text>}
    {proposal.status === 'expired' && <Text style={styles.notice}>만료된 제안입니다. 새 제안을 확인해 주세요.</Text>}
    {proposal.status === 'failed' && <Text style={styles.notice}>제안을 처리하지 못했습니다. 다시 확인해 주세요.</Text>}
    {needsReview && <View style={styles.notice} accessibilityRole="alert">
      <Text>확인이 필요한 내용이 있어 승인할 수 없습니다.</Text>
      {validation.conflicts.map((conflict, index) => <Text key={index}>
        {conflictText(conflict.reason)}{conflict.targetIds.length ? ` (${conflict.targetIds.map(titleFor).join(', ')})` : ''}
        {conflict.timeSlot ? ` · ${slotText(conflict.timeSlot)}` : ''}
      </Text>)}
      {validation.missingFields.length > 0 && <Text>빠진 정보: {[...new Set(validation.missingFields.map(missingFieldText))].join(', ')}. 내용을 보완해 새 제안을 요청해 주세요.</Text>}
      {validation.protectedTargets.length > 0 && <Text>보호된 일정: {validation.protectedTargets.map(titleFor).join(', ')}</Text>}
    </View>}
    {proposal.status === 'pending' && proposal.expiresAt && <Text style={styles.muted}>확인 기한: {instantText(proposal.expiresAt)}</Text>}
    <Text style={styles.sectionTitle} accessibilityRole="header">제안 이유</Text>
    <Text style={styles.text}>{proposal.reason || '이유가 제공되지 않았습니다.'}</Text>

    {!!proposal.changeSet.timingConstraints?.length && <>
      <Text style={styles.sectionTitle} accessibilityRole="header">준비와 이동</Text>
      <Text style={styles.muted}>제안된 시간입니다. 실제 경로와 사용자 확인 여부를 별도로 확인해 주세요.</Text>
      {proposal.changeSet.timingConstraints.map((timing, index) => {
        const appointment = timing.appointment;
        const target = appointment.kind === 'existing' ? proposal.beforeItems.find(item => item.id === appointment.id)
          : proposal.changeSet.changes.find(change => change.changeId === appointment.changeId);
        const title = target && 'title' in target ? target.title : target && 'after' in target ? target.after.title : '관련 약속 확인 필요';
        return <View style={styles.card} key={index}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.text}>준비 {timing.preparationMinutes === null ? '미확인' : `${timing.preparationMinutes}분`} · 이동 {timing.travelMinutes === null ? '미확인' : `${timing.travelMinutes}분`} · 여유 {timing.bufferMinutes === null ? '미확인' : `${timing.bufferMinutes}분`}</Text>
          <Text style={styles.muted}>준비 일정: {segmentText(timing.segments.preparation)}</Text>
          <Text style={styles.muted}>이동 일정: {segmentText(timing.segments.travel)}</Text>
          <Text style={styles.muted}>여유 일정: {segmentText(timing.segments.buffer)}</Text>
        </View>;
      })}
    </>}

    <Text style={styles.sectionTitle} accessibilityRole="header">변경 내용</Text>
    {proposal.changeSet.changes.length === 0 && <Text style={styles.text}>변경 내용이 없습니다.</Text>}
    {proposal.changeSet.changes.map((change, index) => {
      const before = change.operation === 'create' ? undefined : proposal.beforeItems.find((item) => item.id === change.targetId);
      const after = change.operation === 'delete' ? undefined : change.after;
      const effectiveAfter = after && before ? { ...after, category: after.category === undefined ? before.category : after.category,
        attendance: after.attendance === undefined ? before.attendance : after.attendance } : after;
      return <View style={styles.card} key={change.changeId}>
        <Text style={styles.cardTitle}>{index + 1}. {change.operation === 'create' ? '일정 추가' : change.operation === 'update' ? '일정 변경' : '일정 삭제'}</Text>
        {change.operation === 'create' ? effectiveAfter && <Fields item={effectiveAfter} /> : <>
          <Text style={styles.subheading}>변경 전</Text>
          {before ? <Fields item={before} /> : <Text style={styles.text}>기존 일정을 확인할 수 없습니다.</Text>}
          <Text style={styles.subheading}>변경 후</Text>
          {effectiveAfter ? <Fields item={effectiveAfter} /> : <Text style={styles.text}>없음 (삭제)</Text>}
        </>}
        {(before || effectiveAfter) && <ChangedDetails before={before} after={effectiveAfter} />}
        {before && before.sourceRefs.length > 0 && <Text style={styles.muted}>연결된 원본이 있는 일정입니다.</Text>}
        {detailsOpen && <View style={styles.fieldGroup}>
          {before && <><Text style={styles.subheading}>기존 일정 상세</Text><FieldDetails item={before} /></>}
          {effectiveAfter && <><Text style={styles.subheading}>{change.operation === 'create' ? '일정 상세' : '변경 후 상세'}</Text><FieldDetails item={effectiveAfter} /></>}
        </View>}
      </View>;
    })}
    {proposal.changeSet.changes.length > 0 && <Button label={detailsOpen ? '상세 정보 접기' : '상세 정보 보기'} onPress={() => setDetailsOpen(value => !value)} secondary />}
  </>;
}

function compactReviewable(proposal: Proposal): boolean {
  return proposal.changeSet.changes.length > 0 && proposal.changeSet.changes.every(change => {
    const before = change.operation === 'create' ? undefined : proposal.beforeItems.find(item => item.id === change.targetId);
    if (change.operation !== 'create' && !before) return false;
    const after = change.operation === 'delete' ? undefined : change.after;
    return [before, after].every(item => !item || ((!item.timeSlot || !!localTime(item.timeSlot.startsAt) && !!localTime(item.timeSlot.endsAt)) &&
      (item.deadline === null || !!localTime(item.deadline))));
  });
}

function CompactChanges({ proposal }: { proposal: Proposal }) {
  const name = (id: string | null) => {
    if (id === null) return '없음';
    const change = proposal.changeSet.changes.find(item => item.changeId === id);
    const item = change?.operation === 'delete' ? proposal.beforeItems.find(value => value.id === change.targetId) : change?.after;
    return item?.title || '확인 필요';
  };
  return <>
    {proposal.changeSet.changes.map(change => {
      const before = change.operation === 'create' ? undefined : proposal.beforeItems.find(item => item.id === change.targetId);
      const after = change.operation === 'delete' ? undefined : change.after;
      return <View key={change.changeId} style={styles.fieldGroup}>
        <Text style={styles.muted}>{change.operation === 'create' ? '일정 추가' : change.operation === 'update' ? '일정 변경' : '일정 삭제'}</Text>
        {change.operation !== 'create' && <>{before ? <><Text style={styles.muted}>변경 전</Text><Fields item={before} /></> : <Text>기존 일정을 확인할 수 없습니다.</Text>}</>}
        {after && <>{change.operation === 'update' && <Text style={styles.muted}>변경 후</Text>}<Fields item={after} /></>}
        {change.operation === 'delete' && <Text style={styles.muted}>변경 후: 삭제</Text>}
        {(before || after) && <ChangedDetails before={before} after={after} />}
        {before && before.sourceRefs.length > 0 && <Text style={styles.muted}>연결된 원본이 있는 일정입니다.</Text>}
      </View>;
    })}
    {proposal.changeSet.timingConstraints?.map((timing, index) => {
      const appointment = timing.appointment;
      return <View key={index} style={styles.fieldGroup}>
      <Text style={styles.muted}>기준 약속: {appointment.kind === 'existing'
        ? proposal.beforeItems.find(item => item.id === appointment.id)?.title || '확인 필요'
        : name(appointment.changeId)}</Text>
      <Text style={styles.muted}>준비 {timing.preparationMinutes === null ? '미확인' : `${timing.preparationMinutes}분`} · 이동 {timing.travelMinutes === null ? '미확인' : `${timing.travelMinutes}분`} · 여유 {timing.bufferMinutes === null ? '미확인' : `${timing.bufferMinutes}분`}</Text>
      <Text style={styles.muted}>준비: {name(timing.segments.preparation)} · 이동: {name(timing.segments.travel)} · 여유: {name(timing.segments.buffer)}</Text>
    </View>; })}
  </>;
}

function ProposalDetail({ api, client, id, refreshVersion, onScheduleChanged, onBack, onRequestRevision, onOpenGoogleContacts, inline = false, onLockChange }: {
  api: ApiClient; client: ProposalClient; id: string; refreshVersion: number; onScheduleChanged: () => void; onBack: () => void; onRequestRevision: (proposal: Proposal) => void; onOpenGoogleContacts?: () => void;
  inline?: boolean; onLockChange?: (locked: boolean) => void;
}) {
  const [contactProposal, setContactProposal] = useState<Proposal | null>(null);
  const [showReason, setShowReason] = useState(false);
  const [guardMessage, setGuardMessage] = useState(false);
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
    if (decision === 'accept' && (!canAccept(proposal) || inline && !compactReviewable(proposal))) return;
    if (operationGuard.hasUnresolved()) { setGuardMessage(true); return; }
    setGuardMessage(false);
    onLockChange?.(true);
    setFrozenVersion(refreshVersion);
    mutation.submit({ id: proposal.id, proposalRevision: proposal.revision, mode: proposal.mode, decision });
  }

  const state = mutation.state;
  // Keep the operation in memory until its error is retried or explicitly cleared.
  const locked = state.status === 'pending' || state.status === 'error';
  useLayoutEffect(() => { onLockChange?.(locked || contactProposal !== null); }, [locked, contactProposal, onLockChange]);
  const shown = state.status === 'success' ? state.result.proposal : current.status === 'success' ? current.data : null;
  if (contactProposal) return <ContactPanel onOpenGoogleContacts={onOpenGoogleContacts} api={api} proposalClient={client} proposal={contactProposal}
    renderProposal={(item) => <ProposalContent proposal={item} />} onScheduleChanged={onScheduleChanged} onBack={() => {
      setContactProposal(null);
      if (mutation.state.status === 'success') mutation.reset();
      setAttempt((value) => value + 1);
    }} />;
  if (inline) return <View style={[styles.inline, styles.card]}>
    {current.status === 'loading' && state.status !== 'success' && <Loading text="제안을 불러오는 중입니다." />}
    {current.status === 'error' && state.status === 'idle' && <><ErrorNotice error={current.error} /><Button label="제안 다시 조회" onPress={reload} secondary /></>}
    {shown && <>
      {shown.changeSet.changes.length !== 1 && <Text style={styles.cardTitle}>{proposalTitle(shown)}</Text>}
      <CompactChanges proposal={shown} />
      <Text style={styles.muted}>{statusText[shown.status]}</Text>
      {!compactReviewable(shown) && <Text accessibilityRole="alert" style={styles.notice}>변경 내용을 확인할 수 없어 수락할 수 없습니다.</Text>}
      {!canAccept(shown) && shown.status === 'pending' && <View accessibilityRole="alert" style={styles.notice}>
        <Text>확인이 필요한 내용이 있어 수락할 수 없습니다.</Text>
        {shown.validation.conflicts.map((conflict, index) => <Text key={index}>{conflictText(conflict.reason)}{conflict.timeSlot ? ` · ${slotText(conflict.timeSlot)}` : ''}</Text>)}
        {shown.validation.missingFields.length > 0 && <Text>빠진 정보: {[...new Set(shown.validation.missingFields.map(missingFieldText))].join(', ')}</Text>}
        {shown.validation.protectedTargets.length > 0 && <Text>보호된 일정: {shown.validation.protectedTargets.map(id => shown.beforeItems.find(item => item.id === id)?.title || '확인 필요').join(', ')}</Text>}
      </View>}
      {shown.mode === 'coordination' && shown.status === 'pending' && <Text style={styles.muted}>수락해도 원 일정은 유지되며 연락은 별도로 진행합니다.</Text>}
      {shown.reason.trim() !== '' && <><Button label={showReason ? '이유 접기' : '이유 보기'} onPress={() => setShowReason(!showReason)} secondary />
        {showReason && <Text style={styles.text}>{Array.from(shown.reason).slice(0, 180).join('')}{Array.from(shown.reason).length > 180 ? '…' : ''}</Text>}</>}
    </>}
    {state.status === 'success' && <Text accessibilityLiveRegion="polite" style={styles.notice}>{state.result.outcome === 'applied' ? '일정이 반영되었습니다.' :
      state.result.outcome === 'rejected' ? '제안을 거절했습니다.' : '원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.'}</Text>}
    {state.status === 'pending' && <Loading text="결정 결과를 확인하는 중입니다." />}
    {guardMessage && <Text accessibilityRole="alert" style={styles.notice}>처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.</Text>}
    {state.status === 'error' && <><ErrorNotice error={state.error} />
      {uncertain && <Text style={styles.notice}>서버의 처리 여부를 확인하지 못했습니다. 동일한 요청만 다시 시도할 수 있습니다.</Text>}
      <Button label="동일 요청 다시 시도" onPress={mutation.retry} />
      {!uncertain && <Button label="제안 다시 조회" onPress={reload} secondary />}</>}
    {shown && state.status === 'idle' && <View style={styles.actions}>
      {shown.status === 'pending' && <Button label="수락" onPress={() => decide(shown, 'accept')} disabled={!canAccept(shown) || !compactReviewable(shown)} />}
      <Button label="수정" onPress={() => { if (operationGuard.hasUnresolved()) setGuardMessage(true); else onRequestRevision(shown); }} secondary />
      {shown.status === 'pending' && <Button label="거절" onPress={() => decide(shown, 'reject')} secondary />}
    </View>}
    {shown && !locked && shown.mode === 'coordination' && ['pending', 'awaiting_contact', 'applied', 'stale'].includes(shown.status) &&
      <Button label={shown.status === 'applied' || shown.status === 'stale' ? '연락 내역' : '연락 준비'} onPress={() => { onLockChange?.(true); setContactProposal(shown); }} />}
  </View>;
  return <ScrollView contentContainerStyle={styles.container}>
    <View style={styles.row}>
      <Text style={styles.title} accessibilityRole="header">제안 상세</Text>
      <Button label="목록으로" onPress={onBack} disabled={locked} secondary />
    </View>
    {current.status === 'loading' && state.status !== 'success' && <Loading text="제안 상세를 불러오는 중입니다." />}
    {current.status === 'error' && state.status === 'idle' && <><ErrorNotice error={current.error} /><Button label="제안 다시 조회" onPress={reload} secondary /></>}
    {state.status === 'success' && <View accessibilityLiveRegion="polite">
      <Text style={styles.notice}>
        {state.result.outcome === 'applied' ? '일정이 반영되었습니다.' :
          state.result.outcome === 'rejected' ? '제안을 거절했습니다.' :
            '원 일정은 유지됩니다. 연락 준비와 발송은 별도로 진행합니다.'}
      </Text>
    </View>}
    {shown && <ProposalContent proposal={shown} />}
    {state.status === 'pending' && <Loading text="결정 결과를 확인하는 중입니다." />}
    {guardMessage && <Text accessibilityRole="alert" style={styles.notice}>처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.</Text>}
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
        <View style={styles.actions}>
          <Button label="제안 승인" onPress={() => decide(shown, 'accept')} disabled={!canAccept(shown)} />
          <Button label="제안 거절" onPress={() => decide(shown, 'reject')} secondary />
        </View>
      </> : <Button label="제안 다시 조회" onPress={reload} secondary />}
    </>}
    {shown && !locked && shown.mode === 'coordination' && ['pending', 'awaiting_contact', 'applied', 'stale'].includes(shown.status) &&
      <Button label={shown.status === 'applied' || shown.status === 'stale' ? '연락 내역' : '연락 준비'} onPress={() => { onLockChange?.(true); setContactProposal(shown); }} />}
  </ScrollView>;
}

export function ChatProposalCard({ api, id, refreshVersion, onScheduleChanged, onRequestRevision, onOpenGoogleContacts }: {
  api: ApiClient; id: string; refreshVersion: number; onScheduleChanged: () => void; onRequestRevision: (proposal: Proposal) => void; onOpenGoogleContacts?: () => void;
}) {
  const [selection, setSelection] = useState({ api, id, key: 0 });
  const [locked, setLocked] = useState(false);
  const changed = selection.api !== api || selection.id !== id;
  const active = changed && !locked ? { api, id, key: selection.key + 1 } : selection;
  if (active !== selection) setSelection(active);
  const client = useMemo(() => createProposalClient(active.api), [active.api]);
  return <View>
    {changed && locked && <Text style={styles.notice}>진행 중인 제안 요청을 먼저 확인해 주세요.</Text>}
    <ProposalDetail key={active.key} api={active.api} client={client} id={active.id} refreshVersion={refreshVersion}
      onScheduleChanged={onScheduleChanged} onBack={() => {}} onRequestRevision={onRequestRevision} onOpenGoogleContacts={onOpenGoogleContacts}
      inline onLockChange={setLocked} />
  </View>;
}

function ProposalSession({ api, refreshVersion, onScheduleChanged, onBack, onRequestRevision, onOpenGoogleContacts }: Props) {
  const client = useMemo(() => createProposalClient(api), [api]);
  const [selected, setSelected] = useState<string | null>(null);
  return selected === null
    ? <ProposalList client={client} refreshVersion={refreshVersion} onSelect={setSelected} onBack={onBack} />
    : <ProposalDetail key={selected} api={api} client={client} id={selected} refreshVersion={refreshVersion} onScheduleChanged={onScheduleChanged} onBack={() => setSelected(null)} onRequestRevision={onRequestRevision} onOpenGoogleContacts={onOpenGoogleContacts} />;
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
  inline: { gap: 10 },
  container: { padding: 20, gap: 10, paddingBottom: 32, backgroundColor: '#F2F4FC', flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, flexShrink: 1 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 12 },
  subheading: { fontWeight: '700', color: colors.text, marginTop: 8 },
  card: { padding: 18, borderWidth: 1, borderColor: '#E5EAF4', borderRadius: 20, gap: 8, backgroundColor: '#FFFFFF' },
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
