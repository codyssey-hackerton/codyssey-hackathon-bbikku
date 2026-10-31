import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/http';
import { createMutationMachine, type Mutation, type MutationState } from '../src/api/mutation';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('ambiguous retry keeps the exact request, prevents a new intent, then uses new IDs after success', async () => {
  const attempts: Mutation<{ value: { title: string } }>[] = [];
  const states: MutationState<{ saved: boolean }>[] = [];
  const original = { value: { title: '원본' } };
  const machine = createMutationMachine({
    execute: async (op: Mutation<typeof original>) => {
      attempts.push(op);
      if (attempts.length === 1) throw new ApiError('timeout', 'timeout', true);
      return { saved: true };
    },
    changed: (state) => states.push(state),
  });
  machine.submit(original);
  original.value.title = '수정됨';
  await tick();
  assert.equal(machine.getState().status, 'error');
  machine.reset();
  machine.submit({ value: { title: '다른 요청' } });
  assert.equal(attempts.length, 1);
  machine.retry();
  await tick();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(attempts[1].input.value.title, '원본');
  assert.notEqual(attempts[0].requestId, attempts[0].idempotencyKey);
  assert.equal(machine.getState().status, 'success');
  machine.reset();
  machine.submit({ value: { title: '새 요청' } });
  await tick();
  assert.notEqual(attempts[2].idempotencyKey, attempts[1].idempotencyKey);
  assert.equal(states.at(-1)?.status, 'success');
});

test('a confirmed stale response can be cleared before a new action', async () => {
  let count = 0;
  const machine = createMutationMachine({
    execute: async (_op: Mutation<{ value: number }>) => { count += 1; throw new ApiError('stale_proposal', 'stale', false, 409); },
    changed: () => {},
  });
  machine.submit({ value: 1 });
  await tick();
  assert.equal(machine.getState().status, 'error');
  machine.reset();
  assert.equal(machine.getState().status, 'idle');
  machine.submit({ value: 2 });
  await tick();
  assert.equal(count, 2);
});

test('session invalidation ignores late results and success callbacks', async () => {
  let complete!: (value: string) => void;
  let callbacks = 0;
  const machine = createMutationMachine({
    execute: (_op: Mutation<{ value: number }>) => new Promise<string>((resolve) => { complete = resolve; }),
    changed: () => {}, succeeded: () => { callbacks += 1; },
  });
  machine.submit({ value: 1 });
  machine.submit({ value: 2 });
  assert.equal(machine.getState().status, 'pending');
  machine.invalidate();
  complete('done');
  await tick();
  assert.equal(callbacks, 0);
  assert.equal(machine.getState().status, 'idle');
});


test('a later authorization error does not resolve an earlier ambiguous write', async () => {
  let attempts = 0;
  const machine = createMutationMachine({
    execute: async (_op: Mutation<{ value: number }>) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError('timeout', 'timeout', true);
      throw new ApiError('unauthenticated', 'session expired', false, 401);
    },
    changed: () => {},
  });
  machine.submit({ value: 1 });
  await tick();
  machine.retry();
  await tick();
  const state = machine.getState();
  assert.equal(state.status, 'error');
  if (state.status === 'error') assert.equal(state.uncertain, true);
  machine.reset();
  assert.equal(machine.getState().status, 'error');
});

test('a running action cannot be replaced by a second submission or retried concurrently', async () => {
  let complete!: (value: string) => void;
  const attempts: Mutation<{ value: number }>[] = [];
  const machine = createMutationMachine({
    execute: (op: Mutation<{ value: number }>) => {
      attempts.push(op);
      return new Promise<string>((resolve) => { complete = resolve; });
    },
    changed: () => {},
  });
  machine.submit({ value: 1 });
  machine.submit({ value: 2 });
  machine.retry();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].input.value, 1);
  complete('done');
  await tick();
  assert.equal(machine.getState().status, 'success');
});

test('status lookup serializes with retry and retains the original uncertain request', async () => {
  const attempts: Mutation<{ value: number }>[] = [];
  let finishLookup!: (value: { status: 'running' }) => void;
  const machine = createMutationMachine({ execute: async (op: Mutation<{ value: number }>) => {
    attempts.push(op); if (attempts.length === 1) throw new ApiError('timeout', 'timeout', true); return 'done';
  }, changed: () => {} });
  machine.submit({ value: 1 }); await tick();
  const lookup = machine.check(op => { assert.deepEqual(op, attempts[0]); return new Promise<{ status: 'running' }>(resolve => { finishLookup = resolve; }); }, () => null);
  machine.retry(); const concurrent = await machine.check(async () => ({ status: 'running' }), () => null);
  assert.equal(concurrent, undefined); assert.equal(attempts.length, 1);
  finishLookup({ status: 'running' }); assert.deepEqual(await lookup, { status: 'running' });
  assert.equal(machine.getState().status, 'error'); machine.retry(); await tick();
  assert.deepEqual(attempts[1], attempts[0]); assert.equal(machine.getState().status, 'success');
});

test('completed lookup runs the ordinary success path once and ignores invalidated results', async () => {
  let complete!: (value: string) => void; let successes = 0;
  const machine = createMutationMachine({ execute: async (_op: Mutation<number>): Promise<string> => { throw new ApiError('timeout', 'timeout', true); },
    changed: () => {}, succeeded: () => { successes++; } });
  machine.submit(1); await tick();
  const lookup = machine.check(() => new Promise<string>(resolve => { complete = resolve; }), result => ({ result }));
  complete('recovered'); assert.equal(await lookup, 'recovered'); assert.equal(successes, 1);
  assert.deepEqual(machine.getState(), { status: 'success', result: 'recovered' });
  machine.reset(); machine.submit(2); await tick();
  const late = machine.check(() => new Promise<string>(resolve => { complete = resolve; }), result => ({ result }));
  machine.invalidate(); complete('late'); assert.equal(await late, undefined);
  assert.equal(successes, 1); assert.equal(machine.getState().status, 'idle');
});

test('failed lookup keeps uncertainty and allows the original retry', async () => {
  let attempts = 0;
  const machine = createMutationMachine({ execute: async (_op: Mutation<number>): Promise<string> => { attempts++; throw new ApiError('network', 'network', true); }, changed: () => {} });
  machine.submit(1); await tick();
  await assert.rejects(machine.check(async () => { throw new Error('offline'); }, () => null));
  assert.equal(machine.getState().status, 'error'); machine.retry(); await tick(); assert.equal(attempts, 2);
  const state = machine.getState(); assert.equal(state.status, 'error'); if (state.status === 'error') assert.equal(state.uncertain, true);
});
