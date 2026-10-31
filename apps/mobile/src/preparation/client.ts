import type { AgentResult } from '@pikku/domain';
import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/mutation';

export interface PreparationProposalInput {
  targetId: string;
  expectedTargetRevision: number;
  expectedScheduleRevision: number;
  timezone: string;
  preparationMinutes: number;
  travelMinutes: number;
  bufferMinutes: number;
}

export type PreparationResult = Extract<AgentResult, { kind: 'proposal' | 'question' | 'failure' }>;

function isResult(value: unknown): value is PreparationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.message !== 'string' || !result.message.trim()) return false;
  if (result.kind === 'proposal') return Array.isArray(result.proposalIds) && result.proposalIds.length > 0 &&
    result.proposalIds.every(id => typeof id === 'string' && id.trim().length > 0);
  if (result.kind === 'question') return Array.isArray(result.missingFields) &&
    result.missingFields.every(field => typeof field === 'string');
  return result.kind === 'failure' && typeof result.code === 'string' && typeof result.retryable === 'boolean';
}

export function createPreparationClient(api: ApiClient) {
  return {
    async create(op: Mutation<PreparationProposalInput>): Promise<PreparationResult> {
      const data = await api.post<unknown>('/v1/preparation-proposals',
        { requestId: op.requestId, ...op.input }, { idempotencyKey: op.idempotencyKey });
      if (typeof data !== 'object' || data === null || !('result' in data) || !isResult(data.result)) {
        throw new ApiError('invalid_response', '제안 생성 결과를 확인할 수 없습니다.');
      }
      return data.result;
    },
  };
}

export function parseMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return Number.isFinite(minutes) && minutes >= 0 && Number.isSafeInteger(minutes * 60_000) ? minutes : null;
}
