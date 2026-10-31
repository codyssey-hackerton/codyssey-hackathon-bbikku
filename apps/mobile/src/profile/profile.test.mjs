import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let current;
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const slot = () => ({ instance: current, index: current.index++ });
const react = {
  useState(initial) { const { instance, index } = slot(); if (!instance.hooks[index]) {
    const cell = { value: typeof initial === 'function' ? initial() : initial };
    cell.set = next => { if (!instance.alive) return; const value = typeof next === 'function' ? next(cell.value) : next;
      if (!Object.is(value, cell.value)) { cell.value = value; instance.dirty = true; } }; instance.hooks[index] = cell;
  } const cell = instance.hooks[index]; return [cell.value, cell.set]; },
  useRef(initial) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
  useMemo(fn, deps) { const { instance, index } = slot(); if (!instance.hooks[index] || !same(instance.hooks[index].deps, deps)) instance.hooks[index] = { deps, value: fn() }; return instance.hooks[index].value; },
  useEffect(fn, deps) { const { instance, index } = slot(); const effect = instance.hooks[index] ??= {};
    if (!same(effect.deps, deps)) { effect.deps = deps; instance.effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
};
globalThis.__profileReact = react;
const result = await build({ stdin: { contents: "export * from './preferences'; export {usePlanningProfile} from './usePlanningProfile'; export {ApiError} from '../api/http';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'react-host', setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'react-host' }));
    b.onLoad({ filter: /.*/, namespace: 'react-host' }, () => ({ contents: 'module.exports=globalThis.__profileReact', loader: 'js' }));
  } }] });
const compiled = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(compiled, compiled.exports);
const { usePlanningProfile, emptyPreferences, parsePreferences, parseMinutes, findPreferences, ApiError } = compiled.exports;
function hook(api) {
  const h = { hooks: [], index: 0, effects: [], dirty: true, alive: true, api, value: null };
  h.flush = () => { for (let count = 0; h.dirty && count < 30; count++) { h.dirty = false; h.index = 0; h.effects = []; current = h; h.value = usePlanningProfile(h.api); current = null; for (const effect of h.effects) effect(); } if (h.dirty) throw Error('not settled'); };
  h.settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); h.flush(); } };
  h.update = api => { h.api = api; h.dirty = true; h.flush(); };
  h.close = () => { h.alive = false; for (const cell of h.hooks) cell?.cleanup?.(); };
  h.flush(); return h;
}
const value = () => ({ ...emptyPreferences(), goals: ['health'], timing: { preparationMinutes: 0, travelEstimateMinutes: 22, bufferMinutes: null }, preferredPeriod: 'morning', onboardingStatus: 'completed' });
const fact = v => ({ id: 'f1', revision: 1, kind: 'preference', key: 'planning_preferences', value: v, source: { type: 'user', ref: 'actor' }, recordedAt: '2026-11-01T00:00:00Z', validUntil: null });
function server(initial = null) {
  let saved = initial, revision = 7; const calls = [];
  return { calls, get saved() { return saved; }, api: { async get() { return { facts: saved ? [fact(saved)] : [], contextRevision: revision }; },
    async post(path, body, options) { calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
      if (body.expectedContextRevision !== revision) throw new ApiError('conflict', 'conflict', false, 409);
      saved = body.value; revision++; return { fact: fact(saved), contextRevision: revision }; } } };
}
test('profile parsing fails closed and distinguishes zero, missing and invalid values', () => {
  assert.deepEqual(parsePreferences(value()), value());
  assert.equal(parseMinutes('0'), 0); assert.equal(parseMinutes(''), null); assert.equal(parseMinutes('1440'), 1440);
  for (const bad of ['-1', '1.5', '1441', '1e2']) assert.equal(parseMinutes(bad), undefined);
  assert.equal(parsePreferences({ ...value(), goals: ['work', 'work'] }), null);
  assert.equal(parsePreferences({ ...value(), version: 2 }), null);
  assert.equal(parsePreferences({ ...value(), extra: 'preserve me' }), null);
  assert.throws(() => findPreferences([fact({ arbitrary: true })]));
  assert.throws(() => findPreferences([{ ...fact(value()), source: { type: 'provider', ref: 'x' } }]));
});
test('new skip stores explicit blanks and existing skip preserves all settings', async t => {
  const s = server(); const h = hook(s.api); t.after(h.close); await h.settle();
  assert.equal(h.value.load.value, null); assert.equal(h.value.skip(), true); h.flush(); await h.settle();
  assert.deepEqual(s.saved, emptyPreferences()); assert.equal(s.calls[0].body.validUntil, null); assert.equal(s.calls[0].body.expectedContextRevision, 7);
  const s2 = server(value()), h2 = hook(s2.api); t.after(h2.close); await h2.settle();
  assert.equal(h2.value.skip(), true); h2.flush(); await h2.settle();
  assert.deepEqual(s2.saved, { ...value(), onboardingStatus: 'skipped' });
});
test('uncertain writes retry the original body and identifiers; later conflicts remain uncertain', async t => {
  const s = server(); let tries = 0;
  const api = { ...s.api, async post(path, body, options) { s.calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
    if (++tries === 1) throw new ApiError('timeout', 'timeout', true); throw new ApiError('conflict', 'conflict', false, 409); } };
  const h = hook(api); t.after(h.close); await h.settle(); assert.equal(h.value.save(value()), true); h.flush(); await h.settle();
  assert.equal(h.value.mutation.state.uncertain, true); assert.equal(h.value.skip(), false);
  h.value.mutation.retry(); h.flush(); await h.settle(); assert.equal(h.value.mutation.state.uncertain, true);
  assert.deepEqual(s.calls[0], s.calls[1]);
});
test('malformed stored value blocks skip and a late previous-account read is ignored', async t => {
  const malformed = server({ invalid: true }); const h = hook(malformed.api); t.after(h.close); await h.settle();
  assert.equal(h.value.load.status, 'error'); assert.equal(h.value.skip(), false); assert.equal(malformed.calls.length, 0);
  let finish; const slow = { get: () => new Promise(resolve => { finish = resolve; }), post: async () => { throw Error('unexpected'); } };
  const next = server(value()), h2 = hook(slow); t.after(h2.close); h2.update(next.api); await h2.settle();
  finish({ facts: [], contextRevision: 1 }); await h2.settle();
  assert.equal(h2.value.load.status, 'success'); assert.deepEqual(h2.value.load.value, value());
});
test('a confirmed revision conflict requires reload before a fresh save', async t => {
  const s = server(value()); let first = true;
  const api = { ...s.api, async post(path, body, options) { if (first) { first = false; throw new ApiError('conflict', 'conflict', false, 409); } return s.api.post(path, body, options); } };
  const h = hook(api); t.after(h.close); await h.settle();
  assert.equal(h.value.save(value(), 6), false); assert.equal(h.value.save(value(), 7), true); h.flush(); await h.settle();
  assert.equal(h.value.mutation.state.status, 'error'); assert.equal(h.value.mutation.state.uncertain, false);
  assert.equal(h.value.save(value(), 7), false);
  h.value.refresh(); h.flush(); await h.settle(); assert.equal(h.value.load.status, 'success');
  assert.equal(h.value.save(value(), 7), true); h.flush(); await h.settle(); assert.equal(h.value.mutation.state.status, 'success');
});
