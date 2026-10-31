import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateFreshContact, type ContactRequest } from './contact-service.ts';
import { compareInstants, identifier, timestamp } from './planning-schemas.ts';
import { applyChanges, PlanningError, PlanningService } from './planning-service.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';

export type ContactResponse = { id: string; contactRequestId: string; providerEventId: string; receivedAt: string;
  outcome: 'accepted' | 'declined' | 'alternative_proposed' | 'unclear'; selectedOptionId: string | null; evidenceRef: string;
  displayText: string | null; reviewReason: string | null };
export type VerifiedContactEvent = { providerEventId: string; providerOperationId: string; channel: 'email' | 'phone';
  recipientAddress: string; receivedAt: string; outcome: ContactResponse['outcome']; selectedOptionId: string | null; evidenceRef: string;
  displayText?: string | null; reviewReason?: string | null };
export type StoredContactResponse = { response: ContactResponse; event: VerifiedContactEvent; confirmed?: { actorRef: string; selectedOptionId: string; decidedAt: string } };
const safeText = z.string().max(2000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value);
const verifiedEvent = z.object({ providerEventId: identifier, providerOperationId: identifier, channel: z.enum(['email', 'phone']),
  recipientAddress: z.string().min(1).max(254), receivedAt: timestamp, outcome: z.enum(['accepted', 'declined', 'alternative_proposed', 'unclear']),
  selectedOptionId: identifier.nullable(), evidenceRef: identifier, displayText: safeText.nullable().optional(), reviewReason: identifier.nullable().optional() }).strict();

function contactFor(state: UserPlanningState, id: string): ContactRequest {
  const contact = state.contactRequests.get(id);
  if (!contact) throw new PlanningError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
  return contact;
}
function approvalDraft(state: UserPlanningState, userId: string, contact: ContactRequest) {
  const matches = state.contactApprovals.filter(item => item.approval.id === contact.approvalId);
  const approved = matches[0]; const draft = state.contactDraftSnapshots.get(contact.id);
  if (matches.length !== 1 || !approved || approved.approval.subjectType !== 'contact_request' || approved.approval.subjectId !== contact.id ||
      approved.approval.subjectRevision !== contact.revision || approved.approval.actorRef !== userId || approved.approval.decision !== 'accept' ||
      approved.subject.deliveryStatus !== 'pending_approval' || approved.subject.approvalId !== null || approved.subject.providerOperationId !== null ||
      approved.subject.negotiationStatus !== 'not_started' || !draft || !isDeepStrictEqual(draft.subject, approved.subject) ||
      !isDeepStrictEqual(draft.proposals, approved.proposals) ||
      !isDeepStrictEqual({ ...contact, approvalId: null, deliveryStatus: 'pending_approval', negotiationStatus: 'not_started', providerOperationId: null }, approved.subject)) {
    throw new PlanningError(409, 'conflict', '승인된 연락 내용이 변경되었습니다.');
  }
  return draft;
}

export class ContactResponseService {
  constructor(private readonly store: PlanningStore, private readonly planning: PlanningService, private readonly clock: () => Date = () => new Date()) {}

  async list(userId: string, contactId: string) {
    const state = await this.store.read(userId); const contactRequest = contactFor(state, contactId);
    const responses = [...state.contactResponses.values()].filter(item => item.response.contactRequestId === contactId).map(item => item.response);
    return { contactRequest, responses };
  }

  // Trusted server adapters only. Provider authentication and correlation must already have been verified.
  async recordVerified(userId: string, contactId: string, input: VerifiedContactEvent) {
    if (!this.store.durable) throw new PlanningError(503, 'not_configured', '지속 저장소가 필요합니다.');
    const parsed = verifiedEvent.safeParse(input);
    if (!parsed.success || (parsed.data.channel === 'email' && (parsed.data.outcome !== 'unclear' || parsed.data.selectedOptionId !== null))) {
      throw new PlanningError(400, 'invalid_request', '검증된 회신을 확인해 주세요.');
    }
    const event: VerifiedContactEvent = { ...parsed.data, displayText: parsed.data.displayText ?? null, reviewReason: parsed.data.reviewReason ?? null };
    const key = JSON.stringify([event.channel, event.providerEventId]);
    return this.store.atomic(userId, async () => {
      const state = await this.store.read(userId); const contact = contactFor(state, contactId);
      const prior = state.contactResponses.get(key);
      if (prior) {
        if (prior.response.contactRequestId !== contactId || !isDeepStrictEqual(prior.event, event)) throw new PlanningError(409, 'conflict', '이미 처리된 회신입니다.');
        return { contactRequest: contact, response: prior.response, scheduleRevision: state.scheduleRevision, changed: false };
      }
      if (contact.channel !== event.channel || contact.recipientSnapshot.address !== event.recipientAddress ||
          contact.providerOperationId !== event.providerOperationId || contact.deliveryStatus !== 'sent_or_connected') {
        throw new PlanningError(409, 'conflict', '발송과 회신의 연관을 확인할 수 없습니다.');
      }
      const response: ContactResponse = { id: randomUUID(), contactRequestId: contactId, providerEventId: event.providerEventId,
        receivedAt: event.receivedAt, outcome: event.outcome, selectedOptionId: event.selectedOptionId, evidenceRef: event.evidenceRef,
        displayText: event.displayText ?? null, reviewReason: event.reviewReason ?? null };
      const stored: StoredContactResponse = { response, event };
      if (contact.negotiationStatus !== 'awaiting_response') return this.store.transaction(userId, current => {
        current.contactResponses.set(key, stored);
        return { contactRequest: contact, response, scheduleRevision: current.scheduleRevision, changed: false };
      });
      if (event.outcome === 'declined') return this.store.transaction(userId, current => {
        const updated: ContactRequest = { ...contact, negotiationStatus: 'declined' }; current.contactRequests.set(contactId, updated); current.contactResponses.set(key, stored);
        return { contactRequest: updated, response, scheduleRevision: current.scheduleRevision, changed: false };
      });
      if (event.outcome === 'accepted' && event.selectedOptionId && contact.allowedOptions.some(option => option.optionId === event.selectedOptionId)) {
        return this.applyOrReview(userId, contact, stored, key, event.selectedOptionId, false);
      }
      return this.store.transaction(userId, current => {
        const updated: ContactRequest = { ...contact, negotiationStatus: 'needs_user_review' }; current.contactRequests.set(contactId, updated); current.contactResponses.set(key, stored);
        return { contactRequest: updated, response, scheduleRevision: current.scheduleRevision, changed: false };
      });
    });
  }

