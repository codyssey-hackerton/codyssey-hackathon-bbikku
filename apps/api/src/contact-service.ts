import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assessChanges, hasCurrentSnapshotRevisions } from '@pikku/domain';
import type { Approval, ContextSnapshot, Proposal, Recipient } from '@pikku/domain';
import { PlanningError, PlanningService } from './planning-service.ts';
import { compareInstants, timestamp } from './planning-schemas.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';

type ContactOption = { optionId: string; proposalId: string; proposalRevision: number };
export type ContactRequest = {
  id: string; revision: number; baseScheduleRevision: number; baseContextRevision: number;
  recipientRef: string; recipientSnapshot: Pick<Recipient, 'displayName' | 'channel' | 'address'>;
  channel: 'email' | 'phone'; purpose: string; messageOrCallBrief: string; allowedOptions: ContactOption[];
  approvalId: string | null; executionKey: string; providerOperationId: string | null;
  deliveryStatus: 'pending_approval' | 'rejected' | 'ready' | 'submitting' | 'sent_or_connected' | 'failed' | 'outcome_unknown';
  negotiationStatus: 'not_started' | 'awaiting_response' | 'accepted' | 'declined' | 'alternative_proposed' | 'needs_user_review' | 'applied';
  createdAt: string;
};
export type StoredContactApproval = { approval: Approval & { subjectType: 'contact_request' }; subject: ContactRequest; proposals: Proposal[] };
export type StoredContactDraft = { subject: ContactRequest; proposals: Proposal[] };
type CreateRecipient = { displayName: string; channel: 'email' | 'phone'; address: string; confirmed: true };
type CreateContact = Pick<ContactRequest, 'recipientRef' | 'channel' | 'purpose' | 'messageOrCallBrief' | 'allowedOptions'>;
const email = z.email().max(254).refine(value => {
  const [local, domain] = value.split('@');
  return !!local && local.length <= 64 && !!domain && domain.split('.').every(label => label.length <= 63);
});
const phone = /^\+[1-9]\d{1,14}$/;

function recipientSnapshot(recipient: Recipient): ContactRequest['recipientSnapshot'] {
  return { displayName: recipient.displayName, channel: recipient.channel, address: recipient.address };
}

function confirmedRecipient(state: UserPlanningState, id: string, channel: ContactRequest['channel']): Recipient {
  const recipient = state.recipients.get(id);
  if (!recipient) throw new PlanningError(404, 'not_found', '확인된 수신자를 찾을 수 없습니다.');
  if (recipient.id !== id || recipient.channel !== channel ||
      !(channel === 'email' ? email.safeParse(recipient.address).success : phone.test(recipient.address)) || !timestamp.safeParse(recipient.confirmedByUserAt).success) {
    throw new PlanningError(409, 'conflict', '수신자 또는 연락 수단을 다시 확인해 주세요.');
  }
  return recipient;
}

function validatedOptions(state: UserPlanningState, userId: string, options: ContactOption[], current: ContextSnapshot, factsKey: string): Proposal[] {
  const proposals: Proposal[] = [];
  for (const option of options) {
    const proposal = state.proposals.get(option.proposalId);
    if (!proposal) throw new PlanningError(404, 'not_found', '연락 대안을 찾을 수 없습니다.');
    if (proposal.revision !== option.proposalRevision) throw new PlanningError(409, 'stale_proposal', '연락 대안의 버전이 변경되었습니다.');
    if (proposal.status !== 'pending' && proposal.status !== 'awaiting_contact') throw new PlanningError(409, 'conflict', '이미 처리된 연락 대안입니다.');
    if (proposal.mode !== 'coordination' || !proposal.coordinationTarget || !proposal.validation.valid ||
        proposal.validation.checkedScheduleRevision !== proposal.baseScheduleRevision || proposal.validation.checkedContextRevision !== proposal.baseContextRevision) {
      throw new PlanningError(409, 'conflict', '검증된 공동 일정 대안만 선택할 수 있습니다.');
    }
    if (proposal.expiresAt && compareInstants(current.now, proposal.expiresAt) >= 0) throw new PlanningError(409, 'expired_proposal', '연락 대안이 만료되었습니다.');
    if (!hasCurrentSnapshotRevisions(proposal, current) || state.proposalFacts.get(proposal.id) !== factsKey) {
      throw new PlanningError(409, 'stale_proposal', '일정 또는 맥락이 변경되었습니다.');
    }
    const target = current.items.find(item => item.id === proposal.coordinationTarget.id);
    if (!target || proposal.beforeItems.length !== 1 || !isDeepStrictEqual(proposal.beforeItems[0], target)) {
      throw new PlanningError(409, 'stale_proposal', '공동 일정의 기준이 변경되었습니다.');
    }
    const checked = assessChanges({ authenticatedUserId: userId, snapshotUserId: userId, snapshot: current,
      changeSet: proposal.changeSet, purpose: 'ai_proposal', checkedAt: current.now, coordinationTarget: proposal.coordinationTarget });
    if (!checked.validation.valid || checked.mode !== 'coordination' || !isDeepStrictEqual(checked.coordinationTarget, proposal.coordinationTarget)) {
      throw new PlanningError(409, 'stale_proposal', '연락 대안을 현재 상태에서 다시 검증할 수 없습니다.');
    }
    const first = proposals[0];
    if (first && (first.mode !== 'coordination' || !isDeepStrictEqual(first.coordinationTarget, proposal.coordinationTarget) ||
        first.baseScheduleRevision !== proposal.baseScheduleRevision || first.baseContextRevision !== proposal.baseContextRevision)) {
      throw new PlanningError(409, 'conflict', '같은 공동 일정과 기준 버전의 대안만 선택할 수 있습니다.');
    }
    proposals.push(proposal);
  }
  return proposals;
}

