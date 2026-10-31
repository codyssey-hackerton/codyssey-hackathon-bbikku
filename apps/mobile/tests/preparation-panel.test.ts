import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let backHandler: (() => boolean) | undefined;
const appStateListeners = new Set<(state: string) => void>();
const openedLinks: string[] = [];

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
    AppState: { currentState: 'active', addEventListener: (_name: string, callback: (state: string) => void) => { appStateListeners.add(callback); return { remove: () => appStateListeners.delete(callback) }; } },
    Linking: { openURL: async (url: string) => { openedLinks.push(url); } },
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
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
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
function pressAccessible(view: any, label: string) {
  const element = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  assert.ok(element, label); assert.notEqual(element.props.disabled, true); element.props.onPress(); view.flush();
}
function enter(view: any, label: string, value: string) {
  const element = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  assert.ok(element, label); assert.notEqual(element.props.editable, false); element.props.onChangeText(value); view.flush();
}
function inputValue(view: any, label: string) {
  const element = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  assert.ok(element, label); return element.props.value;
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

test('웹 준비 화면은 하드웨어 뒤로가기 리스너를 등록하지 않는다', async t => {
  const { Panel } = await components;
  const native = (globalThis as any).__preparationHarness.native;
  const originalOs = native.Platform.OS, originalBack = native.BackHandler;
  native.Platform.OS = 'web'; native.BackHandler = { addEventListener() { throw new Error('unexpected web listener'); } };
  t.after(() => { native.Platform.OS = originalOs; native.BackHandler = originalBack; });
  let closed = 0;
  const view = harness.renderer(Panel, { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', api: { get: async () => ({ facts: [], contextRevision: 1 }), post: async () => ({}) }, onClose: () => { closed++; }, onProposalCreated() {} });
  t.after(() => view.unmount()); await view.settle(); press(view, '뒤로'); assert.equal(closed, 1);
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

const memoryFact = (key: string, value: unknown, extra: any = {}) => ({
  id: `fact-${key}`, revision: 1, kind: 'preference', key, value, source: { type: 'user', ref: 'user-1' },
  recordedAt: '2020-01-01T00:00:00Z', validUntil: null, ...extra,
});
function propsWithApi(api: any) {
  return { target, expectedScheduleRevision: 9, timezone: 'Asia/Seoul', api, onClose() {}, onProposalCreated() {} };
}

test('유효한 사용자 숫자 선호만 초기 입력으로 표시하고 0은 보존한다', async t => {
  const { Panel } = await components;
  const facts = [memoryFact('preparationMinutes', 15), memoryFact('travelMinutes', 0), memoryFact('bufferMinutes', 5.5)];
  const view = harness.renderer(Panel, propsWithApi({ get: async () => ({ facts, contextRevision: 1 }), post: async () => ({}) }));
  t.after(() => view.unmount()); await view.settle();
  assert.equal(inputValue(view, '준비 시간 (분)'), '15'); assert.equal(inputValue(view, '이동 시간 (분)'), '0');
  assert.equal(inputValue(view, '여유 시간 (분)'), '5.5'); assert.match(textOf(view.tree), /저장된 선호/);
  assert.match(textOf(view.tree), /이번 일정에 맞는지 확인/);
});

test('null, 문자열, 음수, 사용자 외 출처, 미래 기록과 중복 선호는 입력하지 않는다', async t => {
  const { Panel } = await components;
  const cases = [
    [memoryFact('preparationMinutes', null)], [memoryFact('preparationMinutes', '15')], [memoryFact('preparationMinutes', -1)],
    [memoryFact('preparationMinutes', 0.00001)], [memoryFact('preparationMinutes', 10, { kind: 'observation' })],
    [memoryFact('preparationMinutes', 10, { source: { type: 'derived', ref: 'system' } })],
    [memoryFact('preparationMinutes', 10, { recordedAt: '2999-01-01T00:00:00Z' })],
    [memoryFact('preparationMinutes', 10), memoryFact('preparationMinutes', 20, { id: 'duplicate' })],
  ];
  for (const facts of cases) {
    const view = harness.renderer(Panel, propsWithApi({ get: async () => ({ facts, contextRevision: 1 }), post: async () => ({}) }));
    await view.settle(); assert.equal(inputValue(view, '준비 시간 (분)'), ''); view.unmount();
  }
});

test('늦은 조회는 사용자가 입력하거나 지운 칸을 덮지 않는다', async t => {
  const { Panel } = await components; const pending = deferred();
  const view = harness.renderer(Panel, propsWithApi({ get: () => pending.promise, post: async () => ({}) })); t.after(() => view.unmount());
  enter(view, '준비 시간 (분)', '99'); enter(view, '이동 시간 (분)', '12'); enter(view, '이동 시간 (분)', '');
  pending.resolve({ facts: [memoryFact('preparationMinutes', 10), memoryFact('travelMinutes', 20), memoryFact('bufferMinutes', 5)], contextRevision: 1 });
  await view.settle();
  assert.equal(inputValue(view, '준비 시간 (분)'), '99'); assert.equal(inputValue(view, '이동 시간 (분)'), '');
  assert.equal(inputValue(view, '여유 시간 (분)'), '5');
});

test('제안 처리 중 늦게 온 선호는 입력과 동일 요청 재시도를 바꾸지 않는다', async t => {
  const { Panel, ApiError } = await components; const memory = deferred(); const submission = deferred(); const calls: any[] = [];
  const view = harness.renderer(Panel, propsWithApi({ get: () => memory.promise, post: (...args: any[]) => { calls.push(args); return calls.length === 1 ? submission.promise : Promise.resolve({ result: { kind: 'failure', message: '실패', code: 'conflict', retryable: false } }); } }));
  t.after(() => view.unmount()); fill(view); press(view, '제안 생성');
  memory.resolve({ facts: [memoryFact('preparationMinutes', 99)], contextRevision: 1 }); await view.settle();
  assert.equal(inputValue(view, '준비 시간 (분)'), '10');
  submission.reject(new ApiError('timeout', 'timeout', true)); await view.settle();
  press(view, '같은 요청 다시 확인'); await view.settle(); assert.deepEqual(calls[1], calls[0]);
});

test('조회 실패는 직접 입력을 허용하고 재조회가 수정된 칸을 보존한다', async t => {
  const { Panel } = await components; let reads = 0;
  const view = harness.renderer(Panel, propsWithApi({ get: async () => { reads++; if (reads === 1) throw new Error('offline'); return { facts: [memoryFact('preparationMinutes', 30), memoryFact('travelMinutes', 0)], contextRevision: 1 }; }, post: async () => ({}) }));
  t.after(() => view.unmount()); await view.settle(); assert.match(textOf(view.tree), /직접 입력할 수 있습니다/);
  enter(view, '준비 시간 (분)', '9'); press(view, '저장된 시간 다시 조회'); await view.settle();
  assert.equal(inputValue(view, '준비 시간 (분)'), '9'); assert.equal(inputValue(view, '이동 시간 (분)'), '0');
});

test('만료된 저장 선호는 전송 직전에 차단하고 직접 재입력하면 사용할 수 있다', async t => {
  const { Panel } = await components; const actualNow = Date.now(); let clock = actualNow; t.mock.method(Date, 'now', () => clock);
  const calls: any[] = []; const validUntil = new Date(actualNow + 60_000).toISOString();
  const facts = [memoryFact('preparationMinutes', 10, { validUntil }), memoryFact('travelMinutes', 0), memoryFact('bufferMinutes', 5)];
  const view = harness.renderer(Panel, propsWithApi({ get: async () => ({ facts, contextRevision: 1 }), post: (...args: any[]) => { calls.push(args); return Promise.resolve({ result: { kind: 'failure', message: '실패', code: 'conflict', retryable: false } }); } }));
  t.after(() => view.unmount()); await view.settle(); clock = actualNow + 60_001;
  press(view, '제안 생성'); await view.settle(); assert.equal(calls.length, 0); assert.match(textOf(view.tree), /선호가 만료되었습니다/);
  enter(view, '준비 시간 (분)', '10'); press(view, '제안 생성'); await view.settle(); assert.equal(calls.length, 1);
});

test('조회 요청 후 응답 전에 만료된 선호는 채우지 않는다', async t => {
  const { Panel } = await components; const actualNow = Date.now(); let clock = actualNow; t.mock.method(Date, 'now', () => clock);
  const pending = deferred(); const view = harness.renderer(Panel, propsWithApi({ get: () => pending.promise, post: async () => ({}) }));
  t.after(() => view.unmount()); clock = actualNow + 60_001;
  pending.resolve({ facts: [memoryFact('preparationMinutes', 10, { validUntil: new Date(actualNow + 60_000).toISOString() })], contextRevision: 1 });
  await view.settle(); assert.equal(inputValue(view, '준비 시간 (분)'), '');
});

test('계정 전환으로 이전 폼이 제거되면 늦은 이전 계정 응답은 새 폼에 반영되지 않는다', async t => {
  const { Panel } = await components; const oldRequest = deferred();
  const oldView = harness.renderer(Panel, propsWithApi({ get: () => oldRequest.promise, post: async () => ({}) }));
  oldView.unmount();
  const view = harness.renderer(Panel, propsWithApi({ get: async () => ({ facts: [memoryFact('preparationMinutes', 8)], contextRevision: 1 }), post: async () => ({}) }));
  t.after(() => view.unmount()); await view.settle();
  oldRequest.resolve({ facts: [memoryFact('preparationMinutes', 99)], contextRevision: 1 }); await view.settle();
  assert.equal(inputValue(view, '준비 시간 (분)'), '8');
});

const originPlace = { id: 'origin', name: '출발점', address: '출발 주소', roadAddress: '', longitude: 127.1, latitude: 37.4 };
const destinationPlace = { id: 'destination', name: '도착점', address: '도착 주소', roadAddress: '', longitude: 127.2, latitude: 37.5 };
const weatherResponse = { provider: 'open-meteo', timezone: 'Asia/Seoul', forecastTime: '2026-11-02T10:00:00+09:00', temperatureC: 0,
  apparentTemperatureC: null, precipitationMm: 0, precipitationProbabilityPercent: 45, windSpeedKmh: 2,
  fetchedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-01T00:05:00Z', remainingTtlMs: 300_000, sourceUrl: 'https://open-meteo.com/', licenseUrl: 'https://open-meteo.com/en/licence' };
function estimateResponse() {
  const now = Date.now();
  return { durationMinutes: 23, provider: 'kakao', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), mode: 'walk' };
}
function routeApi(travelPost?: (...args: any[]) => any) {
  return {
    get: async (path: string) => path.startsWith('/v1/places/search?') ?
      { places: path.includes(encodeURIComponent('출발')) ? [originPlace] : [destinationPlace] } : { facts: [], contextRevision: 1 },
    post: travelPost ?? (async () => estimateResponse()),
  };
}
async function selectRoute(view: any) {
  enter(view, '출발 장소 검색어', '출발'); press(view, '출발 장소 검색'); await view.settle();
  pressAccessible(view, '출발 장소 장소 선택 출발점 출발 주소');
  enter(view, '도착 장소 검색어', '도착'); press(view, '도착 장소 검색'); await view.settle();
  pressAccessible(view, '도착 장소 장소 선택 도착점 도착 주소'); press(view, '도보');
}

test('장소와 수단을 선택해 조회한 뒤 명시적으로 확인해야 이동시간에 적용한다', async t => {
  const { Panel } = await components; const calls: any[] = [];
  const api = routeApi(async (...args: any[]) => { calls.push(args); return estimateResponse(); });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle();
  fill(view, '10', '7', '5'); assert.match(textOf(view.tree), /검색어는 Kakao에 전달/);
  await selectRoute(view); press(view, '이동 시간 조회'); await view.settle();
  assert.equal(inputValue(view, '이동 시간 (분)'), '7'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['/v1/travel/estimate', { origin: { longitude: 127.1, latitude: 37.4 }, destination: { longitude: 127.2, latitude: 37.5 }, mode: 'walk' }, { idempotencyKey: '' }]);
  press(view, '이동시간에 사용'); assert.equal(inputValue(view, '이동 시간 (분)'), '23');
  assert.match(textOf(view.tree), /확인한 경로 조회 결과/); assert.match(textOf(view.tree), /미래 약속 시각의 이동 시간을 보장하지 않습니다/);
  press(view, '대중교통'); assert.equal(button(view, '제안 생성').props.disabled, true);
  assert.match(textOf(view.tree), /이전 이동시간을 사용할 수 없습니다/);
  enter(view, '이동 시간 (분)', '17'); assert.equal(button(view, '제안 생성').props.disabled, false);
  press(view, '자동차'); assert.equal(inputValue(view, '이동 시간 (분)'), '17'); assert.equal(button(view, '제안 생성').props.disabled, false);
});

test('검색어 편집 후 늦은 장소 결과는 표시하지 않고 오류와 빈 결과를 구분한다', async t => {
  const { Panel, ApiError } = await components; const pending = deferred(); let count = 0;
  const api = { get: (path: string) => { if (!path.startsWith('/v1/places/search?')) return Promise.resolve({ facts: [], contextRevision: 1 });
    count++; if (count === 1) return pending.promise; if (count === 2) return Promise.resolve({ places: [] }); throw new ApiError('not_configured', 'no', false, 503); }, post: async () => ({}) };
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle();
  enter(view, '출발 장소 검색어', '이전'); press(view, '출발 장소 검색'); enter(view, '출발 장소 검색어', '새 검색');
  pending.resolve({ places: [originPlace] }); await view.settle();
  assert.equal(nodes(view.tree).some(node => node.props?.accessibilityLabel?.includes('장소 선택 출발점')), false);
  press(view, '출발 장소 검색'); await view.settle(); assert.match(textOf(view.tree), /검색 결과가 없습니다/);
  press(view, '출발 장소 검색'); await view.settle(); assert.match(textOf(view.tree), /장소 검색이 설정되지 않았습니다/);
  assert.doesNotMatch(textOf(view.tree), /검색 결과가 없습니다/);
});

test('경로 조회 중 수단 변경과 제안 제출은 늦은 결과 적용을 막는다', async t => {
  const { Panel } = await components; const pending = deferred(); const submit = deferred();
  const api = routeApi((path: string) => path === '/v1/travel/estimate' ? pending.promise : submit.promise);
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회'); press(view, '자동차');
  pending.resolve(estimateResponse());
  await view.settle(); assert.equal(button(view, '이동시간에 사용'), undefined);
  assert.equal(inputValue(view, '이동 시간 (분)'), '0');
  press(view, '제안 생성'); assert.equal(button(view, '출발 장소 검색').props.disabled, true);
  assert.equal(button(view, '자동차 선택됨').props.disabled, true);
  submit.resolve({ result: { kind: 'failure', message: '실패', code: 'conflict', retryable: false } }); await view.settle();
});

test('유효기간이 지난 경로 결과는 사용자 확인 시 적용하지 않는다', async t => {
  const { Panel } = await components; const base = Date.now(); let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const api = routeApi(async () => ({ durationMinutes: 23, provider: 'kakao', fetchedAt: new Date(base).toISOString(), expiresAt: new Date(base + 300_000).toISOString(), mode: 'walk' }));
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회'); await view.settle(); elapsed = 300_001;
  press(view, '이동시간에 사용'); assert.equal(inputValue(view, '이동 시간 (분)'), '0'); assert.match(textOf(view.tree), /조회 결과가 만료/);
});

test('지원하지 않는 수단과 권한 오류는 자동 대체하지 않고 수동 입력을 유지한다', async t => {
  const { Panel, ApiError } = await components;
  for (const [code, message] of [['unsupported', '지원을 하지 않습니다'], ['not_configured', '설정되지 않았습니다'], ['permission_denied', '권한이나 연결'], ['no_route', '경로를 찾지 못했습니다']] as const) {
    const calls: any[] = [];
    const api = routeApi(async (...args: any[]) => { calls.push(args); throw new ApiError(code, 'error', false, 422); });
    const view = harness.renderer(Panel, propsWithApi(api)); await view.settle(); fill(view, '10', '7', '5');
    await selectRoute(view); press(view, '대중교통'); press(view, '이동 시간 조회'); await view.settle();
    assert.equal(calls.length, 1); assert.equal(calls[0][1].mode, 'transit');
    assert.match(textOf(view.tree), new RegExp(message === '지원을 하지 않습니다' ? '지원을? 하지 않습니다|지원하지 않습니다' : message));
    assert.equal(inputValue(view, '이동 시간 (분)'), '7'); assert.equal(button(view, '제안 생성').props.disabled, false); view.unmount();
  }
});

test('제안 처리 중 돌아온 경로 응답은 입력이나 확인 버튼을 바꾸지 않는다', async t => {
  const { Panel } = await components; const route = deferred(); const submit = deferred();
  const api = routeApi((path: string) => path === '/v1/travel/estimate' ? route.promise : submit.promise);
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회'); press(view, '제안 생성');
  route.resolve(estimateResponse());
  await view.settle(); assert.equal(inputValue(view, '이동 시간 (분)'), '0'); assert.equal(button(view, '이동시간에 사용'), undefined);
  submit.resolve({ result: { kind: 'failure', message: '실패', code: 'conflict', retryable: false } }); await view.settle();
});

test('적용한 경로가 제안 직전에 만료되면 전송하지 않는다', async t => {
  const { Panel } = await components; const base = Date.now(); let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const calls: string[] = [];
  const api = routeApi(async (path: string) => { calls.push(path); return { durationMinutes: 23, provider: 'kakao', fetchedAt: new Date(base).toISOString(), expiresAt: new Date(base + 300_000).toISOString(), mode: 'walk' }; });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회'); await view.settle(); press(view, '이동시간에 사용');
  elapsed = 300_001; press(view, '제안 생성');
  assert.deepEqual(calls, ['/v1/travel/estimate']); assert.match(textOf(view.tree), /경로 조회 결과가 만료되었거나/);
  assert.equal(button(view, '제안 생성').props.disabled, true);
});

test('계정 전환으로 제거된 폼의 늦은 장소 결과는 새 폼에 나타나지 않는다', async t => {
  const { Panel } = await components; const pending = deferred();
  const oldApi = { get: (path: string) => path.startsWith('/v1/places/search?') ? pending.promise : Promise.resolve({ facts: [], contextRevision: 1 }), post: async () => ({}) };
  const old = harness.renderer(Panel, propsWithApi(oldApi)); await old.settle();
  enter(old, '출발 장소 검색어', '출발'); press(old, '출발 장소 검색'); old.unmount();
  const view = harness.renderer(Panel, propsWithApi(routeApi())); t.after(() => view.unmount()); await view.settle();
  pending.resolve({ places: [originPlace] }); await view.settle();
  assert.equal(inputValue(view, '출발 장소 검색어'), '');
  assert.equal(nodes(view.tree).some(node => node.props?.accessibilityLabel?.includes('장소 선택 출발점')), false);
});

test('앱 비활성화는 경로 결과와 적용값을 무효화하고 수동값은 보존한다', async t => {
  const { Panel } = await components;
  const view = harness.renderer(Panel, propsWithApi(routeApi())); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회'); await view.settle(); press(view, '이동시간에 사용');
  for (const listener of appStateListeners) listener('inactive'); view.flush();
  for (const listener of appStateListeners) listener('active'); view.flush();
  assert.equal(button(view, '이동시간에 사용'), undefined); assert.equal(button(view, '제안 생성').props.disabled, true);
  assert.match(textOf(view.tree), /앱 상태가 바뀌어 이전 이동시간을 사용할 수 없습니다/);
  enter(view, '이동 시간 (분)', '11');
  for (const listener of appStateListeners) listener('background'); view.flush();
  for (const listener of appStateListeners) listener('active'); view.flush();
  assert.equal(inputValue(view, '이동 시간 (분)'), '11'); assert.equal(button(view, '제안 생성').props.disabled, false);
});

test('백그라운드 전 시작한 경로 조회의 늦은 응답은 복귀 후에도 폐기한다', async t => {
  const { Panel } = await components; const pending = deferred();
  const view = harness.renderer(Panel, propsWithApi(routeApi(() => pending.promise))); t.after(() => view.unmount()); await view.settle(); fill(view);
  await selectRoute(view); press(view, '이동 시간 조회');
  for (const listener of appStateListeners) listener('background');
  for (const listener of appStateListeners) listener('active'); view.flush();
  pending.resolve(estimateResponse()); await view.settle();
  assert.equal(button(view, '이동시간에 사용'), undefined); assert.equal(inputValue(view, '이동 시간 (분)'), '0');
});

test('도착 장소와 약속 시각의 날씨는 사용자 요청 후 출처와 시간 기준을 표시한다', async t => {
  const { Panel } = await components; const calls: any[] = [];
  const api = routeApi(async (...args: any[]) => { calls.push(args); return weatherResponse; });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle();
  enter(view, '도착 장소 검색어', '도착'); press(view, '도착 장소 검색'); await view.settle();
  pressAccessible(view, '도착 장소 장소 선택 도착점 도착 주소'); press(view, '날씨 정보 열기');
  assert.equal(calls.length, 0); press(view, '날씨 조회'); await view.settle();
  assert.deepEqual(calls[0], ['/v1/weather/forecast', { destination: { latitude: 37.5, longitude: 127.2 }, appointmentAt: target.timeSlot.startsAt }, { idempotencyKey: '' }]);
  assert.match(textOf(view.tree), /해당 정각 기온 0°C/); assert.match(textOf(view.tree), /체감 미제공/);
  assert.match(textOf(view.tree), /해당 정각 직전 1시간 강수량 0mm/); assert.match(textOf(view.tree), /강수확률 45%/);
  assert.match(textOf(view.tree), /출처: Open-Meteo/); assert.match(textOf(view.tree), /CC BY 4.0/);
  const link = nodes(view.tree).find(node => node.type === 'Text' && textOf(node.children) === '출처: Open-Meteo');
  assert.equal(link.props.accessibilityRole, 'link'); link.props.onPress(); assert.equal(openedLinks.at(-1), 'https://open-meteo.com/');
  assert.equal(inputValue(view, '이동 시간 (분)'), '');
});

test('도착 장소가 바뀌면 늦은 날씨 응답을 폐기하고 예보 실패를 구분한다', async t => {
  const { Panel, ApiError } = await components; const pending = deferred(); let count = 0;
  const api = routeApi(() => { count++; if (count === 1) return pending.promise; throw new ApiError('unsupported_range', 'range', false, 422); });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle();
  enter(view, '도착 장소 검색어', '도착'); press(view, '도착 장소 검색'); await view.settle();
  pressAccessible(view, '도착 장소 장소 선택 도착점 도착 주소'); press(view, '날씨 정보 열기'); press(view, '날씨 조회');
  enter(view, '도착 장소 검색어', '변경'); pending.resolve(weatherResponse); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /강수확률 45%/); assert.equal(button(view, '날씨 조회').props.disabled, true);
  enter(view, '도착 장소 검색어', '도착'); press(view, '도착 장소 검색'); await view.settle();
  pressAccessible(view, '도착 장소 장소 선택 도착점 도착 주소'); press(view, '날씨 조회'); await view.settle();
  assert.match(textOf(view.tree), /선택한 약속 시각의 예보를 제공하지 않습니다/);
});

test('약속 시각 변경과 백그라운드 복귀 전 시작한 날씨 응답은 표시하지 않는다', async t => {
  const { Panel } = await components; const first = deferred(); const second = deferred(); let calls = 0;
  const api = routeApi(() => (++calls === 1 ? first.promise : second.promise)); const props = propsWithApi(api);
  const view = harness.renderer(Panel, props); t.after(() => view.unmount()); await view.settle();
  enter(view, '도착 장소 검색어', '도착'); press(view, '도착 장소 검색'); await view.settle();
  pressAccessible(view, '도착 장소 장소 선택 도착점 도착 주소'); press(view, '날씨 정보 열기'); press(view, '날씨 조회');
  const later = { ...target, timeSlot: { ...target.timeSlot, startsAt: '2026-11-02T11:00:00+09:00' } };
  view.update({ ...props, target: later }); first.resolve(weatherResponse); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /강수확률 45%/);
  press(view, '날씨 조회');
  for (const listener of appStateListeners) listener('background');
  for (const listener of appStateListeners) listener('active'); view.flush();
  second.resolve({ ...weatherResponse, forecastTime: '2026-11-02T11:00:00+09:00' }); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /강수확률 45%/);
});

test('지하철은 사용자가 입력한 역을 조회하고 생성 시각과 오래된 원문을 구분한다', async t => {
  const { Panel } = await components; const calls: any[] = [];
  const api = routeApi(async (...args: any[]) => { calls.push(args); return { provider: 'seoul', stationName: '테스트역', fetchedAt: '2026-11-01T00:03:00Z', arrivals: [
    { lineId: '1002', direction: '상행', destination: '종착', arrivalSeconds: 45, message: '진입', detailMessage: '', observedAt: '2026-11-01T00:02:50Z', stale: false, staleInMs: 110_000 },
    { lineId: '1003', direction: '하행', destination: '종착', arrivalSeconds: 0, message: '과거 원문', detailMessage: '이전 역', observedAt: '2026-11-01T00:00:00Z', stale: true, staleInMs: 0 },
  ] }; });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view, '10', '12', '5');
  press(view, '지하철 정보 열기'); enter(view, '서울 지하철 역 이름', '테스트역'); press(view, '지하철 도착 조회'); await view.settle();
  assert.deepEqual(calls[0], ['/v1/subway/arrivals', { stationName: '테스트역' }, { idempotencyKey: '' }]);
  assert.match(textOf(view.tree), /조회 응답 시 남은 시간 45초/); assert.match(textOf(view.tree), /오래된 정보/);
  assert.match(textOf(view.tree), /정보 생성: 2026-11-01T00:00:00Z/); assert.match(textOf(view.tree), /원문: 과거 원문/);
  assert.match(textOf(view.tree), /출처: 서울 열린데이터광장/); assert.match(textOf(view.tree), /자동 갱신되지 않습니다/);
  assert.equal(inputValue(view, '이동 시간 (분)'), '12');
  const link = nodes(view.tree).find(node => node.type === 'Text' && textOf(node.children) === '출처: 서울 열린데이터광장');
  assert.equal(link.props.accessibilityRole, 'link'); link.props.onPress(); assert.match(openedLinks.at(-1)!, /^https:\/\/data\.seoul\.go\.kr\//);
});

test('지하철 빈 결과, 미설정, 요청 제한을 구분하고 늦은 이전 역 응답은 버린다', async t => {
  const { Panel, ApiError } = await components; const pending = deferred(); let count = 0;
  const api = routeApi(() => { count++; if (count === 1) return pending.promise; if (count === 2) return { provider: 'seoul', stationName: '새역', fetchedAt: '2026-11-01T00:00:00Z', arrivals: [] };
    throw new ApiError(count === 3 ? 'not_configured' : 'rate_limited', 'error'); });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle();
  press(view, '지하철 정보 열기'); enter(view, '서울 지하철 역 이름', '옛역'); press(view, '지하철 도착 조회');
  enter(view, '서울 지하철 역 이름', '새역'); pending.resolve({ provider: 'seoul', stationName: '옛역', fetchedAt: '2026-11-01T00:00:00Z', arrivals: [] }); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /현재 제공된 도착 정보가 없습니다/);
  press(view, '지하철 도착 조회'); await view.settle(); assert.match(textOf(view.tree), /현재 제공된 도착 정보가 없습니다/);
  press(view, '지하철 도착 조회'); await view.settle(); assert.match(textOf(view.tree), /서울 지하철 조회가 설정되지 않았습니다/);
  press(view, '지하철 도착 조회'); await view.settle(); assert.match(textOf(view.tree), /조회가 많아 잠시 후 다시 시도/);
});

test('지하철은 응답 지연과 화면 표시 경과시간을 포함해 항목을 오래된 정보로 전환한다', async t => {
  const { Panel } = await components; let clock = 0; t.mock.method(performance, 'now', () => clock);
  const pending = deferred(); const api = routeApi(() => pending.promise); const props = propsWithApi(api);
  const view = harness.renderer(Panel, props); t.after(() => view.unmount()); await view.settle();
  press(view, '지하철 정보 열기'); enter(view, '서울 지하철 역 이름', '테스트역'); press(view, '지하철 도착 조회');
  clock = 700;
  pending.resolve({ provider: 'seoul', stationName: '테스트역', fetchedAt: '2026-11-01T00:00:00Z', arrivals: [
    { lineId: '1002', direction: '상행', destination: '종착', arrivalSeconds: 45, message: '진입', detailMessage: '', observedAt: '2026-11-01T00:00:00Z', stale: false, staleInMs: 1_000 },
  ] });
  await view.settle(); assert.match(textOf(view.tree), /조회 응답 시 남은 시간 45초/);
  clock = 1_000; view.update(props);
  assert.match(textOf(view.tree), /오래된 정보/); assert.doesNotMatch(textOf(view.tree), /조회 응답 시 남은 시간 45초/);
});

test('이미 경과한 staleInMs는 응답 수신 즉시 오래된 정보로 표시한다', async t => {
  const { Panel } = await components; let clock = 0; t.mock.method(performance, 'now', () => clock);
  const pending = deferred(); const view = harness.renderer(Panel, propsWithApi(routeApi(() => pending.promise))); t.after(() => view.unmount()); await view.settle();
  press(view, '지하철 정보 열기'); enter(view, '서울 지하철 역 이름', '테스트역'); press(view, '지하철 도착 조회'); clock = 500;
  pending.resolve({ provider: 'seoul', stationName: '테스트역', fetchedAt: '2026-11-01T00:00:00Z', arrivals: [
    { lineId: '1002', direction: '', destination: '', arrivalSeconds: 45, message: '진입', detailMessage: '', observedAt: '2026-11-01T00:00:00Z', stale: false, staleInMs: 400 },
  ] }); await view.settle();
  assert.match(textOf(view.tree), /오래된 정보/); assert.doesNotMatch(textOf(view.tree), /조회 응답 시 남은 시간 45초/);
});

test('제안 처리 중 날씨와 지하철 조회는 잠기고 직접 입력은 보존한다', async t => {
  const { Panel } = await components; const pending = deferred(); let calls = 0;
  const api = routeApi(() => { calls++; return pending.promise; });
  const view = harness.renderer(Panel, propsWithApi(api)); t.after(() => view.unmount()); await view.settle(); fill(view, '10', '12', '5');
  press(view, '지하철 정보 열기'); enter(view, '서울 지하철 역 이름', '테스트역'); press(view, '날씨 정보 열기');
  press(view, '제안 생성'); assert.equal(button(view, '지하철 도착 조회').props.disabled, true);
  assert.equal(button(view, '날씨 조회').props.disabled, true); assert.equal(inputValue(view, '이동 시간 (분)'), '12'); assert.equal(calls, 1);
  pending.resolve({ result: { kind: 'failure', message: '실패', code: 'conflict', retryable: false } }); await view.settle();
});
