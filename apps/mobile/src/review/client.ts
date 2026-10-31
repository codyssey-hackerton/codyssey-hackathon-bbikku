import type { ReviewSchedule, UpdateReviewScheduleInput } from '@pikku/domain';
import { ApiError } from '../api/http';
import type { ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';

export type ReviewInput = Omit<UpdateReviewScheduleInput, 'requestId'>;
export type CapabilityStatus = 'not_configured' | 'available' | 'degraded';
export type ReviewCapabilities = {
  scheduler: CapabilityStatus;
  model: CapabilityStatus;
  storage: { mode: 'memory' | 'postgres'; durable: boolean };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isLocalTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function isTimezone(value: string): boolean {
  if (!value.trim() || value.length > 200 || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

function isReviewTime(value: unknown): value is ReviewSchedule['evening'] {
  return isRecord(value) && typeof value.enabled === 'boolean' &&
    (value.localTime === null || (typeof value.localTime === 'string' && isLocalTime(value.localTime))) &&
    (!value.enabled || value.localTime !== null);
}

function isReviewSchedule(value: unknown): value is ReviewSchedule {
  return isRecord(value) && isRevision(value.revision) && typeof value.timezone === 'string' &&
    value.timezone.trim().length > 0 && isReviewTime(value.evening) && isReviewTime(value.morning);
}

function scheduleFrom(data: unknown): ReviewSchedule {
  if (!isRecord(data) || !isReviewSchedule(data.reviewSchedule)) {
    throw new ApiError('invalid_response', '서버의 자동 검토 설정을 확인할 수 없습니다.');
  }
  return data.reviewSchedule;
}

function isStatus(value: unknown): value is CapabilityStatus {
  return value === 'not_configured' || value === 'available' || value === 'degraded';
}

export function createReviewClient(api: ApiClient) {
  return {
    async get(): Promise<ReviewSchedule> {
      return scheduleFrom(await api.get<unknown>('/v1/review-schedule'));
    },
    async save({ input, requestId, idempotencyKey }: Mutation<ReviewInput>): Promise<ReviewSchedule> {
      if (!requestId || !idempotencyKey || !isRevision(input.expectedRevision) || !isTimezone(input.timezone) ||
          !isReviewTime(input.evening) || !isReviewTime(input.morning)) {
        throw new ApiError('invalid_request', '자동 검토 설정을 확인해 주세요.');
      }
      const result = scheduleFrom(await api.post<unknown>('/v1/review-schedule', { requestId, ...input }, { idempotencyKey }));
      if (result.revision !== input.expectedRevision + 1 || result.timezone !== input.timezone ||
          result.evening.enabled !== input.evening.enabled || result.evening.localTime !== input.evening.localTime ||
          result.morning.enabled !== input.morning.enabled || result.morning.localTime !== input.morning.localTime) {
        throw new ApiError('invalid_response', '저장된 자동 검토 설정을 확인할 수 없습니다.');
      }
      return result;
    },
    async capabilities(): Promise<ReviewCapabilities> {
      const data = await api.get<unknown>('/v1/capabilities');
      if (!isRecord(data) || !isRecord(data.scheduler) || !isStatus(data.scheduler.status) ||
          !isRecord(data.model) || !isStatus(data.model.status) || !isRecord(data.storage) ||
          (data.storage.mode !== 'memory' && data.storage.mode !== 'postgres') || typeof data.storage.durable !== 'boolean') {
        throw new ApiError('invalid_response', '서버 실행 상태를 확인할 수 없습니다.');
      }
      return { scheduler: data.scheduler.status, model: data.model.status,
        storage: { mode: data.storage.mode, durable: data.storage.durable } };
    },
  };
}
