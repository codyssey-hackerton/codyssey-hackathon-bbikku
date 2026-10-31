import { isDeepStrictEqual } from 'node:util';
import type { ScheduleItem } from '@pikku/domain';
import type { UserPlanningState } from './planning-store.ts';
import { compareInstants, timestamp } from './planning-schemas.ts';

export type CalendarContactSource = { accountRef: string; calendarId: string; externalEventId: string; sourceVersion: string };
export type CalendarContactAuthorization = { beforeItem: ScheduleItem; afterItem: ScheduleItem; proposalId: string; contactRequestId: string };

// Evidence is only valid for the exact, already-applied contact change and its original Google version.
export function findCalendarContactAuthorization(input: { state: UserPlanningState; userId: string; item: ScheduleItem; source: CalendarContactSource }): CalendarContactAuthorization | null {
  try {
    const { state, userId, item, source } = input;
    if (typeof userId !== 'string' || !userId.trim() || !item || item.kind !== 'event' || item.involvement !== 'shared' ||
        !item.timeSlot || !isDeepStrictEqual(state.items.get(item.id), item) ||
        !source || [source.accountRef, source.calendarId, source.externalEventId, source.sourceVersion].some(value => typeof value !== 'string' || !value.trim())) return null;
    const proofs: CalendarContactAuthorization[] = [];
    for (const [contactId, contact] of state.contactRequests) {
      if (contactId !== contact.id || contact.negotiationStatus !== 'applied' || contact.deliveryStatus !== 'sent_or_connected' || !contact.approvalId || !contact.providerOperationId) continue;
      const approvals = state.contactApprovals.filter(entry => entry.approval.id === contact.approvalId);
      const draft = state.contactDraftSnapshots.get(contact.id);
      if (approvals.length !== 1 || !draft) continue;
      const approved = approvals[0]!; const approval = approved.approval;
      if (approval.subjectType !== 'contact_request' || approval.subjectId !== contact.id || approval.subjectRevision !== contact.revision ||
          approval.actorRef !== userId || approval.decision !== 'accept' || !timestamp.safeParse(approval.decidedAt).success ||
          approved.subject.deliveryStatus !== 'pending_approval' || approved.subject.approvalId !== null ||
          approved.subject.providerOperationId !== null || approved.subject.negotiationStatus !== 'not_started' ||
          !isDeepStrictEqual(draft.subject, approved.subject) || !isDeepStrictEqual(draft.proposals, approved.proposals) ||
          !isDeepStrictEqual({ ...contact, approvalId: null, deliveryStatus: 'pending_approval', negotiationStatus: 'not_started', providerOperationId: null }, approved.subject)) continue;
      const responses = [...state.contactResponses.entries()].filter(([, stored]) => stored.response.contactRequestId === contact.id);
      for (const [key, stored] of responses) {
        const { response, event, confirmed } = stored;
        if (key !== JSON.stringify([event.channel, event.providerEventId]) || response.contactRequestId !== contact.id ||
            response.providerEventId !== event.providerEventId || response.receivedAt !== event.receivedAt || response.outcome !== event.outcome ||
            response.selectedOptionId !== event.selectedOptionId || response.evidenceRef !== event.evidenceRef ||
            response.displayText !== (event.displayText ?? null) || response.reviewReason !== (event.reviewReason ?? null) ||
            event.channel !== contact.channel || event.providerOperationId !== contact.providerOperationId ||
            event.recipientAddress !== contact.recipientSnapshot.address || !response.id || !timestamp.safeParse(event.receivedAt).success ||
            compareInstants(event.receivedAt, approval.decidedAt) < 0) continue;
        let optionId: string | null = null;
        if (confirmed && confirmed.actorRef === userId && timestamp.safeParse(confirmed.decidedAt).success &&
            compareInstants(confirmed.decidedAt, approval.decidedAt) >= 0 && compareInstants(confirmed.decidedAt, event.receivedAt) >= 0 &&
            event.outcome === 'unclear' && event.selectedOptionId === null && !!response.displayText?.trim() &&
            ((event.channel === 'email' && event.reviewReason === 'sender_unverified') || (event.channel === 'phone' && event.reviewReason === 'voice_transcript_unverified'))) {
          optionId = confirmed.selectedOptionId;
        } else if (!confirmed && event.channel === 'phone' && event.outcome === 'accepted' && event.selectedOptionId) {
          optionId = event.selectedOptionId;
        }
        if (!optionId || responses.some(([, other]) => other.response.id !== response.id && compareInstants(other.response.receivedAt, response.receivedAt) >= 0)) continue;
        const options = contact.allowedOptions.filter(option => option.optionId === optionId);
        if (options.length !== 1) continue;
        const option = options[0]!;
        const snapshots = approved.proposals.filter(proposal => proposal.id === option.proposalId && proposal.revision === option.proposalRevision);
        if (snapshots.length !== 1) continue;
        const proposal = snapshots[0]!; const current = state.proposals.get(proposal.id);
        if (!current || !isDeepStrictEqual(current, { ...proposal, revision: proposal.revision + 1, status: 'applied' }) ||
            proposal.mode !== 'coordination' || !['pending', 'awaiting_contact'].includes(proposal.status) || !proposal.validation.valid ||
            proposal.baseScheduleRevision !== contact.baseScheduleRevision || proposal.baseContextRevision !== contact.baseContextRevision ||
            proposal.validation.checkedScheduleRevision !== proposal.baseScheduleRevision || proposal.validation.checkedContextRevision !== proposal.baseContextRevision || proposal.beforeItems.length !== 1 ||
            proposal.changeSet.changes.length !== 1 || (proposal.expiresAt &&
              (!timestamp.safeParse(proposal.expiresAt).success || compareInstants(approval.decidedAt, proposal.expiresAt) >= 0 ||
               (!confirmed && compareInstants(event.receivedAt, proposal.expiresAt) >= 0) ||
               (confirmed && compareInstants(confirmed.decidedAt, proposal.expiresAt) >= 0)))) continue;
        const beforeItem = proposal.beforeItems[0]!; const change = proposal.changeSet.changes[0]!;
        if (beforeItem.kind !== 'event' || beforeItem.involvement !== 'shared' || !beforeItem.timeSlot ||
            proposal.coordinationTarget.id !== beforeItem.id || proposal.coordinationTarget.expectedRevision !== beforeItem.revision ||
            change.operation !== 'update' || change.targetId !== beforeItem.id || change.expectedRevision !== beforeItem.revision ||
            change.after.kind !== 'event' || change.after.involvement !== 'shared' || !change.after.timeSlot ||
            !timestamp.safeParse(beforeItem.timeSlot.startsAt).success || !timestamp.safeParse(beforeItem.timeSlot.endsAt).success ||
            !timestamp.safeParse(change.after.timeSlot.startsAt).success || !timestamp.safeParse(change.after.timeSlot.endsAt).success ||
            compareInstants(beforeItem.timeSlot.startsAt, beforeItem.timeSlot.endsAt) >= 0 || compareInstants(change.after.timeSlot.startsAt, change.after.timeSlot.endsAt) >= 0 ||
            (compareInstants(beforeItem.timeSlot.startsAt, change.after.timeSlot.startsAt) === 0 && compareInstants(beforeItem.timeSlot.endsAt, change.after.timeSlot.endsAt) === 0)) continue;
        const { id: _id, revision: _revision, sourceRefs: _sourceRefs, timeSlot: _beforeTime, ...beforeFields } =
          { ...beforeItem, category: beforeItem.category ?? null, attendance: beforeItem.attendance ?? null };
        const { id: _afterId, revision: _afterRevision, sourceRefs: _afterRefs, timeSlot: _afterTime, ...afterFields } =
          { ...beforeItem, ...change.after, category: change.after.category === undefined ? beforeItem.category ?? null : change.after.category,
            attendance: change.after.attendance === undefined ? beforeItem.attendance ?? null : change.after.attendance };
        if (!isDeepStrictEqual(beforeFields, afterFields)) continue;
        const matchingRefs = beforeItem.sourceRefs.filter(ref => ref.provider === 'google_calendar' && ref.accountRef === source.accountRef &&
          ref.calendarId === source.calendarId && ref.externalEventId === source.externalEventId);
        if (matchingRefs.length !== 1 || matchingRefs[0]!.sourceVersion !== source.sourceVersion) continue;
        const afterItem: ScheduleItem = { ...beforeItem, ...change.after, id: beforeItem.id, revision: beforeItem.revision + 1, sourceRefs: beforeItem.sourceRefs };
        if (!isDeepStrictEqual(item, afterItem)) continue;
        proofs.push({ beforeItem, afterItem, proposalId: proposal.id, contactRequestId: contact.id });
      }
    }
    return proofs.length === 1 ? structuredClone(proofs[0]!) : null;
  } catch { return null; }
}
