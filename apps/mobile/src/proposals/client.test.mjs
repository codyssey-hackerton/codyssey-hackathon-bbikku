import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/http.ts';
import { createMutationMachine } from '../api/mutation.ts';
import { canAccept, createProposalClient } from './client.ts';

const before = {
  id: 'item/1', revision: 4, kind: 'event', title: '회의',
  timeSlot: { startsAt: '2026-10-31T09:00:00+09:00', endsAt: '2026-10-31T10:00:00+09:00', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending',
  sourceRefs: [{ provider: 'calendar', accountRef: 'account', calendarId: 'cal', externalEventId: 'ext', lastSyncedAt: '2026-10-31T00:00:00Z' }],
};
const { id: _id, revision: _revision, sourceRefs: _sourceRefs, ...fields } = before;
const after = { ...fields, title: '새 회의' };
const proposal = {
  id: 'proposal/한', revision: 3, mode: 'personal', baseScheduleRevision: 7, baseContextRevision: 2,
  changeSet: { changes: [{ changeId: 'change-1', operation: 'update', targetId: before.id, expectedRevision: 4, after }] },
  beforeItems: [before], reason: '다른 일정과 조정', evidenceRefs: ['context-1'],
  validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 7, checkedContextRevision: 2, checkedAt: '2026-10-31T00:00:00Z' },
  createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', status: 'pending', coordinationTarget: null,
};
const coordination = { ...proposal, mode: 'coordination', coordinationTarget: { id: before.id, expectedRevision: 4 } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(responses) {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-session',
    fetcher: async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      const [status, payload] = response;
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { client: createProposalClient(api), calls };
}

const ok = (data) => [200, { requestId: 'server-request', data }];
const error = (code, status = 409) => [status, { requestId: 'server-request', error: { code, message: 'server error', retryable: false } }];
const op = (input) => ({ input, requestId: 'request-1', idempotencyKey: 'key-1' });
const input = (value = proposal, decision = 'accept') => ({ id: value.id, proposalRevision: value.revision, mode: value.mode, decision });
const result = (value, outcome) => ({ outcome, proposal: { ...value, status: outcome }, scheduleRevision: 8 });

test('분류와 참석 상태를 보존하며 잘못된 값은 제안 응답에서 거절한다', async () => {
  const categorized = { ...proposal, beforeItems: [{ ...before, category: 'work', attendance: 'attended' }] };
  assert.equal((await setup([ok({ proposal: categorized })]).client.get(proposal.id)).beforeItems[0].attendance, 'attended');
  for (const invalid of [{ ...before, category: 'other' }, { ...before, attendance: 'yes' },
    { ...before, kind: 'task', durationMinutes: 30, attendance: 'attended' }]) {
    await assert.rejects(setup([ok({ proposal: { ...proposal, beforeItems: [invalid] } })]).client.get(proposal.id), error => error.code === 'invalid_response');
  }
});

test('목록 cursor와 상세 ID를 인코딩하고 전체 스냅샷을 보존한다', async () => {
  const cursor = 'next/한?=&';
  const { client, calls } = setup([ok({ proposals: [proposal], nextCursor: cursor }), ok({ proposals: [], nextCursor: null }), ok({ proposal })]);
  assert.deepEqual(await client.list(), { proposals: [proposal], nextCursor: cursor });
  assert.deepEqual(await client.list(cursor), { proposals: [], nextCursor: null });
  assert.deepEqual(await client.get(proposal.id), proposal);
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), cursor);
  assert.equal(new URL(calls[2].url).pathname, `/v1/proposals/${encodeURIComponent(proposal.id)}`);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-session');
});

