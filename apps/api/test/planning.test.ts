import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeSet, ScheduleFields, ScheduleItem } from '@pikku/domain';
import type { ModelPort, Observation } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const fixedNow = '2026-10-31T12:00:00.000Z';
const from = '2026-11-02T00:00+09:00'; const to = '2026-11-03T00:00+09:00';
const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timezone=Asia%2FSeoul`;
const auth = (user = 'alice', key = 'key') => ({ authorization: `Bearer ${user}`, 'idempotency-key': key });
const chat = (requestId = 'chat') => ({ requestId, conversationId: null, message: '계획을 검토해 줘', timezone: 'Asia/Seoul' });
const event: ScheduleFields = { kind: 'event', title: '고정 공동 약속', timeSlot: { startsAt: '2026-11-02T15:00+09:00', endsAt: '2026-11-02T16:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'shared', completion: 'pending' };
const task: ScheduleFields = { kind: 'task', title: '공부', timeSlot: { startsAt: '2026-11-02T09:00+09:00', endsAt: '2026-11-02T10:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: 60, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
function moved(item: ScheduleItem, start = '2026-11-02T11:00+09:00', end = '2026-11-02T12:00+09:00'): ScheduleFields {
  return { kind: item.kind, title: item.title, timeSlot: { startsAt: start, endsAt: end, timezone: 'Asia/Seoul' }, durationMinutes: item.durationMinutes,
    deadline: item.deadline, flexibility: item.flexibility, involvement: item.involvement, completion: item.completion };
}
function update(item: ScheduleItem, after: ScheduleFields): ChangeSet {
  return { changes: [{ changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision, after }] };
}
async function post(app: ReturnType<typeof buildApp>, url: string, payload: object, key: string, user = 'alice') {
  return app.inject({ method: 'POST', url, headers: auth(user, key), payload });
}
async function get(app: ReturnType<typeof buildApp>, url: string, user = 'alice') {
  return app.inject({ method: 'GET', url, headers: auth(user) });
}
async function seed(app: ReturnType<typeof buildApp>) {
  const response = await post(app, '/v1/schedule/commands', { requestId: 'seed', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'event', operation: 'create', after: event }, { changeId: 'task', operation: 'create', after: task },
  ] } }, 'seed');
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().data.items as ScheduleItem[];
  return { event: items.find(item => item.kind === 'event')!, task: items.find(item => item.kind === 'task')! };
}
function resultOf(observations: Observation[], name: string): any {
  return observations.find(observation => observation.name === name)?.result;
}

test('manual schedule, read tools, saved proposal, acceptance, replay and isolation work end to end', async t => {
  let finalObservations: Observation[] = [];
  const model: ModelPort = { async decide(input) {
    const count = input.observations.length;
    if (count === 0) return { kind: 'tool_call', name: 'read_schedule', input: { from, to, timezone: 'Asia/Seoul' } };
    if (count === 1) return { kind: 'tool_call', name: 'read_memory', input: { keys: ['study'], at: input.context.now } };
    if (count === 2) return { kind: 'tool_call', name: 'calculate_timing', input: { appointmentStart: '2026-11-02T15:00+09:00', preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 } };
    const item = (resultOf(input.observations, 'read_schedule').items as ScheduleItem[]).find(value => value.kind === 'task')!;
    const changeSet = update(item, moved(item));
    if (count === 3) return { kind: 'tool_call', name: 'validate_changes', input: { changeSet } };
    finalObservations = input.observations;
    return { kind: 'proposal', reason: '공부 시간을 조정합니다.', changeSet, evidenceRefs: [] };
  } };
  const store = new MemoryPlanningStore();
  const app = buildApp({ sessions, model, store, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const seeded = await seed(app);
  const memory = await post(app, '/v1/memory', { requestId: 'm1', expectedContextRevision: 0, kind: 'preference', key: 'study', value: '오전', validUntil: null }, 'm1');
  assert.equal(memory.statusCode, 200, memory.body);
  assert.equal(memory.json().data.contextRevision, 1);
  const ai = await post(app, '/v1/chat', chat(), 'chat-1');
  assert.equal(ai.statusCode, 200, ai.body);
  assert.equal(ai.json().data.result.kind, 'proposal');
  const proposalId = ai.json().data.result.proposalIds[0];
  assert.equal(resultOf(finalObservations, 'read_schedule').scheduleRevision, 1);
  assert.equal(resultOf(finalObservations, 'read_memory').facts[0].value, '오전');
  assert.deepEqual(resultOf(finalObservations, 'calculate_timing'), { ready: true, departureAt: '2026-11-02T05:20:00.000Z', preparationStartAt: '2026-11-02T05:05:00.000Z' });
  assert.equal(resultOf(finalObservations, 'validate_changes').valid, true);
  const before = await get(app, `/v1/schedule?${range}`);
  assert.equal(before.json().data.items.find((item: ScheduleItem) => item.id === seeded.task.id).timeSlot.startsAt, task.timeSlot!.startsAt);
  const list = await get(app, '/v1/proposals?status=pending&limit=1');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.proposals[0].id, proposalId);
  const proposal = (await get(app, `/v1/proposals/${proposalId}`)).json().data.proposal;
  assert.equal(proposal.baseScheduleRevision, 1);
  assert.equal(proposal.baseContextRevision, 1);
  assert.equal(proposal.coordinationTarget, null);
  assert.equal(proposal.expiresAt, '2026-10-31T12:30:00.000Z');
  const accepted = await post(app, `/v1/proposals/${proposalId}/decision`, { requestId: 'accept', proposalRevision: 1, decision: 'accept' }, 'accept-key');
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().data.outcome, 'applied');
  assert.equal(accepted.json().data.scheduleRevision, 2);
  const replay = await post(app, `/v1/proposals/${proposalId}/decision`, { requestId: 'retry', proposalRevision: 1, decision: 'accept' }, 'accept-key');
  assert.deepEqual(replay.json(), accepted.json());
  const changedKeyBody = await post(app, `/v1/proposals/${proposalId}/decision`, { requestId: 'retry', proposalRevision: 1, decision: 'reject' }, 'accept-key');
  assert.equal(changedKeyBody.statusCode, 409);
  assert.equal(changedKeyBody.json().error.code, 'idempotency_conflict');
  const invalidChangedBody = await post(app, `/v1/proposals/${proposalId}/decision`, { requestId: 'retry', proposalRevision: 1, decision: 'invalid' }, 'accept-key');
  assert.equal(invalidChangedBody.json().error.code, 'idempotency_conflict');
  const stale = await post(app, `/v1/proposals/${proposalId}/decision`, { requestId: 'again', proposalRevision: 1, decision: 'accept' }, 'other');
  assert.equal(stale.json().error.code, 'stale_proposal');
  const after = await get(app, `/v1/schedule?${range}`);
  assert.equal(after.json().data.items.find((item: ScheduleItem) => item.id === seeded.task.id).timeSlot.startsAt, '2026-11-02T11:00+09:00');
  assert.equal((await store.read('alice')).approvals[0].subject.status, 'pending');
  assert.equal((await get(app, `/v1/proposals/${proposalId}`, 'bob')).statusCode, 404);
  assert.deepEqual((await get(app, `/v1/schedule?${range}`, 'bob')).json().data, { items: [], scheduleRevision: 0 });
  const collision = await post(app, '/v1/schedule/commands', { requestId: 'collision', expectedScheduleRevision: 2, changeSet: { changes: [{ changeId: 'c', operation: 'create', after: { ...task, timeSlot: { ...task.timeSlot!, startsAt: '2026-11-02T11:30+09:00', endsAt: '2026-11-02T12:30+09:00' } } }] } }, 'collision');
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error.code, 'conflict');
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.scheduleRevision, 2);
});

test('context changes, expiration and rejection never apply a proposal', async t => {
  let now = fixedNow;
  const store = new MemoryPlanningStore();
  const model: ModelPort = { async decide() { return { kind: 'proposal', reason: '공부 제안', changeSet: { changes: [{ changeId: 'new', operation: 'create', after: task }] }, evidenceRefs: [] }; } };
  const app = buildApp({ sessions, model, store, clock: () => new Date(now) }); t.after(() => app.close());
  const propose = async (key: string) => {
    const response = await post(app, '/v1/chat', chat(key), key);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.result.kind, 'proposal');
    return response.json().data.result.proposalIds[0] as string;
  };
  const staleId = await propose('p1');
  assert.equal((await post(app, '/v1/memory', { requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'mood', value: 'rest', validUntil: null }, 'memory')).statusCode, 200);
  const stale = await post(app, `/v1/proposals/${staleId}/decision`, { requestId: 's', proposalRevision: 1, decision: 'accept' }, 's');
  assert.equal(stale.json().error.code, 'stale_proposal');
  assert.equal((await get(app, `/v1/proposals/${staleId}`)).json().data.proposal.status, 'stale');
  const rejectedId = await propose('p2');
  const rejected = await post(app, `/v1/proposals/${rejectedId}/decision`, { requestId: 'r', proposalRevision: 1, decision: 'reject' }, 'r');
  assert.equal(rejected.json().data.outcome, 'rejected');
  assert.equal(rejected.json().data.scheduleRevision, 0);
  const situation = await post(app, '/v1/memory', { requestId: 'situation', expectedContextRevision: 1, kind: 'situation', key: 'temporary', value: true, validUntil: '2026-10-31T12:10:00Z' }, 'situation');
  assert.equal(situation.statusCode, 200);
  const expiredFactId = await propose('p3');
  assert.equal((await get(app, `/v1/proposals/${expiredFactId}`)).json().data.proposal.expiresAt, '2026-10-31T12:10:00Z');
  now = '2026-10-31T12:11:00.000Z';
  const expiredFact = await post(app, `/v1/proposals/${expiredFactId}/decision`, { requestId: 'sf', proposalRevision: 1, decision: 'accept' }, 'sf');
  assert.equal(expiredFact.json().error.code, 'expired_proposal');
  assert.equal((await get(app, `/v1/memory?at=${encodeURIComponent(now)}`)).json().data.facts.length, 1);
  const expiredId = await propose('p4');
  await store.transaction('alice', state => { state.proposals.get(expiredId)!.expiresAt = '2026-10-31T12:00:00Z'; });
  const expired = await post(app, `/v1/proposals/${expiredId}/decision`, { requestId: 'e', proposalRevision: 1, decision: 'accept' }, 'e');
  assert.equal(expired.json().error.code, 'expired_proposal');
  assert.equal((await get(app, `/v1/proposals/${expiredId}`)).json().data.proposal.status, 'expired');
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.scheduleRevision, 0);
  const changedScheduleId = await propose('p5');
  const manual = await post(app, '/v1/schedule/commands', { requestId: 'manual', expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'event', operation: 'create', after: event }] } }, 'manual');
  assert.equal(manual.statusCode, 200);
  const changedSchedule = await post(app, `/v1/proposals/${changedScheduleId}/decision`, { requestId: 'ss', proposalRevision: 1, decision: 'accept' }, 'ss');
  assert.equal(changedSchedule.json().error.code, 'stale_proposal');
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.items.length, 1);
});

test('fixed shared coordination requires a verified selection and approval leaves the event unchanged', async t => {
  let shared!: ScheduleItem; let flexible!: ScheduleItem; let modelCalls = 0;
  const model: ModelPort = { async decide(input) {
    modelCalls++;
    const outside = input.message === '선택 밖';
    const target = outside ? flexible : shared;
    return { kind: 'proposal', reason: '조정 검토', changeSet: update(target, moved(target, '2026-11-02T17:00+09:00', '2026-11-02T18:00+09:00')), evidenceRefs: [] };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const seeded = await seed(app); shared = seeded.event; flexible = seeded.task;
  for (const after of [{ ...event, involvement: 'personal' as const }, moved(shared, '2026-11-02T17:00+09:00', '2026-11-02T18:00+09:00')]) {
    const direct = await post(app, '/v1/schedule/commands', { requestId: `direct-${after.involvement}`, expectedScheduleRevision: 1, changeSet: update(shared, after) }, `direct-${after.involvement}`);
    assert.equal(direct.json().error.code, 'contact_required');
  }
  const foreign = await post(app, '/v1/chat', { ...chat(), coordinationTarget: { id: shared.id, expectedRevision: 1 } }, 'foreign', 'bob');
  assert.equal(foreign.statusCode, 404);
  const wrongRevision = await post(app, '/v1/chat', { ...chat(), coordinationTarget: { id: shared.id, expectedRevision: 2 } }, 'wrong');
  assert.equal(wrongRevision.statusCode, 409);
  assert.equal(modelCalls, 0);
  const noSelection = await post(app, '/v1/chat', chat('unselected'), 'unselected');
  assert.equal(noSelection.json().data.result.kind, 'failure');
  const outside = await post(app, '/v1/chat', { ...chat('outside'), message: '선택 밖', coordinationTarget: { id: shared.id, expectedRevision: 1 } }, 'outside');
  assert.equal(outside.json().data.result.kind, 'failure');
  const selected = await post(app, '/v1/chat', { ...chat('selected'), coordinationTarget: { id: shared.id, expectedRevision: 1 } }, 'selected');
  assert.equal(selected.json().data.result.kind, 'proposal', selected.body);
  const id = selected.json().data.result.proposalIds[0];
  assert.deepEqual((await get(app, `/v1/proposals/${id}`)).json().data.proposal.coordinationTarget, { id: shared.id, expectedRevision: 1 });
  const decision = await post(app, `/v1/proposals/${id}/decision`, { requestId: 'coord', proposalRevision: 1, decision: 'accept' }, 'coord');
  assert.equal(decision.json().data.outcome, 'awaiting_contact');
  assert.equal(decision.json().data.scheduleRevision, 1);
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.items.find((item: ScheduleItem) => item.id === shared.id).timeSlot.startsAt, event.timeSlot!.startsAt);
  const checked = await post(app, `/v1/schedule/${shared.id}/checkin`, { requestId: 'check', expectedRevision: 1, completion: 'completed' }, 'check');
  assert.equal(checked.statusCode, 200);
  const completed = await post(app, '/v1/chat', { ...chat(), coordinationTarget: { id: shared.id, expectedRevision: 2 } }, 'completed');
  assert.equal(completed.statusCode, 409);
});

test('a change during the model wait makes validation and proposal storage stale', async t => {
  let start!: () => void; let release!: () => void; let staleObservation: any;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const changes: ChangeSet = { changes: [{ changeId: 'new', operation: 'create', after: task }] };
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: { from, to, timezone: 'Asia/Seoul' } };
    if (input.observations.length === 1) { start(); await gate; return { kind: 'tool_call', name: 'validate_changes', input: { changeSet: changes } }; }
    staleObservation = resultOf(input.observations, 'validate_changes');
    return { kind: 'proposal', reason: '제안', changeSet: changes, evidenceRefs: [] };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const pending = post(app, '/v1/chat', chat(), 'waiting'); await started;
  const memory = await post(app, '/v1/memory', { requestId: 'm', expectedContextRevision: 0, kind: 'preference', key: 'change', value: true, validUntil: null }, 'memory');
  assert.equal(memory.statusCode, 200);
  release();
  const response = await pending;
  assert.equal(response.json().data.result.kind, 'failure');
  assert.equal(response.json().data.result.code, 'stale_proposal');
  assert.equal(staleObservation.valid, false);
  assert.equal(staleObservation.conflicts[0].reason, 'stale_snapshot');
  assert.deepEqual((await get(app, '/v1/proposals')).json().data.proposals, []);
});

test('concurrent revisions serialize, manual checkin works without a model, and query validation is strict', async t => {
  const app = buildApp({ sessions, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const makeCommand = (id: string) => ({ requestId: id, expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: id, operation: 'create', after: task }] } });
  const [a, b] = await Promise.all([post(app, '/v1/schedule/commands', makeCommand('a'), 'a'), post(app, '/v1/schedule/commands', makeCommand('b'), 'b')]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const winner = a.statusCode === 200 ? a : b; const winnerKey = a.statusCode === 200 ? 'a' : 'b';
  const replay = await post(app, '/v1/schedule/commands', { ...makeCommand(winnerKey), requestId: 'retry' }, winnerKey);
  assert.deepEqual(replay.json(), winner.json());
  const id = winner.json().data.items[0].id;
  const checked = await post(app, `/v1/schedule/${id}/checkin`, { requestId: 'c', expectedRevision: 1, completion: 'incomplete' }, 'c');
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.json().data.scheduleRevision, 2);
  assert.equal(checked.json().data.item.timeSlot.startsAt, task.timeSlot!.startsAt);
  assert.equal((await post(app, `/v1/schedule/${id}/checkin`, { requestId: 'x', expectedRevision: 1, completion: 'completed' }, 'x')).statusCode, 409);
  assert.equal((await post(app, `/v1/schedule/${id}/checkin`, { requestId: 'x', expectedRevision: 1, completion: 'completed' }, 'x', 'bob')).statusCode, 404);
  assert.equal((await get(app, '/v1/schedule?from=bad&to=bad&timezone=UTC')).statusCode, 400);
  assert.equal((await post(app, '/v1/chat', chat(), 'chat')).statusCode, 503);
});

test('memory revisions and unscheduled, half-open schedule queries obey the v1 contract', async t => {
  const app = buildApp({ sessions, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const unscheduled = { ...task, title: '미배치', timeSlot: null };
  const command = await post(app, '/v1/schedule/commands', { requestId: 'create', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'scheduled', operation: 'create', after: task }, { changeId: 'unscheduled', operation: 'create', after: unscheduled },
  ] } }, 'create');
  assert.equal(command.statusCode, 200, command.body);
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.items.length, 1);
  assert.equal((await get(app, `/v1/schedule?${range}&includeUnscheduled=true`)).json().data.items.length, 2);
  const edgeRange = `from=${encodeURIComponent('2026-11-02T10:00+09:00')}&to=${encodeURIComponent('2026-11-02T11:00+09:00')}&timezone=Asia%2FSeoul`;
  assert.equal((await get(app, `/v1/schedule?${edgeRange}`)).json().data.items.length, 0);
  const missingExpiry = await post(app, '/v1/memory', { requestId: 'bad', expectedContextRevision: 0, kind: 'situation', key: 'busy', value: true, validUntil: null }, 'bad');
  assert.equal(missingExpiry.json().error.code, 'missing_information');
  const first = await post(app, '/v1/memory', { requestId: 'one', expectedContextRevision: 0, kind: 'preference', key: 'study', value: '오전', validUntil: null }, 'one');
  const second = await post(app, '/v1/memory', { requestId: 'two', expectedContextRevision: 1, kind: 'preference', key: 'study', value: '오후', validUntil: null }, 'two');
  assert.equal(second.json().data.fact.id, first.json().data.fact.id);
  assert.equal(second.json().data.fact.revision, 2);
  assert.equal(second.json().data.contextRevision, 2);
  const stale = await post(app, '/v1/memory', { requestId: 'three', expectedContextRevision: 1, kind: 'preference', key: 'study', value: '밤', validUntil: null }, 'three');
  assert.equal(stale.statusCode, 409);
  const current = await get(app, `/v1/memory?at=${encodeURIComponent(fixedNow)}`);
  assert.equal(current.json().data.facts[0].value, '오후');
  assert.deepEqual((await get(app, `/v1/memory?at=${encodeURIComponent(fixedNow)}`, 'bob')).json().data, { facts: [], contextRevision: 0 });
});

test('proposal expiry uses the next start, rejects past placement, and ignores unchanged past slots', async t => {
  let existing!: ScheduleItem;
  const near = { ...task, timeSlot: { startsAt: '2026-10-31T12:20:00Z', endsAt: '2026-10-31T13:20:00Z', timezone: 'UTC' } };
  const past = { ...task, timeSlot: { startsAt: '2026-10-31T10:00:00Z', endsAt: '2026-10-31T11:00:00Z', timezone: 'UTC' } };
  const model: ModelPort = { async decide(input) {
    const changeSet: ChangeSet = input.message === 'rename'
      ? update(existing, { ...past, title: '제목 변경' })
      : { changes: [{ changeId: 'new', operation: 'create', after: input.message === 'past' ? past : near }] };
    return { kind: 'proposal', reason: '검토', changeSet, evidenceRefs: [] };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const nearResponse = await post(app, '/v1/chat', { ...chat('near'), message: 'near' }, 'near');
  const nearId = nearResponse.json().data.result.proposalIds[0];
  assert.equal((await get(app, `/v1/proposals/${nearId}`)).json().data.proposal.expiresAt, '2026-10-31T12:20:00Z');
  const pastResponse = await post(app, '/v1/chat', { ...chat('past'), message: 'past' }, 'past');
  assert.equal(pastResponse.json().data.result.kind, 'failure');
  const createPast = await post(app, '/v1/schedule/commands', { requestId: 'past-item', expectedScheduleRevision: 0,
    changeSet: { changes: [{ changeId: 'past-item', operation: 'create', after: past }] } }, 'past-item');
  assert.equal(createPast.statusCode, 200);
  existing = createPast.json().data.items[0];
  const rename = await post(app, '/v1/chat', { ...chat('rename'), message: 'rename' }, 'rename');
  assert.equal(rename.json().data.result.kind, 'proposal', rename.body);
  const renameId = rename.json().data.result.proposalIds[0];
  assert.equal((await get(app, `/v1/proposals/${renameId}`)).json().data.proposal.expiresAt, '2026-10-31T12:30:00.000Z');
});

test('approval at a new start time is expired and does not write a schedule', async t => {
  let now = fixedNow;
  const near = { ...task, timeSlot: { startsAt: '2026-10-31T12:20:00Z', endsAt: '2026-10-31T13:20:00Z', timezone: 'UTC' } };
  const model: ModelPort = { async decide() { return { kind: 'proposal', reason: '검토', changeSet: { changes: [{ changeId: 'near', operation: 'create', after: near }] }, evidenceRefs: [] }; } };
  const app = buildApp({ sessions, model, clock: () => new Date(now) }); t.after(() => app.close());
  const response = await post(app, '/v1/chat', chat(), 'near');
  const id = response.json().data.result.proposalIds[0];
  now = '2026-10-31T12:20:00.000Z';
  const decision = await post(app, `/v1/proposals/${id}/decision`, { requestId: 'accept', proposalRevision: 1, decision: 'accept' }, 'accept');
  assert.equal(decision.json().error.code, 'expired_proposal');
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.scheduleRevision, 0);
});

test('manual schedule and memory endpoints work over a real loopback HTTP connection', async () => {
  const app = buildApp({ sessions, clock: () => new Date(fixedNow) });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const headers = { authorization: 'Bearer alice', 'content-type': 'application/json', 'idempotency-key': 'http-create' };
    const created = await fetch(`${base}/v1/schedule/commands`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'http', expectedScheduleRevision: 0,
      changeSet: { changes: [{ changeId: 'task', operation: 'create', after: task }] } }) });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).data.scheduleRevision, 1);
    const read = await fetch(`${base}/v1/schedule?${range}`, { headers: { authorization: 'Bearer alice' } });
    assert.equal((await read.json()).data.items.length, 1);
    const memory = await fetch(`${base}/v1/memory`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'http-memory' },
      body: JSON.stringify({ requestId: 'memory', expectedContextRevision: 0, kind: 'preference', key: 'x', value: true, validUntil: null }) });
    assert.equal((await memory.json()).data.contextRevision, 1);
  } finally { await app.close(); }
});

test('read_schedule can retrieve unplaced tasks even though its v1 input has no includeUnscheduled flag', async t => {
  let observed: any;
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: { from, to, timezone: 'Asia/Seoul' } };
    observed = resultOf(input.observations, 'read_schedule');
    return { kind: 'answer', text: '미배치 작업을 확인했습니다.' };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const created = await post(app, '/v1/schedule/commands', { requestId: 'c', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'unplaced', operation: 'create', after: { ...task, timeSlot: null } },
  ] } }, 'c');
  assert.equal(created.statusCode, 200);
  assert.equal((await post(app, '/v1/chat', chat(), 'chat')).statusCode, 200);
  assert.equal(observed.items[0].timeSlot, null);
});

test('read_memory with empty keys discovers the users explicit facts in the snapshot', async t => {
  let observed: any;
  const model: ModelPort = { async decide(input) {
    if (!input.observations.length) {
      assert.match(input.tools.find(tool => tool.name === 'read_memory')!.description, /빈 배열/);
      return { kind: 'tool_call', name: 'read_memory', input: { keys: [], at: input.context.now } };
    }
    observed = resultOf(input.observations, 'read_memory');
    return { kind: 'answer', text: '선호를 확인했습니다.' };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const written = await post(app, '/v1/memory', { requestId: 'p', expectedContextRevision: 0, kind: 'preference', key: 'study', value: '오전', validUntil: null }, 'p');
  assert.equal(written.statusCode, 200);
  assert.equal((await post(app, '/v1/chat', chat(), 'chat')).statusCode, 200);
  assert.equal(observed.facts[0].key, 'study');
  assert.equal(observed.facts[0].value, '오전');
  assert.deepEqual(observed.missingFields, []);
});

test('approval revalidates current snapshot even if a repository revision is incorrectly unchanged', async t => {
  const store = new MemoryPlanningStore();
  const model: ModelPort = { async decide() { return { kind: 'proposal', reason: '검토', changeSet: { changes: [{ changeId: 'new', operation: 'create', after: task }] }, evidenceRefs: [] }; } };
  const app = buildApp({ sessions, model, store, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const response = await post(app, '/v1/chat', chat(), 'proposal');
  const id = response.json().data.result.proposalIds[0];
  await store.transaction('alice', state => {
    const conflicting: ScheduleItem = { ...task, id: 'inserted', revision: 1, sourceRefs: [] };
    state.items.set(conflicting.id, conflicting); // Deliberately corrupt the test repository's revision invariant.
  });
  const decision = await post(app, `/v1/proposals/${id}/decision`, { requestId: 'accept', proposalRevision: 1, decision: 'accept' }, 'accept');
  assert.equal(decision.json().error.code, 'stale_proposal');
  assert.equal((await store.read('alice')).items.size, 1);
});

test('proposal pagination has stable cursors even for equal creation times', async t => {
  const model: ModelPort = { async decide() { return { kind: 'proposal', reason: '검토', changeSet: { changes: [{ changeId: 'new', operation: 'create', after: task }] }, evidenceRefs: [] }; } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const ids = new Set<string>();
  for (const key of ['one', 'two', 'three']) ids.add((await post(app, '/v1/chat', chat(key), key)).json().data.result.proposalIds[0]);
  const observed = new Set<string>(); let cursor: string | null = null;
  do {
    const page = await get(app, `/v1/proposals?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.statusCode, 200, page.body);
    const data = page.json().data;
    assert.equal(data.proposals.length, 1);
    assert.equal(observed.has(data.proposals[0].id), false);
    observed.add(data.proposals[0].id); cursor = data.nextCursor;
  } while (cursor);
  assert.deepEqual(observed, ids);
  assert.equal((await get(app, '/v1/proposals?cursor=%21')).statusCode, 400);
});

