import { ApiClient, ApiError } from '../api/http';
import { parseOffsetDateTime } from '@pikku/domain';
import { normalizeInquiryBrief } from '../contacts/schedule-call-client';

import type { AgentResult, ChatContext, ChatInput, FormDraft } from '@pikku/domain';
export type { AgentResult, CoordinationTarget } from '@pikku/domain';
export type { ChatContext, FormDraft } from '@pikku/domain';
export type ChatEntryContext = { key: string } & (
  | { kind: 'create' }
  | { kind: 'item'; id: string; expectedRevision: number; title: string }
  | { kind: 'form'; draft: FormDraft }
);
export type PhoneRequest = Extract<AgentResult, { kind: 'phone_request' }>;
export type ChatResponse = { conversationId: string; result: AgentResult | { kind: 'reply'; message: string; draft: FormDraft } };

// Initial development limit, not a model latency or service guarantee.
export const CHAT_TIMEOUT_MS = 180_000;

export interface ChatRequest extends ChatInput {
  idempotencyKey: string;
  entryContext?: ChatContext;
}

export interface ChatClient {
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
  checkRequest?(request: { requestId: string; idempotencyKey: string; conversationId: string | null }): Promise<ChatRequestStatus>;
}
export type ChatRequestStatus = { status: 'running' | 'retryable' } |
  { status: 'completed'; result: { response: ChatResponse } | { error: ApiError } };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSuggestions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(item =>
    typeof item === 'object' && item !== null && !Array.isArray(item) &&
    Object.keys(item).length === 2 && Object.keys(item).every(key => key === 'label' || key === 'message') &&
    typeof item.label === 'string' && !!item.label.trim() && item.label.length <= 60 &&
    typeof item.message === 'string' && !!item.message.trim() && item.message.length <= 500));
}

function isFormDraft(value: unknown): value is FormDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  if (!['event', 'task', 'routine'].includes(String(draft.kind)) || typeof draft.fields !== 'object' || draft.fields === null || Array.isArray(draft.fields)) return false;
  const allowed = draft.kind === 'routine' ? ['title', 'weekdays', 'startDate', 'localTime', 'duration', 'category'] :
    ['kind', 'title', 'startsAt', 'endsAt', 'startDate', 'startTime', 'endDate', 'endTime', 'timezone', 'durationMinutes', 'deadline', 'flexibility', 'involvement', 'completion', 'category'];
  return Object.entries(draft.fields).every(([key, field]) => allowed.includes(key) &&
    (key === 'weekdays' ? isStringArray(field) && field.length <= 7 && field.every(item => item.length <= 200) : typeof field === 'string' && field.length <= 2000) &&
    (key !== 'kind' || field === draft.kind));
}

function isReminder(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const reminder = value as Record<string, unknown>;
  const keys = ['itemId', 'expectedRevision', 'title', 'appointmentAt', 'appointmentEndsAt', 'timezone',
    'basis', 'minutesBefore', 'reminderAt', 'expiresAt', 'appointmentLocation', 'departureAt', 'travel'];
  if (Object.keys(reminder).some(key => !keys.includes(key))) return false;
  const date = (value: unknown) => typeof value === 'string' && value.length <= 100 &&
    parseOffsetDateTime(value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, '$1')) !== null;
  if (typeof reminder.itemId !== 'string' || !reminder.itemId.trim() || reminder.itemId.length > 200 ||
      typeof reminder.title !== 'string' || !reminder.title.trim() || reminder.title.length > 2000 ||
      typeof reminder.expectedRevision !== 'number' || !Number.isSafeInteger(reminder.expectedRevision) || reminder.expectedRevision < 1 ||
      typeof reminder.minutesBefore !== 'number' || !Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0 || reminder.minutesBefore > 1440 ||
      typeof reminder.timezone !== 'string' || !reminder.timezone || reminder.timezone.length > 200 ||
      (reminder.appointmentLocation !== undefined && (typeof reminder.appointmentLocation !== 'string' ||
        !reminder.appointmentLocation.trim() || reminder.appointmentLocation.length > 2000)) ||
      !date(reminder.appointmentAt) || !date(reminder.appointmentEndsAt) || !date(reminder.reminderAt) || !date(reminder.expiresAt)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: reminder.timezone }); } catch { return false; }
  const appointment = Date.parse(reminder.appointmentAt as string), end = Date.parse(reminder.appointmentEndsAt as string);
  let basis = appointment;
  if (reminder.basis === 'departure') {
    if (!date(reminder.departureAt) || typeof reminder.travel !== 'object' || reminder.travel === null || Array.isArray(reminder.travel)) return false;
    const travel = reminder.travel as Record<string, unknown>;
    if (Object.keys(travel).some(key => !['mode', 'durationMinutes', 'provider', 'basis', 'destinationName', 'destinationAddress'].includes(key)) ||
        !['walk', 'transit', 'car'].includes(String(travel.mode)) || travel.provider !== 'kakao' || travel.basis !== 'current_time' ||
        typeof travel.destinationName !== 'string' || !travel.destinationName.trim() || travel.destinationName.length > 200 ||
        typeof travel.destinationAddress !== 'string' || !travel.destinationAddress.trim() || travel.destinationAddress.length > 300 ||
        typeof travel.durationMinutes !== 'number' || !Number.isSafeInteger(travel.durationMinutes) || travel.durationMinutes < 0) return false;
    basis = Date.parse(reminder.departureAt as string);
    if (basis !== appointment - travel.durationMinutes * 60_000) return false;
  } else if (reminder.basis !== 'event_start' || reminder.departureAt !== undefined || reminder.travel !== undefined) return false;
  return appointment < end && Date.parse(reminder.reminderAt as string) === basis - reminder.minutesBefore * 60_000;
}

