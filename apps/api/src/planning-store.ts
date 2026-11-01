import { AsyncLocalStorage } from 'node:async_hooks';
import type { Approval, MemoryFact, Proposal, Recipient, ReviewSchedule, ScheduleItem } from '@pikku/domain';
import type { ContactRequest, StoredContactApproval, StoredContactDraft } from './contact-service.ts';
import type { StoredContactResponse } from './contact-response.ts';
import type { HttpResult } from './idempotency.ts';

export type StoredApproval = { approval: Approval; subject: Proposal };
export type Conversation = { turns: { role: 'user' | 'assistant'; content: string; externalExpiresAt?: string; proposalIds?: string[] }[]; lock?: { token: string; until: string } };
export type DurableIdempotencyRecord = { fingerprint: string; operationId: string; state: 'running' | 'retryable' | 'completed';
  result?: HttpResult; token?: string; leaseUntil?: string; requestId?: string };
export type StatusUndo = {
  completion?: { previous: ScheduleItem['completion']; current: ScheduleItem['completion'] };
  attendance?: { previous: NonNullable<ScheduleItem['attendance']> | null; current: NonNullable<ScheduleItem['attendance']> | null };
};
export type UserPlanningState = {
  scheduleRevision: number;
  contextRevision: number;
  items: Map<string, ScheduleItem>;
  tombstones?: Map<string, { itemId: string; deletedRevision: number; priorInvolvement: 'personal' | 'shared'; deletedAt: string }>;
  statusUndo?: Map<string, StatusUndo>;
  facts: Map<string, MemoryFact>;
  proposals: Map<string, Proposal>;
  proposalFacts: Map<string, string>;
  approvals: StoredApproval[];
  recipients: Map<string, Recipient>;
  contactRequests: Map<string, ContactRequest>;
  contactDraftSnapshots: Map<string, StoredContactDraft>;
  contactApprovals: StoredContactApproval[];
  contactResponses: Map<string, StoredContactResponse>;
  voiceSessions: Map<string, unknown>;
  conversations: Map<string, Conversation>;
  idempotency: Map<string, DurableIdempotencyRecord>;
  reviewSchedule: ReviewSchedule | null;
  reviewScheduleUpdatedAt: string | null;
  reviewLedger: Map<string, unknown>;
};

export function emptyState(): UserPlanningState {
  return { scheduleRevision: 0, contextRevision: 0, items: new Map(), tombstones: new Map(), facts: new Map(), proposals: new Map(), proposalFacts: new Map(), approvals: [],
    recipients: new Map(), contactRequests: new Map(), contactDraftSnapshots: new Map(), contactApprovals: [], contactResponses: new Map(), voiceSessions: new Map(),
    conversations: new Map(), idempotency: new Map(), reviewSchedule: null, reviewScheduleUpdatedAt: null, reviewLedger: new Map() };
}

export interface PlanningStore {
  readonly mode: 'memory' | 'postgres';
  readonly durable: boolean;
  read(userId: string): Promise<UserPlanningState>;
  transaction<T>(userId: string, apply: (state: UserPlanningState) => T): Promise<T>;
  atomic<T>(userId: string, run: () => Promise<T>): Promise<T>;
  transactionTimestamp(): Promise<string>;
  listUserIds(): Promise<string[]>;
}
type Context = { userId: string; state: UserPlanningState };
// Single-process, volatile adapter: per-user serialization and copy-on-write rollback.
export class MemoryPlanningStore implements PlanningStore {
  readonly mode = 'memory' as const;
  readonly durable = false;
  private readonly states = new Map<string, UserPlanningState>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly context = new AsyncLocalStorage<Context>();

  async read(userId: string): Promise<UserPlanningState> {
    const context = this.context.getStore();
    return structuredClone(context?.userId === userId ? context.state : this.states.get(userId) ?? emptyState());
  }
  async listUserIds(): Promise<string[]> { return [...this.states.keys()]; }
  async transactionTimestamp(): Promise<string> { return new Date().toISOString(); }
  async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) {
      if (active.userId !== userId) throw new Error('Cross-user transaction not allowed');
      return run();
    }
    const previous = this.tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(userId, tail);
    await previous;
    try {
      const context = { userId, state: structuredClone(this.states.get(userId) ?? emptyState()) };
      return await this.context.run(context, async () => {
        const result = await run();
        this.states.set(userId, context.state);
        return structuredClone(result);
      });
    } finally {
      release();
      if (this.tails.get(userId) === tail) this.tails.delete(userId);
    }
  }
  async transaction<T>(userId: string, apply: (state: UserPlanningState) => T): Promise<T> {
    return this.atomic(userId, async () => {
      const context = this.context.getStore()!;
      const draft = structuredClone(context.state);
      const result = apply(draft);
      if (result instanceof Promise) throw new Error('Memory transaction callbacks must be synchronous');
      context.state = draft;
      return structuredClone(result);
    });
  }
}
