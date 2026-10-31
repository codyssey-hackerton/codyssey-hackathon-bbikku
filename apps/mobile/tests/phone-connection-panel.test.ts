import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

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
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host = { react, native, jsx, fragment, fontState: [true, null] };
  (globalThis as any).__phoneConnectionHarness = host;

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
  stdin: { contents: `export { default as PhoneConnectionPanel } from '../src/contacts/PhoneConnectionPanel';
    export { ApiError } from '../src/api/http'; export { operationGuard } from '../src/api/operationGuard';`, resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/(Icon|typography)|.*ui\/typography)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents:
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
      path === 'react' ? 'module.exports=globalThis.__phoneConnectionHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__phoneConnectionHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__phoneConnectionHarness.jsx; exports.Fragment=globalThis.__phoneConnectionHarness.fragment', loader: 'js' }));
  } }],
}).then(result => { const module: any = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports); return module.exports; });

function nodes(node: any): any[] {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.children)];
}
function textOf(node: any): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return typeof node === 'object' ? textOf(node.children) : String(node);
}
function button(view: any, label: string) { return nodes(view.tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function mockApi(initial: any = { status: 'not_configured', senderNumber: null }) {
  const calls: any[] = [];
  const api: any = { status: initial, getHook: undefined,
    async get(path: string) { calls.push({ method: 'GET', path }); return api.getHook ? api.getHook(path) : api.status; },
    async post(path: string) { calls.push({ method: 'POST', path }); throw new Error('unexpected POST'); },
  };
  return { api, calls };
}
function press(view: any, label: string) { const found = button(view, label); assert.ok(found); assert.notEqual(found.props.disabled, true); found.props.onPress(); view.flush(); }

test('미설정 상태는 운영자 안내만 표시하고 GET으로 확인한다', async t => {
  const { PhoneConnectionPanel } = await components;
  const mock = mockApi(); let backs = 0;
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => backs++ }); t.after(() => view.unmount());
  await view.settle();
  assert.match(textOf(view.tree), /전화 연결이 설정되지 않았습니다.*운영자에게 문의/);
  assert.equal(nodes(view.tree).some((n: any) => n.type === 'TextInput'), false);
  assert.equal(button(view, '전화 연결 설정'), undefined);
  assert.deepEqual(mock.calls, [{ method: 'GET', path: '/v1/phone-connection' }]);
  press(view, '뒤로'); assert.equal(backs, 1);
});

test('연결 상태를 다시 조회하고 발신 번호를 표시한다', async t => {
  const { PhoneConnectionPanel } = await components;
  const mock = mockApi(); const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack() {} }); t.after(() => view.unmount());
  await view.settle(); mock.api.status = { status: 'available', senderNumber: '+15550000001', provider: 'clawops', mode: 'agent' };
  press(view, '전화 연결 상태 확인'); await view.settle();
  assert.match(textOf(view.tree), /연결됨.*\+15550000001/);
  assert.equal(mock.calls.length, 2); assert.ok(mock.calls.every((call: any) => call.method === 'GET'));
});

test('조회 실패는 접근 가능한 오류와 재시도를 제공한다', async t => {
  const { PhoneConnectionPanel } = await components;
  const mock = mockApi(); mock.api.getHook = () => { throw new Error('offline'); };
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack() {} }); t.after(() => view.unmount());
  await view.settle(); assert.ok(nodes(view.tree).some((n: any) => n.props?.accessibilityRole === 'alert'));
  assert.match(textOf(view.tree), /확인하지 못했습니다/);
  mock.api.getHook = undefined; press(view, '다시 시도'); await view.settle();
  assert.match(textOf(view.tree), /운영자에게 문의/); assert.equal(mock.calls.length, 2);
});

test('서버 전환 뒤 이전 조회 응답은 반영하지 않는다', async () => {
  const { PhoneConnectionPanel } = await components;
  const first = mockApi(); const pending = deferred<any>(); first.api.getHook = () => pending.promise;
  const second = mockApi({ status: 'available', senderNumber: '+15550000001' });
  const view = harness.renderer(PhoneConnectionPanel, { api: first.api, onBack() {} });
  view.update({ api: second.api, onBack() {} }); await view.settle();
  assert.match(textOf(view.tree), /연결됨/);
  pending.resolve({ status: 'not_configured', senderNumber: null }); await view.settle();
  assert.match(textOf(view.tree), /연결됨/); assert.doesNotMatch(textOf(view.tree), /운영자에게 문의/);
  view.unmount();
});