// Call while holding the user's store transaction, immediately before approval or dispatch.
export function validateFreshContact(state: UserPlanningState, userId: string, subject: ContactRequest,
  draft: StoredContactDraft, baseline: Awaited<ReturnType<PlanningService['capture']>>, clock: () => Date): { proposals: Proposal[]; checkedAt: string } {
  const recipient = confirmedRecipient(state, subject.recipientRef, subject.channel);
  if (!isDeepStrictEqual(recipientSnapshot(recipient), subject.recipientSnapshot) ||
      subject.baseScheduleRevision !== baseline.snapshot.scheduleRevision || subject.baseContextRevision !== baseline.snapshot.contextRevision) {
    throw new PlanningError(409, 'stale_proposal', '수신자 또는 일정·맥락이 변경되었습니다.');
  }
  const proposals = validatedOptions(state, userId, subject.allowedOptions, baseline.snapshot, baseline.factsKey);
  if (!isDeepStrictEqual(draft.subject, subject) || !isDeepStrictEqual(draft.proposals, proposals)) {
    throw new PlanningError(409, 'stale_proposal', '연락 요청 또는 대안이 변경되었습니다.');
  }
  const checkedAt = clock().toISOString();
  if (compareInstants(checkedAt, baseline.snapshot.now) < 0 || [...state.facts.values()].some(fact => {
    const active = (at: string) => compareInstants(fact.recordedAt, at) <= 0 && (!fact.validUntil || compareInstants(at, fact.validUntil) < 0);
    return active(baseline.snapshot.now) !== active(checkedAt);
  })) throw new PlanningError(409, 'stale_proposal', '연락 처리 중 맥락의 유효 기간이 변경되었습니다.');
  for (const proposal of proposals) {
    if ((proposal.expiresAt && compareInstants(checkedAt, proposal.expiresAt) >= 0) ||
        proposal.changeSet.changes.some(change => change.operation !== 'delete' && change.after.timeSlot &&
          compareInstants(checkedAt, change.after.timeSlot.startsAt) >= 0)) {
      throw new PlanningError(409, 'expired_proposal', '연락 대안이 만료되었습니다.');
    }
  }
  return { proposals, checkedAt };
}

function visibleContact(state: UserPlanningState, contact: ContactRequest, now: Date): ContactRequest {
  if (contact.deliveryStatus !== 'submitting') return contact;
  const attempt = [...state.idempotency.entries()].find(([key, value]) => key.startsWith('["contact_send",') &&
    value.operationId === contact.executionKey && value.state === 'running')?.[1];
  // An expired claim is never taken over; the view alone becomes uncertain if a process died.
  if (!attempt?.leaseUntil || !Number.isFinite(Date.parse(attempt.leaseUntil)) || Date.parse(attempt.leaseUntil) <= now.getTime()) {
    return { ...contact, deliveryStatus: 'outcome_unknown' };
  }
  return contact;
}

export class ContactService {
  constructor(private readonly store: PlanningStore, private readonly planning: PlanningService, private readonly clock: () => Date = () => new Date()) {}

