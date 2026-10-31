import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Render the real app/ProposalPanel with native views and unrelated screens replaced by local test doubles.
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
  const host: any = { react, native, jsx, fragment, marker: 0, fontState: [true, null] };
  (globalThis as any).__appIntegrationHarness = host;

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
        for (const [id, instance] of view.instances) {
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
    view.settle = async () => { for (let i = 0; i < 5; i += 1) { await new Promise((done) => setImmediate(done)); view.flush(); } };
    view.unmount = () => { for (const instance of view.instances.values()) { instance.alive = false; for (const hook of instance.hooks) hook?.cleanup?.(); } view.instances.clear(); };
    view.flush();
    return view;
  }
  return { renderer };
}

const harness = createHarness();
const testDir = resolve(__dirname);
const components = build({
  stdin: { contents: `export { default } from '../App'; export { operationGuard } from '../src/api/operationGuard';
    import { useMutation } from '../src/api/useMutation'; import { jsx } from 'react/jsx-runtime';
    export function MutationTester({ run }) { const action = useMutation(run); return jsx('MutationTester', action); }`,
    resolveDir: testDir, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.otf': 'empty', '.ttf': 'empty' },
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|react-native-safe-area-context|expo-status-bar|expo-font|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface))$/ }, (args) => ({ path: args.path, namespace: 'app-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'app-native' }, ({ path }) => ({
      contents: path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"; exports.FontReadyContext={Provider:({children})=>children}' :
        path === 'expo-font' ? 'exports.useFonts=()=>globalThis.__appIntegrationHarness.fontState' :
        path === 'react' ? 'module.exports = globalThis.__appIntegrationHarness.react' :
        path === 'react-native' ? 'module.exports = globalThis.__appIntegrationHarness.native' :
        path === 'react-native-safe-area-context' ? 'exports.SafeAreaProvider = ({children}) => children; exports.SafeAreaView = "View"' :
        path === 'expo-status-bar' ? 'exports.StatusBar = "StatusBar"' :
          'exports.jsx = exports.jsxs = globalThis.__appIntegrationHarness.jsx; exports.Fragment = globalThis.__appIntegrationHarness.fragment', loader: 'js',
    }));
    builder.onResolve({ filter: /^\.\/src\/(chat\/ChatScreen|memory\/MemoryPanel|screens\/CalendarScreen|screens\/DayScreen)$/ }, (args) => ({ path: args.path, namespace: 'app-screen' }));
    builder.onLoad({ filter: /.*/, namespace: 'app-screen' }, ({ path }) => ({
      contents: path.endsWith('ChatScreen')
        ? 'const R=require("react"), {jsx}=require("react/jsx-runtime"); module.exports=function ChatScreen(props){const [marker]=R.useState(()=>++globalThis.__appIntegrationHarness.marker);return jsx("ChatScreen",{...props,marker})}'
        : `const {jsx}=require('react/jsx-runtime'); module.exports=function Stub(props){return jsx(${JSON.stringify(path.split('/').pop())},props)}`,
      loader: 'js',
    }));
  } }],
}).then((bundled) => {
  const compiled: any = { exports: {} };
  new Function('module', 'exports', bundled.outputFiles[0].text)(compiled, compiled.exports);
  return { App: compiled.exports.default, operationGuard: compiled.exports.operationGuard, MutationTester: compiled.exports.MutationTester };
});

