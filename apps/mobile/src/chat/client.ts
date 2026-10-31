import { ApiClient, ApiError } from '../api/http';

import type { AgentResult, ChatContext, ChatInput, FormDraft } from '@pikku/domain';
export type { AgentResult, CoordinationTarget } from '@pikku/domain';
export type { ChatContext, FormDraft } from '@pikku/domain';
export type ChatEntryContext = { key: string } & (
  | { kind: 'create' }
  | { kind: 'item'; id: string; expectedRevision: number; title: string }
  | { kind: 'form'; draft: FormDraft }
);
export type ChatResponse = { conversationId: string; result: AgentResult | { kind: 'reply'; message: string; draft: FormDraft } };

// Initial development limit, not a model latency or service guarantee.
export const CHAT_TIMEOUT_MS = 180_000;

export interface ChatRequest extends ChatInput {
  idempotencyKey: string;
  entryContext?: ChatContext;
}

export interface ChatClient {
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

function isChatResponse(value: unknown): value is ChatResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.conversationId !== 'string' || !candidate.conversationId || typeof candidate.result !== 'object' || candidate.result === null) return false;
  const result = candidate.result as Record<string, unknown>;
  if (typeof result.message !== 'string' || !result.message.trim()) return false;
  switch (result.kind) {
    case 'reply': return result.draft === undefined || isFormDraft(result.draft);
    case 'question': return isStringArray(result.missingFields);
    case 'proposal': return isStringArray(result.proposalIds);
    case 'failure': return typeof result.code === 'string' && typeof result.retryable === 'boolean';
    default: return false;
  }
}

export function createChatClient(api: ApiClient, options: { timeoutMs?: number } = {}): ChatClient {
  const timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
  return {
    async sendMessage({ requestId, idempotencyKey, conversationId, message, timezone, coordinationTarget, entryContext }) {
      const data = await api.post<unknown>(
        '/v1/chat',
        { requestId, conversationId, message, timezone, ...(coordinationTarget ? { coordinationTarget } : {}), ...(entryContext ? { entryContext } : {}) },
        { idempotencyKey, timeoutMs },
      );
      if (!isChatResponse(data)) throw new ApiError('invalid_response', '대화 응답 형식이 올바르지 않습니다.');
      return data;
    },
  };
}