  async createRecipient(userId: string, input: CreateRecipient) {
    if (input.confirmed !== true || !(input.channel === 'email' ? email.safeParse(input.address).success : phone.test(input.address))) {
      throw new PlanningError(400, 'invalid_request', '확인된 연락처가 필요합니다.');
    }
    const recipient: Recipient = { id: randomUUID(), displayName: input.displayName, channel: input.channel,
      address: input.address, confirmedByUserAt: this.clock().toISOString() };
    return this.store.transaction(userId, state => { state.recipients.set(recipient.id, recipient); return { recipient }; });
  }

  async create(userId: string, input: CreateContact) {
    return this.store.atomic(userId, async () => {
      const baseline = await this.planning.capture(userId, 'UTC');
      return this.store.transaction(userId, state => {
        const recipient = confirmedRecipient(state, input.recipientRef, input.channel);
        const proposals = validatedOptions(state, userId, input.allowedOptions, baseline.snapshot, baseline.factsKey);
        const contactRequest: ContactRequest = { id: randomUUID(), revision: 1,
          baseScheduleRevision: baseline.snapshot.scheduleRevision, baseContextRevision: baseline.snapshot.contextRevision,
          recipientRef: recipient.id, recipientSnapshot: recipientSnapshot(recipient), channel: input.channel,
          purpose: input.purpose, messageOrCallBrief: input.messageOrCallBrief, allowedOptions: structuredClone(input.allowedOptions),
          approvalId: null, executionKey: randomUUID(), providerOperationId: null,
          deliveryStatus: 'pending_approval', negotiationStatus: 'not_started', createdAt: baseline.snapshot.now };
        state.contactRequests.set(contactRequest.id, contactRequest);
        state.contactDraftSnapshots.set(contactRequest.id, { subject: structuredClone(contactRequest), proposals: structuredClone(proposals) });
        return { contactRequest };
      });
    });
  }

  async get(userId: string, id: string) {
    const state = await this.store.read(userId);
    const contactRequest = state.contactRequests.get(id);
    if (!contactRequest) throw new PlanningError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
    return { contactRequest: visibleContact(state, contactRequest, this.clock()) };
  }

  async list(userId: string, proposalId?: string) {
    const state = await this.store.read(userId);
    const contactRequests = [...state.contactRequests.values()].reverse()
      .filter(contact => !proposalId || contact.allowedOptions.some(option => option.proposalId === proposalId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100).map(contact => visibleContact(state, contact, this.clock()));
    return { contactRequests };
  }

  async decide(userId: string, id: string, input: { contactRevision: number; decision: 'accept' | 'reject' }) {
    return this.store.atomic(userId, async () => {
      const baseline = input.decision === 'accept' ? await this.planning.capture(userId, 'UTC') : null;
      return this.store.transaction(userId, state => {
        const contactRequest = state.contactRequests.get(id);
        if (!contactRequest) throw new PlanningError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
        if (contactRequest.revision !== input.contactRevision) throw new PlanningError(409, 'conflict', '연락 요청 버전이 변경되었습니다.');
        if (contactRequest.deliveryStatus !== 'pending_approval' || contactRequest.approvalId !== null) {
          throw new PlanningError(409, 'conflict', '이미 처리된 연락 요청입니다.');
        }
        const draft = state.contactDraftSnapshots.get(id);
        if (!draft || !Array.isArray(draft.proposals) || !isDeepStrictEqual(draft.subject, contactRequest)) {
          throw new PlanningError(409, 'stale_proposal', '연락 요청 내용이 변경되었습니다.');
        }
        const completeDecision = (proposals: Proposal[], decidedAt: string) => {
          const approval: StoredContactApproval['approval'] = { id: randomUUID(), subjectType: 'contact_request', subjectId: id,
            subjectRevision: contactRequest.revision, decision: input.decision, decidedAt, actorRef: userId };
          state.contactApprovals.push({ approval, subject: structuredClone(draft.subject), proposals: structuredClone(proposals) });
          const updated: ContactRequest = { ...contactRequest, approvalId: approval.id, deliveryStatus: input.decision === 'accept' ? 'ready' : 'rejected' };
          state.contactRequests.set(id, updated);
          return { contactRequest: updated };
        };
        if (input.decision === 'reject') return completeDecision(draft.proposals, this.clock().toISOString());
        if (!baseline) throw new Error('Missing approval baseline');
        const { proposals, checkedAt } = validateFreshContact(state, userId, contactRequest, draft, baseline, this.clock);
        return completeDecision(proposals, checkedAt);
      });
    });
  }
}