function nodes(root: any): any[] {
  if (root === null || root === undefined) return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object') return [];
  return [root, ...nodes(root.children)];
}
function textOf(root: any): string {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function node(view: any, type: string, predicate: (node: any) => boolean = () => true) {
  const found = nodes(view.tree).find((item) => item.type === type && predicate(item));
  assert.ok(found, `missing ${type}`); return found;
}
function input(view: any, label: string) { return node(view, 'TextInput', (item) => item.props.accessibilityLabel === label); }
function enter(view: any, label: string, value: string) { input(view, label).props.onChangeText(value); view.flush(); }
function press(view: any, label: string) {
  const button = node(view, 'Pressable', (item) => (item.props.accessibilityLabel === label || textOf(item.children) === label));
  assert.notEqual(button.props.disabled, true, `${label} disabled`);
  button.props.onPress(); view.flush();
}
function chat(view: any) { return node(view, 'ChatScreen'); }
function proposal(reason: string) {
  return {
    id: 'p1', revision: 1, mode: 'personal', coordinationTarget: null,
    baseScheduleRevision: 0, baseContextRevision: 0,
    changeSet: { changes: [{ changeId: 'c1', operation: 'create', after: { kind: 'event', title: '일정',
      timeSlot: { startsAt: '2026-11-01T09:00:00+09:00', endsAt: '2026-11-01T10:00:00+09:00', timezone: 'Asia/Seoul' },
      durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' } }] },
    beforeItems: [], reason, evidenceRefs: [],
    validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 0, checkedContextRevision: 0, checkedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z', expiresAt: null, status: 'pending',
  };
}
function response(proposals: unknown[]) { return new Response(JSON.stringify({ requestId: 'r', data: { proposals, nextCursor: null } })); }

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; (globalThis as any).__appIntegrationHarness.fontState = [true, null]; });

test('preloaded proposals refresh when chat creates a proposal without resetting the workspace', async () => {
  const { App } = await components;
  let reads = 0;
  globalThis.fetch = async () => response(++reads === 1 ? [] : [proposal('새로운 제안')]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  await view.settle();
  assert.equal(reads, 1);
  const marker = chat(view).props.marker;
  chat(view).props.onProposalCreated(); view.flush();
  await view.settle();
  assert.equal(reads, 2);
  assert.equal(chat(view).props.marker, marker);
  chat(view).props.onOpenProposals(); view.flush();
  assert.match(textOf(view.tree), /새로운 제안/);
  view.unmount();
});

test('same normalized connection preserves draft/session and unresolved keys; actual change is blocked', async () => {
  const { App, operationGuard } = await components;
  globalThis.fetch = async () => response([]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  await view.settle();
  const marker = chat(view).props.marker;
  const owner = {};
  operationGuard.update(owner, { status: 'pending' });
  press(view, '개발 연결 설정');
  for (const partial of ['H', 'HTTP:', 'HTTP://', 'HTTP://LOCALHOST:03001////']) enter(view, 'API 서버 주소', partial);
  assert.equal(input(view, '개발 세션 토큰').props.value, 'dev-token');
  press(view, '설정 적용');
  assert.equal(chat(view).props.marker, marker);
  press(view, '개발 연결 설정');
  assert.equal(input(view, 'API 서버 주소').props.value, 'http://localhost:3001');
  assert.equal(input(view, '개발 세션 토큰').props.value, 'dev-token');
  enter(view, 'API 서버 주소', 'http://other.test:3001');
  enter(view, '개발 세션 토큰', 'other-token');
  press(view, '설정 적용');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  assert.equal(chat(view).props.marker, marker);
  operationGuard.update(owner, { status: 'error', error: new Error('timeout'), uncertain: true });
  press(view, '설정 적용');
  assert.equal(chat(view).props.marker, marker);
  operationGuard.clear(owner);
  press(view, '설정 적용');
  await view.settle();
  assert.notEqual(chat(view).props.marker, marker);
  view.unmount();
});

test('a different account on the same API remounts state and ignores old-user list responses', async () => {
  const { App } = await components;
  let resolveOld!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (auth === 'Bearer old-user') return new Promise<Response>((resolve) => { resolveOld = resolve; });
    return response([proposal('새 사용자 제안')]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'old-user'); press(view, '설정 적용');
  await view.settle();
  const oldMarker = chat(view).props.marker;
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'new-user'); press(view, '설정 적용');
  await view.settle();
  assert.notEqual(chat(view).props.marker, oldMarker);
  assert.match(textOf(view.tree), /새 사용자 제안/);
  resolveOld(response([proposal('이전 사용자 제안')]));
  await view.settle();
  assert.doesNotMatch(textOf(view.tree), /이전 사용자 제안/);
  assert.match(textOf(view.tree), /새 사용자 제안/);
  view.unmount();
});


test('useMutation itself registers pending and uncertain actions, and releases the guard on resolution or unmount', async () => {
  const { MutationTester, operationGuard } = await components;
  let rejectFirst: (error: Error) => void = () => {};
  let resolveSecond: (value: string) => void = () => {};
  let calls = 0;
  const view = harness.renderer(MutationTester, { run: () => {
    calls += 1;
    return calls === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; })
      : new Promise((resolve) => { resolveSecond = resolve; });
  } });
  assert.equal(operationGuard.hasUnresolved(), false);
  node(view, 'MutationTester').props.submit({ value: 'x' });
  view.flush();
  assert.equal(operationGuard.hasUnresolved(), true);
  rejectFirst(new Error('network'));
  await view.settle();
  assert.equal(node(view, 'MutationTester').props.state.status, 'error');
  assert.equal(operationGuard.hasUnresolved(), true);
  node(view, 'MutationTester').props.retry();
  view.flush();
  assert.equal(operationGuard.hasUnresolved(), true);
  resolveSecond('confirmed');
  await view.settle();
  assert.equal(node(view, 'MutationTester').props.state.status, 'success');
  assert.equal(operationGuard.hasUnresolved(), false);
  view.unmount();
});

test('changing server requires explicit token entry before the old token can be reused', async () => {
  const { App } = await components;
  globalThis.fetch = async () => response([]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  await view.settle();
  const marker = chat(view).props.marker;
  press(view, '개발 연결 설정');
  enter(view, 'API 서버 주소', 'https://another.test');
  assert.equal(input(view, '개발 세션 토큰').props.value, 'dev-token');
  press(view, '설정 적용');
  assert.match(textOf(view.tree), /해당 서버의 세션 토큰을 다시 입력/);
  assert.equal(input(view, '개발 세션 토큰').props.value, '');
  assert.equal(chat(view).props.marker, marker);
  enter(view, '개발 세션 토큰', 'dev-token');
  press(view, '설정 적용');
  await view.settle();
  assert.notEqual(chat(view).props.marker, marker);
  view.unmount();
});

test('a real in-flight mutation blocks account changes until its response is confirmed', async () => {
  const { App, MutationTester, operationGuard } = await components;
  globalThis.fetch = async () => response([]);
  let complete!: (value: string) => void;
  const run = () => new Promise<string>((resolve) => { complete = resolve; });
  const Root = () => [(globalThis as any).__appIntegrationHarness.jsx(App, {}, 'app'),
    (globalThis as any).__appIntegrationHarness.jsx(MutationTester, { run }, 'mutation')];
  const view = harness.renderer(Root);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'old-user'); press(view, '설정 적용');
  await view.settle();
  const marker = chat(view).props.marker;
  node(view, 'MutationTester').props.submit({ value: 'request' }); view.flush();
  assert.equal(operationGuard.hasUnresolved(), true);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'new-user'); press(view, '설정 적용');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  assert.equal(chat(view).props.marker, marker);
  complete('confirmed');
  await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false);
  press(view, '설정 적용');
  await view.settle();
  assert.notEqual(chat(view).props.marker, marker);
  view.unmount();
});

