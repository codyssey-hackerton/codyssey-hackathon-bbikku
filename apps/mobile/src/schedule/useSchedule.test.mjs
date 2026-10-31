import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useSchedule } from './useSchedule.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const query = { from: '2026-10-30T15:00:00Z', to: '2026-10-31T15:00:00Z', timezone: 'Asia/Seoul', includeUnscheduled: true };

// A small hook host exercises effects and delayed responses without installing a renderer.
function hookHost(t) {
  const values = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  let scheduled = [];
  t.mock.method(React, 'useState', (initial) => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (update) => {
      values[index] = typeof update === 'function' ? update(values[index]) : update;
      dirty = true;
    }];
  });
  t.mock.method(React, 'useEffect', (effect, deps) => {
    const index = cursor++;
    const previous = effects[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) scheduled.push({ index, effect, deps });
  });
  return (client, currentQuery, refreshVersion = 0) => {
    let result;
    do {
      cursor = 0;
      dirty = false;
      scheduled = [];
      result = useSchedule(client, currentQuery, refreshVersion);
    } while (dirty);
    for (const { index, effect, deps } of scheduled) {
      effects[index]?.cleanup?.();
      effects[index] = { deps, cleanup: effect() };
    }
    return result;
  };
}

function deferredRequests() {
  const requests = [];
  const client = { list: (input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) };
  return { client, requests };
}

test('refreshVersion reloads immediately and ignores a late earlier response', async (t) => {
  const render = hookHost(t);
  const { client, requests } = deferredRequests();
  assert.equal(render(client, query).status, 'loading');
  await tick();
  requests[0].resolve({ items: [], scheduleRevision: 1 });
  await tick();
  assert.equal(render(client, query).data.scheduleRevision, 1);
  assert.equal(render(client, query, 1).status, 'loading');
  await tick();
  assert.equal(render(client, query, 2).status, 'loading');
  await tick();
  requests[1].resolve({ items: [], scheduleRevision: 2 });
  await tick();
  assert.equal(render(client, query, 2).status, 'loading');
  requests[2].resolve({ items: [], scheduleRevision: 3 });
  await tick();
  assert.equal(render(client, query, 2).data.scheduleRevision, 3);
});

test('manual retry reloads after an error without changing external refreshVersion', async (t) => {
  const render = hookHost(t);
  const { client, requests } = deferredRequests();
  render(client, query, 5);
  await tick();
  requests[0].reject(new Error('offline'));
  await tick();
  const error = render(client, query, 5);
  assert.equal(error.status, 'error');
  error.retry();
  assert.equal(render(client, query, 5).status, 'loading');
  await tick();
  assert.deepEqual(requests[1].input, query);
  requests[1].resolve({ items: [], scheduleRevision: 7 });
  await tick();
  assert.equal(render(client, query, 5).data.scheduleRevision, 7);
});
