import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';

export type ScheduleCallStatus = 'pending' | 'dispatching' | 'submitted' | 'outcome_unknown' | 'failed' | 'completed' | 'no_answer' | 'review_pending' | 'applied' | 'rejected';
export type ScheduleCallTarget = { itemId: string; expectedRevision: number } | { mode: 'inquiry'; brief: string };
export type ScheduleCall = { id: string; revision: number; status: ScheduleCallStatus; toNumber: string; question: string;
  transcript?: { role: 'user' | 'agent'; text: string }[] } & (
  { mode?: 'schedule_check'; itemId: string; itemRevision: number; title: string;
    correction?: { beforeLocation: string | null; afterLocation: string; summary: string }; reviewNote?: string } |
  { mode: 'inquiry'; brief: string });
export type ScheduleCallOperation = ({ kind: 'create'; toNumber: string } & ScheduleCallTarget) |
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
export function normalizeInquiryBrief(value: string): string | null {
  const brief = value.trim();
  if (!brief || brief.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/.test(brief) ||
      Array.from(brief).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) return null;
  return brief;
}
function parseCall(data: unknown): ScheduleCall {
  if (!record(data) || !record(data.call)) throw invalid();
  const call = data.call;
  if (!id(call.id) || !revision(call.revision) || !statuses.includes(call.status as ScheduleCallStatus) ||
      typeof call.toNumber !== 'string' || normalizeScheduleCallNumber(call.toNumber) !== call.toNumber) throw invalid();
  if (call.mode === 'inquiry') {
    if (typeof call.brief !== 'string' || normalizeInquiryBrief(call.brief) !== call.brief || call.question !== call.brief || ['review_pending', 'applied', 'rejected'].includes(call.status as string) ||
        call.itemId !== undefined || call.itemRevision !== undefined || call.title !== undefined || call.correction !== undefined || call.reviewNote !== undefined) throw invalid();
  } else if ((call.mode !== undefined && call.mode !== 'schedule_check') || !id(call.itemId) ||
      !revision(call.itemRevision) || !text(call.title, 2000) || !text(call.question, 8192)) throw invalid();
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
  if (value.id !== expected.id || value.toNumber !== expected.toNumber || value.revision < expected.revision ||
      (expected.mode === 'inquiry' ? value.mode !== 'inquiry' || value.brief !== expected.brief :
        value.mode === 'inquiry' || value.itemId !== expected.itemId || value.itemRevision !== expected.itemRevision ||
        value.title !== expected.title || value.question !== expected.question)) throw invalid();
  return value;
}
export function createScheduleCallClient(api: ApiClient) {
  return {
    async get(expected: ScheduleCall) { return sameSubject(expected, parseCall(await api.get<unknown>(`/v1/schedule-calls/${encodeURIComponent(expected.id)}`))); },
    async execute(op: Mutation<ScheduleCallOperation>): Promise<ScheduleCall> {
      const { input, requestId, idempotencyKey } = op;
      if (input.kind === 'create') {
        const toNumber = normalizeScheduleCallNumber(input.toNumber);
        if (!toNumber || ('itemId' in input ? !id(input.itemId) || !revision(input.expectedRevision) : !normalizeInquiryBrief(input.brief))) throw new ApiError('invalid_request', '전화번호와 내용을 확인해 주세요.');
        const subject = 'itemId' in input ? { itemId: input.itemId, expectedRevision: input.expectedRevision } : { mode: 'inquiry' as const, brief: input.brief.trim() };
        const call = parseCall(await api.post<unknown>('/v1/schedule-calls', { requestId, ...subject, toNumber }, { idempotencyKey }));
        if (call.status !== 'pending' || call.toNumber !== toNumber || ('itemId' in input ?
          call.mode === 'inquiry' || call.itemId !== input.itemId || call.itemRevision !== input.expectedRevision : call.mode !== 'inquiry' || call.brief !== input.brief.trim())) throw invalid();
        return call;
      }
      const expected = input.call;
      if (expected.mode === 'inquiry' && (input.kind === 'propose' || input.kind === 'decision')) throw new ApiError('invalid_request', '일반 문의에는 일정 변경을 적용할 수 없습니다.');
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
