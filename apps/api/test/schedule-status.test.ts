import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleFields } from '@pikku/domain';
import { buildApp } from '../src/app.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { PlanningService } from '../src/planning-service.ts';

const sessions = { async resolve(token: string) { return ['alice', 'bob'].includes(token) ? { userId: token } : null; } };
const event: ScheduleFields = { kind: 'event', title: '약속', timeSlot: { startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z', timezone: 'UTC' }, durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'shared', completion: 'pending', category: 'work' };
const task: ScheduleFields = { kind: 'task', title: '할 일', timeSlot: null, durationMinutes: 30, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'unknown' };

test('status changes are independent, idempotent and undo only recorded previous values', async t => {
  const store = new MemoryPlanningStore();
  const app = buildApp({ sessions, store, clock: () => new Date('2029-12-01T00:00:00Z') }); t.after(() => app.close());
  const post = (url: string, payload: object, key: string, user = 'alice') => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${user}`, 'idempotency-key': key }, payload });
  const created = await post('/v1/schedule/commands', { requestId: 'create', expectedScheduleRevision: 0, changeSet: { changes: [
    { changeId: 'event', operation: 'create', after: event }, { changeId: 'task', operation: 'create', after: task },
  ] } }, 'create');
  assert.equal(created.statusCode, 200, created.body);
  const items = created.json().data.items; const meeting = items.find((x: any) => x.kind === 'event'); const todo = items.find((x: any) => x.kind === 'task');
  const attendBody = { requestId: 'attend', expectedRevision: 1, attendance: 'attended' };
  const attend = await post(`/v1/schedule/${meeting.id}/attendance`, attendBody, 'attendance');
  assert.equal(attend.statusCode, 200, attend.body);
  assert.equal(attend.json().data.item.completion, 'pending');
  assert.equal(attend.json().data.item.category, 'work');
  assert.deepEqual((await post(`/v1/schedule/${meeting.id}/attendance`, { ...attendBody, requestId: 'retry' }, 'attendance')).json(), attend.json());
  assert.equal((await post(`/v1/schedule/${meeting.id}/attendance`, { ...attendBody, attendance: 'absent' }, 'attendance')).json().error.code, 'idempotency_conflict');
  assert.equal((await post(`/v1/schedule/${todo.id}/attendance`, attendBody, 'task-attendance')).statusCode, 400);
  assert.equal((await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'x', expectedRevision: 2, field: 'attendance' }, 'other-user', 'bob')).statusCode, 404);
  assert.equal((await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'x', expectedRevision: 1, field: 'attendance' }, 'stale')).statusCode, 409);
  const undo = await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'undo', expectedRevision: 2, field: 'attendance' }, 'undo');
  assert.equal(undo.statusCode, 200, undo.body); assert.equal(undo.json().data.item.attendance, null);
  assert.deepEqual((await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'retry', expectedRevision: 2, field: 'attendance' }, 'undo')).json(), undo.json());
  const absent = await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'again', expectedRevision: 3, field: 'attendance' }, 'again');
  assert.equal(absent.statusCode, 409); assert.equal(absent.json().error.code, 'no_undo');
  const done = await post(`/v1/schedule/${todo.id}/checkin`, { requestId: 'done', expectedRevision: 1, completion: 'completed' }, 'done');
  assert.equal(done.statusCode, 200, done.body);
  const undoDone = await post(`/v1/schedule/${todo.id}/undo`, { requestId: 'undo-done', expectedRevision: 2, field: 'completion' }, 'undo-done');
  assert.equal(undoDone.statusCode, 200, undoDone.body); assert.equal(undoDone.json().data.item.completion, 'unknown');
  const legacy = await post(`/v1/schedule/${meeting.id}/undo`, { requestId: 'legacy', expectedRevision: 3, field: 'completion' }, 'legacy');
  assert.equal(legacy.json().error.code, 'no_undo');
});

test('legacy updates preserve category and attendance, direct status edits are undoable', async t => {
  const store = new MemoryPlanningStore(); const app = buildApp({ sessions, store, clock: () => new Date('2029-12-01T00:00:00Z') }); t.after(() => app.close());
  const post = (url: string, payload: object, key: string) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer alice', 'idempotency-key': key }, payload });
  const created = await post('/v1/schedule/commands', { requestId: 'c', expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'c', operation: 'create', after: { ...event, involvement: 'personal', attendance: 'attended' } }] } }, 'c');
  const item = created.json().data.items[0]; assert.equal(created.statusCode, 200, created.body);
  const { category: _c, attendance: _a, ...legacy } = { ...event, involvement: 'personal' as const };
  const changed = await post('/v1/schedule/commands', { requestId: 'u', expectedScheduleRevision: 1, changeSet: { changes: [{ changeId: 'u', operation: 'update', targetId: item.id, expectedRevision: 1, after: { ...legacy, title: '수정', completion: 'completed' } }] } }, 'u');
  assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().data.items[0].category, 'work'); assert.equal(changed.json().data.items[0].attendance, 'attended');
  const undone = await post(`/v1/schedule/${item.id}/undo`, { requestId: 'undo', expectedRevision: 2, field: 'completion' }, 'undo');
  assert.equal(undone.statusCode, 200, undone.body); assert.equal(undone.json().data.item.completion, 'pending');
  const taskChange = await post('/v1/schedule/commands', { requestId: 'task', expectedScheduleRevision: 3, changeSet: { changes: [{ changeId: 'task', operation: 'update', targetId: item.id, expectedRevision: 3, after: task }] } }, 'task');
  assert.equal(taskChange.statusCode, 409, taskChange.body);
  const explicitClear = await post('/v1/schedule/commands', { requestId: 'clear', expectedScheduleRevision: 3, changeSet: { changes: [{ changeId: 'clear', operation: 'update', targetId: item.id, expectedRevision: 3, after: { ...task, category: null, attendance: null } }] } }, 'clear');
  assert.equal(explicitClear.statusCode, 200, explicitClear.body); assert.equal(explicitClear.json().data.items[0].category, null); assert.equal(explicitClear.json().data.items[0].attendance, null);
});

test('personal AI proposal omitting new fields preserves them through approval', async () => {
  const store = new MemoryPlanningStore(); const planning = new PlanningService(store, () => new Date('2029-12-01T00:00:00Z'));
  const saved = await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'c', operation: 'create', after: { ...event, involvement: 'personal', attendance: 'attended' } }] } });
  const item = saved.items[0]!;
  const baseline = await planning.capture('alice', 'UTC');
  const { category: _category, attendance: _attendance, ...oldFields } = { ...event, involvement: 'personal' as const };
  const proposed = await planning.saveProposal(baseline, { kind: 'proposal', reason: '시간 이동', evidenceRefs: [], changeSet: { changes: [{ changeId: 'move', operation: 'update', targetId: item.id, expectedRevision: item.revision, after: { ...oldFields, timeSlot: { startsAt: '2030-01-01T12:00:00Z', endsAt: '2030-01-01T13:00:00Z', timezone: 'UTC' } } }] } });
  assert.equal(proposed.kind, 'proposal'); if (proposed.kind !== 'proposal') return;
  assert.equal((await planning.decideProposal('alice', proposed.proposalIds[0]!, { proposalRevision: 1, decision: 'accept' })).outcome, 'applied');
  const updated = (await store.read('alice')).items.get(item.id)!;
  assert.equal(updated.category, 'work'); assert.equal(updated.attendance, 'attended'); assert.equal(updated.completion, 'pending');
});

test('changing kind invalidates attendance undo without discarding completion undo', async () => {
  const store = new MemoryPlanningStore(); const planning = new PlanningService(store);
  const created = await planning.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'create', operation: 'create', after: { ...event, involvement: 'personal', attendance: 'attended' } }] } });
  const id = created.items[0]!.id;
  await planning.checkin('alice', id, { expectedRevision: 1, completion: 'completed' });
  await planning.command('alice', { expectedScheduleRevision: 2, changeSet: { changes: [{ changeId: 'task', operation: 'update', targetId: id, expectedRevision: 2,
    after: { ...task, completion: 'completed', attendance: null } }] } });
  assert.equal((await store.read('alice')).statusUndo?.get(id)?.attendance, undefined);
  const { attendance: _attendance, ...legacyEvent } = event;
  await planning.command('alice', { expectedScheduleRevision: 3, changeSet: { changes: [{ changeId: 'event', operation: 'update', targetId: id, expectedRevision: 3,
    after: { ...legacyEvent, involvement: 'personal', completion: 'completed' } }] } });
  await assert.rejects(planning.undo('alice', id, { expectedRevision: 4, field: 'attendance' }), { code: 'no_undo' });
  const restored = await planning.undo('alice', id, { expectedRevision: 4, field: 'completion' });
  assert.equal(restored.item.completion, 'pending'); assert.equal(restored.item.attendance, null);
});
