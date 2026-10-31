import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateFreshContact, type ContactRequest, type StoredContactDraft } from './contact-service.ts';
import type { ApprovedGmailContact, GmailContactResult } from './gmail-contact.ts';
import type { HttpResult } from './idempotency.ts';
import { PlanningError, PlanningService } from './planning-service.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';

export type GmailContactPort = {
  userId: string;
  senderAddress: string;
  dispatch(input: ApprovedGmailContact, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<GmailContactResult>;
};

export function gmailAvailable(store: PlanningStore, provider: GmailContactPort | undefined, userId: string): provider is GmailContactPort {
  return store.durable && !!provider && provider.userId === userId && typeof provider.dispatch === 'function' &&
    typeof provider.senderAddress === 'string' && z.email().max(254).safeParse(provider.senderAddress).success;
}

function error(status: number, requestId: string, code: string, message: string, retryable = false, details?: unknown): HttpResult {
  return { status, body: { requestId, error: { code, message, retryable, ...(details === undefined ? {} : { details }) } } };
}

function replay(state: UserPlanningState, identity: string, fingerprint: string, requestId: string): HttpResult | undefined {
  const previous = state.idempotency.get(identity);
  if (!previous) return undefined;
  if (previous.fingerprint !== fingerprint) return error(409, requestId, 'idempotency_conflict', '동일한 중복 키에 다른 요청을 사용할 수 없습니다.');
  if (previous.state === 'completed' && previous.result) return previous.result;
  // No expiry or takeover: the original provider call may have succeeded.
  return error(409, requestId, 'operation_in_progress', '발송 결과를 확인해 주세요. 자동 재발송하지 않습니다.', false,
    { operationId: previous.operationId });
}

const unknown: GmailContactResult = { status: 'outcome_unknown', providerOperationId: null };
function approvedDraft(state: UserPlanningState, userId: string, id: string, contact: ContactRequest): StoredContactDraft {
  if ([...state.contactRequests.values()].some(other => other.id !== id && other.executionKey === contact.executionKey)) {
    throw new PlanningError(409, 'conflict', '연락 요청의 실행 키를 확인해 주세요.');
  }
  const approvals = state.contactApprovals.filter(item => item.approval.id === contact.approvalId);
  const approved = approvals[0];
  if (approvals.length !== 1 || !approved || approved.approval.subjectType !== 'contact_request' || approved.approval.subjectId !== id ||
      approved.approval.subjectRevision !== contact.revision || approved.approval.actorRef !== userId || approved.approval.decision !== 'accept' ||
      approved.subject.deliveryStatus !== 'pending_approval' || approved.subject.approvalId !== null ||
      approved.subject.providerOperationId !== null || approved.subject.negotiationStatus !== 'not_started' ||
      !approved.subject.allowedOptions.length || approved.subject.allowedOptions.length > 100 ||
      !isDeepStrictEqual(contact, { ...approved.subject, approvalId: approved.approval.id, deliveryStatus: 'ready' })) {
    throw new PlanningError(409, 'conflict', '승인된 연락 내용이 변경되었습니다.');
  }
  const draft = state.contactDraftSnapshots.get(id);
  if (!draft || !isDeepStrictEqual(draft.subject, approved.subject) || !isDeepStrictEqual(draft.proposals, approved.proposals)) {
    throw new PlanningError(409, 'stale_proposal', '승인된 연락 대안이 변경되었습니다.');
  }
  return draft;
}

async function dispatchOnce(provider: GmailContactPort, input: ApprovedGmailContact, deadline: string, clock: () => Date,
  beforeSend: (signal: AbortSignal) => Promise<void>): Promise<GmailContactResult> {
  const expiresAt = Date.parse(deadline);
  const remaining = expiresAt - clock().getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => clock().getTime() >= expiresAt ? unknown :
        provider.dispatch(input, controller.signal, () => beforeSend(controller.signal))).catch(() => unknown),
      new Promise<GmailContactResult>(resolve => { timer = setTimeout(() => { resolve(unknown); controller.abort(); }, remaining); }),
    ]);
    if (controller.signal.aborted || clock().getTime() >= expiresAt) return unknown;
    if (result?.status === 'submitted' && typeof result.providerOperationId === 'string' &&
        result.providerOperationId.trim() === result.providerOperationId && result.providerOperationId.length > 0 &&
        !/[\x00-\x1f\x7f]/.test(result.providerOperationId)) return result;
    if (result?.status === 'failed' && result.providerOperationId === null) return result;
    return unknown;
  } finally { if (timer) clearTimeout(timer); }
}

export class ContactDispatch {
  constructor(private readonly store: PlanningStore, private readonly planning: PlanningService,
    private readonly provider: GmailContactPort | undefined, private readonly clock: () => Date = () => new Date()) {}