test('task slots shorter than their duration are rejected without changing state', async t => {
  const app = buildApp({ sessions, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const short = await post(app, '/v1/schedule/commands', { requestId: 'short', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'short', operation: 'create', after: { ...task, durationMinutes: 120 } },
  ] } }, 'short');
  assert.ok(short.statusCode >= 400, short.body);
  assert.equal((await get(app, `/v1/schedule?${range}`)).json().data.scheduleRevision, 0);
});

test('unsupported shared-task moves are rejected without changing state', async t => {
  const app = buildApp({ sessions, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const sharedTask = { ...task, involvement: 'shared' as const };
  const created = await post(app, '/v1/schedule/commands', { requestId: 'shared', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'shared', operation: 'create', after: sharedTask },
  ] } }, 'shared');
  assert.equal(created.statusCode, 200, created.body);
  const item: ScheduleItem = created.json().data.items[0];
  const changed = await post(app, '/v1/schedule/commands', { requestId: 'change', expectedScheduleRevision: 1, changeSet: update(item, moved(item)) }, 'change');
  assert.ok(changed.statusCode >= 400, changed.body);
  const current = (await get(app, `/v1/schedule?${range}`)).json().data;
  assert.equal(current.scheduleRevision, 1);
  assert.equal(current.items[0].timeSlot.startsAt, task.timeSlot!.startsAt);
});

