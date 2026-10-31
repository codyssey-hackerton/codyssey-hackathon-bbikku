import type { Pool, PoolClient } from 'pg';

export type SyncMapping = {
  bindingId: string;
  itemId: string;
  eventId: string;
  itemRevision: number;
  etag: string;
};
export type SyncConnection = {
  id: string;
  calendarId: string;
  accountRef: string;
  revision: number;
  allowDeletes: boolean;
  exportItemIds: string[];
  syncToken: string | null;
  mappings: SyncMapping[];
  activeRun: string | null;
};
export type SyncOperation = {
  id: string;
  fingerprint: string;
  state: 'running' | 'completed' | 'uncertain';
  result?: unknown;
};
export type SyncState = { connections: SyncConnection[]; operations: SyncOperation[] };
export interface CalendarSyncStore {
  read(userId: string): Promise<SyncState>;
  update<T>(userId: string, apply: (state: SyncState) => T | Promise<T>): Promise<T>;
}
const empty = (): SyncState => ({ connections: [], operations: [] });

export class PostgresCalendarSyncStore implements CalendarSyncStore {
  constructor(readonly pool: Pool) {}
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [174274, 2]);
      await client.query(`CREATE TABLE IF NOT EXISTS pikku_calendar_sync_v1 (
        user_id text PRIMARY KEY,
        state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be lost */ }
      throw error;
    } finally { client.release(); }
  }
  async read(userId: string): Promise<SyncState> {
    const result = await this.pool.query('SELECT state FROM pikku_calendar_sync_v1 WHERE user_id = $1', [userId]);
    return result.rows.length ? structuredClone(result.rows[0].state as SyncState) : empty();
  }
  async update<T>(userId: string, apply: (state: SyncState) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const output = await this.updateWithClient(client, userId, apply);
      await client.query('COMMIT');
      return structuredClone(output);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be lost */ }
      throw error;
    } finally { client.release(); }
  }
  async updateWithClient<T>(client: PoolClient, userId: string, apply: (state: SyncState) => T | Promise<T>): Promise<T> {
    await client.query('INSERT INTO pikku_calendar_sync_v1 (user_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING', [userId, JSON.stringify(empty())]);
    const result = await client.query('SELECT state FROM pikku_calendar_sync_v1 WHERE user_id = $1 FOR UPDATE', [userId]);
    const state = result.rows[0].state as SyncState;
    const output = await apply(state);
    await client.query('UPDATE pikku_calendar_sync_v1 SET state = $2::jsonb, updated_at = now() WHERE user_id = $1', [userId, JSON.stringify(state)]);
    return structuredClone(output);
  }
}

export class MemoryCalendarSyncStore implements CalendarSyncStore {
  private readonly states = new Map<string, SyncState>();
  private readonly tails = new Map<string, Promise<void>>();
  async read(userId: string): Promise<SyncState> { return structuredClone(this.states.get(userId) ?? empty()); }
  async update<T>(userId: string, apply: (state: SyncState) => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    this.tails.set(userId, tail);
    await previous;
    try {
      const state = await this.read(userId);
      const output = await apply(state);
      this.states.set(userId, state);
      return structuredClone(output);
    } finally {
      release();
      if (this.tails.get(userId) === tail) this.tails.delete(userId);
    }
  }
}
