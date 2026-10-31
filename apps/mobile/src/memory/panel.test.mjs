import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A small host renderer exercises our actual hooks and event handlers without a native device.
// React Native Testing Library / react-test-renderer are not installed in this worktree.
function createHarness() {
  let current;
  const fragment = Symbol('fragment');
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const slot = () => {
    if (!current) throw new Error('hook called outside a component');
    const instance = current;
    const index = instance.index++;
    return { instance, index };
  };
  const react = {
    useState(initial) {
      const { instance, index } = slot();
      if (!instance.hooks[index]) {
        const state = { value: typeof initial === 'function' ? initial() : initial };
        state.set = (update) => {
          if (!instance.alive) return;
          const next = typeof update === 'function' ? update(state.value) : update;
          if (!Object.is(next, state.value)) { state.value = next; instance.renderer.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useRef(initial) {
      const { instance, index } = slot();
      return instance.hooks[index] ??= { current: initial };
    },
    useMemo(factory, deps) {
      const { instance, index } = slot();
      const old = instance.hooks[index];
      if (!old || !sameDeps(old.deps, deps)) instance.hooks[index] = { deps, value: factory() };
      return instance.hooks[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!sameDeps(effect.deps, deps)) {
        effect.deps = deps;
        instance.renderer.effects.push(() => {
          effect.cleanup?.();
          effect.cleanup = callback();
        });
      }
    },
  };
  const native = {
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Pressable: 'Pressable',
    Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'ios' }, StyleSheet: { create: (styles) => styles },
    FlatList({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }) {
      return jsx('FlatList', { children: [ListHeaderComponent, data.length ? data.map((item, index) => renderItem({ item, index })) : ListEmptyComponent, ListFooterComponent] });
    },
  };
  globalThis.__memoryPanelHarness = { react, native, jsx, fragment };

  function renderer(Component, initialProps) {
    const view = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    function render(node, path, seen) {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`, seen));
      if (node.type === fragment) return render(node.props.children, `${path}.fragment`, seen);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        let instance = view.instances.get(id);
        if (!instance) {
          instance = { hooks: [], alive: true, renderer: view, index: 0 };
          view.instances.set(id, instance);
        }
        seen.add(id);
        instance.index = 0;
        const previous = current;
        current = instance;
        const output = node.type(node.props);
        current = previous;
        return render(output, `${id}.child`, seen);
      }
      return { type: node.type, props: node.props, children: render(node.props.children, `${path}.children`, seen) };
    }
    view.flush = () => {
      for (let count = 0; view.dirty && count < 30; count += 1) {
        view.dirty = false;
        view.effects = [];
        const seen = new Set();
        view.tree = render(jsx(Component, view.props), 'root', seen);
        for (const [id, instance] of view.instances) {
          if (!seen.has(id)) {
            instance.alive = false;
            for (const hook of instance.hooks) if (hook?.cleanup) hook.cleanup();
            view.instances.delete(id);
          }
        }
        for (const effect of view.effects) effect();
      }
      if (view.dirty) throw new Error('render did not settle');
    };
    view.update = (props) => { view.props = props; view.dirty = true; view.flush(); };
    view.settle = async () => { for (let i = 0; i < 4; i += 1) { await new Promise((done) => setImmediate(done)); view.flush(); } };
    view.flush();
    return view;
  }
  return { renderer };
}

const harness = createHarness();
const directory = dirname(fileURLToPath(import.meta.url));
const bundled = await build({
  stdin: {
    contents: `export { default } from './MemoryPanel'; export { ApiError } from '../api/http';`,
    resolveDir: directory, loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface))$/ }, (args) => ({ path: args.path, namespace: 'test-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-native' }, ({ path }) => ({
      contents: path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
        path === 'react' ? 'module.exports = globalThis.__memoryPanelHarness.react' :
        path === 'react-native' ? 'module.exports = globalThis.__memoryPanelHarness.native' :
          'exports.jsx = exports.jsxs = globalThis.__memoryPanelHarness.jsx; exports.Fragment = globalThis.__memoryPanelHarness.fragment',
      loader: 'js',
    }));
  } }],
});
const compiled = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(compiled, compiled.exports);
const { default: MemoryPanel, ApiError } = compiled.exports;

function nodes(root) {
  if (root === null || root === undefined) return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object') return [];
  return [root, ...nodes(root.children)];
}
function textOf(root) {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function input(view, label) {
  const element = nodes(view.tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  assert.ok(element, `missing input: ${label}`);
  return element;
}
function press(view, label) {
  const element = nodes(view.tree).find((node) => node.type === 'Pressable' && textOf(node.children) === label);
  assert.ok(element, `missing button: ${label}`);
  assert.equal(element.props.disabled, false, `disabled button: ${label}`);
  element.props.onPress();
  view.flush();
}
function enter(view, label, value) {
  const element = input(view, label);
  assert.equal(element.props.editable, true);
  element.props.onChangeText(value);
  view.flush();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const fact = (key, value) => ({
  id: key, revision: 1, kind: 'preference', key, value, source: { type: 'user', ref: 'u' },
  recordedAt: '2026-10-31T00:00:00Z', validUntil: null,
});

test('a hidden panel retains its draft, while a connection change clears it and ignores an old save', async () => {
  const pending = deferred();
  const calls = [];
  const oldApi = {
    get: async () => ({ facts: [fact('old-fact', 'old-value')], contextRevision: 3 }),
    post: (_path, body, options) => { calls.push({ body, options }); return pending.promise; },
  };
  const newApi = { get: async () => ({ facts: [fact('new-fact', 'new-value')], contextRevision: 9 }), post: async () => { throw new Error('unexpected'); } };
  let back = 0;
  let changed = 0;
  const props = { api: oldApi, onBack: () => { back += 1; }, onMemoryChanged: () => { changed += 1; } };
  const view = harness.renderer(MemoryPanel, props);
  await view.settle();
  enter(view, '항목 이름', 'draft-key');
  enter(view, '값', 'draft-value');
  press(view, '뒤로');
  view.update(props); // Parent hides the same mounted panel.
  assert.equal(back, 1);
  assert.equal(input(view, '값').props.value, 'draft-value');
  press(view, '저장');
  assert.equal(calls.length, 1);
  view.update({ ...props, api: newApi });
  assert.equal(input(view, '값').props.value, '');
  assert.doesNotMatch(textOf(view.tree), /old-value|draft-value/);
  await view.settle();
  assert.match(textOf(view.tree), /new-value/);
  pending.resolve({ fact: fact('draft-key', 'draft-value'), contextRevision: 4 });
  await view.settle();
  assert.equal(changed, 0);
  assert.doesNotMatch(textOf(view.tree), /old-value|draft-value/);
});

for (const errorKind of ['network', 'not_configured']) {
  test(`${errorKind} screen retry keeps the original input and refreshes list and parent on success`, async () => {
    let reads = 0;
    const calls = [];
    const api = {
      get: async () => { reads += 1; return { facts: [], contextRevision: reads === 1 ? 7 : 8 }; },
      post: async (path, body, options) => {
        calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
        if (calls.length === 1) throw errorKind === 'network' ? new Error('offline') : new ApiError('not_configured', 'not configured', false, 503);
        return { fact: fact('focus', '오전'), contextRevision: 8 };
      },
    };
    let changed = 0;
    const view = harness.renderer(MemoryPanel, { api, onBack: () => {}, onMemoryChanged: () => { changed += 1; } });
    await view.settle();
    enter(view, '항목 이름', 'focus');
    enter(view, '값', '오전');
    press(view, '저장');
    await view.settle();
    if (errorKind === 'not_configured') enter(view, '값', '수정한 초안');
    else assert.equal(input(view, '값').props.editable, false);
    press(view, '같은 요청 다시 시도');
    await view.settle();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[0].body.expectedContextRevision, 7);
    assert.notEqual(calls[0].body.requestId, calls[0].options.idempotencyKey);
    assert.equal(reads, 2);
    assert.equal(changed, 1);
    assert.match(textOf(view.tree), /서버에 저장했습니다/);
    assert.equal(input(view, '값').props.value, errorKind === 'not_configured' ? '수정한 초안' : '');
  });
}

test('a conflict after a timeout keeps the outcome uncertain and offers no new-request button', async () => {
  const calls = [];
  const api = {
    get: async () => ({ facts: [], contextRevision: 7 }),
    post: async (path, body, options) => {
      calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
      if (calls.length === 1) throw new ApiError('timeout', 'timeout', true);
      throw new ApiError('conflict', 'conflict', false, 409);
    },
  };
  const view = harness.renderer(MemoryPanel, { api, onBack: () => {}, onMemoryChanged: () => assert.fail('not saved') });
  await view.settle();
  enter(view, '항목 이름', 'focus');
  enter(view, '값', '오전');
  press(view, '저장');
  await view.settle();
  press(view, '같은 요청 다시 시도');
  await view.settle();
  assert.deepEqual(calls[1], calls[0]);
  assert.match(textOf(view.tree), /이전 저장의 처리 여부는 아직 확인되지 않았습니다/);
  assert.doesNotMatch(textOf(view.tree), /최신 목록 확인 후 새 요청/);
  assert.equal(input(view, '값').props.editable, false);
});

test('optional time setup saves each numeric preference with the latest revision and leaves other fields unchanged', async () => {
  let revision = 3;
  const facts = [fact('preparationMinutes', 15)];
  const calls = [];
  const api = {
    get: async () => ({ facts: [...facts], contextRevision: revision }),
    post: async (path, body, options) => {
      calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
      assert.equal(body.expectedContextRevision, revision);
      const saved = fact(body.key, body.value);
      const index = facts.findIndex((entry) => entry.key === body.key);
      if (index < 0) facts.push(saved); else facts[index] = saved;
      return { fact: saved, contextRevision: ++revision };
    },
  };
  let changed = 0;
  let back = 0;
  const view = harness.renderer(MemoryPanel, { api, onBack: () => { back += 1; }, onMemoryChanged: () => { changed += 1; } });
  await view.settle();
  assert.match(textOf(view.tree), /현재 저장값: 15분/);
  enter(view, '준비시간 분', '45');
  enter(view, '이동시간 분', '30.5');
  enter(view, '도착 여유시간 분', '0');
  for (const label of ['준비시간', '이동시간', '도착 여유시간']) {
    press(view, `${label} 저장`);
    await view.settle();
  }
  assert.deepEqual(calls.map(({ body }) => [body.key, body.value, body.expectedContextRevision, body.kind, body.validUntil]), [
    ['preparationMinutes', 45, 3, 'preference', null],
    ['travelMinutes', 30.5, 4, 'preference', null],
    ['bufferMinutes', 0, 5, 'preference', null],
  ]);
  assert.ok(calls.every(({ path }) => path === '/v1/memory'));
  assert.equal(changed, 3);
  assert.match(textOf(view.tree), /현재 저장값: 45분/);
  press(view, '나중에 설정');
  assert.equal(back, 1);
  assert.equal(calls.length, 3);
});

test('time setup rejects empty, negative, malformed and non-finite values without writing; skip remains available', async () => {
  const calls = [];
  const api = { get: async () => ({ facts: [], contextRevision: 1 }), post: async (...args) => { calls.push(args); } };
  let back = 0;
  const view = harness.renderer(MemoryPanel, { api, onBack: () => { back += 1; }, onMemoryChanged: () => assert.fail('not saved') });
  await view.settle();
  for (const value of ['', ' ', '-1', 'abc', '1e3', 'Infinity', '9'.repeat(400)]) {
    enter(view, '준비시간 분', value);
    press(view, '준비시간 저장');
    assert.match(textOf(view.tree), /준비시간은 0 이상의 숫자/);
  }
  press(view, '나중에 설정');
  assert.equal(back, 1);
  assert.equal(calls.length, 0);
});

test('time setup retries an uncertain write with the same request and keeps other drafts', async () => {
  const calls = [];
  let revision = 7;
  let saved;
  const api = {
    get: async () => ({ facts: saved ? [saved] : [], contextRevision: revision }),
    post: async (path, body, options) => {
      calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
      if (calls.length === 1) throw new ApiError('timeout', 'timeout', true);
      saved = fact(body.key, body.value);
      return { fact: saved, contextRevision: ++revision };
    },
  };
  const view = harness.renderer(MemoryPanel, { api, onBack: () => {}, onMemoryChanged: () => {} });
  await view.settle();
  enter(view, '준비시간 분', '15');
  enter(view, '이동시간 분', '30');
  press(view, '준비시간 저장');
  await view.settle();
  assert.equal(input(view, '준비시간 분').props.editable, false);
  press(view, '같은 요청 다시 시도');
  await view.settle();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(input(view, '준비시간 분').props.value, '');
  assert.equal(input(view, '이동시간 분').props.value, '30');
  assert.match(textOf(view.tree), /현재 저장값: 15분/);
});

test('saving one time and skipping does not write the other optional fields', async () => {
  const calls = [];
  const api = {
    get: async () => ({ facts: [], contextRevision: 1 }),
    post: async (path, body) => { calls.push({ path, body }); return { fact: fact(body.key, body.value), contextRevision: 2 }; },
  };
  let back = 0;
  const view = harness.renderer(MemoryPanel, { api, onBack: () => { back += 1; }, onMemoryChanged: () => {} });
  await view.settle();
  enter(view, '이동시간 분', '30');
  press(view, '이동시간 저장');
  await view.settle();
  press(view, '나중에 설정');
  assert.equal(back, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.key, 'travelMinutes');
  assert.equal(calls[0].body.value, 30);
});
