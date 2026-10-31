import { ApiError, type ApiClient } from '../api/http';
import type { Mutation } from '../api/useMutation';
import type { Change, ListProposalsOutput, Proposal, ProposalMode, ScheduleFields, ScheduleItem, TimeSlot } from '@pikku/domain';

export type { Proposal, ScheduleFields } from '@pikku/domain';
export type ProposalPage = ListProposalsOutput;

export interface DecisionInput {
  id: string;
  proposalRevision: number;
  mode: ProposalMode;
  decision: 'accept' | 'reject';
}

export interface DecisionResult {
  outcome: 'applied' | 'rejected' | 'awaiting_contact';
  proposal: Proposal;
  scheduleRevision: number;
}

export function canAccept(proposal: Proposal): boolean {
  const validation = proposal.validation;
  return proposal.status === 'pending' && validation.valid && validation.conflicts.length === 0 &&
    validation.missingFields.length === 0 && validation.protectedTargets.length === 0;
}

function invalidResponse(): ApiError {
  // After a POST this code is deliberately treated as an uncertain outcome by useMutation.
  return new ApiError('invalid_response', '서버의 제안 응답을 확인할 수 없습니다.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const endOfMonth = new Date(0);
  endOfMonth.setUTCFullYear(Number(year), Number(month), 0);
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 &&
    Number(day) <= endOfMonth.getUTCDate() && Number(hour) <= 23 && Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59) && Number.isFinite(Date.parse(value));
}

function compareTimestamps(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  if (difference !== 0) return Math.sign(difference);
  const remainder = (value: string) => (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '').slice(3);
  const a = remainder(left);
  const b = remainder(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a.charCodeAt(index) || 48) - (b.charCodeAt(index) || 48);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function isTimeSlot(value: unknown): value is TimeSlot {
  return isRecord(value) && isTimestamp(value.startsAt) && isTimestamp(value.endsAt) &&
    isId(value.timezone) && compareTimestamps(value.startsAt, value.endsAt) < 0;
}

function isFields(value: unknown): value is ScheduleFields {
  if (!isRecord(value) || (value.kind !== 'event' && value.kind !== 'task') ||
      typeof value.title !== 'string' || !(value.timeSlot === null || isTimeSlot(value.timeSlot)) ||
      !(value.durationMinutes === null || (typeof value.durationMinutes === 'number' && Number.isFinite(value.durationMinutes))) ||
      !(value.deadline === null || isTimestamp(value.deadline)) ||
      (value.flexibility !== 'fixed' && value.flexibility !== 'flexible') ||
      (value.involvement !== 'personal' && value.involvement !== 'shared') ||
      !['pending', 'completed', 'incomplete', 'unknown'].includes(value.completion as string)) return false;
  if (value.kind === 'event' && value.timeSlot === null) return false;
  if (value.kind === 'task' && (typeof value.durationMinutes !== 'number' || value.durationMinutes <= 0)) return false;
  return !(isTimeSlot(value.timeSlot) && typeof value.deadline === 'string' &&
    compareTimestamps(value.timeSlot.endsAt, value.deadline) > 0);
}

function isItem(value: unknown): value is ScheduleItem {
  if (!isRecord(value)) return false;
  const sourceRefs = value.sourceRefs;
  if (!isId(value.id) || !isRevision(value.revision, 1) || !Array.isArray(sourceRefs) || !isFields(value)) return false;
  return sourceRefs.every((source: unknown) => isRecord(source) &&
    typeof source.provider === 'string' && typeof source.accountRef === 'string' &&
    typeof source.calendarId === 'string' && typeof source.externalEventId === 'string' &&
    typeof source.lastSyncedAt === 'string' &&
    (source.occurrenceKey === undefined || typeof source.occurrenceKey === 'string') &&
    (source.sourceVersion === undefined || typeof source.sourceVersion === 'string'));
}

function isChange(value: unknown): value is Change {
  if (!isRecord(value) || !isId(value.changeId)) return false;
  if (value.operation === 'create') return isFields(value.after);
  if (!isId(value.targetId) || !isRevision(value.expectedRevision, 1)) return false;
  if (value.operation === 'update') return isFields(value.after);
  return value.operation === 'delete';
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTimingConstraint(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.appointment) || !isRecord(value.segments)) return false;
  const appointment = value.appointment;
  if (appointment.kind === 'existing' ? !isId(appointment.id) || !isRevision(appointment.expectedRevision, 1) :
      appointment.kind === 'change' ? !isId(appointment.changeId) : true) return false;
  const minutes = (item: unknown) => item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0 && Number.isSafeInteger(item * 60_000));
  const segment = (item: unknown) => item === null || isId(item);
  return minutes(value.preparationMinutes) && minutes(value.travelMinutes) && minutes(value.bufferMinutes) &&
    segment(value.segments.preparation) && segment(value.segments.travel) && segment(value.segments.buffer);
}

