import type { CreateRecipientInput, Recipient } from '@pikku/domain';
import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/mutation';
import { isOffsetTimestamp } from '../memory/client';

export type { Recipient } from '@pikku/domain';
export type RecipientInput = Omit<CreateRecipientInput, 'requestId'>;

export interface ContactOption {
  optionId: string;
  proposalId: string;
  proposalRevision: number;
}

export interface ContactRequest {
  id: string;
  revision: number;
  baseScheduleRevision: number;
  baseContextRevision: number;
  recipientRef: string;
  recipientSnapshot: Pick<Recipient, 'displayName' | 'channel' | 'address'>;
  channel: 'email' | 'phone';
  purpose: string;
  messageOrCallBrief: string;
  allowedOptions: ContactOption[];
  approvalId: string | null;
  executionKey: string;
  providerOperationId: string | null;
  deliveryStatus: 'pending_approval' | 'rejected' | 'ready' | 'submitting' | 'sent_or_connected' | 'failed' | 'outcome_unknown';
  negotiationStatus: 'not_started' | 'awaiting_response' | 'accepted' | 'declined' | 'alternative_proposed' | 'needs_user_review' | 'applied';
  createdAt: string;
}

export type ContactDraftInput = Pick<ContactRequest, 'recipientRef' | 'channel' | 'purpose' | 'messageOrCallBrief' | 'allowedOptions'>;
export interface ContactDecisionInput { id: string; contactRevision: number; decision: 'accept' | 'reject' }
export interface ContactSendInput { id: string; contactRevision: number; expectedSenderAddress: string }
export type EmailConnection = { status: 'available'; senderAddress: string } | { status: 'not_configured'; senderAddress: string | null };

export interface ContactClient {
  list(proposalId: string): Promise<ContactRequest[]>;
  get(id: string): Promise<ContactRequest>;
  emailConnection(): Promise<EmailConnection>;
  createRecipient(op: Mutation<RecipientInput>): Promise<Recipient>;
  createDraft(op: Mutation<ContactDraftInput>): Promise<ContactRequest>;
  decide(op: Mutation<ContactDecisionInput>): Promise<ContactRequest>;
  send(op: Mutation<ContactSendInput>): Promise<ContactRequest>;
}