function isChatResponse(value: unknown): value is ChatResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.conversationId !== 'string' || !candidate.conversationId || typeof candidate.result !== 'object' || candidate.result === null) return false;
  const result = candidate.result as Record<string, unknown>;
  if (typeof result.message !== 'string' || !result.message.trim()) return false;
  if (result.kind !== 'reply' && result.kind !== 'question' && result.suggestions !== undefined) return false;
  switch (result.kind) {
    case 'reply': return isSuggestions(result.suggestions) && (result.draft === undefined || (result.suggestions === undefined && isFormDraft(result.draft)));
    case 'question': return isSuggestions(result.suggestions) && isStringArray(result.missingFields);
    case 'proposal': return isStringArray(result.proposalIds);
    case 'phone_request': return result.mode === 'inquiry'
      ? typeof result.brief === 'string' && normalizeInquiryBrief(result.brief) === result.brief && result.itemId === undefined && result.expectedRevision === undefined
      : (result.mode === undefined || result.mode === 'schedule_check') && typeof result.itemId === 'string' && !!result.itemId.trim() && result.itemId.length <= 200 &&
        typeof result.expectedRevision === 'number' && Number.isSafeInteger(result.expectedRevision) && result.expectedRevision >= 1 && result.brief === undefined;
    case 'reminder_request': return isReminder(result.reminder);
    case 'failure': return typeof result.code === 'string' && typeof result.retryable === 'boolean';
    default: return false;
  }
}

export function createChatClient(api: ApiClient, options: { timeoutMs?: number } = {}): ChatClient {
  const timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
  return {
    async sendMessage({ requestId, idempotencyKey, conversationId, message, timezone, coordinationTarget, entryContext, deviceContext }) {
      if (deviceContext?.currentLocation) {
        const capturedAt = deviceContext.currentLocation.capturedAt;
        const captured = typeof capturedAt === 'string'
          ? parseOffsetDateTime(capturedAt.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, '$1')) : null;
        if (captured === null || Date.now() - captured >= 300_000) {
          throw new ApiError('location_expired', '현재 위치가 만료되어 이 요청을 전송할 수 없습니다.');
        }
      }
      const data = await api.post<unknown>(
        '/v1/chat',
        { requestId, conversationId, message, timezone, ...(coordinationTarget ? { coordinationTarget } : {}), ...(entryContext ? { entryContext } : {}),
          ...(deviceContext ? { deviceContext } : {}) },
        { idempotencyKey, timeoutMs },
      );
      if (!isChatResponse(data)) throw new ApiError('invalid_response', '대화 응답 형식이 올바르지 않습니다.');
      return data;
    },
    async checkRequest({ requestId, idempotencyKey, conversationId }) {
      const invalid = () => new ApiError('invalid_response', '저장된 대화 응답을 확인할 수 없습니다.');
      if (!requestId || !idempotencyKey) throw invalid();
      const value = await api.get<unknown>(`/v1/chat/requests/${encodeURIComponent(requestId)}`, { idempotencyKey, expectedRequestId: requestId });
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
      const data = value as Record<string, unknown>;
      if (data.status === 'running' || data.status === 'retryable') {
        if ('result' in data) throw invalid();
        return { status: data.status };
      }
      if (data.status !== 'completed' || typeof data.result !== 'object' || data.result === null || Array.isArray(data.result)) throw invalid();
      const result = data.result as Record<string, unknown>;
      if (!Number.isInteger(result.status) || typeof result.status !== 'number' || result.status < 200 || result.status > 599 ||
          typeof result.body !== 'object' || result.body === null || Array.isArray(result.body)) throw invalid();
      const body = result.body as Record<string, unknown>;
      if (body.requestId !== requestId) throw invalid();
      if (result.status < 300) {
        if (!isChatResponse(body.data) || (conversationId !== null && body.data.conversationId !== conversationId)) throw invalid();
        return { status: 'completed', result: { response: body.data } };
      }
      if (result.status < 400 || typeof body.error !== 'object' || body.error === null || Array.isArray(body.error)) throw invalid();
      const error = body.error as Record<string, unknown>;
      if (typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') throw invalid();
      return { status: 'completed', result: { error: new ApiError(error.code, error.message, error.retryable, result.status) } };
    },
  };
}