test('coordination drafts cannot smuggle completion changes into a flexible shared event', async t => {
  let shared!: ScheduleItem;
  const model: ModelPort = { async decide() { return { kind: 'proposal', reason: '검토', changeSet: update(shared, {
    ...moved(shared, '2026-11-02T17:00+09:00', '2026-11-02T18:00+09:00'), completion: 'completed',
  }), evidenceRefs: [] }; } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const created = await post(app, '/v1/schedule/commands', { requestId: 'shared', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'shared', operation: 'create', after: { ...event, flexibility: 'flexible' } },
  ] } }, 'shared');
  assert.equal(created.statusCode, 200, created.body);
  shared = created.json().data.items[0];
  const response = await post(app, '/v1/chat', chat(), 'proposal');
  assert.equal(response.json().data.result.kind, 'failure', response.body);
  assert.deepEqual((await get(app, '/v1/proposals')).json().data.proposals, []);
});

test('derived coordination targets cannot save a proposal that approval would reject as out of scope', async t => {
  let shared!: ScheduleItem; let personal!: ScheduleItem; let validation: any;
  const model: ModelPort = { async decide(input) {
    const changeSet: ChangeSet = { changes: [
      { changeId: 'shared', operation: 'update', targetId: shared.id, expectedRevision: 1, after: moved(shared, '2026-11-02T17:00+09:00', '2026-11-02T18:00+09:00') },
      { changeId: 'personal', operation: 'update', targetId: personal.id, expectedRevision: 1, after: moved(personal) },
    ] };
    if (!input.observations.length) return { kind: 'tool_call', name: 'validate_changes', input: { changeSet } };
    validation = resultOf(input.observations, 'validate_changes');
    return { kind: 'proposal', reason: '검토', changeSet, evidenceRefs: [] };
  } };
  const app = buildApp({ sessions, model, clock: () => new Date(fixedNow) }); t.after(() => app.close());
  const created = await post(app, '/v1/schedule/commands', { requestId: 'seed', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'shared', operation: 'create', after: { ...event, flexibility: 'flexible' } },
    { changeId: 'personal', operation: 'create', after: task },
  ] } }, 'seed');
  assert.equal(created.statusCode, 200, created.body);
  [shared, personal] = created.json().data.items;
  const response = await post(app, '/v1/chat', chat(), 'proposal');
  assert.equal(response.json().data.result.kind, 'failure', response.body);
  assert.equal(validation.valid, false);
  assert.deepEqual((await get(app, '/v1/proposals')).json().data.proposals, []);
});
