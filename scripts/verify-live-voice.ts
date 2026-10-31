import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import type { ScheduleFields } from '../packages/domain/src/contracts.ts';
import { buildApp } from '../apps/api/src/app.ts';
import { ContactService } from '../apps/api/src/contact-service.ts';
import { normalizePhoneNumber, PhoneConnections } from '../apps/api/src/phone-connection.ts';
import { managedCallBindingKey } from '../apps/api/src/phone-dispatch.ts';
import { PlanningService } from '../apps/api/src/planning-service.ts';
import { MemoryPlanningStore, type PlanningStore } from '../apps/api/src/planning-store.ts';
import { PostgresPlanningStore } from '../apps/api/src/postgres-store.ts';

// Live mode is never implicit. The permanent marker prevents a second real POST,
// including when the provider's outcome is unknown or this process is interrupted.
const root = process.env.PIKKU_VOICE_PRIVATE_ROOT ?? process.cwd();
const privateDir = join(root, '.local', 'live-voice');
const actor = 'synthetic-managed-voice';
const optionId = 'synthetic-option';
const localDbFile = join(process.cwd(), '.local', 'postgres', 'test', 'postgres-url.txt');
const mode = process.argv[2];

async function testDatabaseUrl() {
  const db = (await readFile(localDbFile, 'utf8')).trim(); const url = new URL(db);
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433');
  return db;
}

