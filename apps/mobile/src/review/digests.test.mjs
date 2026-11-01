import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let hooks = [], index = 0, effects = [], dirty = false;
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const react = {
  useState(initial) {
    const at = index++; hooks[at] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[at].value, value => { hooks[at].value = typeof value === 'function' ? value(hooks[at].value) : value; dirty = true; }];
  },
  useMemo(factory, deps) { const at = index++; if (!hooks[at] || !same(hooks[at].deps, deps)) hooks[at] = { value: factory(), deps }; return hooks[at].value; },
  useEffect(callback, deps) { const at = index++; if (!hooks[at] || !same(hooks[at].deps, deps)) {
    const old = hooks[at]; hooks[at] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[at].cleanup = callback(); });
  } },
};
const jsx = (type, props) => ({ type, props: props ?? {} });
globalThis.__digestTest = { react, jsx, fragment: Symbol('fragment') };
const bundle = await build({ stdin: { contents: "export { default } from './ReviewDigests';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'digest-test', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\.\/ui\/(ActionButton|typography|theme))$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'module.exports=globalThis.__digestTest.react' :
      path === 'react/jsx-runtime' ? 'exports.jsx=exports.jsxs=globalThis.__digestTest.jsx;exports.Fragment=globalThis.__digestTest.fragment' :
      path === 'react-native' ? 'exports.View="View";exports.StyleSheet={create:x=>x}' :
      path.endsWith('ActionButton') ? 'exports.ActionButton="Button"' :
      path.endsWith('typography') ? 'exports.Text="Text"' :
      'exports.colors={text:"#111",muted:"#777",surfaceSecondary:"#eee"}' }));
  } }] });
const compiled = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(compiled, compiled.exports);
const Component = compiled.exports.default;
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const digest = (id, message, proposalIds = []) => ({ id, reason: 'morning_review', createdAt: '2030-01-01T00:00:00Z', message, proposalIds });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function render(props) {
  hooks = []; let tree;
  const view = { props, flush() { do { dirty = false; index = 0; effects = []; tree = Component(view.props); for (const run of effects) run(); } while (dirty); },
    get tree() { return tree; }, update(next) { view.props = { ...view.props, ...next }; dirty = true; view.flush(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); view.flush(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); } };
  dirty = true; view.flush(); return view;
}

test('visible reviews ignore late old-account data and reuse proposal display without a write', async () => {
  const old = deferred(), calls = [];
  const first = { get(path) { calls.push(['first', path]); return old.promise; } };
  const second = { async get(path) { calls.push(['second', path]); return { digests: [digest('b', '새 사용자 브리핑', ['p1'])] }; } };
  const rendered = [];
  const view = render({ api: first, visible: true, refreshVersion: 0, renderProposal: id => { rendered.push(id); return jsx('Proposal', { id }); } });
  try {
    view.update({ api: second }); await view.settle();
    old.resolve({ digests: [digest('a', '이전 사용자 비밀')] }); await view.settle();
    assert.ok(JSON.stringify(view.tree).includes('새 사용자 브리핑'));
    assert.equal(JSON.stringify(view.tree).includes('이전 사용자 비밀'), false);
    assert.ok(rendered.includes('p1'));
    assert.deepEqual(calls, [['first', '/v1/review-digests'], ['second', '/v1/review-digests']]);
    view.update({ visible: false }); assert.equal(view.tree, null);
  } finally { view.unmount(); }
});

test('failed read offers an explicit retry and rejects malformed data', async () => {
  let calls = 0;
  const api = { async get() { calls++; return calls === 1 ? { digests: [{ id: 'bad' }] } : { digests: [digest('good', '확인')] }; } };
  const view = render({ api, visible: true, refreshVersion: 0 });
  try {
    await view.settle();
    const button = nodes(view.tree).find(node => node.type === 'Button' && node.props.label === '다시 불러오기');
    assert.ok(button); button.props.onPress(); view.flush(); await view.settle();
    assert.ok(JSON.stringify(view.tree).includes('확인')); assert.equal(calls, 2);
  } finally { view.unmount(); }
});

test('refreshes once per minute only while visible', async () => {
  const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval;
  let tick, cleared = false, calls = 0;
  globalThis.setInterval = (fn, delay) => { assert.equal(delay, 60_000); tick = fn; return -1; };
  globalThis.clearInterval = () => { cleared = true; };
  const api = { async get() { calls++; return { digests: [] }; } };
  const view = render({ api, visible: true, refreshVersion: 0 });
  try {
    await view.settle(); assert.equal(calls, 1); assert.equal(view.tree, null);
    tick(); await view.settle(); assert.equal(calls, 2);
    view.update({ visible: false }); assert.equal(cleared, true);
    tick(); await view.settle(); assert.equal(calls, 2);
  } finally { view.unmount(); globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; }
});

test('shows two recent records by default and expands the rest', async () => {
  const api = { async get() { return { digests: [digest('one', '첫 번째'), digest('two', '두 번째'), digest('three', '세 번째')] }; } };
  const view = render({ api, visible: true, refreshVersion: 0 });
  try {
    await view.settle();
    assert.ok(JSON.stringify(view.tree).includes('첫 번째')); assert.ok(JSON.stringify(view.tree).includes('두 번째'));
    assert.equal(JSON.stringify(view.tree).includes('세 번째'), false);
    const button = nodes(view.tree).find(node => node.type === 'Button' && node.props.label === '이전 기록 더 보기');
    assert.ok(button); button.props.onPress(); view.flush();
    assert.ok(JSON.stringify(view.tree).includes('세 번째'));
  } finally { view.unmount(); }
});