function isProposal(value: unknown): value is Proposal {
  if (!isRecord(value) || !isId(value.id) || !isRevision(value.revision, 1) ||
      (value.mode !== 'personal' && value.mode !== 'coordination') ||
      !isRevision(value.baseScheduleRevision, 0) || !isRevision(value.baseContextRevision, 0) ||
      !isRecord(value.changeSet) || !Array.isArray(value.changeSet.changes) ||
      !value.changeSet.changes.every(isChange) ||
      !(value.changeSet.timingConstraints === undefined || (Array.isArray(value.changeSet.timingConstraints) &&
        value.changeSet.timingConstraints.length <= 100 && value.changeSet.timingConstraints.every(isTimingConstraint))) || !Array.isArray(value.beforeItems) ||
      !value.beforeItems.every(isItem) || typeof value.reason !== 'string' || !isStrings(value.evidenceRefs) ||
      !isTimestamp(value.createdAt) || !(value.expiresAt === null || isTimestamp(value.expiresAt)) ||
      !['pending', 'awaiting_contact', 'applied', 'rejected', 'stale', 'expired', 'failed'].includes(value.status as string)) return false;

  const target = value.coordinationTarget;
  if (value.mode === 'personal' ? target !== null :
    !isRecord(target) || !isId(target.id) || !isRevision(target.expectedRevision, 1)) return false;

  const validation = value.validation;
  if (!isRecord(validation) || typeof validation.valid !== 'boolean' || !Array.isArray(validation.conflicts) ||
      !validation.conflicts.every((conflict: unknown) => isRecord(conflict) && isStrings(conflict.targetIds) &&
        typeof conflict.reason === 'string' && (conflict.timeSlot === undefined || isTimeSlot(conflict.timeSlot))) ||
      !isStrings(validation.missingFields) || !isStrings(validation.protectedTargets) ||
      !isRevision(validation.checkedScheduleRevision, 0) || !isRevision(validation.checkedContextRevision, 0) ||
      !isTimestamp(validation.checkedAt)) return false;

  const changes = value.changeSet.changes as Change[];
  const items = value.beforeItems as ScheduleItem[];
  const targets = changes.filter((change) => change.operation !== 'create').map((change) => change.targetId);
  return new Set(changes.map((change) => change.changeId)).size === changes.length &&
    new Set(items.map((item) => item.id)).size === items.length &&
    new Set(targets).size === targets.length && targets.every((id) => items.some((item) => item.id === id));
}

export function createProposalClient(api: ApiClient) {
  return {
    async list(cursor?: string): Promise<ProposalPage> {
      const path = cursor === undefined ? '/v1/proposals' : `/v1/proposals?cursor=${encodeURIComponent(cursor)}`;
      const data = await api.get<unknown>(path);
      if (!isRecord(data) || !Array.isArray(data.proposals) || !data.proposals.every(isProposal) ||
          !(data.nextCursor === null || isId(data.nextCursor)) || data.nextCursor === cursor) throw invalidResponse();
      return { proposals: data.proposals, nextCursor: data.nextCursor };
    },

    async get(id: string): Promise<Proposal> {
      const data = await api.get<unknown>(`/v1/proposals/${encodeURIComponent(id)}`);
      if (!isRecord(data) || !isProposal(data.proposal) || data.proposal.id !== id) throw invalidResponse();
      return data.proposal;
    },

    async decide(op: Mutation<DecisionInput>): Promise<DecisionResult> {
      const { id, proposalRevision, decision, mode } = op.input;
      const data = await api.post<unknown>(
        `/v1/proposals/${encodeURIComponent(id)}/decision`,
        { requestId: op.requestId, proposalRevision, decision },
        { idempotencyKey: op.idempotencyKey },
      );
      const expected = decision === 'reject' ? 'rejected' : mode === 'personal' ? 'applied' : 'awaiting_contact';
      if (!isRecord(data) || data.outcome !== expected || !isRevision(data.scheduleRevision, 0) ||
          !isProposal(data.proposal) || data.proposal.id !== id || data.proposal.mode !== mode ||
          data.proposal.status !== expected) throw invalidResponse();
      return { outcome: expected, proposal: data.proposal, scheduleRevision: data.scheduleRevision };
    },
  };
}

export type ProposalClient = ReturnType<typeof createProposalClient>;
