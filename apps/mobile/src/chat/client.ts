import { ApiClient, ApiError } from '../api/http';

import type { ChatInput, ChatOutput } from '@pikku/domain';
export type { AgentResult, CoordinationTarget } from '@pikku/domain';
export type ChatResponse = ChatOutput;

// Initial development limit, not a model latency or service guarantee.
export const CHAT_TIMEOUT_MS = 180_000;

export interface ChatRequest extends ChatInput {
  idempotencyKey: string;
}

export interface ChatClient {
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isChatResponse(value: unknown): value is ChatResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.conversationId !== 'string' || !candidate.conversationId || typeof candidate.result !== 'object' || candidate.result === null) return false;
  const result = candidate.result as Record<string, unknown>;
  if (typeof result.message !== 'string' || !result.message.trim()) return false;
  switch (result.kind) {
    case 'reply': return true;
    case 'question': return isStringArray(result.missingFields);
    case 'proposal': return isStringArray(result.proposalIds);
    case 'failure': return typeof result.code === 'string' && typeof result.retryable === 'boolean';
    default: return false;
  }
}

export function createChatClient(api: ApiClient, options: { timeoutMs?: number } = {}): ChatClient {
  const timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
  return {
    async sendMessage({ requestId, idempotencyKey, conversationId, message, timezone, coordinationTarget }) {
      const data = await api.post<unknown>(
        '/v1/chat',
        { requestId, conversationId, message, timezone, ...(coordinationTarget ? { coordinationTarget } : {}) },
        { idempotencyKey, timeoutMs },
      );
      if (!isChatResponse(data)) throw new ApiError('invalid_response', '대화 응답 형식이 올바르지 않습니다.');
      return data;
    },
  };
}
