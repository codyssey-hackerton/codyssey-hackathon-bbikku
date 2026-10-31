import { randomUUID } from 'node:crypto';
import {
  assessChanges, hasCurrentSnapshotRevisions,
  type AgentResult, type ChangeSet, type ContextSnapshot, type CoordinationTarget,
  type MemoryFact, type Proposal, type ReviewSchedule, type ScheduleItem, type ValidationResult,
} from '@pikku/domain';
import type { AgentDecision } from './agent.ts';
import { changeSet as changeSetSchema, compareInstants, timestamp } from './planning-schemas.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';

export class PlanningError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) { super(message); }
}
type Baseline = { userId: string; snapshot: ContextSnapshot; factsKey: string; coordinationTarget?: CoordinationTarget; externalExpiresAt?: string };
type ProposalReview =
  | { ok: true; changes: ChangeSet; assessment: ReturnType<typeof proposalAssessment>; expiresAt: string }
  | { ok: false; result: AgentResult };

function activeFacts(state: UserPlanningState, at: string): MemoryFact[] {
  return [...state.facts.values()].filter(fact => compareInstants(fact.recordedAt, at) <= 0 && (!fact.validUntil || compareInstants(at, fact.validUntil) < 0));
}
function factsKey(facts: MemoryFact[]): string {
  return JSON.stringify(facts.map(fact => [fact.id, fact.revision, fact.validUntil]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
function snapshot(state: UserPlanningState, timezone: string, now: string): ContextSnapshot {
  return { now, timezone, scheduleRevision: state.scheduleRevision, contextRevision: state.contextRevision,
    items: [...state.items.values()], facts: activeFacts(state, now), missingFields: [] };
}
function assessment(userId: string, current: ContextSnapshot, changes: ChangeSet, purpose: 'ai_proposal' | 'user_command', coordinationTarget?: CoordinationTarget | null) {
  return assessChanges({ authenticatedUserId: userId, snapshotUserId: userId, snapshot: current, changeSet: changes, purpose, checkedAt: current.now, coordinationTarget });
}
function proposalAssessment(userId: string, current: ContextSnapshot, changes: ChangeSet, selected?: CoordinationTarget | null) {
  const result = assessment(userId, current, changes, 'ai_proposal', selected);
  // A derived coordination target must satisfy the same scope used again at approval.
  return result.validation.valid && result.mode === 'coordination' && result.coordinationTarget && !selected
    ? assessment(userId, current, changes, 'ai_proposal', result.coordinationTarget) : result;
}
function validationError(validation: ValidationResult): PlanningError {
  if (validation.conflicts.some(conflict => conflict.reason === 'contact_required')) return new PlanningError(409, 'contact_required', '공동 약속 변경에는 연락 조정이 필요합니다.', false, validation);
  if (validation.missingFields.length) return new PlanningError(422, 'missing_information', '일정을 검증할 정보가 부족합니다.', false, validation);
  return new PlanningError(409, 'conflict', '일정 변경을 적용할 수 없습니다.', false, validation);
}
function proposalExpiry(current: ContextSnapshot, changes: ChangeSet): string | null {
  let expiresAt = new Date(Date.parse(current.now) + 30 * 60_000).toISOString();
  for (const fact of current.facts) {
    if (fact.kind === 'situation' && fact.validUntil && compareInstants(fact.validUntil, expiresAt) < 0) expiresAt = fact.validUntil;
  }
  for (const change of changes.changes) {
    if (change.operation === 'delete' || !change.after.timeSlot) continue;
    const before = change.operation === 'update' ? current.items.find(item => item.id === change.targetId)?.timeSlot : null;
    const next = change.after.timeSlot;
    const moved = !before || compareInstants(before.startsAt, next.startsAt) !== 0 || compareInstants(before.endsAt, next.endsAt) !== 0 || before.timezone !== next.timezone;
    if (!moved) continue;
    if (compareInstants(next.startsAt, current.now) <= 0) return null;
    if (compareInstants(next.startsAt, expiresAt) < 0) expiresAt = next.startsAt;
  }
  return compareInstants(expiresAt, current.now) <= 0 ? null : expiresAt;
}
export function applyChanges(state: UserPlanningState, changes: ChangeSet, deletedAt = new Date().toISOString()): { items: ScheduleItem[]; deletedIds: string[]; scheduleRevision: number } {
  const items: ScheduleItem[] = []; const deletedIds: string[] = [];
  for (const change of changes.changes) {
    if (change.operation === 'create') {
      const item: ScheduleItem = { ...change.after, id: randomUUID(), revision: 1, sourceRefs: [] };
      state.items.set(item.id, item); items.push(item);
    } else if (change.operation === 'update') {
      const before = state.items.get(change.targetId)!;
      const { category, attendance, location, ...after } = change.after;
      const item: ScheduleItem = { ...before, ...after, ...(category === undefined ? {} : { category }), ...(attendance === undefined ? {} : { attendance }),
        ...(location === undefined ? {} : { location }),
        id: before.id, revision: before.revision + 1, sourceRefs: before.sourceRefs };
      if (before.completion !== item.completion || (before.attendance ?? null) !== (item.attendance ?? null)) {
        const history = state.statusUndo ??= new Map(); const undo = history.get(before.id) ?? {};
        if (before.completion !== item.completion) undo.completion = { previous: before.completion, current: item.completion };
        if ((before.attendance ?? null) !== (item.attendance ?? null)) undo.attendance = { previous: before.attendance ?? null, current: item.attendance ?? null };
        history.set(before.id, undo);
      }
      if (before.kind !== item.kind) {
        const undo = state.statusUndo?.get(before.id);
        if (undo) {
          delete undo.attendance;
          if (!undo.completion) state.statusUndo!.delete(before.id);
        }
      }
      state.items.set(item.id, item); items.push(item);
    } else {
      const before = state.items.get(change.targetId)!;
      (state.tombstones ??= new Map()).set(before.id, { itemId: before.id, deletedRevision: before.revision + 1, priorInvolvement: before.involvement, deletedAt });
      state.items.delete(change.targetId); deletedIds.push(change.targetId);
      state.statusUndo?.delete(change.targetId);
    }
  }
  state.scheduleRevision++;
  return { items, deletedIds, scheduleRevision: state.scheduleRevision };
}

export class PlanningService {
  constructor(readonly store: PlanningStore, private readonly clock: () => Date = () => new Date()) {}
  private now(): string { return this.clock().toISOString(); }

  async capture(userId: string, timezone: string, target?: CoordinationTarget): Promise<Baseline> {
    const current = snapshot(await this.store.read(userId), timezone, this.now());
    if (target) {
      const item = current.items.find(value => value.id === target.id);
      if (!item) throw new PlanningError(404, 'not_found', '선택한 일정을 찾을 수 없습니다.');
      if (item.revision !== target.expectedRevision) throw new PlanningError(409, 'conflict', '선택한 일정의 버전이 변경되었습니다.');
      if (item.kind !== 'event' || item.involvement !== 'shared' || item.completion === 'completed') {
        throw new PlanningError(409, 'conflict', '선택한 일정은 공동 조정 대상으로 사용할 수 없습니다.');
      }
    }
    return { userId, snapshot: current, factsKey: factsKey(current.facts), ...(target ? { coordinationTarget: target } : {}) };
  }
  async latest(baseline: Baseline): Promise<ContextSnapshot> {
    return snapshot(await this.store.read(baseline.userId), baseline.snapshot.timezone, this.now());
  }
  baselineCurrent(baseline: Baseline, current: ContextSnapshot): boolean {
    return current.scheduleRevision === baseline.snapshot.scheduleRevision && current.contextRevision === baseline.snapshot.contextRevision && factsKey(current.facts) === baseline.factsKey;
  }
  private reviewProposal(baseline: Baseline, current: ContextSnapshot, decision: Extract<AgentDecision, { kind: 'proposal' }>): ProposalReview {
    const parsed = changeSetSchema.safeParse(decision.changeSet);
    if (!parsed.success || !decision.reason.trim()) return { ok: false, result: { kind: 'failure', message: '제안 형식을 확인할 수 없습니다.', code: 'invalid_request', retryable: false } };
    if (!this.baselineCurrent(baseline, current)) return { ok: false, result: { kind: 'failure', message: '검토 중 일정 또는 맥락이 변경되었습니다. 다시 요청해 주세요.', code: 'stale_proposal', retryable: true } };
    if (baseline.externalExpiresAt !== undefined && (!timestamp.safeParse(baseline.externalExpiresAt).success || compareInstants(baseline.externalExpiresAt, current.now) <= 0)) {
      return { ok: false, result: { kind: 'failure', message: '조회한 외부 정보가 만료되었습니다. 다시 조회해 주세요.', code: 'external_data_expired', retryable: true } };
    }
    const result = proposalAssessment(baseline.userId, current, parsed.data, baseline.coordinationTarget);
    if (!result.validation.valid || !result.mode) {
      if (result.validation.missingFields.length) return { ok: false, result: { kind: 'question', message: '제안을 확인할 정보가 부족합니다.', missingFields: result.validation.missingFields } };
      return { ok: false, result: { kind: 'failure', message: '제안이 일정 제약을 통과하지 못했습니다.', code: 'conflict', retryable: false } };
    }
    let expiresAt = proposalExpiry(current, parsed.data);
    if (expiresAt && baseline.externalExpiresAt && compareInstants(baseline.externalExpiresAt, expiresAt) < 0) expiresAt = baseline.externalExpiresAt;
    if (!expiresAt) return { ok: false, result: { kind: 'failure', message: '이미 시작했거나 만료된 제안은 저장할 수 없습니다.', code: 'expired_proposal', retryable: false } };
    return { ok: true, changes: parsed.data, assessment: result, expiresAt };
  }
  async inspectProposal(baseline: Baseline, decision: Extract<AgentDecision, { kind: 'proposal' }>): Promise<AgentResult | null> {
    const review = this.reviewProposal(baseline, await this.latest(baseline), decision);
    return review.ok ? null : review.result;
  }
  async validateTool(baseline: Baseline, changes: ChangeSet): Promise<ValidationResult> {
    const current = await this.latest(baseline);
    if (!this.baselineCurrent(baseline, current)) return {
      valid: false, conflicts: [{ targetIds: [], reason: 'stale_snapshot' }], missingFields: [], protectedTargets: [],
      checkedScheduleRevision: current.scheduleRevision, checkedContextRevision: current.contextRevision, checkedAt: current.now,
    };
    return proposalAssessment(baseline.userId, current, changes, baseline.coordinationTarget).validation;
  }
  async listSchedule(userId: string, query: { from: string; to: string; includeUnscheduled: string }) {
    const state = await this.store.read(userId);
    return { items: [...state.items.values()].filter(item => item.timeSlot
      ? compareInstants(item.timeSlot.startsAt, query.to) < 0 && compareInstants(query.from, item.timeSlot.endsAt) < 0
      : query.includeUnscheduled === 'true' && item.kind === 'task'), scheduleRevision: state.scheduleRevision };
  }
  async listMemory(userId: string, at: string) {
    const state = await this.store.read(userId);
    return { facts: activeFacts(state, at), contextRevision: state.contextRevision };
  }
  async getReviewSchedule(userId: string): Promise<{ reviewSchedule: ReviewSchedule }> {
    return { reviewSchedule: (await this.store.read(userId)).reviewSchedule ?? {
      revision: 0, timezone: 'UTC', evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null },
    } };
  }
  async saveReviewSchedule(userId: string, input: { expectedRevision: number; timezone: string; evening: ReviewSchedule['evening']; morning: ReviewSchedule['morning'] }) {
    return this.store.atomic(userId, async () => {
      const changedAt = this.store.mode === 'postgres' ? await this.store.transactionTimestamp() : this.now();
      return this.store.transaction(userId, state => {
        const revision = state.reviewSchedule?.revision ?? 0;
        if (revision !== input.expectedRevision) throw new PlanningError(409, 'conflict', '검토 일정 설정 버전이 변경되었습니다.');
        const reviewSchedule: ReviewSchedule = { revision: revision + 1, timezone: input.timezone, evening: input.evening, morning: input.morning };
        state.reviewSchedule = reviewSchedule; state.reviewScheduleUpdatedAt = changedAt;
        return { reviewSchedule };
      });
    });
  }
  async listReviewSchedules(): Promise<Array<{ userId: string; reviewSchedule: ReviewSchedule; updatedAt?: string }>> {
    const users = await this.store.listUserIds();
    const schedules = await Promise.all(users.map(async userId => {
      const state = await this.store.read(userId);
      return { userId, reviewSchedule: state.reviewSchedule, ...(state.reviewScheduleUpdatedAt ? { updatedAt: state.reviewScheduleUpdatedAt } : {}) };
    }));
    return schedules.filter((value): value is { userId: string; reviewSchedule: ReviewSchedule; updatedAt?: string } => value.reviewSchedule !== null);
  }
  async command(userId: string, input: { expectedScheduleRevision: number; changeSet: ChangeSet }) {
    return this.store.transaction(userId, state => {
      if (state.scheduleRevision !== input.expectedScheduleRevision) throw new PlanningError(409, 'conflict', '일정 버전이 변경되었습니다.');
      const now = this.now();
      const result = assessment(userId, snapshot(state, 'UTC', now), input.changeSet, 'user_command');
      if (!result.validation.valid) throw validationError(result.validation);
      return { outcome: 'applied' as const, ...applyChanges(state, input.changeSet, now) };
    });
  }
  async checkin(userId: string, id: string, input: { expectedRevision: number; completion: 'completed' | 'incomplete' | 'unknown' }) {
    return this.store.transaction(userId, state => {
      const before = state.items.get(id);
      if (!before) throw new PlanningError(404, 'not_found', '일정을 찾을 수 없습니다.');
      if (before.revision !== input.expectedRevision) throw new PlanningError(409, 'conflict', '일정 버전이 변경되었습니다.');
      if (before.completion !== input.completion) {
        const history = state.statusUndo ??= new Map(); const undo = history.get(id) ?? {};
        undo.completion = { previous: before.completion, current: input.completion }; history.set(id, undo);
      }
      const item = { ...before, completion: input.completion, revision: before.revision + 1 };
      state.items.set(id, item); state.scheduleRevision++;
      return { item, scheduleRevision: state.scheduleRevision };
    });
  }
  async attendance(userId: string, id: string, input: { expectedRevision: number; attendance: 'attended' | 'absent' | 'unknown' }) {
    return this.store.transaction(userId, state => {
      const before = state.items.get(id);
      if (!before) throw new PlanningError(404, 'not_found', '일정을 찾을 수 없습니다.');
      if (before.revision !== input.expectedRevision) throw new PlanningError(409, 'conflict', '일정 버전이 변경되었습니다.');
      if (before.kind !== 'event') throw new PlanningError(400, 'invalid_request', '참석은 약속과 일정에만 기록할 수 있습니다.');
      if ((before.attendance ?? null) !== input.attendance) {
        const history = state.statusUndo ??= new Map(); const undo = history.get(id) ?? {};
        undo.attendance = { previous: before.attendance ?? null, current: input.attendance }; history.set(id, undo);
      }
      const item = { ...before, attendance: input.attendance, revision: before.revision + 1 };
      state.items.set(id, item); state.scheduleRevision++;
      return { item, scheduleRevision: state.scheduleRevision };
    });
  }
  async undo(userId: string, id: string, input: { expectedRevision: number; field: 'completion' | 'attendance' }) {
    return this.store.transaction(userId, state => {
      const before = state.items.get(id);
      if (!before) throw new PlanningError(404, 'not_found', '일정을 찾을 수 없습니다.');
      if (before.revision !== input.expectedRevision) throw new PlanningError(409, 'conflict', '일정 버전이 변경되었습니다.');
      const undo = state.statusUndo?.get(id); const entry = undo?.[input.field];
      if (!entry || (input.field === 'attendance' && before.kind !== 'event') ||
          (input.field === 'completion' ? before.completion : before.attendance ?? null) !== entry.current) {
        throw new PlanningError(409, 'no_undo', '되돌릴 이전 상태가 없습니다.');
      }
      const item: ScheduleItem = input.field === 'completion'
        ? { ...before, completion: undo!.completion!.previous, revision: before.revision + 1 }
        : { ...before, attendance: undo!.attendance!.previous, revision: before.revision + 1 };
      delete undo![input.field];
      if (!undo!.completion && !undo!.attendance) state.statusUndo!.delete(id);
      state.items.set(id, item); state.scheduleRevision++;
      return { item, scheduleRevision: state.scheduleRevision };
    });
  }
  async saveMemory(userId: string, input: { expectedContextRevision: number; kind: 'preference' | 'situation'; key: string; value: MemoryFact['value']; validUntil: string | null }) {
    return this.store.transaction(userId, state => {
      if (state.contextRevision !== input.expectedContextRevision) throw new PlanningError(409, 'conflict', '맥락 버전이 변경되었습니다.');
      const now = this.now();
      if ((input.kind === 'situation' && !input.validUntil) || (input.validUntil && compareInstants(input.validUntil, now) <= 0)) {
        throw new PlanningError(422, 'missing_information', '유효한 만료 시각이 필요합니다.');
      }
      const key = JSON.stringify([input.kind, input.key]); const old = state.facts.get(key);
      const fact: MemoryFact = { id: old?.id ?? randomUUID(), revision: old ? old.revision + 1 : 1,
        kind: input.kind, key: input.key, value: input.value, source: { type: 'user', ref: userId }, recordedAt: now, validUntil: input.validUntil };
      state.facts.set(key, fact); state.contextRevision++;
      return { fact, contextRevision: state.contextRevision };
    });
  }
  async listProposals(userId: string, input: { status?: Proposal['status']; cursor?: string; limit?: number }) {
    let after: [string, string] | undefined;
    if (input.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error('Invalid cursor');
        const decoded: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every(value => typeof value === 'string')) throw new Error('Invalid cursor');
        after = decoded as [string, string];
      } catch { throw new PlanningError(400, 'invalid_request', '페이지 커서를 확인해 주세요.'); }
    }
    const ordered = [...(await this.store.read(userId)).proposals.values()]
      .filter(proposal => !input.status || proposal.status === input.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter(proposal => !after || proposal.createdAt < after[0] || (proposal.createdAt === after[0] && proposal.id < after[1]));
    const limit = input.limit ?? 50; const proposals = ordered.slice(0, limit); const last = proposals.at(-1);
    return { proposals, nextCursor: ordered.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null };
  }
  async getProposal(userId: string, id: string) {
    const proposal = (await this.store.read(userId)).proposals.get(id);
    if (!proposal) throw new PlanningError(404, 'not_found', '제안을 찾을 수 없습니다.');
    return { proposal };
  }
  async saveProposal(baseline: Baseline, decision: Extract<AgentDecision, { kind: 'proposal' }>): Promise<AgentResult> {
    return this.store.transaction(baseline.userId, state => {
      const current = snapshot(state, baseline.snapshot.timezone, this.now());
      // Recheck the captured revisions and constraints under the write transaction.
      const review = this.reviewProposal(baseline, current, decision);
      if (!review.ok) return review.result;
      const { changes, assessment: result, expiresAt } = review;
      const beforeItems = changes.changes.flatMap(change => change.operation === 'create' ? [] : [state.items.get(change.targetId)!]);
      const common = { id: randomUUID(), revision: 1, baseScheduleRevision: current.scheduleRevision, baseContextRevision: current.contextRevision,
        changeSet: changes, beforeItems, reason: decision.reason, evidenceRefs: decision.evidenceRefs,
        validation: result.validation, createdAt: current.now, expiresAt, status: 'pending' as const };
      const proposal: Proposal = result.mode === 'coordination'
        ? { ...common, mode: 'coordination', coordinationTarget: result.coordinationTarget! }
        : { ...common, mode: 'personal', coordinationTarget: null };
      state.proposals.set(proposal.id, proposal); state.proposalFacts.set(proposal.id, factsKey(current.facts));
      return { kind: 'proposal' as const, message: '변경안을 검토해 주세요.', proposalIds: [proposal.id] };
    });
  }
  async decideProposal(userId: string, id: string, input: { proposalRevision: number; decision: 'accept' | 'reject' }) {
    const outcome = await this.store.transaction(userId, state => {
      const proposal = state.proposals.get(id);
      if (!proposal) throw new PlanningError(404, 'not_found', '제안을 찾을 수 없습니다.');
      if (proposal.revision !== input.proposalRevision) throw new PlanningError(409, 'stale_proposal', '제안 버전이 변경되었습니다.');
      if (proposal.status !== 'pending') throw new PlanningError(409, 'conflict', '이미 처리된 제안입니다.');
      const now = this.now(); const current = snapshot(state, 'UTC', now);
      const invalidate = (status: 'stale' | 'expired', code: 'stale_proposal' | 'expired_proposal', message: string) => {
        state.proposals.set(id, { ...proposal, status, revision: proposal.revision + 1 });
        return { error: { code, message } } as const;
      };
      if (proposal.expiresAt && compareInstants(now, proposal.expiresAt) >= 0) return invalidate('expired', 'expired_proposal', '제안이 만료되었습니다.');
      if (!hasCurrentSnapshotRevisions(proposal, current) || state.proposalFacts.get(id) !== factsKey(current.facts)) {
        return invalidate('stale', 'stale_proposal', '일정 또는 맥락이 변경되었습니다.');
      }
      if (input.decision === 'accept') {
        const checked = assessment(userId, current, proposal.changeSet, 'ai_proposal', proposal.coordinationTarget);
        if (!checked.validation.valid || checked.mode !== proposal.mode) return invalidate('stale', 'stale_proposal', '제안을 현재 상태에서 다시 검증할 수 없습니다.');
      }
      const subject = structuredClone(proposal);
      const approval = { id: randomUUID(), subjectType: 'proposal' as const, subjectId: proposal.id, subjectRevision: proposal.revision,
        decision: input.decision, decidedAt: now, actorRef: userId };
      state.approvals.push({ approval, subject });
      const status = input.decision === 'reject' ? 'rejected' : proposal.mode === 'coordination' ? 'awaiting_contact' : 'applied';
      if (status === 'applied') applyChanges(state, proposal.changeSet, now);
      const updated: Proposal = { ...proposal, revision: proposal.revision + 1, status };
      state.proposals.set(id, updated);
      return { data: { outcome: status, proposal: updated, scheduleRevision: state.scheduleRevision } } as const;
    });
    if ('error' in outcome) throw new PlanningError(409, outcome.error.code, outcome.error.message);
    return outcome.data;
  }
}