const reviewDefaults = { revision: 0, timezone: 'UTC', evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } };
const capabilities = { storage: { mode: 'memory', durable: false }, model: { status: 'degraded' }, scheduler: { status: 'not_configured' } };
function apiResponse(data: unknown, status = 200) { return new Response(JSON.stringify({ requestId: 'response', data }), { status }); }
function toggle(view: any, label: string, value: boolean) {
  const control = node(view, 'Switch', (item) => item.props.accessibilityLabel === label);
  assert.notEqual(control.props.disabled, true);
  control.props.onValueChange(value); view.flush();
}
function openReview(view: any) { chat(view).props.onOpenReviewSchedule(); view.flush(); }

test('chat opens initially disabled review settings; valid changes save the contract and show separate server status', async () => {
  const { App } = await components;
  const writes: { body: any; key: string }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/review-schedule' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ body, key: (init.headers as Record<string, string>)['Idempotency-Key'] });
      return apiResponse({ reviewSchedule: { revision: body.expectedRevision + 1, timezone: body.timezone, evening: body.evening, morning: body.morning } });
    }
    if (path === '/v1/review-schedule') return apiResponse({ reviewSchedule: reviewDefaults });
    if (path === '/v1/capabilities') return apiResponse(capabilities);
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  openReview(view); await view.settle();
  assert.equal(node(view, 'Switch', (item) => item.props.accessibilityLabel === '저녁 자동 검토').props.value, false);
  assert.equal(node(view, 'Switch', (item) => item.props.accessibilityLabel === '아침 자동 검토').props.value, false);
  assert.equal(input(view, '저녁 시각').props.value, '');
  assert.match(textOf(view.tree), /스케줄러: 설정되지 않음/);
  assert.match(textOf(view.tree), /모델: 상태 저하/);
  assert.match(textOf(view.tree), /임시 저장/);
  toggle(view, '저녁 자동 검토', true);
  press(view, '자동 검토 설정 저장');
  assert.match(textOf(view.tree), /저녁 자동 검토를 켜려면 시각이 필요/);
  assert.equal(writes.length, 0);
  enter(view, '시간대', 'Asia/Seoul'); enter(view, '저녁 시각', '21:45');
  toggle(view, '아침 자동 검토', true); enter(view, '아침 시각', '07:30');
  press(view, '자동 검토 설정 저장'); await view.settle();
  assert.equal(writes.length, 1);
  assert.deepEqual({ ...writes[0].body, requestId: '<id>' }, { requestId: '<id>', expectedRevision: 0, timezone: 'Asia/Seoul',
    evening: { enabled: true, localTime: '21:45' }, morning: { enabled: true, localTime: '07:30' } });
  assert.ok(writes[0].body.requestId && writes[0].key && writes[0].body.requestId !== writes[0].key);
  assert.match(textOf(view.tree), /설정을 저장했습니다\. 실행 상태는 위에서 확인/);
  assert.match(textOf(view.tree), /설정 저장과 스케줄러 실행 및 모델 사용 가능 여부는 별개/);
  view.unmount();
});

