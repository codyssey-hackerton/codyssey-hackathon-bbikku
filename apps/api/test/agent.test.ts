import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createPlanningAgent, type ModelPort, type ReadTool } from '../src/agent.ts';

test('the agent does not call tools for a simple thanks', async () => {
  let toolsRun = 0;
  const tool: ReadTool = { name: 'read_schedule', description: 'read', input: z.object({}), async run() { toolsRun++; return {}; } };
  const model: ModelPort = { async decide() { return { kind: 'answer', text: '천만에요!' }; } };
  const graph = createPlanningAgent({ model, tools: [tool], validateProposal: async () => [] });
  const result = await graph.invoke({ userId: 'alice', message: '고마워', context: {} });
  assert.equal(result.decision?.kind, 'answer');
  assert.equal(toolsRun, 0);
});

test('unknown tools and invalid arguments are rejected before execution', async () => {
  let toolsRun = 0;
  const tool: ReadTool = { name: 'read_schedule', description: 'read', input: z.object({ days: z.number().int().positive() }).strict(), async run() { toolsRun++; return {}; } };
  for (const decision of [
    { kind: 'tool_call', name: 'send_message', input: {} },
    { kind: 'tool_call', name: 'read_schedule', input: { days: 'not-a-number' } },
  ]) {
    const graph = createPlanningAgent({ model: { async decide() { return decision; } }, tools: [tool], validateProposal: async () => [] });
    await assert.rejects(() => graph.invoke({ userId: 'alice', message: '일정', context: {} }));
  }
  assert.equal(toolsRun, 0);
});

test('observations retain each validated tool input alongside its result', async () => {
  const invoked: unknown[] = [];
  const tool: ReadTool = { name: 'read_schedule', description: 'read', input: z.object({ from: z.string().trim(), to: z.string().trim() }).strict(),
    async run(value, userId) { assert.equal(userId, 'alice'); invoked.push(value); return { items: [] }; } };
  const model: ModelPort = { async decide(input) {
    if (input.observations.length === 0) return { kind: 'tool_call', name: 'read_schedule', input: { from: ' first ', to: ' second ' } };
    if (input.observations.length === 1) return { kind: 'tool_call', name: 'read_schedule', input: { from: 'third', to: 'fourth' } };
    assert.deepEqual(input.observations, [
      { name: 'read_schedule', input: { from: 'first', to: 'second' }, result: { items: [] } },
      { name: 'read_schedule', input: { from: 'third', to: 'fourth' }, result: { items: [] } },
    ]);
    return { kind: 'answer', text: '확인했습니다.' };
  } };
  const graph = createPlanningAgent({ model, tools: [tool], validateProposal: async () => [] });
  const result = await graph.invoke({ userId: 'alice', message: '일정 확인', context: {} });
  assert.equal(result.decision?.kind, 'answer');
  assert.deepEqual(invoked, [{ from: 'first', to: 'second' }, { from: 'third', to: 'fourth' }]);
});

test('default step limit permits nine reads and a final answer', async () => {
  let calls = 0;
  const tool: ReadTool = { name: 'read_schedule', description: 'read', input: z.object({}), async run() { calls++; return {}; } };
  const model: ModelPort = { async decide(input) { return input.observations.length < 9
    ? { kind: 'tool_call', name: 'read_schedule', input: {} } : { kind: 'answer', text: '확인했습니다.' }; } };
  const graph = createPlanningAgent({ model, tools: [tool], validateProposal: async () => [] });
  assert.equal((await graph.invoke({ userId: 'alice', message: '조회', context: {} })).decision?.kind, 'answer');
  assert.equal(calls, 9);
});
