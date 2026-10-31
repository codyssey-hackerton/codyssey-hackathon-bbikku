import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type Member = { id: string; email: string; displayName: string };

export class MemberAuthStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [174274, 2]);
      await client.query(`CREATE TABLE IF NOT EXISTS pikku_members_v1 (
        id text PRIMARY KEY, google_subject text NOT NULL UNIQUE, email text NOT NULL,
        display_name text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS pikku_member_sessions_v1 (
        token_hash text PRIMARY KEY, member_id text NOT NULL REFERENCES pikku_members_v1(id),
        created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
      )`);
      await client.query('SELECT id, google_subject, email, display_name, created_at, updated_at FROM pikku_members_v1 LIMIT 0');
      await client.query('SELECT token_hash, member_id, created_at, expires_at, revoked_at FROM pikku_member_sessions_v1 LIMIT 0');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async createSession(identity: { subject: string; email: string; displayName: string }, hash: string, now: Date, expiresAt: Date): Promise<Member> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; email: string; display_name: string }>(
        `INSERT INTO pikku_members_v1 (id, google_subject, email, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (google_subject) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
         RETURNING id, email, display_name`, [`member:${randomUUID()}`, identity.subject, identity.email, identity.displayName, now]);
      const row = result.rows[0];
      if (!row) throw new Error('MEMBER_STORE_FAILED');
      await client.query('INSERT INTO pikku_member_sessions_v1 (token_hash, member_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [hash, row.id, now, expiresAt]);
      await client.query('COMMIT');
      return { id: row.id, email: row.email, displayName: row.display_name };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async findSession(hash: string, now: Date): Promise<Member | null> {
    const result = await this.pool.query<{ id: string; email: string; display_name: string }>(
      `SELECT m.id, m.email, m.display_name FROM pikku_member_sessions_v1 s
       JOIN pikku_members_v1 m ON m.id = s.member_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`, [hash, now]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
  }

  async revokeSession(hash: string, now: Date): Promise<boolean> {
    const result = await this.pool.query('UPDATE pikku_member_sessions_v1 SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2', [hash, now]);
    return result.rowCount === 1;
  }
}