test('uncertain review save stays retryable across navigation and blocks a connection change', async () => {
  const { App, operationGuard } = await components;
  const writes: { body: string; key: string }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/review-schedule' && init?.method === 'POST') {
      const body = String(init.body);
      writes.push({ body, key: (init.headers as Record<string, string>)['Idempotency-Key'] });
      if (writes.length === 1) throw new Error('offline');
      const parsed = JSON.parse(body);
      return apiResponse({ reviewSchedule: { revision: parsed.expectedRevision + 1, timezone: parsed.timezone, evening: parsed.evening, morning: parsed.morning } });
    }
    if (path === '/v1/review-schedule') return apiResponse({ reviewSchedule: reviewDefaults });
    if (path === '/v1/capabilities') return apiResponse(capabilities);
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  openReview(view); await view.settle();
  enter(view, '시간대', 'Asia/Seoul'); toggle(view, '저녁 자동 검토', true); enter(view, '저녁 시각', '21:00');
  press(view, '자동 검토 설정 저장'); await view.settle();
  assert.match(textOf(view.tree), /저장 여부가 불확실합니다/);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(input(view, '저녁 시각').props.editable, false);
  const back = nodes(view.tree).filter((item) => item.type === 'Pressable' && textOf(item.children) === '뒤로').at(-1);
  assert.ok(back); back.props.onPress(); view.flush();
  openReview(view); view.flush();
  assert.equal(input(view, '저녁 시각').props.value, '21:00');
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'other-token'); press(view, '설정 적용');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  press(view, '개발 연결 설정');
  press(view, '같은 요청 다시 시도'); await view.settle();
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(operationGuard.hasUnresolved(), false);
  assert.match(textOf(view.tree), /설정을 저장했습니다/);
  view.unmount();
});

