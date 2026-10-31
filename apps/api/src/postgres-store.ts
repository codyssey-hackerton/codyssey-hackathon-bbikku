import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emptyState, type PlanningStore, type UserPlanningState } from './planning-store.ts';

// Temporary v1 repository contract: one versioned JSONB document per authenticated user.
// This is a regular durable PostgreSQL table, not a PostgreSQL TEMP/UNLOGGED table.
// A coordinated migration is required before replacing this with normalized tables.
const migration = `
  CREATE TABLE IF NOT EXISTS pikku_user_state_v1 (
    user_id text PRIMARY KEY,
    schema_version integer NOT NULL CHECK (schema_version = 1),
    state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
const pairs = z.array(z.tuple([z.string(), z.unknown()]));
const stored = z.object({
  format: z.literal(1), scheduleRevision: z.number().int().nonnegative(), contextRevision: z.number().int().nonnegative(),
  items: pairs, facts: pairs, proposals: pairs, proposalFacts: pairs, approvals: z.array(z.unknown()),
  recipients: pairs.optional(), contactRequests: pairs.optional(), contactDraftSnapshots: pairs.optional(), contactApprovals: z.array(z.unknown()).optional(),
  contactResponses: pairs.optional(), voiceSessions: pairs.optional(),
  conversations: pairs, idempotency: pairs, reviewSchedule: z.unknown().nullable(), reviewScheduleUpdatedAt: z.string().nullable().optional(), reviewLedger: pairs,
}).strict();

function encode(state: UserPlanningState): string {
  return JSON.stringify({ format: 1, scheduleRevision: state.scheduleRevision, contextRevision: state.contextRevision,
    items: [...state.items], facts: [...state.facts], proposals: [...state.proposals], proposalFacts: [...state.proposalFacts], approvals: state.approvals,
    ...(state.recipients.size ? { recipients: [...state.recipients] } : {}),
    ...(state.contactRequests.size ? { contactRequests: [...state.contactRequests] } : {}),
    ...(state.contactDraftSnapshots.size ? { contactDraftSnapshots: [...state.contactDraftSnapshots] } : {}),
    ...(state.contactApprovals.length ? { contactApprovals: state.contactApprovals } : {}),
    ...(state.contactResponses.size ? { contactResponses: [...state.contactResponses] } : {}),
    ...(state.voiceSessions.size ? { voiceSessions: [...state.voiceSessions] } : {}),
    conversations: [...state.conversations], idempotency: [...state.idempotency], reviewSchedule: state.reviewSchedule,
    reviewScheduleUpdatedAt: state.reviewScheduleUpdatedAt, reviewLedger: [...state.reviewLedger] });
}
function decode(value: unknown): UserPlanningState {
  const data = stored.parse(value);
  return { scheduleRevision: data.scheduleRevision, contextRevision: data.contextRevision,
    items: new Map(data.items), facts: new Map(data.facts), proposals: new Map(data.proposals), proposalFacts: new Map(data.proposalFacts), approvals: data.approvals,
    recipients: new Map(data.recipients ?? []), contactRequests: new Map(data.contactRequests ?? []),
    contactDraftSnapshots: new Map(data.contactDraftSnapshots ?? []), contactApprovals: data.contactApprovals ?? [],
    contactResponses: new Map(data.contactResponses ?? []), voiceSessions: new Map(data.voiceSessions ?? []),
    conversations: new Map(data.conversations), idempotency: new Map(data.idempotency), reviewSchedule: data.reviewSchedule,
    reviewScheduleUpdatedAt: data.reviewScheduleUpdatedAt ?? null, reviewLedger: new Map(data.reviewLedger),
  } as UserPlanningState;
}
type Context = { userId: string; state: UserPlanningState; timestamp: string };

export class PostgresPlanningStore implements PlanningStore {
  readonly mode = 'postgres' as const;
  readonly durable = true;
  private readonly context = new AsyncLocalStorage<Context>();
  constructor(readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [174274, 1]);
      await client.query(migration);
      await client.query('SELECT user_id, schema_version, state, updated_at FROM pikku_user_state_v1 LIMIT 0');
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* connection may already be lost */ } throw error; }
    finally { client.release(); }
  }
  async read(userId: string): Promise<UserPlanningState> {
    const active = this.context.getStore();
    if (active) {
      if (active.userId !== userId) throw new Error('Cross-user transaction not allowed');
      return structuredClone(active.state);
    }
    const result = await this.pool.query('SELECT schema_version, state FROM pikku_user_state_v1 WHERE user_id = $1', [userId]);
    if (!result.rows.length) return emptyState();
    if (result.rows[0].schema_version !== 1) throw new Error('Unsupported database state version');
    return decode(result.rows[0].state);
  }
  async listUserIds(): Promise<string[]> {
    const result = await this.pool.query('SELECT user_id FROM pikku_user_state_v1 ORDER BY user_id');
    return result.rows.map(row => String(row.user_id));
  }
  async transactionTimestamp(): Promise<string> {
    const active = this.context.getStore();
    if (!active) throw new Error('A transaction is required');
    return active.timestamp;
  }
  async atomic<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) {
      if (active.userId !== userId) throw new Error('Cross-user transaction not allowed');
      return run();
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pikku_user_state_v1(user_id, schema_version, state) VALUES ($1, 1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING', [userId, encode(emptyState())]);
      const result = await client.query('SELECT schema_version, state FROM pikku_user_state_v1 WHERE user_id = $1 FOR UPDATE', [userId]);
      if (result.rows.length !== 1 || result.rows[0].schema_version !== 1) throw new Error('Unsupported database state version');
      const timestamp = await client.query('SELECT clock_timestamp() AS locked_at');
      const context = { userId, state: decode(result.rows[0].state), timestamp: (timestamp.rows[0].locked_at as Date).toISOString() };
      const output = await this.context.run(context, run);
      await client.query('UPDATE pikku_user_state_v1 SET state = $2::jsonb, updated_at = now() WHERE user_id = $1', [userId, encode(context.state)]);
      await client.query('COMMIT');
      return structuredClone(output);
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* commit outcome can be unknown */ } throw error; }
    finally { client.release(); }
  }
  async transaction<T>(userId: string, apply: (state: UserPlanningState) => T): Promise<T> {
    return this.atomic(userId, async () => {
      const context = this.context.getStore()!;
      const draft = structuredClone(context.state);
      const result = apply(draft);
      if (result instanceof Promise) throw new Error('PostgreSQL state callbacks must be synchronous');
      context.state = draft;
      return structuredClone(result);
    });
  }
}
