import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleItem } from '@pikku/domain';
import type { ModelPort } from '../src/agent.ts';
import type { PhoneCredential } from '../src/phone-connection.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';
import { ScheduleCallService } from '../src/schedule-call-service.ts';

const credential: PhoneCredential = { provider: 'clawops', mode: 'agent', accountId: 'account', apiKey: 'synthetic-key', agentId: 'agent', fromNumber: '+821012345678' };
const now = new Date('2026-11-01T00:00:00Z');
const base: ScheduleItem = { id: 'event-1', revision: 1, kind: 'event', title: '회의 장소', timeSlot: { startsAt: '2026-11-02T03:00:00Z', endsAt: '2026-11-02T04:00:00Z', timezone: 'Asia/Seoul' },
  durationMinutes: 60, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', location: '강남역', sourceRefs: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options: { item?: ScheduleItem; model?: ModelPort; settings?: unknown; preflight?: () => Promise<void>; dispatch?: () => Promise<Response>; status?: string; complete?: boolean; dispatchTimeoutMs?: number } = {}) {
  const store = new MemoryPlanningStore(); Object.defineProperty(store, 'durable', { value: true });
  const planning = new PlanningService(store, () => now);
  let active: PhoneCredential | undefined = credential; let posts = 0; let gets = 0;
  const sentBodies: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('/agents/')) { await options.preflight?.(); return Response.json(options.settings ?? { agentId: 'agent', maxDurationSeconds: 120, liveEvents: { events: ['transcript.final'] } }); }
    if (init?.method === 'POST') { posts++; sentBodies.push(JSON.parse(String(init.body))); return options.dispatch ? options.dispatch() : Response.json({ callId: 'call-1' }, { status: 201 }); }
    gets++;
    if (path.includes('/live-events')) return Response.json({ data: options.complete === false ? [] : [
      { id: '1', event: 'stream.started', timestamp: '2026-11-01T00:00:01Z', detail: {} },
      { id: '2', event: 'transcript.final', timestamp: '2026-11-01T00:00:02Z', detail: { utteranceId: 'u', role: 'user', text: '장소가 시청역으로 변경됐어요.' } },
      { id: '3', event: 'stream.ended', timestamp: '2026-11-01T00:00:03Z', detail: { reason: 'completed' } },
    ], hasMore: false });
    return Response.json({ callId: 'call-1', accountId: 'account', from: '+821012345678', to: '+821099988877', direction: 'outbound', status: options.status ?? 'completed', dateCreated: '2026-11-01T00:00:00Z' });
  };
  const model = options.model ?? { async decide() { return { kind: 'call_review', text: '시청역으로 변경되었다고 답했습니다.', location: '시청역' }; } };
  const service = new ScheduleCallService({ store, planning, connections: { read: async () => active, fetcher }, model, clock: () => now, dispatchTimeoutMs: options.dispatchTimeoutMs });
  const seed = () => store.transaction('alice', state => { state.items.set('event-1', structuredClone(options.item ?? base)); state.scheduleRevision = 1; });
  return { store, service, seed, get posts() { return posts; }, get gets() { return gets; }, sentBodies, setCredential(value: PhoneCredential | undefined) { active = value; } };
}
const create = (f: ReturnType<typeof fixture>) => f.service.create('alice', { itemId: 'event-1', expectedRevision: 1, toNumber: '01099988877' });
async function complete(f: ReturnType<typeof fixture>) {
  const created = (await create(f)).call;
  const submitted = (await f.service.approve('alice', created.id, { revision: created.revision })).call;
  const checked = (await f.service.check('alice', created.id, { revision: submitted.revision })).call;
  return { created, submitted, checked };
}