test('a revision conflict requires explicit reload before a new save', async () => {
  const { App } = await components;
  const newer = { revision: 2, timezone: 'Asia/Seoul', evening: { enabled: false, localTime: '20:00' }, morning: { enabled: false, localTime: null } };
  let reads = 0;
  const writes: any[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/review-schedule' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (writes.length === 1) return new Response(JSON.stringify({ requestId: 'r', error: { code: 'conflict', message: 'conflict', retryable: false } }), { status: 409 });
      return apiResponse({ reviewSchedule: { revision: body.expectedRevision + 1, timezone: body.timezone, evening: body.evening, morning: body.morning } });
    }
    if (path === '/v1/review-schedule') return apiResponse({ reviewSchedule: ++reads === 1 ? reviewDefaults : newer });
    if (path === '/v1/capabilities') return apiResponse(capabilities);
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  openReview(view); await view.settle();
  toggle(view, '저녁 자동 검토', true); enter(view, '저녁 시각', '21:00');
  press(view, '자동 검토 설정 저장'); await view.settle();
  assert.match(textOf(view.tree), /다른 곳에서 설정이 바뀌었습니다/);
  assert.equal(input(view, '저녁 시각').props.value, '21:00');
  assert.equal(input(view, '저녁 시각').props.editable, false);
  press(view, '최신 설정 불러오기'); await view.settle();
  assert.equal(input(view, '저녁 시각').props.value, '20:00');
  toggle(view, '저녁 자동 검토', true); press(view, '자동 검토 설정 저장'); await view.settle();
  assert.equal(writes[1].expectedRevision, 2);
  view.unmount();
});

test('a conflict after an uncertain review save cannot unlock a new request', async () => {
  const { App, operationGuard } = await components;
  const writes: { body: string; key: string }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/review-schedule' && init?.method === 'POST') {
      const body = String(init.body);
      writes.push({ body, key: (init.headers as Record<string, string>)['Idempotency-Key'] });
      if (writes.length === 1) throw new Error('offline');
      if (writes.length === 2) return new Response(JSON.stringify({ requestId: 'r', error: { code: 'conflict', message: 'conflict', retryable: false } }), { status: 409 });
      const parsed = JSON.parse(body);
      return apiResponse({ reviewSchedule: { revision: parsed.expectedRevision + 1, timezone: parsed.timezone, evening: parsed.evening, morning: parsed.morning } });
    }
    if (path === '/v1/review-schedule') return apiResponse({ reviewSchedule: reviewDefaults });
    if (path === '/v1/capabilities') return apiResponse(capabilities);
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  openReview(view); await view.settle();
  toggle(view, '저녁 자동 검토', true); enter(view, '저녁 시각', '21:00');
  press(view, '자동 검토 설정 저장'); await view.settle();
  press(view, '같은 요청 다시 시도'); await view.settle();
  assert.match(textOf(view.tree), /이전 저장의 처리 여부는 아직 확인되지 않았습니다/);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(input(view, '저녁 시각').props.editable, false);
  assert.equal(nodes(view.tree).some((item) => item.type === 'Pressable' && textOf(item.children) === '최신 설정 불러오기'), false);
  press(view, '같은 요청 다시 시도'); await view.settle();
  assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(writes[1], writes[2]);
  assert.equal(operationGuard.hasUnresolved(), false);
  view.unmount();
});


test('font loading defers workspace requests and shows a readable loading state', async () => {
  const { App } = await components;
  (globalThis as any).__appIntegrationHarness.fontState = [false, null];
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response([]); };
  const view = harness.renderer(App);
  await view.settle();
  assert.match(textOf(view.tree), /하루를 준비하고 있어요/);
  assert.equal(nodes(view.tree).some((item) => item.type === 'ChatScreen'), false);
  assert.equal(calls, 0);
  view.unmount();
});

test('font loading failure leaves connection settings and the workspace usable', async () => {
  const { App } = await components;
  (globalThis as any).__appIntegrationHarness.fontState = [false, new Error('font unavailable')];
  globalThis.fetch = async () => response([]);
  const view = harness.renderer(App);
  assert.match(textOf(view.tree), /기본 글꼴로 표시/);
  press(view, '개발 연결 설정');
  enter(view, '개발 세션 토큰', 'dev-token');
  press(view, '설정 적용');
  await view.settle();
  assert.ok(chat(view));
  view.unmount();
});
