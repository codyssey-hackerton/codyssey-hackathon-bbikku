import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { buildApp } from '../apps/api/src/app.ts';
import { createResponsesModel, MODEL_ID, REASONING_EFFORT } from '../apps/api/src/model.ts';
import { PostgresPlanningStore } from '../apps/api/src/postgres-store.ts';
import { buildReviewEvents, startReviewScheduler, type ReviewScheduler } from '../apps/api/src/scheduler.ts';
import type { ModelPort } from '../apps/api/src/agent.ts';
import type { AgentResult, Proposal, ScheduleFields } from '../packages/domain/src/contracts.ts';

async function main() {
  // Explicitly opt in: uses a project key and synthetic data, never an existing user's state.
  if (process.argv.slice(2).join(' ') !== '--live') {
    console.log('Usage: node --env-file-if-exists=.env.local --import tsx scripts/verify-live-planning.ts --live');
    console.log('Runs real model + isolated PostgreSQL HTTP/queue checks; max 24 provider requests; no external contact.');
    process.exit(0);
  }
  const key = process.env.PIKKU_OPENAI_API_KEY?.trim();
  if (!key) { console.error('PIKKU_OPENAI_API_KEY is not configured.'); process.exit(1); }
  const connectionString = process.env.PIKKU_TEST_DATABASE_URL?.trim()
    || readFileSync(new URL('../.local/postgres-url.txt', import.meta.url), 'utf8').trim();
  const runId = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `pikku_live_${runId}`;
  const userId = 'synthetic-live';
  const timezone = 'Asia/Seoul';
  const token = randomBytes(24).toString('hex');
  const report: Record<string, unknown> = { runId, schema, model: MODEL_ID, reasoningEffort: REASONING_EFFORT,
    startedAt: new Date().toISOString(), checks: [], providerRequests: 0, tools: [] };
  const checks = report.checks as string[];
  const tools = report.tools as string[];
  let providerRequests = 0;
  const live = createResponsesModel(key, async (url, init) => {
    if (++providerRequests > 24) throw new Error('PROVIDER_BUDGET');
    const response = await fetch(url, init);
    return response;
  });
  const model: ModelPort = { async decide(input) {
    const decision = await live.decide(input) as { kind: string; name?: string };
    if (decision.kind === 'tool_call' && decision.name) tools.push(decision.name);
    return decision;
  } };
  let pool: pg.Pool | undefined;
  let store!: PostgresPlanningStore;
  let app: ReturnType<typeof buildApp> | undefined;
  let scheduler: ReviewScheduler | undefined;
  let base = '';
  let stage = 'database_setup';
  const passed = (name: string) => { checks.push(name); console.log(JSON.stringify({ check: name, status: 'passed' })); };
  function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
  async function openApp() {
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    store = new PostgresPlanningStore(pool);
    await store.migrate();
    app = buildApp({ store, model, sessions: { async resolve(candidate) { return candidate === token ? { userId } : null; } },
      schedulerStatus: () => scheduler ? 'available' : 'not_configured' });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }
  async function request(path: string, payload?: object, idempotencyKey = randomUUID()) {
    const response = await fetch(base + path, { method: payload ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      ...(payload ? { body: JSON.stringify({ requestId: idempotencyKey, ...payload }) } : {}), signal: AbortSignal.timeout(390_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`HTTP_${response.status}_${String(value.error?.code ?? 'unknown')}`);
    return value.data;
  }
  function civil(date: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
  function field(title: string): ScheduleFields {
    return { kind: 'task', title, timeSlot: null, durationMinutes: 60, deadline: null,
      flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
  }
  async function approve(proposal: Proposal, itemId: string, expectedStart: string | null) {
    const approvalKey = randomUUID();
    const body = { proposalRevision: proposal.revision, decision: 'accept' };
    const result = await request(`/v1/proposals/${proposal.id}/decision`, body, approvalKey);
    expect(result.outcome === 'applied', 'approval_not_applied');
    const replay = await request(`/v1/proposals/${proposal.id}/decision`, body, approvalKey);
    assert.deepEqual(replay, result);
    const state = await store.read(userId);
    expect(state.items.get(itemId)?.timeSlot, 'approved_item_not_scheduled');
    if (expectedStart) expect(Date.parse(state.items.get(itemId)!.timeSlot!.startsAt) === Date.parse(expectedStart), 'approved_time_mismatch');
  }
  try {
    const admin = new pg.Pool({ connectionString });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    await openApp();
    const cap = await request('/v1/capabilities');
    expect(cap.storage.mode === 'postgres' && cap.storage.durable, 'not_postgres');
    passed('postgres_authenticated_http');
    const tomorrow = civil(new Date(Date.now() + 86_400_000));
    const study = field('합성 검증 공부');
    const meeting: ScheduleFields = { ...field('합성 고정 회의'), kind: 'event', durationMinutes: null, flexibility: 'fixed',
      timeSlot: { startsAt: `${tomorrow}T15:00:00+09:00`, endsAt: `${tomorrow}T16:00:00+09:00`, timezone } };
    const seeded = await request('/v1/schedule/commands', { expectedScheduleRevision: 0, changeSet: { changes: [study, meeting].map((after, i) => ({ changeId: `seed-${i}`, operation: 'create', after })) } });
    const itemId = seeded.items.find((item: { title: string }) => item.title === study.title).id as string;
    const fixedId = seeded.items.find((item: { title: string }) => item.title === meeting.title).id as string;
    await request('/v1/memory', { expectedContextRevision: 0, kind: 'preference', key: 'study_time', value: '공부는 오전 10시부터 60분을 선호한다.', validUntil: null });
    stage = 'live_chat_proposal';
    const chat = await request('/v1/chat', { conversationId: null, timezone,
      message: `${tomorrow} 일정과 선호를 조회하고 기존 미배치 할 일 '합성 검증 공부'를 오전 10시~11시에 배치하는 변경안을 제안해줘. 새 작업을 만들지 말고 기존 작업 하나만 수정해줘. 고정 회의는 유지해줘. 승인은 내가 별도로 할게.` });
    const result = chat.result as AgentResult;
    expect(result.kind === 'proposal', `chat_${result.kind}${result.kind === 'failure' ? `_${result.code}` : ''}`);
    if (result.kind !== 'proposal') throw new Error('no_proposal');
    const proposal = (await request(`/v1/proposals/${result.proposalIds[0]}`)).proposal as Proposal;
    expect(proposal.validation.valid && proposal.status === 'pending', 'proposal_not_valid');
    expect(proposal.changeSet.changes.length === 1 && proposal.changeSet.changes[0]?.operation === 'update'
      && proposal.changeSet.changes[0].targetId === itemId, 'unexpected_change_scope');
    const before = await store.read(userId);
    expect(before.items.get(itemId)?.timeSlot === null && before.scheduleRevision === 1, 'changed_before_approval');
    passed('real_model_tools_validated_pending_proposal');
    stage = 'approval_restart';
    await app!.close(); app = undefined; await pool!.end(); pool = undefined;
    await openApp();
    const restored = (await request(`/v1/proposals/${proposal.id}`)).proposal;
    assert.deepEqual(restored, proposal);
    passed('pending_approval_survives_api_and_pool_restart');
    await approve(proposal, itemId, `${tomorrow}T10:00:00+09:00`);
    expect((await store.read(userId)).approvals.length === 1, 'duplicate_approval');
    assert.deepEqual((await store.read(userId)).items.get(fixedId)?.timeSlot, meeting.timeSlot);
    passed('approval_applies_once_fixed_event_unchanged');

    stage = 'scheduled_review';
    const scheduledTask = { ...field('합성 예약 검토 독서'), durationMinutes: 30 };
    const current = await store.read(userId);
    const created = await request('/v1/schedule/commands', { expectedScheduleRevision: current.scheduleRevision,
      changeSet: { changes: [{ changeId: 'scheduled-task', operation: 'create', after: scheduledTask }] } });
    const scheduledItemId = created.items.find((item: { title: string }) => item.title === scheduledTask.title).id as string;
    await request('/v1/memory', { expectedContextRevision: current.contextRevision, kind: 'preference', key: 'reading_plan',
      value: `${tomorrow} 미배치 할 일 '합성 예약 검토 독서'는 14:00~14:30에 하기를 원한다. 다음 날 계획 검토 시 이 작업만 배치 제안하고 기존 고정 회의와 공부는 유지한다.`, validUntil: null });
    const due = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(due);
    const setting = await request('/v1/review-schedule', { expectedRevision: 0, timezone,
      evening: { enabled: true, localTime }, morning: { enabled: false, localTime: null } });
    const event = buildReviewEvents({ userId, reviewSchedule: setting.reviewSchedule }, new Date())[0]!;
    expect(event && Date.parse(event.scheduledFor) === due.getTime(), 'unexpected_due');
    report.scheduledFor = event.scheduledFor;
    const boss = new PgBoss({ connectionString, schema: `${schema}_jobs` });
    scheduler = await startReviewScheduler({ connectionString, runtime: app!.reviewRuntime, boss, reconcileIntervalMs: 1000 });
    console.log(JSON.stringify({ check: 'real_queue_wait', scheduledFor: event.scheduledFor }));
    const deadline = due.getTime() + 6 * 60_000;
    let ledger: { status?: string; result?: AgentResult } | undefined;
    while (Date.now() < deadline) {
      ledger = (await store.read(userId)).reviewLedger.get(event.idempotencyKey) as typeof ledger;
      if (ledger?.status === 'completed') break;
      await delay(1000);
    }
    expect(ledger?.status === 'completed', 'scheduled_review_timeout');
    expect(ledger.result?.kind === 'proposal', `scheduled_${ledger.result?.kind ?? 'missing'}`);
    const pending = await store.read(userId);
    expect(pending.items.get(scheduledItemId)?.timeSlot === null, 'scheduler_changed_without_approval');
    passed('real_pgboss_due_event_creates_pending_ai_proposal');
    const callsBeforeReplay = providerRequests;
    const replay = await app!.reviewRuntime.runScheduledReview(event);
    expect(replay.status === 'completed' && providerRequests === callsBeforeReplay, 'duplicate_trigger_called_model');
    expect((await store.read(userId)).proposals.size === pending.proposals.size, 'duplicate_trigger_proposal');
    passed('duplicate_trigger_no_new_model_call_or_proposal');
    const scheduledResult = ledger.result;
    if (scheduledResult.kind !== 'proposal') throw new Error('scheduled_no_proposal');
    const second = (await request(`/v1/proposals/${scheduledResult.proposalIds[0]}`)).proposal as Proposal;
    expect(second.changeSet.changes.length === 1 && second.changeSet.changes[0]?.operation === 'update'
      && second.changeSet.changes[0].targetId === scheduledItemId, 'scheduled_scope_mismatch');
    await approve(second, scheduledItemId, `${tomorrow}T14:00:00+09:00`);
    passed('scheduled_proposal_approval_applies_once');
    const final = await store.read(userId);
    assert.deepEqual(final.items.get(fixedId)?.timeSlot, meeting.timeSlot);
    await scheduler.stop(); scheduler = undefined;
    await app!.close(); app = undefined; await pool!.end(); pool = undefined;
    await openApp();
    const recovered = await store.read(userId);
    assert.deepEqual([...recovered.items], [...final.items]);
    expect(recovered.approvals.length === 2 && recovered.reviewLedger.has(event.idempotencyKey), 'durable_result_missing');
    passed('approved_items_ledger_and_approvals_survive_restart');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failedStage = stage;
    // Only our fixed diagnostic codes are printed, never provider payloads or credentials.
    report.failure = error instanceof Error && /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'verification_failed';
    process.exitCode = 1;
  } finally {
    if (scheduler) await scheduler.stop();
    // Preserve evidence but disable this synthetic user's future recurring runs.
    if (pool && !pool.ended) await store!.transaction(userId, state => {
      if (state.reviewSchedule) state.reviewSchedule = { ...state.reviewSchedule, revision: state.reviewSchedule.revision + 1,
        evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } };
    }).catch(() => {});
    if (app) await app.close();
    if (pool && !pool.ended) await pool.end();
    report.providerRequests = providerRequests; report.finishedAt = new Date().toISOString();
    const directory = new URL('../.local/live-planning/', import.meta.url);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(new URL(`${runId}.json`, directory), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report));
  }
}
void main().catch(() => { console.error('Verification setup failed. Check local database/key configuration.'); process.exitCode = 1; });