  async confirm(userId: string, contactId: string, input: { responseId: string; contactRevision: number; selectedOptionId: string }) {
    if (!this.store.durable) throw new PlanningError(503, 'not_configured', '지속 저장소가 필요합니다.');
    if (!identifier.safeParse(input?.responseId).success || !identifier.safeParse(input?.selectedOptionId).success || !Number.isSafeInteger(input?.contactRevision)) {
      throw new PlanningError(400, 'invalid_request', '회신과 선택한 대안을 확인해 주세요.');
    }
    return this.store.atomic(userId, async () => {
      const state = await this.store.read(userId); const contact = contactFor(state, contactId);
      if (contact.revision !== input.contactRevision) throw new PlanningError(409, 'conflict', '연락 요청 버전이 변경되었습니다.');
      const found = [...state.contactResponses.entries()].find(([, item]) => item.response.id === input.responseId && item.response.contactRequestId === contactId);
      if (!found) throw new PlanningError(404, 'not_found', '회신을 찾을 수 없습니다.');
      const [key, stored] = found;
      if (stored.confirmed) {
        throw new PlanningError(409, 'conflict', '이미 확인한 회신입니다.');
      }
      const superseded = [...state.contactResponses.values()].some(other => other.response.id !== stored.response.id &&
        other.response.contactRequestId === contactId && compareInstants(other.response.receivedAt, stored.response.receivedAt) >= 0);
      const reviewable = (stored.event.channel === 'email' && stored.response.reviewReason === 'sender_unverified') ||
        (stored.event.channel === 'phone' && stored.response.reviewReason === 'voice_transcript_unverified');
      if (contact.negotiationStatus !== 'needs_user_review' || !reviewable || stored.response.outcome !== 'unclear' ||
          superseded || contact.deliveryStatus !== 'sent_or_connected' || contact.channel !== stored.event.channel ||
          contact.providerOperationId !== stored.event.providerOperationId || contact.recipientSnapshot.address !== stored.event.recipientAddress ||
          stored.response.displayText !== (stored.event.displayText ?? null) || stored.response.reviewReason !== (stored.event.reviewReason ?? null) ||
          !stored.response.displayText?.trim() ||
          !contact.allowedOptions.some(option => option.optionId === input.selectedOptionId)) {
        throw new PlanningError(409, 'conflict', '회신 또는 허용된 대안을 다시 확인해 주세요.');
      }
      return this.applyOrReview(userId, contact, stored, key, input.selectedOptionId, true);
    });
  }

  private async applyOrReview(userId: string, contact: ContactRequest, stored: StoredContactResponse, key: string, optionId: string, manual: boolean) {
    try {
      const state = await this.store.read(userId);
      const draft = approvalDraft(state, userId, contact);
      const baseline = await this.planning.capture(userId, 'UTC');
      const { proposals } = validateFreshContact(state, userId, draft.subject, draft, baseline, this.clock);
      const option = contact.allowedOptions.find(item => item.optionId === optionId)!;
      const selected = proposals.find(proposal => proposal.id === option.proposalId && proposal.revision === option.proposalRevision);
      if (!selected) throw new PlanningError(409, 'stale_proposal', '선택한 대안을 확인할 수 없습니다.');
      return this.store.transaction(userId, current => {
        applyChanges(current, selected.changeSet);
        for (const candidate of proposals) {
          current.proposals.set(candidate.id, { ...candidate, status: candidate.id === selected.id ? 'applied' : 'stale', revision: candidate.revision + 1 });
        }
        const updated: ContactRequest = { ...contact, negotiationStatus: 'applied' };
        if (manual) stored.confirmed = { actorRef: userId, selectedOptionId: optionId, decidedAt: this.clock().toISOString() };
        current.contactRequests.set(contact.id, updated); current.contactResponses.set(key, stored);
        return { contactRequest: updated, response: stored.response, scheduleRevision: current.scheduleRevision, changed: true };
      });
    } catch (cause) {
      if (!(cause instanceof PlanningError)) throw cause;
      return this.store.transaction(userId, current => {
        const updated: ContactRequest = { ...contact, negotiationStatus: 'needs_user_review' };
        current.contactRequests.set(contact.id, updated); current.contactResponses.set(key, stored);
        return { contactRequest: updated, response: stored.response, scheduleRevision: current.scheduleRevision, changed: false };
      });
    }
  }
}