test('생성·수정·삭제의 전체 전후 필드와 검증 정보를 읽는다', async () => {
  const other = { ...before, id: 'item-2', revision: 2 };
  const full = {
    ...proposal,
    beforeItems: [before, other],
    changeSet: { changes: [
      { changeId: 'c', operation: 'create', after: { ...after, kind: 'task', timeSlot: null, durationMinutes: 30 } },
      proposal.changeSet.changes[0],
      { changeId: 'd', operation: 'delete', targetId: other.id, expectedRevision: 2 },
    ] },
    validation: { ...proposal.validation, valid: false, conflicts: [{ targetIds: [before.id], reason: '충돌', timeSlot: before.timeSlot }], missingFields: ['장소'], protectedTargets: [other.id] },
  };
  const { client } = setup([ok({ proposal: full })]);
  assert.deepEqual(await client.get(full.id), full);
});

test('준비시간 관계의 확정된 구조를 보존하고 잘못된 구조를 거절한다', async () => {
  const timing = { appointment: { kind: 'existing', id: before.id, expectedRevision: 4 }, preparationMinutes: 15, travelMinutes: 0, bufferMinutes: null, segments: { preparation: 'change-1', travel: null, buffer: null } };
  const withTiming = { ...proposal, changeSet: { ...proposal.changeSet, timingConstraints: [timing] } };
  assert.deepEqual(await setup([ok({ proposal: withTiming })]).client.get(proposal.id), withTiming);
  for (const invalid of [{ ...timing, segments: null }, { ...timing, segments: { preparation: '', travel: null, buffer: null } },
    { ...timing, preparationMinutes: -1 }, { ...timing, appointment: { kind: 'unknown' } }, { ...timing, travelMinutes: '0' }]) {
    const value = { ...proposal, changeSet: { ...proposal.changeSet, timingConstraints: [invalid] } };
    await assert.rejects(setup([ok({ proposal: value })]).client.get(proposal.id), caught => caught.code === 'invalid_response');
  }
});

test('불완전한 전후·검증·상태 또는 잘못된 상세 ID를 거절한다', async () => {
  const invalid = [
    { ...proposal, beforeItems: [] },
    { ...proposal, changeSet: { changes: [{ ...proposal.changeSet.changes[0], after: { ...after, title: undefined } }] } },
    { ...proposal, validation: { ...proposal.validation, conflicts: 'bad' } },
    { ...proposal, status: 'unknown' },
    { ...proposal, coordinationTarget: { id: before.id, expectedRevision: 4 } },
    { ...proposal, id: 'different' },
  ];
  for (const value of invalid) {
    const { client } = setup([ok({ proposal: value })]);
    await assert.rejects(client.get(proposal.id), (caught) => caught.code === 'invalid_response');
  }
  const cycle = setup([ok({ proposals: [], nextCursor: 'same' })]);
  await assert.rejects(cycle.client.list('same'), (caught) => caught.code === 'invalid_response');
});

test('검증 플래그와 상세 결과가 모순되면 승인을 막는다', () => {
  assert.equal(canAccept(proposal), true);
  for (const validation of [
    { ...proposal.validation, valid: false },
    { ...proposal.validation, conflicts: [{ targetIds: [], reason: '충돌' }] },
    { ...proposal.validation, missingFields: ['시간'] },
    { ...proposal.validation, protectedTargets: ['protected'] },
  ]) assert.equal(canAccept({ ...proposal, validation }), false);
  assert.equal(canAccept({ ...proposal, status: 'expired' }), false);
});

test('밀리초 이하의 정확한 시작·종료·마감 순서를 보존한다', async () => {
  const precise = {
    ...before,
    timeSlot: { ...before.timeSlot, startsAt: '2026-10-31T00:00:00.0001Z', endsAt: '2026-10-31T00:00:00.0002Z' },
    deadline: '2026-10-31T00:00:00.0002Z',
  };
  const full = { ...proposal, beforeItems: [precise] };
  assert.deepEqual(await setup([ok({ proposal: full })]).client.get(full.id), full);
  const bad = { ...full, beforeItems: [{ ...precise, deadline: '2026-10-31T00:00:00.00015Z' }] };
  await assert.rejects(setup([ok({ proposal: bad })]).client.get(full.id), (caught) => caught.code === 'invalid_response');
});

