import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutationMachine } from '../api/mutation.ts';
import { operationGuard } from '../api/operationGuard.ts';
import { startWrite } from './startWrite.ts';

test('another screen blocks new writes while an uncertain request can retry unchanged', async () => {
  const hidden = {};
  const own = {};
  let message = '';
  let calls = 0;
  const attempts = [];
  const machine = createMutationMachine({
    execute: async operation => {
      calls += 1;
      attempts.push(operation);
      if (calls === 1) throw new Error('uncertain');
      return 'ok';
    },
    changed: state => operationGuard.update(own, state),
  });
  try {
    operationGuard.update(hidden, { status: 'error', uncertain: true, error: new Error('unknown') });
    startWrite(() => machine.submit({ title: 'first' }), value => { message = value; });
    assert.equal(calls, 0);
    assert.match(message, /다른 화면/);
    operationGuard.clear(hidden);
    startWrite(() => machine.submit({ title: 'first' }), value => { message = value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(machine.getState().uncertain, true);
    startWrite(() => machine.submit({ title: 'second' }), value => { message = value; });
    assert.equal(calls, 1);
    machine.retry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(operationGuard.hasUnresolved(), false);
  } finally {
    operationGuard.clear(hidden);
    operationGuard.clear(own);
  }
});