// A human must inspect the private transcript and explicitly choose this mode.
// It never performs a provider request or initiates a call.
async function confirmReviewed(runId: string) {
  assert.match(runId, /^[a-f0-9]{20}$/);
  const file = join(privateDir, `${runId}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const report = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(report.runId, runId); assert.equal(report.schema, `pikku_voice_${runId}`);
  const pool = new pg.Pool({ connectionString: await testDatabaseUrl(), options: `-c search_path=${report.schema}` });
  const store = new PostgresPlanningStore(pool);
  const app = buildApp({ store, sessions: { async resolve(token) { return token === 'synthetic-session' ? { userId: actor } : null; } } });
  const path = `/v1/contact-requests/${report.contactId}/responses/${report.responseId}/confirm`;
  const post = (requestId: string) => app.inject({ method: 'POST', url: path,
    headers: { authorization: 'Bearer synthetic-session', 'idempotency-key': requestId },
    payload: { requestId, contactRevision: report.contactRevision, selectedOptionId: optionId } });
  try {
    const before = await store.read(actor);
    const result = await post('reviewed-confirm'); assert.equal(result.statusCode, 200); assert.equal(result.json().data.changed, true);
    const after = await store.read(actor); assert.equal(after.scheduleRevision, before.scheduleRevision + 1);
    assert.equal(after.items.get(report.itemId)?.timeSlot?.startsAt, '2026-11-02T18:00:00+09:00');
    const duplicate = await post('reviewed-duplicate'); assert.equal(duplicate.statusCode, 409);
    assert.equal((await store.read(actor)).scheduleRevision, after.scheduleRevision);
    console.log(JSON.stringify({ status: 'passed', checks: ['manual_confirmation', 'synthetic_schedule_changed_once', 'duplicate_rejected'], externalNetwork: false }));
  } finally { await app.close(); await pool.end(); }
}

async function main() {
  if (mode === '--confirm-reviewed' && process.argv.length === 4) return confirmReviewed(process.argv[3]!);
  if (process.argv.length !== 3 || !['--fake', '--fake-pg', '--fake-pg-review', '--live'].includes(mode ?? '')) {
    console.log('Usage: node --import tsx scripts/verify-live-voice.ts --fake|--fake-pg|--fake-pg-review|--live|--confirm-reviewed <run-id>');
    process.exitCode = 1; return;
  }
  const live = mode === '--live';
  let env: Record<string, string | undefined> = {};
  if (live) {
    const file = join(root, '.local', 'clawops.env');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    env = parseEnv(await readFile(file, 'utf8'));
    for (const key of ['CLAWOPS_API_KEY', 'CLAWOPS_ACCOUNT_ID', 'CLAWOPS_AGENT_ID', 'CLAWOPS_FROM_NUMBER', 'CLAWOPS_TEST_TO']) assert.ok(env[key]);
    assert.match(env.CLAWOPS_TEST_TO!, /^\+82[1-9]\d{6,12}$/);
    assert.match(env.CLAWOPS_FROM_NUMBER!, /^\+82[1-9]\d{6,12}$/);
  }
  const credential = live ? { provider: 'clawops' as const, mode: 'agent' as const, accountId: env.CLAWOPS_ACCOUNT_ID!, apiKey: env.CLAWOPS_API_KEY!, agentId: env.CLAWOPS_AGENT_ID!, fromNumber: env.CLAWOPS_FROM_NUMBER! }
    : { provider: 'clawops' as const, mode: 'agent' as const, accountId: 'synthetic-account', apiKey: 'synthetic-key', agentId: 'synthetic-agent', fromNumber: '+827012345678' };
  const target = live ? env.CLAWOPS_TEST_TO! : '+821012345678';
  const callId = 'synthetic-call';
  const iso = () => new Date().toISOString();
  const runId = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `pikku_voice_${runId}`;
  let pool: pg.Pool | undefined;
  let store: PlanningStore;
  if (live || mode === '--fake-pg' || mode === '--fake-pg-review') {
    const db = await testDatabaseUrl();
    const admin = new pg.Pool({ connectionString: db });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    pool = new pg.Pool({ connectionString: db, options: `-c search_path=${schema}` });
    const postgres = new PostgresPlanningStore(pool); await postgres.migrate(); store = postgres;
  } else {
    const memory = new MemoryPlanningStore();
    store = { mode: memory.mode, durable: true, read: memory.read.bind(memory), transaction: memory.transaction.bind(memory),
      atomic: memory.atomic.bind(memory), transactionTimestamp: memory.transactionTimestamp.bind(memory), listUserIds: memory.listUserIds.bind(memory) };
  }
  const directory = await mkdtemp(join(tmpdir(), 'pikku-voice-credential-'));
  let callPosts = 0; let terminationPosts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.claw-ops.com');
    const method = init?.method ?? 'GET';
    const callRoot = `/v1/accounts/${encodeURIComponent(credential.accountId)}/calls`;
    if (url.pathname === callRoot && method === 'POST') {
      assert.equal(++callPosts, 1);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.AgentId, credential.agentId); assert.equal(body.Url, undefined);
      assert.equal(normalizePhoneNumber(body.To), target);
      assert.equal(normalizePhoneNumber(body.From), credential.fromNumber);
      if (live) {
        await mkdir(privateDir, { recursive: true, mode: 0o700 });
        assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
        const marker = await open(join(privateDir, 'one-live-call.marker'), 'wx', 0o600);
        try { await marker.writeFile(`${runId}\n`); await marker.sync(); } finally { await marker.close(); }
      }
      if (!live) return Response.json({ callId }, { status: 201 });
    } else if (method === 'POST') {
      const state = await store.read(actor);
      const matches = [...state.contactRequests.values()].filter(contact => contact.channel === 'phone' &&
        contact.deliveryStatus === 'sent_or_connected' && contact.providerOperationId &&
        url.pathname === `${callRoot}/${encodeURIComponent(contact.providerOperationId)}`);
      assert.equal(matches.length, 1);
      const contact = matches[0]!;
      assert.deepEqual(state.voiceSessions.get(managedCallBindingKey(contact.executionKey)), {
        contactId: contact.id, accountId: credential.accountId, agentId: credential.agentId, fromNumber: credential.fromNumber, mode: 'agent',
      });
      assert.deepEqual(JSON.parse(String(init?.body)), { Status: 'completed' });
      assert.equal(++terminationPosts, 1);
      if (!live) return Response.json({ status: 'completed' });
    } else if (method !== 'GET' || !/\/(numbers|agents\/[^/]+|calls\/[^/]+(?:\/live-events)?)$/.test(url.pathname)) {
      throw new Error('NETWORK_NOT_ALLOWED');
    }
    if (live) return fetch(url, init);
    if (url.pathname.endsWith('/numbers')) return Response.json({ data: [{ number: '07012345678' }] });
    if (url.pathname.endsWith('/agents/synthetic-agent')) return Response.json({ agentId: credential.agentId });
    if (url.pathname.endsWith('/live-events')) {
      const row = (id: string, event: string, detail: object = {}) => ({ id, event, timestamp: iso(), detail });
      return Response.json({ data: [row('1', 'stream.started'), row('2', 'transcript.final', { utteranceId: 'u1', role: 'user', text: '네, 그 시간에 가능해요.' }), row('3', 'stream.ended', { reason: 'completed' })], hasMore: false });
    }
    return Response.json({ callId, accountId: credential.accountId, from: credential.fromNumber, to: target, direction: 'outbound', status: 'completed', dateCreated: iso() });
  };
  const connections = new PhoneConnections({ directory, fetcher });
  const app = buildApp({ store, phoneConnections: connections, allowLocalPhoneConnect: true,
    sessions: { async resolve(token) { return token === 'synthetic-session' ? { userId: actor } : null; } } });
  const checks: string[] = [];
  const post = (path: string, payload: object, key: string) => app.inject({ method: 'POST', url: path,
    headers: { authorization: 'Bearer synthetic-session', 'idempotency-key': key }, payload });
  try {
    const connected = await post('/v1/phone-connection', { requestId: 'connect', ...credential }, 'connect');
    assert.equal(connected.statusCode, 200); checks.push('connection');
    const planning = new PlanningService(store), contacts = new ContactService(store, planning);
    const original: ScheduleFields = { kind: 'event', title: '가상 저녁 약속', timeSlot: { startsAt: '2026-11-02T17:00:00+09:00', endsAt: '2026-11-02T18:00:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };
    const item = (await planning.command(actor, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'seed', operation: 'create', after: original }] } })).items[0]!;
    const baseline = await planning.capture(actor, 'Asia/Seoul', { id: item.id, expectedRevision: item.revision });
    const proposal = await planning.saveProposal(baseline, { kind: 'proposal', reason: '가상 일정 변경', evidenceRefs: [], changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision,
      after: { ...original, timeSlot: { ...original.timeSlot!, startsAt: '2026-11-02T18:00:00+09:00', endsAt: '2026-11-02T19:00:00+09:00' } } }] } });
    assert.equal(proposal.kind, 'proposal'); if (proposal.kind !== 'proposal') throw Error('proposal');
    const recipient = (await contacts.createRecipient(actor, { displayName: '합성 상대', channel: 'phone', address: target, confirmed: true })).recipient;
    const contact = (await contacts.create(actor, { recipientRef: recipient.id, channel: 'phone', purpose: '삐꾸 연결 테스트',
      messageOrCallBrief: '삐꾸 연결 테스트임을 밝히고 가상 저녁 약속을 2026년 11월 2일 18시로 미룰 수 있는지 자연스럽게 문의하세요. 실제 일정은 변경하지 않습니다.',
      allowedOptions: [{ optionId, proposalId: proposal.proposalIds[0]!, proposalRevision: 1 }] })).contactRequest;
    await contacts.decide(actor, contact.id, { contactRevision: contact.revision, decision: 'accept' });
    const before = await store.read(actor);
    const sent = await post(`/v1/contact-requests/${contact.id}/call`, { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber }, 'call');
    assert.equal(sent.statusCode, 200); assert.equal(callPosts, 1); checks.push('single_call');
    const replay = await post(`/v1/contact-requests/${contact.id}/call`, { requestId: 'call', contactRevision: contact.revision, expectedSenderNumber: credential.fromNumber }, 'call');
    assert.equal(replay.statusCode, 200); assert.equal(callPosts, 1); checks.push('duplicate_call_not_sent');
    let review: any;
    for (let i = 0; i < (live ? 40 : 1); i++) {
      const checked = await post(`/v1/contact-requests/${contact.id}/check-call`, { requestId: `check-${i}`, contactRevision: contact.revision }, `check-${i}`);
      if (checked.statusCode === 200) { const data = checked.json().data; if (data.complete && !data.truncated && data.responses?.length === 1) { review = data.responses[0]; break; } }
      if (live) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    const after = await store.read(actor);
    assert.deepEqual(after.items.get(item.id), before.items.get(item.id)); assert.equal(after.scheduleRevision, before.scheduleRevision);
    checks.push('schedule_unchanged_before_review');
    if (!review) {
      if (!live) throw Error('FAKE_REVIEW_MISSING');
      console.log(JSON.stringify({ status: 'incomplete_review_skipped', runId, checks, callPosts, terminationPosts })); return;
    }
    assert.equal(review.outcome, 'unclear'); assert.equal(review.reviewReason, 'voice_transcript_unverified'); checks.push('completed_transcript_unclear');
    if (live || mode === '--fake-pg-review') {
      await mkdir(privateDir, { recursive: true, mode: 0o700 });
      const report = { runId, schema, contactId: contact.id, contactRevision: contact.revision, itemId: item.id, responseId: review.id, transcript: review.displayText };
      await writeFile(join(privateDir, `${runId}.json`), JSON.stringify(report), { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ status: 'human_review_required', runId, checks, callPosts, terminationPosts, privateReportSaved: true }));
    } else {
      const confirmed = await post(`/v1/contact-requests/${contact.id}/responses/${review.id}/confirm`, { requestId: 'confirm', contactRevision: contact.revision, selectedOptionId: optionId }, 'confirm');
      assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().data.changed, true);
      assert.equal((await store.read(actor)).items.get(item.id)?.timeSlot?.startsAt, '2026-11-02T18:00:00+09:00');
      const again = await post(`/v1/contact-requests/${contact.id}/responses/${review.id}/confirm`, { requestId: 'duplicate', contactRevision: contact.revision, selectedOptionId: optionId }, 'duplicate');
      assert.equal(again.statusCode, 409); checks.push('manual_confirmation_once');
      console.log(JSON.stringify({ status: 'passed', checks, callPosts, terminationPosts, externalNetwork: false }));
    }
  } finally { await app.close(); await pool?.end(); await rm(directory, { recursive: true, force: true }); }
}

void main().catch(() => { console.error('VOICE_VERIFICATION_FAILED'); process.exitCode = 1; });
