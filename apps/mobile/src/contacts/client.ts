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
export interface ContactCallInput { id: string; contactRevision: number; expectedSenderNumber: string }
export type PhoneProvider = 'twilio' | 'clawops';
export type PhoneMode = 'agent' | 'voiceml';
export type PhoneConnection = ({ status: 'available'; senderNumber: string } | { status: 'not_configured'; senderNumber: string | null }) & { lastRequestId?: string | null; provider?: PhoneProvider; mode?: PhoneMode };
export type EmailConnection = { status: 'available'; senderAddress: string } | { status: 'not_configured'; senderAddress: string | null };
export interface ContactResponse {
  id: string; contactRequestId: string; providerEventId: string; receivedAt: string;
  outcome: 'accepted' | 'declined' | 'alternative_proposed' | 'unclear';
  selectedOptionId: string | null; evidenceRef: string; displayText?: string | null; reviewReason?: string | null;
}
export interface ContactResults { contactRequest: ContactRequest; responses: ContactResponse[] }
export interface ContactReplyCheck extends ContactResults { checkedCount: number; unmatchedCount: number }
export interface ContactCallCheck extends ContactReplyCheck { callStatus?: string; complete?: boolean; truncated?: boolean }
export interface ContactConfirmResult { contactRequest: ContactRequest; response: ContactResponse; scheduleRevision: number; changed: boolean }

