import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ScheduleFields, ScheduleItem } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import type { ModelPort } from '../src/agent.ts';
import { ApiError, createApiClient } from '../../mobile/src/api/http.ts';
import { createScheduleClient } from '../../mobile/src/schedule/client.ts';
import { createMemoryClient } from '../../mobile/src/memory/client.ts';
import { createChatClient } from '../../mobile/src/chat/client.ts';
import { createProposalClient } from '../../mobile/src/proposals/client.ts';

const timezone = 'Asia/Seoul';
const now = '2026-11-01T00:00:00.000Z';
const range = { from: '2026-11-01T00:00:00+09:00', to: '2026-11-02T00:00:00+09:00', timezone, includeUnscheduled: true };
const slot = (start: string, end: string) => ({ startsAt: `2026-11-01T${start}:00+09:00`, endsAt: `2026-11-01T${end}:00+09:00`, timezone });
const operation = <I>(input: I) => ({ input, requestId: randomUUID(), idempotencyKey: randomUUID() });
const task: ScheduleFields = { kind: 'task', title: '공부', timeSlot: null, durationMinutes: 60, deadline: '2026-11-01T18:00:00+09:00', flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
const meeting: ScheduleFields = { ...task, kind: 'event', title: '고정 회의', timeSlot: slot('15:00', '16:00'), durationMinutes: null, deadline: null, flexibility: 'fixed' };

// This deterministic test model proves the HTTP/client wiring, not real model quality.
const planningModel: ModelPort = {
  async decide(input) {
    if (input.message === '고마워') {
      assert.equal(input.observations.length, 0);
      return { kind: 'answer', text: '언제든 도와드릴게요.' };
    }
    if (input.observations.length === 0) return { kind: 'tool_call', name: 'read_schedule', input: { from: range.from, to: range.to, timezone } };
    if (input.observations.length === 1) return { kind: 'tool_call', name: 'read_memory', input: { keys: [], at: now } };
    const schedule = input.observations.find(value => value.name === 'read_schedule')!;
    assert.deepEqual(schedule.input, { from: range.from, to: range.to, timezone });
    const facts = input.observations.find(value => value.name === 'read_memory')!.result as { facts: { value: unknown }[] };
    assert.equal(facts.facts[0]?.value, '오늘 오전은 쉬고 오후에 공부');
    const original = (schedule.result as { items: ScheduleItem[] }).items.find(item => item.kind === 'task')!;
    const { id, revision, sourceRefs: _sources, ...fields } = original;
    return { kind: 'proposal', reason: '입력한 오전 휴식 선호와 고정 회의를 고려해 오후 공부를 제안합니다.', evidenceRefs: [id],
      changeSet: { changes: [{ changeId: 'move-study', operation: 'update', targetId: id, expectedRevision: revision, after: { ...fields, timeSlot: slot('16:30', '17:30') } }] } };
  },
};

async function setup() {
  const app = buildApp({ model: planningModel, clock: () => new Date(now), sessions: { async resolve(token) { return ['user-one', 'user-two'].includes(token) ? { userId: token } : null; } } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const api = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, getSessionToken: () => 'user-one' });
  const schedule = createScheduleClient(api); const memory = createMemoryClient(api); const proposals = createProposalClient(api); const chat = createChatClient(api);
  await schedule.command(operation({ expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'fixed', operation: 'create' as const, after: meeting }, { changeId: 'task', operation: 'create' as const, after: task },
  ] } }));
  await memory.save(operation({ expectedContextRevision: 0, kind: 'situation' as const, key: 'todayPreference', value: '오늘 오전은 쉬고 오후에 공부', validUntil: '2026-11-01T23:59:00+09:00' }));
  return { app, api, schedule, memory, proposals, chat, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('real HTTP: mobile clients register, read memory, request a proposal, approve once, and refresh', async t => {
  const { app, schedule, memory, proposals, chat, baseUrl } = await setup(); t.after(() => app.close());
  assert.equal((await memory.list(now)).facts.length, 1);
  const before = await schedule.list(range);
  assert.equal(before.items.length, 2);
  const result = await chat.sendMessage({ requestId: 'plan', idempotencyKey: 'plan-once', conversationId: null, message: '공부 시간을 추천해줘', timezone });
  assert.equal(result.result.kind, 'proposal');
  if (result.result.kind !== 'proposal') throw new Error('Expected test proposal');
  const proposal = await proposals.get(result.result.proposalIds[0]!);
  assert.equal((await proposals.list()).proposals[0]?.id, proposal.id);
  assert.equal((await schedule.list(range)).items.find(item => item.kind === 'task')?.timeSlot, null, 'no change before approval');
  const approval = operation({ id: proposal.id, proposalRevision: proposal.revision, mode: proposal.mode, decision: 'accept' as const });
  const applied = await proposals.decide(approval);
  assert.equal(applied.outcome, 'applied');
  assert.deepEqual(await proposals.decide({ ...approval, requestId: 'retry-with-new-trace-only' }), applied, 'duplicate approval returns first result');
  const day = await schedule.list(range);
  const month = await schedule.list({ ...range, from: '2026-11-01T00:00:00+09:00', to: '2026-12-01T00:00:00+09:00' });
  assert.deepEqual(day.items, month.items, 'day/month clients read the same canonical items');
  const study = day.items.find(item => item.kind === 'task')!;
  assert.equal(study.timeSlot?.startsAt, slot('16:30', '17:30').startsAt);
  assert.equal(day.items.find(item => item.kind === 'event')?.revision, 1);
  const checked = await schedule.checkin(operation({ id: study.id, expectedRevision: study.revision, completion: 'completed' as const }));
  assert.equal(checked.item.completion, 'completed');
  const thanks = await chat.sendMessage({ requestId: 'thanks', idempotencyKey: 'thanks-once', conversationId: result.conversationId, message: '고마워', timezone });
  assert.equal(thanks.result.kind, 'reply');
  const secondUser = createApiClient({ baseUrl, getSessionToken: () => 'user-two' });
  assert.deepEqual((await createScheduleClient(secondUser).list(range)).items, []);
  await assert.rejects(() => createProposalClient(secondUser).get(proposal.id), (error: unknown) => error instanceof ApiError && error.code === 'not_found');
});

test('real HTTP: mobile approval receives stale state after intervening direct save', async t => {
  const { app, schedule, proposals, chat } = await setup(); t.after(() => app.close());
  const response = await chat.sendMessage({ requestId: 'plan', idempotencyKey: 'plan', conversationId: null, message: '계획 추천', timezone });
  if (response.result.kind !== 'proposal') throw new Error('Expected test proposal');
  const proposal = await proposals.get(response.result.proposalIds[0]!);
  const current = await schedule.list(range);
  await schedule.command(operation({ expectedScheduleRevision: current.scheduleRevision, changeSet: { changes: [{ changeId: 'new', operation: 'create' as const, after: { ...task, title: '추가 작업' } }] } }));
  await assert.rejects(() => proposals.decide(operation({ id: proposal.id, proposalRevision: proposal.revision, mode: proposal.mode, decision: 'accept' as const })),
    (error: unknown) => error instanceof ApiError && error.code === 'stale_proposal');
  assert.equal((await proposals.get(proposal.id)).status, 'stale');
  assert.ok((await schedule.list(range)).items.filter(item => item.kind === 'task').every(item => item.timeSlot === null));
});
