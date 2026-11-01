import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryFact } from '@pikku/domain';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createPlanningTools } from '../src/planning-tools.ts';
import { PlanningAgentRunner } from '../src/agent-runner.ts';

const at = '2026-10-31T12:00:00Z';
const fact = (key: string, value: MemoryFact['value'], overrides: Partial<MemoryFact> = {}): MemoryFact => ({
  id: key, revision: 1, kind: 'preference', key, value,
  source: { type: 'user', ref: 'alice' }, recordedAt: at, validUntil: null, ...overrides,
});

async function memoryTool(facts: MemoryFact[]) {
  const service = new PlanningService(new MemoryPlanningStore(), () => new Date(at));
  const baseline = await service.capture('alice', 'UTC');
  baseline.snapshot.facts = facts;
  baseline.snapshot.contextRevision = 7;
  return createPlanningTools(service, baseline).find(tool => tool.name === 'read_memory')!;
}

test('read_memory retains null facts but reports keys without a non-null value', async () => {
  const facts = [fact('null-only', null), fact('both', null),
    fact('both', 'available', { id: 'both-situation', kind: 'situation' }),
    fact('false', false), fact('zero', 0), fact('empty', ''), fact('unrequested', 'hidden')];
  const tool = await memoryTool(facts);
  const keys = ['null-only', 'absent', 'both', 'false', 'zero', 'empty', 'null-only'];
  assert.deepEqual(await tool.run({ keys, at }, 'alice'), {
    facts: facts.slice(0, -1), contextRevision: 7, missingFields: ['null-only', 'absent'], truncated: false, omittedCount: 0,
  });
});

test('read_memory applies recording and expiry boundaries before checking missing values', async () => {
  const facts = [
    fact('expired', 'old', { validUntil: at }),
    fact('future', 'later', { recordedAt: '2026-10-31T12:00:01Z' }),
    fact('mixed', null),
    fact('mixed', 'expired', { id: 'mixed-expired', kind: 'situation', validUntil: at }),
    fact('active', false, { validUntil: '2026-10-31T12:00:01Z' }),
  ];
  const tool = await memoryTool(facts);
  assert.deepEqual(await tool.run({ keys: ['expired', 'future', 'mixed', 'active'], at }, 'alice'), {
    facts: [facts[2], facts[4]], contextRevision: 7, missingFields: ['expired', 'future', 'mixed'], truncated: false, omittedCount: 0,
  });
  assert.deepEqual(await tool.run({ keys: [], at }, 'alice'), {
    facts: [facts[2], facts[4]], contextRevision: 7, missingFields: [], truncated: false, omittedCount: 0,
  });
  await assert.rejects(tool.run({ keys: [], at }, 'bob'), /TOOL_SCOPE_MISMATCH/);
});

test('read_memory limits fact count and marks only requested keys with omitted or null values', async () => {
  const facts = Array.from({ length: 25 }, (_, index) => fact(`key-${index}`, index));
  facts.push(fact('key-0', 'different kind', { id: 'key-0-situation', kind: 'situation' }));
  const tool = await memoryTool(facts);
  const result = await tool.run({ keys: facts.map(value => value.key), at }, 'alice') as any;
  assert.deepEqual(result.facts, facts.slice(0, 20));
  assert.equal(result.truncated, true); assert.equal(result.omittedCount, 6);
  assert.deepEqual(result.missingFields, ['key-0', ...facts.slice(20, 25).map(value => value.key)]);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16384);
  const all = await tool.run({ keys: [], at }, 'alice') as any;
  assert.deepEqual(all.missingFields, ['memory.truncated']); assert.equal(all.omittedCount, 6);
});

