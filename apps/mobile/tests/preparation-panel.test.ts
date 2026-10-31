import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let backHandler: (() => boolean) | undefined;

// The same small host-renderer approach used by app-integration.test.ts; no native device or server.
function createHarness() {
  let current: any;
  const fragment = Symbol('fragment');
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const jsx = (type: any, props: any, key?: any) => ({ type, props: props ?? {}, key });
  const slot = () => {
    if (!current) throw new Error('hook outside component');
    return { instance: current, index: current.index++ };
  };
  const react: any = {
    useState(initial: any) {
      const { instance, index } = slot();
      if (!instance.hooks[index]) {
        const state: any = { value: typeof initial === 'function' ? initial() : initial };
        state.set = (update: any) => {
          if (!instance.alive) return;
          const value = typeof update === 'function' ? update(state.value) : update;
          if (!Object.is(value, state.value)) { state.value = value; instance.renderer.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useRef(initial: any) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
    useMemo(factory: () => any, deps: any[]) {
      const { instance, index } = slot();
      const old = instance.hooks[index];
      if (!old || !same(old.deps, deps)) instance.hooks[index] = { deps, value: factory() };
      return instance.hooks[index].value;
    },
    useCallback(callback: any, deps: any[]) { return react.useMemo(() => callback, deps); },
    useEffect(callback: any, deps: any[]) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!same(effect.deps, deps)) {
        effect.deps = deps;
        instance.renderer.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const native = {
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch',
    BackHandler: { addEventListener: (_name: string, callback: () => boolean) => { backHandler = callback; return { remove: () => { backHandler = undefined; } }; } },
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host = { react, native, jsx, fragment, fontState: [true, null] };
  (globalThis as any).__preparationHarness = host;

  function renderer(Component: any, initialProps: any = {}) {
    const view: any = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    function render(node: any, path: string, seen: Set<string>): any {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`, seen));
      if (node.type === fragment) return render(node.props.children, `${path}.fragment`, seen);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        let instance = view.instances.get(id);
        if (!instance) { instance = { hooks: [], alive: true, renderer: view, index: 0 }; view.instances.set(id, instance); }
        seen.add(id); instance.index = 0;
        const previous = current; current = instance;
        const output = node.type(node.props); current = previous;
        return render(output, `${id}.child`, seen);
      }
      return { type: node.type, props: node.props, children: render(node.props.children, `${path}.children`, seen) };
    }
    view.flush = () => {
      for (let count = 0; view.dirty && count < 50; count += 1) {
        view.dirty = false; view.effects = [];
        const seen = new Set<string>();
        view.tree = render(jsx(Component, view.props), 'root', seen);
        for (const [id, instance] of view.instances as Map<string, any>) {
          if (!seen.has(id)) {
            instance.alive = false;
            for (const hook of instance.hooks) hook?.cleanup?.();
            view.instances.delete(id);
          }
        }
        for (const effect of view.effects) effect();
      }
      if (view.dirty) throw new Error('render did not settle');
    };
    view.update = (props: any) => { view.props = props; view.dirty = true; view.flush(); };
    view.settle = async () => { for (let i = 0; i < 5; i += 1) { await new Promise(done => setImmediate(done)); view.flush(); } };
    view.unmount = () => {
      for (const instance of view.instances.values() as Iterable<any>) {
        instance.alive = false;
        for (const hook of instance.hooks) hook?.cleanup?.();
      }
      view.instances.clear();
    };
    view.flush();
    return view;
  }
  return { renderer, jsx };
}

const harness = createHarness();
const components = build({
  stdin: { contents: `export { default as Panel } from '../src/preparation/PreparationProposalPanel';
    export { operationGuard } from '../src/api/operationGuard'; export { ApiError } from '../src/api/http';`, resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/typography)$/ }, args => ({ path: args.path, namespace: 'preparation-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'preparation-native' }, ({ path }) => ({
      contents: path === 'react' ? 'module.exports=globalThis.__preparationHarness.react' :
        path === 'react-native' ? 'module.exports=globalThis.__preparationHarness.native' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
        'exports.jsx=exports.jsxs=globalThis.__preparationHarness.jsx; exports.Fragment=globalThis.__preparationHarness.fragment', loader: 'js',
    }));
  } }],
}).then(bundled => {
  const compiled: any = { exports: {} };
  new Function('module', 'exports', bundled.outputFiles[0].text)(compiled, compiled.exports);
  return compiled.exports;
});

function nodes(root: any): any[] {
  if (root == null || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.children)];
}
function textOf(root: any): string {
  if (root == null) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function button(view: any, label: string) {
  return nodes(view.tree).find(node => node.type === 'Pressable' && textOf(node.children) === label);
}
function press(view: any, label: string) {
  const element = button(view, label); assert.ok(element, label); assert.notEqual(element.props.disabled, true);
  element.props.onPress(); view.flush();
}
function enter(view: any, label: string, value: string) {
  const element = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  assert.ok(element, label); assert.notEqual(element.props.editable, false); element.props.onChangeText(value); view.flush();
}
function deferred() {
  let resolve!: (value: unknown) => void; let reject!: (value: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const target = { id: 'event-1', revision: 4, title: '약속', kind: 'event', timeSlot: { startsAt: '2026-11-02T10:00:00+09:00', endsAt: '2026-11-02T11:00:00+09:00', timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', sourceRefs: [] };
function fill(view: any, preparation = '10', travel = '0', buffer = '5') {
  enter(view, '준비 시간 (분)', preparation); enter(view, '이동 시간 (분)', travel); enter(view, '여유 시간 (분)', buffer);
}

test('requires explicit finite nonnegative values and blocks all-zero while permitting individual zero', async t => {
  const { Panel } = await components; const calls: any[] = [];
  const view = harness.renderer(Panel, { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', api: { post: (...args: any[]) => { calls.push(args); return Promise.resolve({ result: { kind: 'proposal', message: '제안', proposalIds: ['p1'] } }); } }, onClose() {}, onProposalCreated() {} });
  t.after(() => view.unmount());
  assert.equal(button(view, '제안 생성').props.disabled, true);
  for (const bad of ['', ' ', '-1', 'Infinity', 'NaN', '1e999', 'abc', '0.00001', '150119987580']) {
    fill(view, bad, '0', '1'); assert.equal(button(view, '제안 생성').props.disabled, true, bad);
  }
  assert.match(textOf(view.tree), /밀리초 단위로 안전하게 표현/);
  fill(view, '0', '0', '0'); assert.equal(button(view, '제안 생성').props.disabled, true);
  assert.match(textOf(view.tree), /모두 0이면 생성할 변경이 없습니다/);
  fill(view, '0', '2.5', '0'); press(view, '제안 생성'); await view.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/v1/preparation-proposals');
  assert.deepEqual({ ...calls[0][1], requestId: 'id' }, { requestId: 'id', targetId: 'event-1', expectedTargetRevision: 4, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', preparationMinutes: 0, travelMinutes: 2.5, bufferMinutes: 0 });
  assert.ok(calls[0][1].requestId); assert.ok(calls[0][2].idempotencyKey);
  assert.equal(target.revision, 4); assert.match(textOf(view.tree), /별도로 승인/);
});

test('pending and uncertain lock both back controls; retry reuses exact request, success calls proposal callback only', async t => {
  const { Panel, ApiError, operationGuard } = await components; const first = deferred(); const calls: any[] = []; let closed = 0; const results: any[] = [];
  const view = harness.renderer(Panel, { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', api: { post: (...args: any[]) => { calls.push(args); return calls.length === 1 ? first.promise : Promise.resolve({ result: { kind: 'proposal', message: '만들었어요', proposalIds: ['p1'] } }); } }, onClose: () => { closed++; }, onProposalCreated: (result: any) => results.push(result) });
  t.after(() => view.unmount()); fill(view); press(view, '제안 생성');
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true); assert.equal(backHandler?.(), true); assert.equal(closed, 0);
  first.reject(new ApiError('timeout', 'timeout', true)); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true); backHandler?.(); assert.equal(closed, 0);
  press(view, '같은 요청 다시 확인'); await view.settle();
  assert.deepEqual(calls[1], calls[0]); assert.equal(operationGuard.hasUnresolved(), false); assert.deepEqual(results, [{ kind: 'proposal', message: '만들었어요', proposalIds: ['p1'] }]);
  press(view, '뒤로'); assert.equal(closed, 1);
});

test('back listener follows visibility while a pending operation stays mounted', async t => {
  const { Panel, operationGuard } = await components;
  const pending = deferred(); let closed = 0;
  const props = { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul',
    api: { post: () => pending.promise }, onClose: () => { closed++; }, onProposalCreated() {} };
  const view = harness.renderer(Panel, props);
  t.after(() => view.unmount());
  assert.equal(typeof backHandler, 'function');
  fill(view); press(view, '제안 생성');
  assert.equal(operationGuard.hasUnresolved(), true);
  view.update({ ...props, visible: false });
  assert.equal(backHandler, undefined);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(button(view, '뒤로').props.disabled, true);
  view.update({ ...props, visible: true });
  assert.equal(typeof backHandler, 'function');
  assert.equal(backHandler?.(), true); assert.equal(closed, 0);
  pending.resolve({ result: { kind: 'proposal', message: '완료', proposalIds: ['p1'] } });
  await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(backHandler?.(), true); assert.equal(closed, 1);
  view.update({ ...props, visible: false });
  assert.equal(backHandler, undefined);
});

test('question and failure are displayed without claiming a created proposal', async t => {
  const { Panel } = await components;
  for (const result of [{ kind: 'question', message: '추가 정보가 필요해요', missingFields: ['x'] }, { kind: 'failure', message: '생성할 수 없어요', code: 'conflict', retryable: false }]) {
    let callbacks = 0;
    const view = harness.renderer(Panel, { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', api: { post: async () => ({ result }) }, onClose() {}, onProposalCreated() { callbacks++; } });
    fill(view); press(view, '제안 생성'); await view.settle();
    assert.equal(callbacks, 0); assert.match(textOf(view.tree), new RegExp(result.message)); assert.ok(button(view, '다시 입력')); view.unmount();
  }
});
