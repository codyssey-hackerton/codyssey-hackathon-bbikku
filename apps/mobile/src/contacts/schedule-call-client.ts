import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';

export type ScheduleCallStatus = 'pending' | 'dispatching' | 'submitted' | 'outcome_unknown' | 'failed' | 'completed' | 'no_answer' | 'review_pending' | 'applied' | 'rejected';
export type ScheduleCall = { id: string; revision: number; status: ScheduleCallStatus; itemId: string; itemRevision: number;
  title: string; question: string; toNumber: string; transcript?: { role: 'user' | 'agent'; text: string }[];
  correction?: { beforeLocation: string | null; afterLocation: string; summary: string }; reviewNote?: string };
export type ScheduleCallOperation = { kind: 'create'; itemId: string; expectedRevision: number; toNumber: string } |
  { kind: 'approve' | 'check' | 'propose'; call: ScheduleCall } | { kind: 'decision'; call: ScheduleCall; decision: 'accept' | 'reject' };
const statuses: ScheduleCallStatus[] = ['pending', 'dispatching', 'submitted', 'outcome_unknown', 'failed', 'completed', 'no_answer', 'review_pending', 'applied', 'rejected'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const invalid = () => new ApiError('invalid_response', '전화 요청 응답을 확인할 수 없습니다.');
export function normalizeScheduleCallNumber(value: string): string | null {
  const input = value.trim(); const normalized = /^0[1-9]\d{6,12}$/.test(input) ? `+82${input.slice(1)}` : input;
  return /^\+[1-9]\d{1,14}$/.test(normalized) ? normalized : null;
}
function parseCall(data: unknown): ScheduleCall {
  if (!record(data) || !record(data.call)) throw invalid();
  const call = data.call;
  if (!id(call.id) || !revision(call.revision) || !statuses.includes(call.status as ScheduleCallStatus) || !id(call.itemId) ||
      !revision(call.itemRevision) || !text(call.title, 2000) || !text(call.question, 8192) ||
      typeof call.toNumber !== 'string' || normalizeScheduleCallNumber(call.toNumber) !== call.toNumber) throw invalid();
  if (call.transcript !== undefined && (!Array.isArray(call.transcript) || call.transcript.length > 400 ||
      !call.transcript.every(entry => record(entry) && (entry.role === 'user' || entry.role === 'agent') && text(entry.text, 2000)))) throw invalid();
  if (call.reviewNote !== undefined && !text(call.reviewNote, 2000)) throw invalid();
  if (call.correction !== undefined && (!record(call.correction) ||
      !(call.correction.beforeLocation === null || text(call.correction.beforeLocation, 2000)) ||
      !text(call.correction.afterLocation, 200) || !text(call.correction.summary, 2000))) throw invalid();
  if (['completed', 'review_pending', 'applied', 'rejected'].includes(call.status as string) && (!Array.isArray(call.transcript) || !call.transcript.length)) throw invalid();
  if (call.status === 'applied' && call.correction === undefined) throw invalid();
  return call as ScheduleCall;
}
function sameSubject(expected: ScheduleCall, value: ScheduleCall) {
  if (value.id !== expected.id || value.itemId !== expected.itemId || value.itemRevision !== expected.itemRevision ||
      value.title !== expected.title || value.question !== expected.question || value.toNumber !== expected.toNumber || value.revision < expected.revision) throw invalid();
  return value;
}
export function createScheduleCallClient(api: ApiClient) {
  return {
    async get(expected: ScheduleCall) { return sameSubject(expected, parseCall(await api.get<unknown>(`/v1/schedule-calls/${encodeURIComponent(expected.id)}`))); },
    async execute(op: Mutation<ScheduleCallOperation>): Promise<ScheduleCall> {
      const { input, requestId, idempotencyKey } = op;
      if (input.kind === 'create') {
        const toNumber = normalizeScheduleCallNumber(input.toNumber);
        if (!toNumber || !id(input.itemId) || !revision(input.expectedRevision)) throw new ApiError('invalid_request', '전화번호와 일정을 확인해 주세요.');
        const call = parseCall(await api.post<unknown>('/v1/schedule-calls', { requestId, itemId: input.itemId, expectedRevision: input.expectedRevision, toNumber }, { idempotencyKey }));
        if (call.status !== 'pending' || call.itemId !== input.itemId || call.itemRevision !== input.expectedRevision || call.toNumber !== toNumber) throw invalid();
        return call;
      }
      const expected = input.call;
      const path = `/v1/schedule-calls/${encodeURIComponent(expected.id)}/${input.kind}`;
      const body = { requestId, revision: expected.revision, ...(input.kind === 'decision' ? { decision: input.decision } : {}) };
      const call = sameSubject(expected, parseCall(await api.post<unknown>(path, body, { idempotencyKey, timeoutMs: input.kind === 'propose' ? 180_000 : 60_000 })));
      const accepted: Record<Exclude<ScheduleCallOperation['kind'], 'create'>, ScheduleCallStatus[]> = {
        approve: ['dispatching', 'submitted', 'outcome_unknown', 'failed'], check: ['submitted', 'completed', 'no_answer', 'failed'],
        propose: ['review_pending'], decision: [input.kind === 'decision' && input.decision === 'accept' ? 'applied' : 'rejected'],
      };
      if (!accepted[input.kind].includes(call.status) || (input.kind !== 'check' && call.revision <= expected.revision) ||
          (input.kind === 'check' && call.status !== 'submitted' && call.revision <= expected.revision)) throw invalid();
      return call;
    },
  };
}