test('read_memory enforces whole-result UTF-8 limit without altering large facts', async () => {
  const oversized = fact('large', '한'.repeat(6000));
  const small = fact('small', 0);
  const tool = await memoryTool([oversized, small]);
  const result = await tool.run({ keys: ['large', 'small'], at }, 'alice') as any;
  assert.deepEqual(result.facts, [small]); assert.deepEqual(result.missingFields, ['large']);
  assert.equal(result.truncated, true); assert.equal(result.omittedCount, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16384);

  const base = fact('boundary', '');
  const fixed = Buffer.byteLength(JSON.stringify({ facts: [base], contextRevision: 7, missingFields: [], truncated: false, omittedCount: 0 }), 'utf8');
  const exact = fact('boundary', 'x'.repeat(16384 - fixed));
  const boundaryTool = await memoryTool([exact]);
  const boundary = await boundaryTool.run({ keys: ['boundary'], at }, 'alice') as any;
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), 'utf8'), 16384);
  assert.deepEqual(boundary.facts, [exact]); assert.equal(boundary.truncated, false);
  const overTool = await memoryTool([fact('boundary', `${exact.value}x`)]);
  const over = await overTool.run({ keys: ['boundary'], at }, 'alice') as any;
  assert.deepEqual(over.facts, []); assert.deepEqual(over.missingFields, ['boundary']); assert.equal(over.omittedCount, 1);
});

test('read_memory rejects excessive unique key bytes and accepts duplicates without expanding the budget', async () => {
  const tool = await memoryTool([]);
  const keys = Array.from({ length: 20 }, (_, index) => `${index}-${'한'.repeat(150)}`);
  assert.ok(Buffer.byteLength(JSON.stringify(keys), 'utf8') > 8192);
  await assert.rejects(tool.run({ keys, at }, 'alice'));
  const result = await tool.run({ keys: Array(100).fill(keys[0]), at }, 'alice') as any;
  assert.deepEqual(result.missingFields, [keys[0]]); assert.equal(result.truncated, false);
});

test('runner receives at most 30 active owner memory keys without fact values', async () => {
  class CountingStore extends MemoryPlanningStore {
    reads = 0;
    override async read(userId: string) { this.reads++; return super.read(userId); }
  }
  const store = new CountingStore();
  const active = Array.from({ length: 31 }, (_, index) => fact(`active-${index}`, `secret-value-${index}`));
  await store.transaction('alice', state => {
    state.facts.set('expired', fact('expired-key', 'expired-secret', { validUntil: at }));
    state.facts.set('future', fact('future-key', 'future-secret', { recordedAt: '2026-10-31T12:00:01Z' }));
    for (const [index, item] of active.entries()) {
      state.facts.set(item.key, item);
      if (index === 0) state.facts.set('duplicate', { ...item, id: 'duplicate-id' });
    }
  });
  await store.transaction('bob', state => { state.facts.set('bob', fact('other-user-key', 'other-user-secret')); });
  const service = new PlanningService(store, () => new Date(at));
  let context: Record<string, unknown> | undefined;
  const runner = new PlanningAgentRunner(service, { async decide(input) {
    assert.deepEqual(input.observations, []); context = input.context;
    return { kind: 'answer', text: '확인했습니다.' };
  } });
  await runner.prepare({ userId: 'alice', requestId: 'index-test', conversationId: null, message: '확인', timezone: 'UTC', history: [] });
  assert.equal(store.reads, 1);
  assert.deepEqual(context?.memoryIndex, { keys: active.slice(0, 30).map(({ kind, key }) => ({ kind, key })), truncated: true });
  const serialized = JSON.stringify(context);
  for (const secret of ['secret-value-', 'expired-secret', 'future-secret', 'other-user-secret', 'expired-key', 'future-key', 'other-user-key']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('validate_changes exposes the declared timing scope without claiming unexpressed relationships', async () => {
  const service = new PlanningService(new MemoryPlanningStore(), () => new Date(at));
  await service.command('alice', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'event', operation: 'create', after: {
    kind: 'event', title: '약속', timeSlot: { startsAt: '2026-11-01T15:00:00Z', endsAt: '2026-11-01T16:00:00Z', timezone: 'UTC' },
    durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending',
  } }] } });
  const tool = createPlanningTools(service, await service.capture('alice', 'UTC')).find(value => value.name === 'validate_changes')!;
  assert.match(tool.description, /명시된 timingConstraints/);
  assert.match(tool.description, /검증하지 않습니다/);
  const result = await tool.run({ changeSet: { changes: [{ changeId: 'prep', operation: 'create', after: {
    kind: 'task', title: '준비', timeSlot: { startsAt: '2026-11-01T08:00:00Z', endsAt: '2026-11-01T08:30:00Z', timezone: 'UTC' },
    durationMinutes: 30, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending',
  } }] } }, 'alice') as { valid: boolean };
  assert.equal(result.valid, true);
});