function invalidResponse(): ApiError {
  return new ApiError('invalid_response', '서버의 연락 요청 응답을 확인할 수 없습니다.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0;
}

function isId(value: unknown): value is string {
  return isText(value, 200);
}

function isRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isChannel(value: unknown): value is Recipient['channel'] {
  return value === 'email' || value === 'phone';
}

function isRecipientSnapshot(value: unknown): value is ContactRequest['recipientSnapshot'] {
  return isRecord(value) && isText(value.displayName, 200) && !/[\x00-\x1f\x7f]/.test(value.displayName) &&
    isChannel(value.channel) && isText(value.address, 254);
}

function isRecipient(value: unknown): value is Recipient {
  return isRecord(value) && isId(value.id) && isOffsetTimestamp(value.confirmedByUserAt) && isRecipientSnapshot(value);
}

function isOption(value: unknown): value is ContactOption {
  return isRecord(value) && isId(value.optionId) && isId(value.proposalId) && isRevision(value.proposalRevision, 1);
}

function isContactRequest(value: unknown): value is ContactRequest {
  if (!isRecord(value) || !isId(value.id) || !isRevision(value.revision, 1) ||
      !isRevision(value.baseScheduleRevision, 0) || !isRevision(value.baseContextRevision, 0) ||
      !isId(value.recipientRef) || !isRecipientSnapshot(value.recipientSnapshot) ||
      !isChannel(value.channel) || value.recipientSnapshot.channel !== value.channel ||
      !isText(value.purpose, 200) || /[\x00-\x1f\x7f]/.test(value.purpose) ||
      !isText(value.messageOrCallBrief, 20_000) || !Array.isArray(value.allowedOptions) ||
      value.allowedOptions.length < 1 || value.allowedOptions.length > 100 || !value.allowedOptions.every(isOption) ||
      !(value.approvalId === null || isId(value.approvalId)) || !isId(value.executionKey) ||
      !(value.providerOperationId === null || (typeof value.providerOperationId === 'string' && value.providerOperationId.trim().length > 0)) ||
      !['pending_approval', 'rejected', 'ready', 'submitting', 'sent_or_connected', 'failed', 'outcome_unknown'].includes(value.deliveryStatus as string) ||
      !['not_started', 'awaiting_response', 'accepted', 'declined', 'alternative_proposed', 'needs_user_review', 'applied'].includes(value.negotiationStatus as string) ||
      !isOffsetTimestamp(value.createdAt)) return false;

  const options = value.allowedOptions as ContactOption[];
  return new Set(options.map(option => option.optionId)).size === options.length &&
    new Set(options.map(option => option.proposalId)).size === options.length;
}

function contactFrom(data: unknown): ContactRequest {
  if (!isRecord(data) || !isContactRequest(data.contactRequest)) throw invalidResponse();
  return data.contactRequest;
}

export function createContactClient(api: ApiClient): ContactClient {
  return {
    async list(proposalId) {
      const data = await api.get<unknown>(`/v1/contact-requests?proposalId=${encodeURIComponent(proposalId)}`);
      if (!isRecord(data) || !Array.isArray(data.contactRequests) || !data.contactRequests.every(isContactRequest) ||
          data.contactRequests.some((contact: ContactRequest) => !contact.allowedOptions.some(option => option.proposalId === proposalId)) ||
          new Set(data.contactRequests.map((contact: ContactRequest) => contact.id)).size !== data.contactRequests.length) throw invalidResponse();
      return data.contactRequests;
    },
    async get(id) {
      const contact = contactFrom(await api.get<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}`));
      if (contact.id !== id) throw invalidResponse();
      return contact;
    },
    async emailConnection() {
      const data = await api.get<unknown>('/v1/email-connection');
      if (!isRecord(data) || (data.status !== 'available' && data.status !== 'not_configured') ||
          !(data.senderAddress === null || typeof data.senderAddress === 'string') ||
          (data.status === 'available' && (typeof data.senderAddress !== 'string' || !data.senderAddress.trim()))) throw invalidResponse();
      if (data.status === 'available') return { status: data.status, senderAddress: data.senderAddress as string };
      return { status: data.status, senderAddress: data.senderAddress };
    },
    async createRecipient({ input, requestId, idempotencyKey }) {
      const { displayName, channel, address, confirmed } = input;
      const data = await api.post<unknown>('/v1/recipients',
        { requestId, displayName, channel, address, confirmed }, { idempotencyKey });
      if (!isRecord(data) || !isRecipient(data.recipient) || data.recipient.displayName !== displayName ||
          data.recipient.channel !== channel || data.recipient.address !== address) throw invalidResponse();
      return data.recipient;
    },
    async createDraft({ input, requestId, idempotencyKey }) {
      const { recipientRef, channel, purpose, messageOrCallBrief, allowedOptions } = input;
      const contact = contactFrom(await api.post<unknown>('/v1/contact-requests',
        { requestId, recipientRef, channel, purpose, messageOrCallBrief, allowedOptions }, { idempotencyKey }));
      if (contact.revision !== 1 || contact.recipientRef !== recipientRef || contact.channel !== channel ||
          contact.purpose !== purpose || contact.messageOrCallBrief !== messageOrCallBrief ||
          contact.approvalId !== null || contact.deliveryStatus !== 'pending_approval' ||
          contact.negotiationStatus !== 'not_started' || contact.providerOperationId !== null ||
          contact.allowedOptions.length !== allowedOptions.length || contact.allowedOptions.some((option, index) =>
            option.optionId !== allowedOptions[index].optionId || option.proposalId !== allowedOptions[index].proposalId ||
            option.proposalRevision !== allowedOptions[index].proposalRevision)) throw invalidResponse();
      return contact;
    },
    async decide({ input, requestId, idempotencyKey }) {
      const { id, contactRevision, decision } = input;
      const contact = contactFrom(await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}/decision`,
        { requestId, contactRevision, decision }, { idempotencyKey }));
      if (contact.id !== id || contact.revision !== contactRevision || !contact.approvalId ||
          contact.deliveryStatus !== (decision === 'accept' ? 'ready' : 'rejected')) throw invalidResponse();
      return contact;
    },
    async send({ input, requestId, idempotencyKey }) {
      const { id, contactRevision, expectedSenderAddress } = input;
      const contact = contactFrom(await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}/send`,
        // The server can wait 30 seconds for the provider before returning an uncertain outcome.
        { requestId, contactRevision, expectedSenderAddress }, { idempotencyKey, timeoutMs: 60_000 }));
      const submitted = contact.deliveryStatus === 'sent_or_connected' &&
        contact.negotiationStatus === 'awaiting_response' && contact.providerOperationId !== null;
      const pendingOrFailedOrUnknown = (contact.deliveryStatus === 'submitting' || contact.deliveryStatus === 'failed' ||
        contact.deliveryStatus === 'outcome_unknown') &&
        contact.negotiationStatus === 'not_started' && contact.providerOperationId === null;
      if (contact.id !== id || contact.revision !== contactRevision || !contact.approvalId ||
          (!submitted && !pendingOrFailedOrUnknown)) throw invalidResponse();
      return contact;
    },
  };
}
