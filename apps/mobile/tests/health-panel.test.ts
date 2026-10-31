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
  (globalThis as any).__healthPanelHarness = host;

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
  stdin: { contents: `export { default as HealthPanel } from '../src/health/HealthPanel';`, resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/native-adapter|\.\/(Icon|typography)|.*ui\/typography)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents:
      path === './native-adapter' ? 'exports.createHealthAdapter=()=>globalThis.__healthAdapter' :
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
      path === 'react' ? 'module.exports=globalThis.__healthPanelHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__healthPanelHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__healthPanelHarness.jsx; exports.Fragment=globalThis.__healthPanelHarness.fragment', loader: 'js' }));
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
function press(view: any, label: string) { const found = button(view, label); assert.ok(found, label); assert.notEqual(found.props.disabled, true); found.props.onPress(); view.flush(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const calls: any[] = [];
  const adapter: any = {
    availability: async () => { calls.push(['availability']); return { status: 'available', source: 'apple_health' }; },
    connect: async (selection: any) => { calls.push(['connect', { ...selection }]); return { steps: selection.steps ? 'granted' : 'not_selected', workouts: selection.workouts ? 'granted' : 'not_selected' }; },
    read: async (input: any) => { calls.push(['read', input]); return { source: 'apple_health', lastSyncedAt: input.now, timezone: input.timezone, selection: input.selection,
      status: 'ok', truncated: false, workoutsAvailability: input.selection.workouts ? 'available' : 'not_selected',
      stepsByDay: input.selection.steps ? [{ date: input.now.slice(0, 10), steps: 1234 }] : [], workouts: [] }; },
    openSettings: async () => { calls.push(['settings']); },
  };
  (globalThis as any).__healthAdapter = adapter;
  return { adapter, calls };
}

test('건강 항목은 명시 선택과 연결 전 읽지 않으며 선택 변경 시 이전 결과를 지운다', async t => {
  const { HealthPanel } = await components; const { calls } = fixture();
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle(); assert.deepEqual(calls, [['availability']]);
  assert.equal(button(view, '연결하기').props.disabled, true);
  assert.match(textOf(view.tree), /서버나 AI로 전송하지 않습니다/);
  press(view, '걸음 수 선택'); press(view, '연결하기'); await view.settle();
  assert.deepEqual(calls[1], ['connect', { steps: true, workouts: false }]);
  assert.deepEqual(calls[2][1].selection, { steps: true, workouts: false });
  assert.match(textOf(view.tree), /1,234걸음/); assert.match(textOf(view.tree), /운동 기록 구간: 미수집/);
  press(view, '운동 기록 선택'); assert.doesNotMatch(textOf(view.tree), /1,234걸음/);
  assert.equal(button(view, '다시 동기화'), undefined); assert.equal(calls.length, 3);
});

test('권한 미확인과 데이터 없음을 허용이나 거부로 단정하지 않고 연결해제는 메모리만 비운다', async t => {
  const { HealthPanel } = await components; const { adapter, calls } = fixture();
  adapter.connect = async (selection: any) => { calls.push(['connect', selection]); return { steps: 'unknown', workouts: 'unknown' }; };
  adapter.read = async (input: any) => { calls.push(['read', input]); return { source: 'apple_health', lastSyncedAt: input.now, timezone: input.timezone, selection: input.selection,
    status: 'no_data_or_access', truncated: false, workoutsAvailability: 'no_data_or_access', stepsByDay: [], workouts: [] }; };
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle(); press(view, '걸음 수 선택'); press(view, '운동 기록 선택'); press(view, '연결하기'); await view.settle();
  assert.match(textOf(view.tree), /권한과 데이터 유무를 확인할 수 없음/); assert.match(textOf(view.tree), /미수집/);
  assert.match(textOf(view.tree), /일시정지를 포함한 시작~종료 구간이며 실제 운동 수행 시간과 다를 수 있어요/);
  assert.doesNotMatch(textOf(view.tree), /읽기 권한 확인됨|읽기 권한 없음/);
  press(view, '연결해제'); assert.doesNotMatch(textOf(view.tree), /최근 7일.*출처/);
  assert.match(textOf(view.tree), /기기의 건강 권한은 별도로 변경/); assert.equal(calls.filter(item => item[0] === 'settings').length, 0);
});

test('권한 거부 항목은 읽지 않으며 시간대가 바뀐 뒤 늦은 결과를 표시하지 않는다', async t => {
  const { HealthPanel } = await components; const { adapter, calls } = fixture(); const pending = deferred<any>();
  adapter.connect = async () => ({ steps: 'granted', workouts: 'denied' });
  adapter.read = async (input: any) => { calls.push(['read', input]); return pending.promise; };
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle(); press(view, '걸음 수 선택'); press(view, '운동 기록 선택'); press(view, '연결하기'); await view.settle();
  assert.deepEqual(calls.find(item => item[0] === 'read')[1].selection, { steps: true, workouts: false });
  view.update({ timezone: 'Asia/Seoul', onBack() {} });
  const request = calls.find(item => item[0] === 'read')[1];
  pending.resolve({ source: 'apple_health', lastSyncedAt: request.now, timezone: 'UTC', selection: request.selection,
    status: 'ok', truncated: false, workoutsAvailability: 'not_selected', stepsByDay: [{ date: request.now.slice(0, 10), steps: 9876 }], workouts: [] });
  await view.settle(); assert.doesNotMatch(textOf(view.tree), /9,876걸음/);
});

test('어댑터의 반환 선택 항목이 요청과 다르면 결과를 버린다', async t => {
  const { HealthPanel } = await components; const { adapter } = fixture();
  adapter.read = async (input: any) => ({ source: 'health_connect', lastSyncedAt: new Date().toISOString(), timezone: input.timezone,
    selection: { steps: true, workouts: true }, status: 'ok', truncated: false, workoutsAvailability: 'available',
    stepsByDay: [{ date: input.now.slice(0, 10), steps: 9876 }], workouts: [] });
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle(); press(view, '걸음 수 선택'); press(view, '연결하기'); await view.settle();
  assert.match(textOf(view.tree), /건강 데이터를 확인하지 못했습니다/);
  assert.doesNotMatch(textOf(view.tree), /9,876걸음|조회 요약/);
  assert.equal(button(view, '다시 동기화'), undefined);
});

test('미지원 환경은 개발 빌드 안내만 표시하고 권한이나 데이터를 읽지 않는다', async t => {
  const { HealthPanel } = await components; const { adapter, calls } = fixture();
  adapter.availability = async () => { calls.push(['availability']); return { status: 'unsupported', source: null, reason: 'needs_dev_build' }; };
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle(); press(view, '걸음 수 선택'); assert.match(textOf(view.tree), /Expo Go.*개발 빌드/);
  assert.equal(button(view, '연결하기'), undefined); assert.deepEqual(calls, [['availability']]);
});

test('Android 9 미만은 OS 버전 요구 사항을 표시하고 건강 데이터를 읽지 않는다', async t => {
  const { HealthPanel } = await components; const { adapter, calls } = fixture();
  adapter.availability = async () => { calls.push(['availability']); return { status: 'unsupported', source: 'health_connect', reason: 'unsupported' }; };
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  await view.settle();
  assert.match(textOf(view.tree), /Android 9\(API 28\) 이상/);
  assert.doesNotMatch(textOf(view.tree), /Expo Go|개발 빌드/);
  assert.equal(button(view, '연결하기'), undefined); assert.deepEqual(calls, [['availability']]);
});

test('iOS는 직접 설정 경로를 안내하고 Android에서만 Health Connect 설정을 연다', async t => {
  const { HealthPanel } = await components; const { calls } = fixture();
  const platform = (globalThis as any).__healthPanelHarness.native.Platform;
  const previous = platform.OS; t.after(() => { platform.OS = previous; });
  platform.OS = 'ios';
  const ios = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} });
  await ios.settle();
  assert.match(textOf(ios.tree), /건강 앱에서 프로필 사진 → 개인정보 보호의 앱/);
  assert.match(textOf(ios.tree), /앱 설정은 건강 읽기 권한 화면이 아닙니다/);
  assert.match(textOf(ios.tree), /조회 결과가 없어도 읽기 권한이 거부되었는지는 알 수 없습니다/);
  assert.equal(button(ios, 'Health Connect 설정'), undefined);
  assert.equal(button(ios, 'OS 건강 권한 설정'), undefined);
  ios.unmount();
  platform.OS = 'android';
  const android = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => android.unmount());
  await android.settle(); press(android, 'Health Connect 설정'); await android.settle();
  assert.equal(calls.filter(item => item[0] === 'settings').length, 1);
});