test('승인·거절은 선택된 revision, 훅의 requestId와 별도 중복 키만 전송한다', async () => {
  const cases = [[proposal, 'accept', 'applied'], [coordination, 'accept', 'awaiting_contact'], [coordination, 'reject', 'rejected']];
  for (const [value, decision, outcome] of cases) {
    const { client, calls } = setup([ok(result(value, outcome))]);
    assert.equal((await client.decide(op(input(value, decision)))).outcome, outcome);
    assert.equal(new URL(calls[0].url).pathname, `/v1/proposals/${encodeURIComponent(value.id)}/decision`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['Idempotency-Key'], 'key-1');
    assert.deepEqual(JSON.parse(calls[0].body), { requestId: 'request-1', proposalRevision: 3, decision });
  }
});

test('예상과 다른 outcome·모드·상태·ID를 성공으로 처리하지 않는다', async () => {
  const bad = [
    result(proposal, 'awaiting_contact'), result(proposal, 'rejected'), result(proposal, 'unknown'),
    { ...result(proposal, 'applied'), proposal: { ...proposal, status: 'pending' } },
    { ...result(proposal, 'applied'), proposal: { ...proposal, id: 'other', status: 'applied' } },
    { ...result(proposal, 'applied'), scheduleRevision: -1 },
    result(coordination, 'applied'),
  ];
  for (const response of bad) {
    const { client } = setup([ok(response)]);
    await assert.rejects(client.decide(op(input(proposal))), (caught) => caught.code === 'invalid_response');
  }
  const wrongCoordination = setup([ok(result(coordination, 'applied'))]);
  await assert.rejects(wrongCoordination.client.decide(op(input(coordination))), (caught) => caught.code === 'invalid_response');
});

test('불확정 오류 후 선택이 바뀌어도 동일 경로·본문·키로만 재시도한다', async () => {
  const { client, calls } = setup([new Error('offline'), error('stale_proposal'), ok(result(proposal, 'awaiting_contact')), ok(result(proposal, 'applied'))]);
  let selection = input();
  let successes = 0;
  const machine = createMutationMachine({ execute: (operation) => client.decide(operation), changed: () => {}, succeeded: () => { successes += 1; } });
  machine.submit(selection);
  selection.id = 'another-proposal';
  selection.proposalRevision = 900;
  selection = input(coordination, 'reject');
  await tick();
  assert.equal(machine.getState().uncertain, true);
  machine.reset();
  machine.submit(selection);
  assert.equal(calls.length, 1);
  machine.retry();
  await tick();
  assert.equal(machine.getState().status, 'error');
  assert.equal(machine.getState().uncertain, true);
  assert.equal(successes, 0);
  machine.reset();
  assert.equal(machine.getState().status, 'error');
  machine.retry();
  await tick();
  assert.equal(machine.getState().status, 'error');
  assert.equal(machine.getState().uncertain, true);
  assert.equal(successes, 0);
  machine.retry();
  await tick();
  assert.equal(machine.getState().status, 'success');
  assert.equal(successes, 1);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[2], calls[0]);
  assert.deepEqual(calls[3], calls[0]);
});

test('확정 stale·expired·conflict도 재시도에서 같은 요청을 보존하고 명시적 재조회 전 reset할 수 있다', async () => {
  for (const code of ['stale_proposal', 'expired_proposal', 'conflict']) {
    const { client, calls } = setup([error(code), error(code)]);
    const machine = createMutationMachine({ execute: (operation) => client.decide(operation), changed: () => {} });
    machine.submit(input());
    await tick();
    assert.equal(machine.getState().status, 'error');
    assert.equal(machine.getState().uncertain, false);
    machine.retry();
    await tick();
    assert.deepEqual(calls[1], calls[0]);
    machine.reset();
    assert.equal(machine.getState().status, 'idle');
  }
});