export interface ContactClient {
  list(proposalId: string): Promise<ContactRequest[]>;
  get(id: string): Promise<ContactRequest>;
  emailConnection(): Promise<EmailConnection>;
  emailReplyConnection(): Promise<EmailConnection>;
  responses(id: string): Promise<ContactResults>;
  checkReplies(op: Mutation<{ id: string; contactRevision: number }>): Promise<ContactReplyCheck>;
  checkCall(op: Mutation<{ id: string; contactRevision: number }>): Promise<ContactCallCheck>;
  confirmResponse(op: Mutation<{ id: string; responseId: string; contactRevision: number; selectedOptionId: string }>): Promise<ContactConfirmResult>;
  phoneConnection(): Promise<PhoneConnection>;
  createRecipient(op: Mutation<RecipientInput>): Promise<Recipient>;
  createDraft(op: Mutation<ContactDraftInput>): Promise<ContactRequest>;
  decide(op: Mutation<ContactDecisionInput>): Promise<ContactRequest>;
  send(op: Mutation<ContactSendInput>): Promise<ContactRequest>;
  call(op: Mutation<ContactCallInput>): Promise<ContactRequest>;
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

function isResponse(item: unknown, id: string): item is ContactResponse {
  return isRecord(item) && isId(item.id) && item.contactRequestId === id && isId(item.providerEventId) &&
    isOffsetTimestamp(item.receivedAt) && ['accepted', 'declined', 'alternative_proposed', 'unclear'].includes(item.outcome as string) &&
    (item.selectedOptionId === null || isId(item.selectedOptionId)) && isId(item.evidenceRef) &&
    (item.displayText === undefined || item.displayText === null || (typeof item.displayText === 'string' && item.displayText.length <= 2000)) &&
    (item.reviewReason === undefined || item.reviewReason === null || isText(item.reviewReason, 200));
}

function resultsFrom(data: unknown, id: string): ContactResults {
  const contactRequest = contactFrom(data);
  if (contactRequest.id !== id || !isRecord(data) || !Array.isArray(data.responses) ||
      !data.responses.every((item: unknown) => isResponse(item, id)) ||
      new Set(data.responses.map((item: ContactResponse) => item.id)).size !== data.responses.length) throw invalidResponse();
  return { contactRequest, responses: data.responses as ContactResponse[] };
}

function phoneConnectionFrom(data: unknown): PhoneConnection {
  if (!isRecord(data) || (data.status !== 'available' && data.status !== 'not_configured') ||
      !(data.senderNumber === null || typeof data.senderNumber === 'string') ||
      !(data.provider === undefined || data.provider === 'twilio' || data.provider === 'clawops') ||
      !(data.mode === undefined || (data.provider === 'clawops' && (data.mode === 'agent' || data.mode === 'voiceml'))) ||
      !(data.lastRequestId === undefined || data.lastRequestId === null || isId(data.lastRequestId)) ||
      (data.status === 'available' && (typeof data.senderNumber !== 'string' || !/^\+[1-9]\d{1,14}$/.test(data.senderNumber)))) throw invalidResponse();
  const receipt = data.lastRequestId === undefined ? {} : { lastRequestId: data.lastRequestId as string | null };
  const provider = data.provider === undefined ? {} : { provider: data.provider as PhoneProvider };
  const mode = data.mode === undefined ? {} : { mode: data.mode as PhoneMode };
  if (data.status === 'available') return { status: data.status, senderNumber: data.senderNumber as string, ...receipt, ...provider, ...mode };
  return { status: data.status, senderNumber: data.senderNumber as string | null, ...receipt, ...provider, ...mode };
}

function dispatched(contact: ContactRequest, id: string, contactRevision: number, channel: ContactRequest['channel']): ContactRequest {
  const submitted = contact.deliveryStatus === 'sent_or_connected' &&
    contact.negotiationStatus === 'awaiting_response' && contact.providerOperationId !== null;
  const pendingOrFailedOrUnknown = (contact.deliveryStatus === 'submitting' || contact.deliveryStatus === 'failed' ||
    contact.deliveryStatus === 'outcome_unknown') && contact.negotiationStatus === 'not_started' && contact.providerOperationId === null;
  if (contact.id !== id || contact.revision !== contactRevision || contact.channel !== channel || !contact.approvalId ||
      (!submitted && !pendingOrFailedOrUnknown)) throw invalidResponse();
  return contact;
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
    async emailReplyConnection() {
      const data = await api.get<unknown>('/v1/email-reply-connection');
      if (!isRecord(data) || (data.status !== 'available' && data.status !== 'not_configured') ||
          !(data.senderAddress === null || typeof data.senderAddress === 'string') ||
          (data.status === 'available' && (typeof data.senderAddress !== 'string' || !data.senderAddress.trim()))) throw invalidResponse();
      return data.status === 'available' ? { status: data.status, senderAddress: data.senderAddress as string }
        : { status: data.status, senderAddress: data.senderAddress as string | null };
    },
    async responses(id) {
      return resultsFrom(await api.get<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}/responses`), id);
    },
    async checkReplies({ input, requestId, idempotencyKey }) {
      const data = await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(input.id)}/check-replies`,
        { requestId, contactRevision: input.contactRevision }, { idempotencyKey, timeoutMs: 60_000 });
      const result = resultsFrom(data, input.id);
      if (!isRecord(data) || !isRevision(data.checkedCount, 0) || !isRevision(data.unmatchedCount, 0)) throw invalidResponse();
      return { ...result, checkedCount: data.checkedCount as number, unmatchedCount: data.unmatchedCount as number };
    },
    async checkCall({ input, requestId, idempotencyKey }) {
      const data = await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(input.id)}/check-call`,
        { requestId, contactRevision: input.contactRevision }, { idempotencyKey, timeoutMs: 60_000 });
      const result = resultsFrom(data, input.id);
      if (!isRecord(data) || result.contactRequest.channel !== 'phone' || !isRevision(data.checkedCount, 0) || !isRevision(data.unmatchedCount, 0) ||
          !(data.callStatus === undefined || (typeof data.callStatus === 'string' && data.callStatus.length <= 200)) ||
          !(data.complete === undefined || typeof data.complete === 'boolean') || !(data.truncated === undefined || typeof data.truncated === 'boolean')) throw invalidResponse();
      return { ...result, checkedCount: data.checkedCount as number, unmatchedCount: data.unmatchedCount as number,
        ...(data.callStatus === undefined ? {} : { callStatus: data.callStatus as string }),
        ...(data.complete === undefined ? {} : { complete: data.complete as boolean }),
        ...(data.truncated === undefined ? {} : { truncated: data.truncated as boolean }) };
    },
    async confirmResponse({ input, requestId, idempotencyKey }) {
      const { id, responseId, contactRevision, selectedOptionId } = input;
      const data = await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}/responses/${encodeURIComponent(responseId)}/confirm`,
        { requestId, contactRevision, selectedOptionId }, { idempotencyKey });
      const contactRequest = contactFrom(data);
      if (!isRecord(data) || contactRequest.id !== id || !isResponse(data.response, id) || data.response.id !== responseId ||
          !isRevision(data.scheduleRevision, 0) || typeof data.changed !== 'boolean') throw invalidResponse();
      return { contactRequest, response: data.response, scheduleRevision: data.scheduleRevision as number, changed: data.changed };
    },
    async phoneConnection() {
      return phoneConnectionFrom(await api.get<unknown>('/v1/phone-connection'));
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
      return dispatched(contact, id, contactRevision, 'email');
    },
    async call({ input, requestId, idempotencyKey }) {
      const { id, contactRevision, expectedSenderNumber } = input;
      const contact = contactFrom(await api.post<unknown>(`/v1/contact-requests/${encodeURIComponent(id)}/call`,
        { requestId, contactRevision, expectedSenderNumber }, { idempotencyKey, timeoutMs: 60_000 }));
      return dispatched(contact, id, contactRevision, 'phone');
    },
  };
}
