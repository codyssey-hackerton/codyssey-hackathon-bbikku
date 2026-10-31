import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { MemberAuthStore } from '../src/member-auth-store.ts';

// This test creates its own short-lived synthetic cluster; it never reads a configured database URL.
test('member sessions and identity survive PostgreSQL transactions without modifying planning data',
  { skip: process.env.PIKKU_TEST_ISOLATED_MEMBER_PG !== '1', timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pikku-member-pg-'));
    const listener = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') return reject(new Error('No local port'));
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'synthetic', password: 'synthetic-only-password',
      persistent: false, authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
    let started = false; let pool: pg.Pool | undefined;
    t.after(async () => { if (pool) await pool.end(); if (started) await postgres.stop(); await rm(directory, { recursive: true, force: true }); });
    process.umask(0o077);
    await postgres.initialise(); await postgres.start(); started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'synthetic', password: 'synthetic-only-password', database: 'postgres' });
    await pool.query('CREATE TABLE pikku_user_state_v1 (user_id text PRIMARY KEY, state jsonb NOT NULL)');
    await pool.query('INSERT INTO pikku_user_state_v1 VALUES ($1, $2)', ['preview-user', { sample: 'unchanged' }]);
    const store = new MemberAuthStore(pool); await store.migrate(); await store.migrate();
    const now = new Date('2030-01-01T00:00:00Z'); const expiry = new Date('2030-01-08T00:00:00Z');
    const hash = createHash('sha256').update('synthetic-session').digest('hex');
    const identity = { subject: 'subject-1', email: 'same@example.test', displayName: '첫 회원' };
    const member = await store.createSession(identity, hash, now, expiry);
    assert.match(member.id, /^member:/); assert.deepEqual(await store.findSession(hash, now), member);
    assert.deepEqual(await new MemberAuthStore(pool).findSession(hash, now), member);
    const another = await store.createSession({ ...identity, subject: 'subject-2' }, 'different-hash', now, expiry);
    assert.notEqual(another.id, member.id);
    const same = await store.createSession({ ...identity, displayName: '변경된 이름' }, 'another-hash', now, expiry);
    assert.equal(same.id, member.id);
    await assert.rejects(store.createSession({ ...identity, displayName: '롤백되어야 할 이름' }, hash, now, expiry));
    assert.equal((await store.findSession(hash, now))?.displayName, '변경된 이름');
    assert.equal(await store.findSession(hash, expiry), null);
    assert.equal(await store.revokeSession(hash, now), true); assert.equal(await store.revokeSession(hash, now), false);
    assert.equal(await store.findSession(hash, now), null);
    const rows = await pool.query('SELECT token_hash FROM pikku_member_sessions_v1');
    assert.ok(rows.rows.every(row => row.token_hash !== 'synthetic-session'));
    assert.deepEqual((await pool.query('SELECT state FROM pikku_user_state_v1 WHERE user_id = $1', ['preview-user'])).rows[0].state, { sample: 'unchanged' });
  });