  async send(userId: string, id: string, input: { requestId: string; contactRevision: number; expectedSenderAddress: string }, key: string): Promise<HttpResult> {
    if (!this.store.durable) {
      return error(503, input.requestId, 'not_configured', '지속 저장소와 이메일 연결이 필요합니다.');
    }
    const identity = JSON.stringify(['contact_send', key]);
    const fingerprint = createHash('sha256').update(JSON.stringify([id, input.contactRevision, input.expectedSenderAddress])).digest('hex');
    const existing = replay(await this.store.read(userId), identity, fingerprint, input.requestId);
    if (existing) return existing;
    if (!gmailAvailable(this.store, this.provider, userId)) {
      return error(503, input.requestId, 'not_configured', '지속 저장소와 이메일 연결이 필요합니다.');
    }
    if (this.provider.senderAddress !== input.expectedSenderAddress) {
      return error(409, input.requestId, 'conflict', '확인한 발신 계정이 변경되었습니다.');
    }
    const token = randomUUID();
    const claim = await this.store.atomic(userId, async () => {
      const state = await this.store.read(userId);
      const previous = replay(state, identity, fingerprint, input.requestId);
      if (previous) return { result: previous };
      if (!gmailAvailable(this.store, this.provider, userId)) {
        return { result: error(503, input.requestId, 'not_configured', '지속 저장소와 이메일 연결이 필요합니다.') };
      }
      if (this.provider.senderAddress !== input.expectedSenderAddress) {
        return { result: error(409, input.requestId, 'conflict', '확인한 발신 계정이 변경되었습니다.') };
      }
      if (state.idempotency.size >= 10_000) return { result: error(503, input.requestId, 'provider_unavailable', '요청 저장 공간이 가득 찼습니다.') };
      let contact: ContactRequest;
      let checkedAt: string;
      try {
        const candidate = state.contactRequests.get(id);
        if (!candidate) throw new PlanningError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
        if (candidate.revision !== input.contactRevision || candidate.deliveryStatus !== 'ready' || !candidate.approvalId) {
          throw new PlanningError(409, 'conflict', '승인된 발송 대기 요청을 확인해 주세요.');
        }
        if ([...state.idempotency.entries()].some(([entryKey, entry]) => entryKey.startsWith('["contact_send",') &&
            entry.operationId === candidate.executionKey)) {
          throw new PlanningError(409, 'conflict', '이미 발송이 시도된 연락 요청입니다.');
        }
        const draft = approvedDraft(state, userId, id, candidate);
        const baseline = await this.planning.capture(userId, 'UTC');
        ({ checkedAt } = validateFreshContact(state, userId, draft.subject, draft, baseline, this.clock));
        contact = candidate;
      } catch (cause) {
        if (!(cause instanceof PlanningError)) throw cause;
        const result = error(cause.status, input.requestId, cause.code, cause.message, cause.retryable, cause.details);
        await this.store.transaction(userId, current => current.idempotency.set(identity,
          { fingerprint, operationId: randomUUID(), state: 'completed', result }));
        return { result };
      }
      const deadline = new Date(Date.parse(checkedAt) + 30_000).toISOString();
      await this.store.transaction(userId, current => {
        current.contactRequests.set(id, { ...contact, deliveryStatus: 'submitting' });
        current.idempotency.set(identity, { fingerprint, operationId: contact.executionKey, state: 'running', token, leaseUntil: deadline });
      });
      return { contact, deadline };
    }).catch((cause: unknown) => {
      // The claim has not committed or reached Gmail if PostgreSQL is read-only.
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '25006') {
        return { result: error(503, input.requestId, 'not_configured', '쓰기 가능한 지속 저장소가 필요합니다.') };
      }
      throw cause;
    });
    if ('result' in claim && claim.result) return claim.result;
    const contact = claim.contact!;
    const deadline = claim.deadline!;
    const provider = this.provider!;
    // The claim is durable and the DB lock has been released before this call.
    const outcome = await dispatchOnce(provider, { recipient: contact.recipientSnapshot.address, subject: contact.purpose,
      message: contact.messageOrCallBrief, executionKey: contact.executionKey }, deadline, this.clock, async signal => {
      const checkDeadline = () => {
        if (signal.aborted || this.clock().getTime() >= Date.parse(deadline)) throw new Error('Contact dispatch expired');
      };
      checkDeadline();
      await this.store.atomic(userId, async () => {
        if (!gmailAvailable(this.store, this.provider, userId) || this.provider.senderAddress !== input.expectedSenderAddress) {
          throw new PlanningError(409, 'conflict', '확인한 발신 계정이 변경되었습니다.');
        }
        const state = await this.store.read(userId);
        const current = state.contactRequests.get(id);
        const record = state.idempotency.get(identity);
        if (!current || !isDeepStrictEqual(current, { ...contact, deliveryStatus: 'submitting' }) ||
            !record || record.state !== 'running' || record.token !== token || record.fingerprint !== fingerprint ||
            record.operationId !== contact.executionKey || record.leaseUntil !== deadline) {
          throw new PlanningError(409, 'conflict', '발송 대상 또는 실행 상태가 변경되었습니다.');
        }
        const draft = approvedDraft(state, userId, id, contact);
        const baseline = await this.planning.capture(userId, 'UTC');
        validateFreshContact(state, userId, draft.subject, draft, baseline, this.clock);
        checkDeadline();
      });
      checkDeadline();
    });
    return this.store.transaction(userId, state => {
      const record = state.idempotency.get(identity);
      const current = state.contactRequests.get(id);
      if (!record || record.state !== 'running' || record.token !== token || record.fingerprint !== fingerprint ||
          record.operationId !== contact.executionKey || record.leaseUntil !== deadline ||
          !current || !isDeepStrictEqual(current, { ...contact, deliveryStatus: 'submitting' })) {
        return error(503, input.requestId, 'provider_unavailable', '발송 결과를 확인해 주세요. 자동 재발송하지 않습니다.');
      }
      const updated: ContactRequest = { ...current,
        deliveryStatus: outcome.status === 'submitted' ? 'sent_or_connected' : outcome.status,
        negotiationStatus: outcome.status === 'submitted' ? 'awaiting_response' : 'not_started',
        providerOperationId: outcome.status === 'submitted' ? outcome.providerOperationId : null };
      state.contactRequests.set(id, updated);
      const result: HttpResult = { status: 200, body: { requestId: input.requestId, data: { contactRequest: updated } } };
      record.state = 'completed'; record.result = result; delete record.token; delete record.leaseUntil;
      return result;
    });
  }
}
