import { ApiError } from '../api/http';
import type { ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';
import type { JSONValue as JsonValue, MemoryFact } from '@pikku/domain';

export type { JSONValue as JsonValue, MemoryFact } from '@pikku/domain';
export type WritableMemoryKind = Extract<MemoryFact['kind'], 'preference' | 'situation'>;

export interface MemoryList {
  facts: MemoryFact[];
  contextRevision: number;
}

export interface MemoryWriteInput {
  expectedContextRevision: number;
  kind: WritableMemoryKind;
  key: string;
  value: JsonValue;
  validUntil: string | null;
}

export interface MemoryWriteResult {
  fact: MemoryFact;
  contextRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept UTC Z or an explicit numeric offset, and reject normalized invalid dates. */
export function isOffsetTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const lastOfMonth = new Date(0);
  lastOfMonth.setUTCFullYear(Number(year), Number(month), 0);
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 &&
    Number(day) <= lastOfMonth.getUTCDate() && Number(hour) <= 23 && Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59) &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59) && Number.isFinite(Date.parse(value));
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isMemoryFact(value: unknown): value is MemoryFact {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  const kind = value.kind;
  return typeof value.id === 'string' && value.id.length > 0 && isRevision(value.revision, 1) &&
    (kind === 'preference' || kind === 'situation' || kind === 'observation' || kind === 'inference') &&
    typeof value.key === 'string' && isJsonValue(value.value) &&
    (value.source.type === 'user' || value.source.type === 'provider' || value.source.type === 'derived') &&
    typeof value.source.ref === 'string' && isOffsetTimestamp(value.recordedAt) &&
    (value.validUntil === null || isOffsetTimestamp(value.validUntil)) &&
    (kind !== 'situation' || value.validUntil !== null);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key] as JsonValue, right[key] as JsonValue));
}

function invalidResponse(): ApiError {
  // A POST may have committed before an unreadable response; the shared hook treats this as uncertain.
  return new ApiError('invalid_response', '서버의 메모리 응답 형식이 올바르지 않습니다.');
}

export function createMemoryClient(api: ApiClient) {
  return {
    async list(at: string): Promise<MemoryList> {
      if (!isOffsetTimestamp(at)) throw new ApiError('invalid_request', '조회 시각을 확인해 주세요.');
      const data = await api.get<unknown>(`/v1/memory?at=${encodeURIComponent(at)}`);
      if (!isRecord(data) || !Array.isArray(data.facts) || !data.facts.every(isMemoryFact) ||
          !isRevision(data.contextRevision, 0) || data.facts.some((fact: MemoryFact) =>
            fact.validUntil !== null && Date.parse(fact.validUntil) <= Date.parse(at))) {
        throw invalidResponse();
      }
      return { facts: data.facts, contextRevision: data.contextRevision };
    },

    async save({ input, requestId, idempotencyKey }: Mutation<MemoryWriteInput>): Promise<MemoryWriteResult> {
      if (!requestId || !idempotencyKey || !isRevision(input.expectedContextRevision, 0) ||
          (input.kind !== 'preference' && input.kind !== 'situation') || !input.key.trim() ||
          !isJsonValue(input.value) ||
          !(input.validUntil === null || isOffsetTimestamp(input.validUntil)) ||
          (input.kind === 'situation' && input.validUntil === null)) {
        throw new ApiError('invalid_request', '저장할 메모리 내용을 확인해 주세요.');
      }
      // Do not re-check against the current clock: an uncertain retry must keep the original body.
      const data = await api.post<unknown>('/v1/memory', { requestId, ...input }, { idempotencyKey });
      if (!isRecord(data) || !isMemoryFact(data.fact) || !isRevision(data.contextRevision, 0) ||
          data.contextRevision <= input.expectedContextRevision || data.fact.kind !== input.kind ||
          data.fact.key !== input.key || data.fact.source.type !== 'user' ||
          !sameJson(data.fact.value, input.value) ||
          (input.validUntil === null ? data.fact.validUntil !== null :
            data.fact.validUntil === null || Date.parse(data.fact.validUntil) !== Date.parse(input.validUntil))) {
        throw invalidResponse();
      }
      return { fact: data.fact, contextRevision: data.contextRevision };
    },
  };
}
