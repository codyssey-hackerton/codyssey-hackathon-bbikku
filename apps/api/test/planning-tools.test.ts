import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryFact } from '@pikku/domain';
import { PlanningService } from '../src/planning-service.ts';
import { MemoryPlanningStore } from '../src/planning-store.ts';
import { createPlanningTools } from '../src/planning-tools.ts';

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
    facts: facts.slice(0, -1), contextRevision: 7, missingFields: ['null-only', 'absent'],
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
    facts: [facts[2], facts[4]], contextRevision: 7, missingFields: ['expired', 'future', 'mixed'],
  });
  assert.deepEqual(await tool.run({ keys: [], at }, 'alice'), {
    facts: [facts[2], facts[4]], contextRevision: 7, missingFields: [],
  });
  await assert.rejects(tool.run({ keys: [], at }, 'bob'), /TOOL_SCOPE_MISMATCH/);
});
