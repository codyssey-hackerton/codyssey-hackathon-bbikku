import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readProjectApiKey, runCli } from '../../../scripts/verify-model.ts';

const fakeKey = 'synthetic-test-key-only';
const timing = { appointmentStart: '2030-01-02T15:00:00+09:00', preparationMinutes: 15, travelMinutes: 30, bufferMinutes: 10 };
const toolResult = { ready: true, departureAt: '2030-01-02T05:20:00.000Z', preparationStartAt: '2030-01-02T05:05:00.000Z' };
const providerResponse = (output: unknown[], extra = {}) => new Response(JSON.stringify({
  status: 'completed', model: 'gpt-6.1-terra', reasoning: { effort: 'high' }, output, ...extra,
}), { status: 200 });
const toolCall = (args: unknown = timing) => ({ type: 'function_call', call_id: 'synthetic-call', name: 'calculate_timing', arguments: JSON.stringify(args) });
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"kind":"answer","text":"출발 14:20, 준비 14:05"}' }] };

test('requires --live before reading the key or calling the provider', async () => {
  let reads = 0;
  let calls = 0;
  const lines: string[] = [];
  const dependencies = {
    readKey: () => { reads++; return fakeKey; },
    fetcher: async () => { calls++; throw new Error('unexpected'); },
    write: (line: string) => { lines.push(line); },
  };
  assert.equal(await runCli([], dependencies), 0);
  assert.equal(JSON.parse(lines[0]).status, 'not_run');
  assert.equal(await runCli(['--help'], dependencies), 0);
  assert.equal(await runCli(['--run'], dependencies), 2);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('an absent project key reports not_configured without a provider request', async () => {
  let calls = 0;
  const lines: string[] = [];
  const exit = await runCli(['--live'], {
    readKey: () => undefined,
    fetcher: async () => { calls++; throw new Error('unexpected'); },
    write: line => { lines.push(line); },
  });
  assert.equal(exit, 2);
  assert.deepEqual(JSON.parse(lines[0]), { status: 'not_configured', requests: 0 });
  assert.equal(calls, 0);
});

test('uses only the project key and rejects an env file pointing outside the project', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pikku-verify-model-'));
  try {
    const project = join(scratch, 'project');
    mkdirSync(project);
    assert.equal(readProjectApiKey(project, undefined), undefined);
    writeFileSync(join(project, '.env.local'), `UNRELATED=ignored\nPIKKU_OPENAI_API_KEY="${fakeKey}"\n`);
    assert.equal(readProjectApiKey(project, undefined), fakeKey);
    assert.equal(readProjectApiKey(project, 'process-key'), 'process-key');
    unlinkSync(join(project, '.env.local'));
    const outside = join(scratch, 'outside');
    writeFileSync(outside, `PIKKU_OPENAI_API_KEY=${fakeKey}\n`);
    symlinkSync(outside, join(project, '.env.local'));
    assert.throws(() => readProjectApiKey(project, undefined), { message: 'PROJECT_KEY_UNAVAILABLE' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a stubbed two-step provider response validates the real adapter and registered tool', async () => {
  let calls = 0;
  const lines: string[] = [];
  const exit = await runCli(['--live'], {
    readKey: () => fakeKey,
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-6.1-terra');
      assert.equal(body.reasoning.effort, 'high');
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ['calculate_timing']);
      assert.ok(!JSON.stringify(body.input).includes(fakeKey));
      if (calls === 1) return providerResponse([{ type: 'reasoning', summary: [] }, toolCall()]);
      const input = JSON.parse(body.input[1].content);
      assert.deepEqual(input.observations, [{ name: 'calculate_timing', input: timing, result: toolResult }]);
      return providerResponse([answer]);
    },
    write: line => { lines.push(line); },
  });
  assert.equal(exit, 0);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(lines[0]), { status: 'verified', requests: 2, toolCalls: 1, model: 'gpt-6.1-terra', reasoningEffort: 'high' });
  assert.ok(!lines.join('').includes(fakeKey));
});

test('does not report success without a valid tool call and matching response metadata', async t => {
  const cases = [
    { name: 'missing tool call', response: providerResponse([answer]), reason: 'tool_not_called' },
    { name: 'wrong tool input', response: providerResponse([toolCall({ ...timing, travelMinutes: 99 })]), reason: 'tool_input' },
    { name: 'different response model', response: providerResponse([toolCall()], { model: 'other-model' }), reason: 'response_metadata' },
    { name: 'different response effort', response: providerResponse([toolCall()], { reasoning: { effort: 'low' } }), reason: 'response_metadata' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    let calls = 0;
    const lines: string[] = [];
    const exit = await runCli(['--live'], {
      readKey: () => fakeKey,
      fetcher: async () => { calls++; return item.response; },
      write: line => { lines.push(line); },
    });
    assert.equal(exit, 1);
    assert.equal(JSON.parse(lines[0]).status, 'failed');
    assert.equal(JSON.parse(lines[0]).reason, item.reason);
    assert.equal(calls, 1);
    assert.ok(!lines.join('').includes(fakeKey));
  });
});

test('provider failures are sanitized and not retried', async () => {
  for (const scenario of ['http', 'network'] as const) {
    let calls = 0;
    const lines: string[] = [];
    const exit = await runCli(['--live'], {
      readKey: () => fakeKey,
      fetcher: async () => {
        calls++;
        if (scenario === 'network') throw new Error(`private: ${fakeKey}`);
        return new Response(`private: ${fakeKey}`, { status: 401 });
      },
      write: line => { lines.push(line); },
    });
    assert.equal(exit, 1);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(lines[0]).reason, scenario);
    if (scenario === 'http') assert.equal(JSON.parse(lines[0]).httpStatus, 401);
    assert.ok(!lines.join('').includes(fakeKey));
  }
});

test('a repeated tool call fails after at most two requests', async () => {
  let calls = 0;
  const lines: string[] = [];
  const exit = await runCli(['--live'], {
    readKey: () => fakeKey,
    fetcher: async () => { calls++; return providerResponse([toolCall()]); },
    write: line => { lines.push(line); },
  });
  assert.equal(exit, 1);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(lines[0]).reason, 'tool_repeated');
  assert.equal(JSON.parse(lines[0]).toolCalls, 1);
});