test('조회 완료 시각으로 요약하고 화면에서 만료되면 신호를 숨긴다', async t => {
  const { HealthPanel } = await components; const { adapter, calls } = fixture();
  const oldNow = Date.now; const oldSetTimeout = globalThis.setTimeout; const oldClearTimeout = globalThis.clearTimeout;
  let fire: (() => void) | undefined;
  t.after(() => { Date.now = oldNow; globalThis.setTimeout = oldSetTimeout; globalThis.clearTimeout = oldClearTimeout; });
  const originalRead = adapter.read;
  adapter.read = async (input: any) => {
    await new Promise(done => oldSetTimeout(done, 10));
    return { ...await originalRead(input), lastSyncedAt: new Date().toISOString() };
  };
  const view = harness.renderer(HealthPanel, { timezone: 'UTC', onBack() {} }); t.after(() => view.unmount());
  globalThis.setTimeout = ((callback: () => void) => { fire = callback; return 1 as any; }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  await view.settle(); press(view, '걸음 수 선택'); press(view, '연결하기');
  await new Promise(done => oldSetTimeout(done, 20)); await view.settle();
  assert.match(textOf(view.tree), /조회 요약/);
  assert.doesNotMatch(textOf(view.tree), /이전 조회 결과입니다/);
  Date.now = () => oldNow() + 300_001;
  assert.ok(fire); fire(); view.flush();
  assert.doesNotMatch(textOf(view.tree), /조회 요약/);
  assert.match(textOf(view.tree), /이전 조회 결과입니다/);
  // Reopening a hidden panel also checks expiry without another device read.
  view.update({ timezone: 'UTC', onBack() {}, visible: false });
  view.update({ timezone: 'UTC', onBack() {}, visible: true });
  assert.doesNotMatch(textOf(view.tree), /조회 요약/);
  assert.match(textOf(view.tree), /이전 조회 결과입니다/);
  assert.equal(calls.filter(item => item[0] === 'read').length, 1);
});