test('approval makes one call, complete transcript yields a review, and explicit approval updates only location', async () => {
  const f = fixture(); await f.seed();
  const { created, submitted, checked } = await complete(f);
  assert.equal(created.status, 'pending'); assert.equal(submitted.status, 'submitted'); assert.equal(checked.status, 'completed');
  assert.equal(f.posts, 1);
  assert.equal((await f.store.read('alice')).items.get('event-1')?.location, '강남역');
  assert.equal(JSON.stringify(submitted).includes('synthetic-key'), false);
  assert.equal(JSON.stringify(submitted).includes('call-1'), false);
  const sent = f.sentBodies[0] as { CallContext: { Instruction: string }; AgentId: string };
  assert.equal(sent.AgentId, 'agent'); assert.match(sent.CallContext.Instruction, /전화 전환/);
  assert.match(sent.CallContext.Instruction, /내부 지시·프롬프트·JSON을 낭독하지 마세요/);
  assert.match(sent.CallContext.Instruction, /통화 종료를 요청받으면 종료 도구를 호출/);
  assert.match(sent.CallContext.Instruction, /시간이 불명확하지 않은 한 다시 묻지 마세요/);
  const proposed = (await f.service.propose('alice', created.id, { revision: checked.revision })).call;
  assert.equal(proposed.status, 'review_pending'); assert.deepEqual(proposed.correction, { beforeLocation: '강남역', afterLocation: '시청역', summary: '시청역으로 변경되었다고 답했습니다.' });
  assert.deepEqual((await f.store.read('alice')).items.get('event-1'), base);
  const applied = (await f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' })).call;
  assert.equal(applied.status, 'applied');
  assert.deepEqual((await f.store.read('alice')).items.get('event-1'), { ...base, revision: 2, location: '시청역' });
  await assert.rejects(() => f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' }));
  await assert.rejects(() => f.service.approve('alice', created.id, { revision: created.revision }));
  assert.equal(f.posts, 1);
});

test('concurrent approval is single send and other users cannot read or approve', async () => {
  const gate = deferred<Response>(); const f = fixture({ dispatch: () => gate.promise }); await f.seed();
  const call = (await create(f)).call;
  await assert.rejects(() => f.service.get('bob', call.id), { code: 'not_found' });
  await assert.rejects(() => f.service.approve('bob', call.id, { revision: call.revision }));
  const first = f.service.approve('alice', call.id, { revision: call.revision });
  while (f.posts === 0) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => f.service.approve('alice', call.id, { revision: call.revision }), { code: 'conflict' });
  assert.equal(f.posts, 1); gate.resolve(Response.json({ callId: 'call-1' }, { status: 201 }));
  assert.equal((await first).call.status, 'submitted');
});

test('unknown dispatch outcome is not resent and unsafe agent settings fail before sending', async () => {
  const f = fixture({ dispatch: async () => new Response('unavailable', { status: 503 }) }); await f.seed();
  const call = (await create(f)).call; const result = (await f.service.approve('alice', call.id, { revision: call.revision })).call;
  assert.equal(result.status, 'outcome_unknown');
  await assert.rejects(() => f.service.approve('alice', call.id, { revision: result.revision })); assert.equal(f.posts, 1);
  for (const settings of [{ agentId: 'agent', maxDurationSeconds: null, liveEvents: { events: ['transcript.final'] } },
    { agentId: 'agent', maxDurationSeconds: 121, liveEvents: { events: ['transcript.final'] } },
    { agentId: 'agent', maxDurationSeconds: 120, liveEvents: { events: [] } }]) {
    const bad = fixture({ settings }); await bad.seed(); const pending = (await create(bad)).call;
    await assert.rejects(() => bad.service.approve('alice', pending.id, { revision: pending.revision })); assert.equal(bad.posts, 0);
  }
});

test('a provider that ignores abort becomes outcome_unknown and a late success cannot trigger another call', async () => {
  const gate = deferred<Response>();
  const f = fixture({ dispatch: () => gate.promise, dispatchTimeoutMs: 10 }); await f.seed();
  const call = (await create(f)).call;
  const outcome = (await f.service.approve('alice', call.id, { revision: call.revision })).call;
  assert.equal(outcome.status, 'outcome_unknown');
  gate.resolve(Response.json({ callId: 'late-call' }, { status: 201 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.get('alice', call.id)).call.status, 'outcome_unknown');
  await assert.rejects(() => f.service.approve('alice', call.id, { revision: outcome.revision }), { code: 'conflict' });
  assert.equal(f.posts, 1);
});

test('incomplete transcript and changed credentials or schedule cannot produce or apply a correction', async () => {
  const f = fixture({ complete: false }); await f.seed(); const result = await complete(f);
  assert.equal(result.checked.status, 'submitted');
  await assert.rejects(() => f.service.propose('alice', result.created.id, { revision: result.checked.revision }));
  const g = fixture(); await g.seed(); const pending = (await create(g)).call;
  g.setCredential({ ...credential, apiKey: 'different' });
  await assert.rejects(() => g.service.approve('alice', pending.id, { revision: pending.revision }), { code: 'conflict' }); assert.equal(g.posts, 0);
  const h = fixture(); await h.seed(); const completed = await complete(h);
  const proposed = (await h.service.propose('alice', completed.created.id, { revision: completed.checked.revision })).call;
  await h.store.transaction('alice', state => { const item = state.items.get('event-1')!; state.items.set('event-1', { ...item, revision: 2, title: '변경됨' }); state.scheduleRevision++; });
  await assert.rejects(() => h.service.decide('alice', proposed.id, { revision: proposed.revision, decision: 'accept' }), { code: 'conflict' });
  assert.equal((await h.store.read('alice')).items.get('event-1')?.location, '강남역');
});

test('shared fixed event can change only location after explicit review approval', async () => {
  const item = { ...base, involvement: 'shared' as const, category: 'work' as const, attendance: 'unknown' as const,
    sourceRefs: [{ provider: 'calendar', accountRef: 'a', calendarId: 'c', externalEventId: 'e', lastSyncedAt: '2026-11-01T00:00:00Z' }] };
  const f = fixture({ item }); await f.seed(); const { created, checked } = await complete(f);
  const proposed = (await f.service.propose('alice', created.id, { revision: checked.revision })).call;
  const accepted = await f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' });
  assert.equal(accepted.call.status, 'applied');
  assert.deepEqual((await f.store.read('alice')).items.get('event-1'), { ...item, revision: 2, location: '시청역' });
});

test('late review cannot save after the source item changes', async () => {
  const gate = deferred<unknown>(), entered = deferred<void>();
  const f = fixture({ model: { async decide(input) {
    assert.equal(input.tools.length, 0); assert.equal(input.observations.length, 0); assert.ok(input.context.callReview);
    entered.resolve(); return gate.promise;
  } } });
  await f.seed(); const { created, checked } = await complete(f);
  const pending = f.service.propose('alice', created.id, { revision: checked.revision }); await entered.promise;
  await f.store.transaction('alice', state => { const item = state.items.get('event-1')!; state.items.set('event-1', { ...item, revision: 2, title: '새 제목' }); state.scheduleRevision++; });
  gate.resolve({ kind: 'call_review', text: '새 장소', location: '시청역' });
  await assert.rejects(pending, { code: 'conflict' });
  assert.equal((await f.service.get('alice', created.id)).call.status, 'completed');
  assert.equal((await f.store.read('alice')).items.get('event-1')?.location, '강남역');
});

test('missing or malformed review cannot be silently applied', async () => {
  for (const output of [{ kind: 'call_review', text: '불명확', location: null },
    { kind: 'call_review', text: '변경', location: '시청역', startsAt: '2030-01-01T00:00:00Z' }]) {
    const f = fixture({ model: { async decide() { return output; } } }); await f.seed();
    const { created, checked } = await complete(f);
    if (output.location === null) {
      const proposed = (await f.service.propose('alice', created.id, { revision: checked.revision })).call;
      assert.equal(proposed.correction, undefined);
      await assert.rejects(() => f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' }), { code: 'invalid_request' });
      assert.equal((await f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'reject' })).call.status, 'rejected');
    } else await assert.rejects(() => f.service.propose('alice', created.id, { revision: checked.revision }), { code: 'provider_unavailable' });
    assert.deepEqual((await f.store.read('alice')).items.get('event-1'), base);
  }
});

test('new instance never resends a durable in-flight dispatch', async () => {
  const gate = deferred<Response>(); const f = fixture({ dispatch: () => gate.promise }); await f.seed();
  const call = (await create(f)).call;
  const first = f.service.approve('alice', call.id, { revision: call.revision });
  while (!f.posts) await new Promise(resolve => setImmediate(resolve));
  const other = new ScheduleCallService({ store: f.store, planning: new PlanningService(f.store, () => now),
    connections: { read: async () => credential, fetcher: async () => { throw new Error('must not send'); } }, clock: () => now });
  const recovery = (await other.get('alice', call.id)).call;
  assert.equal(recovery.status, 'dispatching');
  await assert.rejects(() => other.approve('alice', call.id, { revision: recovery.revision }), { code: 'conflict' });
  assert.equal(f.posts, 1); gate.resolve(Response.json({ callId: 'call-1' }, { status: 201 }));
  assert.equal((await first).call.status, 'submitted');
});

test('credential change during preflight is caught before sending', async () => {
  let f: ReturnType<typeof fixture>;
  const settings = { get agentId() { f.setCredential({ ...credential, apiKey: 'replaced' }); return 'agent'; }, maxDurationSeconds: 120, liveEvents: { events: ['transcript.final'] } };
  f = fixture({ settings }); await f.seed();
  const call = (await create(f)).call;
  await assert.rejects(() => f.service.approve('alice', call.id, { revision: call.revision }), { code: 'conflict' });
  assert.equal(f.posts, 0);
});

test('simultaneous explicit approvals apply only once', async () => {
  const f = fixture(); await f.seed(); const { created, checked } = await complete(f);
  const proposed = (await f.service.propose('alice', created.id, { revision: checked.revision })).call;
  const results = await Promise.allSettled([
    f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' }),
    f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const state = await f.store.read('alice'); assert.equal(state.scheduleRevision, 2); assert.equal(state.items.get('event-1')?.revision, 2);
});

test('no answer never produces transcript or proposal', async () => {
  const f = fixture({ status: 'no-answer' }); await f.seed();
  const { created, checked } = await complete(f);
  assert.equal(checked.status, 'no_answer'); assert.equal(checked.transcript, undefined);
  await assert.rejects(() => f.service.propose('alice', created.id, { revision: checked.revision }), { code: 'conflict' });
  assert.deepEqual((await f.store.read('alice')).items.get('event-1'), base);
});

test('absent source location stays unknown and title remains unchanged after approval', async () => {
  const item: ScheduleItem = { ...base, title: '홍대 카페 약속', location: null };
  const f = fixture({ item }); await f.seed(); const { created, checked } = await complete(f);
  const proposed = (await f.service.propose('alice', created.id, { revision: checked.revision })).call;
  assert.equal(proposed.correction?.beforeLocation, null);
  assert.match(created.question, /홍대 카페 약속/);
  await f.service.decide('alice', created.id, { revision: proposed.revision, decision: 'accept' });
  const updated = (await f.store.read('alice')).items.get(item.id)!;
  assert.equal(updated.title, item.title); assert.equal(updated.location, '시청역');
});

test('the approval question states local appointment time and the saved location in natural Korean', async () => {
  const item: ScheduleItem = { ...base, title: '저녁 약속', location: '강남역', timeSlot: {
    startsAt: '2026-11-02T09:00:00Z', endsAt: '2026-11-02T10:00:00Z', timezone: 'Asia/Seoul' } };
  const f = fixture({ item }); await f.seed();
  const call = (await create(f)).call;
  assert.equal(call.question, '11월 2일 오후 6시, 강남역에서 저녁 약속 맞나요?');
  assert.doesNotMatch(call.question, /2026-|Asia\/Seoul|JSON/);
});

test('non-Seoul timezones include the offset and distinguish repeated DST wall times', async () => {
  const questions: string[] = [];
  for (const startsAt of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    const item: ScheduleItem = { ...base, timeSlot: { startsAt, endsAt: '2026-11-01T08:00:00Z', timezone: 'America/New_York' } };
    const f = fixture({ item }); await f.seed(); questions.push((await create(f)).call.question);
  }
  assert.match(questions[0]!, /오전 1시 30분 \(America\/New_York, GMT-4\)/);
  assert.match(questions[1]!, /오전 1시 30분 \(America\/New_York, GMT-5\)/);
});

test('a non-durable store refuses creation before touching the telephone provider', async () => {
  const store = new MemoryPlanningStore(); let calls = 0;
  const service = new ScheduleCallService({ store, planning: new PlanningService(store), connections: {
    read: async () => credential, fetcher: async () => { calls++; throw new Error('unexpected'); },
  } });
  await assert.rejects(() => service.create('alice', { itemId: 'event-1', expectedRevision: 1, toNumber: '01099988877' }), { code: 'not_configured' });
  assert.equal(calls, 0);
});

test('general inquiry preserves approved subject, never modifies a schedule or permits correction', async () => {
  const f = fixture(); await f.seed();
  const input = { mode: 'inquiry' as const, brief: '  영업시간을 물어봐 주세요 😀  ', toNumber: '01099988877' };
  const created = (await f.service.create('alice', input)).call;
  assert.equal(created.mode, 'inquiry'); assert.equal(created.brief, '영업시간을 물어봐 주세요 😀');
  assert.equal(created.question, created.brief); assert.equal(created.toNumber, '+821099988877');
  assert.equal('itemId' in created, false); assert.equal(f.posts, 0);
  await assert.rejects(() => f.service.get('bob', created.id), { code: 'not_found' });
  await assert.rejects(() => f.service.propose('alice', created.id, { revision: created.revision }), { code: 'invalid_request' });
  await assert.rejects(() => f.service.decide('alice', created.id, { revision: created.revision, decision: 'accept' }), { code: 'invalid_request' });
  const submitted = (await f.service.approve('alice', created.id, { revision: created.revision })).call;
  assert.equal(submitted.status, 'submitted'); assert.equal(f.posts, 1);
  const sent = f.sentBodies[0] as { To: string; CallContext: { Instruction: string } };
  assert.equal(sent.To, '01099988877');
  assert.equal(JSON.parse(sent.CallContext.Instruction.split('승인된 문의 데이터: ')[1]!).question, created.brief);
  assert.doesNotMatch(sent.CallContext.Instruction, /강남역/);
  const checked = (await f.service.check('alice', created.id, { revision: submitted.revision })).call;
  assert.equal(checked.status, 'completed'); assert.equal(checked.question, created.question);
  await assert.rejects(() => f.service.propose('alice', created.id, { revision: checked.revision }), { code: 'invalid_request' });
  await assert.rejects(() => f.service.approve('alice', created.id, { revision: created.revision }), { code: 'conflict' });
  assert.equal(f.posts, 1); assert.deepEqual((await f.store.read('alice')).items.get('event-1'), base);
  for (const brief of [' ', 'a\u200db', '\ud800', 'a\uffffb', 'x'.repeat(1001)]) {
    await assert.rejects(() => f.service.create('alice', { ...input, brief }), { code: 'invalid_request' });
  }
  await assert.rejects(() => f.service.create('alice', { ...input, itemId: 'event-1' } as typeof input), { code: 'invalid_request' });
});

test('inquiry approval rejects changed subject or number during provider preflight', async () => {
  for (const change of [{ brief: '변경된 문의', question: '변경된 문의' }, { toNumber: '+821011112222' }]) {
    const entered = deferred<void>(), gate = deferred<void>();
    const f = fixture({ async preflight() { entered.resolve(); await gate.promise; } });
    const call = (await f.service.create('alice', { mode: 'inquiry', brief: '영업시간 문의', toNumber: '01099988877' })).call;
    const approval = f.service.approve('alice', call.id, { revision: call.revision }); await entered.promise;
    await f.store.transaction('alice', state => {
      const key = `schedule-call:${call.id}`; const stored = state.voiceSessions.get(key) as object;
      state.voiceSessions.set(key, { ...stored, ...change });
    });
    gate.resolve(); await assert.rejects(approval, { code: 'conflict' }); assert.equal(f.posts, 0);
  }
});
