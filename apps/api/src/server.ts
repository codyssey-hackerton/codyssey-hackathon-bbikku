import { buildApp } from './app.ts';
import { localDevelopmentSession } from './auth.ts';
import { createResponsesModel } from './model.ts';
import { assertDevelopmentBinding } from './development.ts';
import pg from 'pg';
import { PostgresPlanningStore } from './postgres-store.ts';
import { startReviewScheduler, type ReviewScheduler } from './scheduler.ts';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST ?? '127.0.0.1';
const developmentAuth = process.env.PIKKU_DEV_AUTH === 'true';
assertDevelopmentBinding(process.env, host);
const sessions = developmentAuth ? localDevelopmentSession(process.env.PIKKU_DEV_SESSION_TOKEN ?? '') : undefined;
// Only the explicitly named project key is used; do not discover global or other application keys.
const projectKey = process.env.PIKKU_OPENAI_API_KEY;
const model = projectKey?.trim() ? createResponsesModel(projectKey) : undefined;
const connectionString = process.env.PIKKU_DATABASE_URL?.trim();
const schedulerEnabled = process.env.PIKKU_SCHEDULER_ENABLED === 'true';
if (schedulerEnabled && !connectionString) throw new Error('PIKKU_DATABASE_URL is required when the scheduler is enabled');
let pool: pg.Pool | undefined;
let store: PostgresPlanningStore | undefined;
if (connectionString) {
  pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { process.emitWarning('PostgreSQL pool connection error'); });
  store = new PostgresPlanningStore(pool);
  try { await store.migrate(); } catch { await pool.end(); throw new Error('PostgreSQL initialization failed'); }
}
let scheduler: ReviewScheduler | undefined;
let schedulerState: 'not_configured' | 'available' | 'degraded' = schedulerEnabled ? 'degraded' : 'not_configured';
const app = buildApp({ sessions, model, store, schedulerStatus: () => schedulerState,
  onReviewScheduleChanged: async () => {
    if (!scheduler) return;
    try { await scheduler.reconcile(); schedulerState = 'available'; }
    catch { schedulerState = 'degraded'; throw new Error('Review schedule reconciliation failed'); }
  },
});
try {
  if (schedulerEnabled) {
    scheduler = await startReviewScheduler({ connectionString: connectionString!, runtime: app.reviewRuntime,
      onError: () => { schedulerState = 'degraded'; } });
    schedulerState = 'available';
  }
  await app.listen({ host, port });
} catch {
  if (scheduler) await scheduler.stop();
  await app.close();
  if (pool) await pool.end();
  throw new Error('PIKKU server initialization failed');
}
console.log(`PIKKU local API listening at ${app.server.address() && `port ${port}`}`);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  void (async () => { if (scheduler) await scheduler.stop(); await app.close(); if (pool) await pool.end(); })()
    .catch(() => { process.exitCode = 1; });
});
