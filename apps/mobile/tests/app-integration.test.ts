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
  const backListeners = new Set<() => boolean>();
  const openedLinks: string[] = [];
  const native = {
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch',
    BackHandler: { addEventListener: (_event: string, listener: () => boolean) => { backListeners.add(listener); return { remove: () => backListeners.delete(listener) }; } },
    Linking: { openURL: async (url: string) => { openedLinks.push(url); } },
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host: any = { react, native, jsx, fragment, backListeners, openedLinks, marker: 0, fontState: [true, null] };
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
function visibleNodes(root: any): any[] {
  if (root == null || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(visibleNodes);
  if (root.props?.accessibilityElementsHidden === true || root.props?.importantForAccessibility === 'no-hide-descendants') return [];
  return [root, ...visibleNodes(root.children)];
}
function visiblePress(view: any, label: string) {
  const found = visibleNodes(view.tree).find(item => item.type === 'Pressable' && (item.props.accessibilityLabel === label || textOf(item.children) === label));
  assert.ok(found, `missing visible ${label}`); assert.notEqual(found.props.disabled, true); found.props.onPress(); view.flush();
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
test.afterEach(() => { globalThis.fetch = originalFetch; (globalThis as any).__appIntegrationHarness.fontState = [true, null]; (globalThis as any).__appIntegrationHarness.openedLinks.length = 0; });

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

test('제안의 준비시간 관계는 모델이 제안한 값과 연결된 변경 ID로 표시한다', async () => {
  const { App } = await components;
  const item = proposal('시간 관계 제안');
  const withTiming = { ...item, changeSet: { ...item.changeSet, timingConstraints: [{ appointment: { kind: 'existing', id: 'event-1', expectedRevision: 2 },
    preparationMinutes: 15, travelMinutes: 0, bufferMinutes: null, segments: { preparation: 'c1', travel: null, buffer: null } }] } };
  globalThis.fetch = async (url) => new URL(String(url)).pathname === '/v1/proposals/p1'
    ? Response.json({ requestId: 'r', data: { proposal: withTiming } }) : response([withTiming]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용'); await view.settle();
  chat(view).props.onOpenProposals(); view.flush(); press(view, '제안 시간 관계 제안, 확인 대기, 상세 보기'); await view.settle();
  assert.match(textOf(view.tree), /제안된 준비·이동 관계/); assert.match(textOf(view.tree), /기준 약속: event-1/);
  assert.match(textOf(view.tree), /준비 15분 · 이동 0분 · 여유 미확인/); assert.match(textOf(view.tree), /연결된 변경 ID: 준비 c1 · 이동 없음 · 여유 없음/);
  assert.match(textOf(view.tree), /사용자 확인 여부를 별도로 확인/);
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

test('사용자별 Google 동의는 별도 버튼으로 열고 URL과 이전 사용자 상태를 화면에 노출하지 않는다', async () => {
  const { App } = await components; const requests: any[] = [];
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code',
    state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send' })}`;
  const completionSecret = 'q'.repeat(43), confirmationCode = 'z'.repeat(43);
  const releaseOld: ((response: Response) => void)[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; const auth = (init?.headers as Record<string, string>).Authorization;
    requests.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-connection' && auth === 'Bearer old-user') return new Promise<Response>((resolve) => { releaseOld.push(resolve); });
    if (path === '/v1/calendar-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', accountLabel: null } });
    if (path === '/v1/email-connection' || path === '/v1/email-reply-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', senderAddress: null } });
    if (path === '/v1/google/oauth/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret } });
    if (path === '/v1/google/oauth/complete') return Response.json({ requestId: 'r', data: { status: 'connected' } });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'old-user'); press(view, '설정 적용'); await view.settle();
  press(view, 'Google 연결'); await view.settle();
  press(view, 'Gmail 발송 연결 시작'); await view.settle();
  assert.equal((globalThis as any).__appIntegrationHarness.openedLinks.length, 0);
  assert.doesNotMatch(textOf(view.tree), /ssssssssss|qqqqqqqqqq|accounts\.google\.com/);
  assert.deepEqual(requests.find((item) => item.path === '/v1/google/oauth/start').body, { kind: 'gmail_send' });
  press(view, 'Google 동의 화면 열기'); await view.settle();
  assert.deepEqual((globalThis as any).__appIntegrationHarness.openedLinks, [authorizationUrl]);
  assert.match(textOf(view.tree), /다른 사람에게 전달하지 마세요/);
  assert.equal(input(view, 'Google 연결 확인 코드').props.secureTextEntry, true);
  enter(view, 'Google 연결 확인 코드', confirmationCode); press(view, 'Google 연결 확인'); await view.settle();
  assert.deepEqual(requests.find((item) => item.path === '/v1/google/oauth/complete').body, { completionSecret, confirmationCode });
  assert.equal(requests.filter((item) => item.path === '/v1/google/oauth/complete').length, 1);
  assert.doesNotMatch(textOf(view.tree), /qqqqqqqqqq|zzzzzzzzzz/);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'new-user'); press(view, '설정 적용'); await view.settle();
  press(view, 'Google 연결'); await view.settle();
  for (const resolve of releaseOld) resolve(Response.json({ requestId: 'r', data: { status: 'available', accountLabel: '이전 계정' } })); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /이전 계정|ssssssssss/);
  assert.equal(nodes(view.tree).some((item) => item.type === 'Pressable' && textOf(item.children) === 'Google 동의 화면 열기'), false);
  view.unmount();
});

test('Google 연결 확인 응답 유실은 자동 재시도하지 않고 새 연결을 안내한다', async () => {
  const { App } = await components; let completions = 0;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code',
    state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send' })}`;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', accountLabel: null } });
    if (path === '/v1/email-connection' || path === '/v1/email-reply-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', senderAddress: null } });
    if (path === '/v1/google/oauth/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/google/oauth/complete') { completions++; throw new Error('connection lost'); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test-user'); press(view, '설정 적용'); await view.settle();
  press(view, 'Google 연결'); await view.settle(); press(view, 'Gmail 발송 연결 시작'); await view.settle();
  enter(view, 'Google 연결 확인 코드', 'z'.repeat(43)); press(view, 'Google 연결 확인'); await view.settle();
  assert.equal(completions, 1); assert.match(textOf(view.tree), /연결 결과를 확인하지 못했습니다/);
  assert.equal(nodes(view.tree).some((item) => item.type === 'TextInput' && item.props.accessibilityLabel === 'Google 연결 확인 코드'), false);
  press(view, '연결 상태 다시 확인'); await view.settle(); assert.equal(completions, 1);
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

test('proposal detail opens an editable revision draft with all changes and without a write', async () => {
  const { App } = await components;
  const original = proposal('원본 제안');
  original.changeSet.changes.push({ ...original.changeSet.changes[0], changeId: 'c2', after: { ...original.changeSet.changes[0].after, title: '두 번째 일정' } });
  (original.changeSet as any).timingConstraints = [{ appointment: { kind: 'existing', id: 'event-1', expectedRevision: 2 },
    preparationMinutes: 15, travelMinutes: 0, bufferMinutes: null, segments: { preparation: 'c1', travel: null, buffer: null } }];
  const writes: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') writes.push(String(url));
    return new URL(String(url)).pathname === '/v1/proposals/p1' ? apiResponse({ proposal: original }) : response([original]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
  await view.settle();
  chat(view).props.onOpenProposals(); view.flush();
  press(view, '제안 원본 제안, 확인 대기, 상세 보기'); await view.settle();
  press(view, '수정 요청');
  const request = chat(view).props.revisionRequest;
  assert.equal(request.proposalId, 'p1');
  assert.match(request.text, /제안 ID: p1 · 버전: 1/);
  assert.match(request.text, /"changeId": "c1"/);
  assert.match(request.text, /"changeId": "c2"/);
  assert.match(request.text, /"timingConstraints"/); assert.match(request.text, /"preparation": "c1"/);
  assert.match(request.text, /별도 검토와 승인/);
  assert.deepEqual(writes, []);
  view.unmount();
});

test('calendar import mounts only while open and removes its hardware back handler', async () => {
  const { App, operationGuard } = await components;
  globalThis.fetch = async () => response([]);
  const host = (globalThis as any).__appIntegrationHarness;
  const view = harness.renderer(App);
  assert.equal(host.backListeners.size, 0);
  press(view, '캘린더');
  press(view, '캘린더 일정 가져오기');
  assert.equal(host.backListeners.size, 1);
  assert.match(textOf(view.tree), /선택한 기간의 일정을 직접 조회/);
  const owner = {};
  operationGuard.update(owner, { status: 'pending' });
  [...host.backListeners][0](); view.flush();
  assert.equal(host.backListeners.size, 1);
  operationGuard.clear(owner);
  [...host.backListeners][0](); view.flush();
  assert.equal(host.backListeners.size, 0);
  view.unmount();
});

test('web team preview shows the participation code connection without changing native settings', async () => {
  const { App } = await components;
  const host = (globalThis as any).__appIntegrationHarness;
  const oldTeam = process.env.EXPO_PUBLIC_TEAM_PREVIEW;
  const oldPreview = process.env.EXPO_PUBLIC_PREVIEW_ONLY;
  const oldPlatform = host.native.Platform.OS;
  try {
    process.env.EXPO_PUBLIC_TEAM_PREVIEW = 'true';
    process.env.EXPO_PUBLIC_PREVIEW_ONLY = 'false';
    host.native.Platform.OS = 'web';
    const view = harness.renderer(App);
    assert.match(textOf(view.tree), /팀 공유 · 기능 테스트/);
    assert.ok(input(view, '팀 참여 코드'));
    assert.equal(input(view, 'API 서버 주소').props.editable, undefined);
    view.unmount();
  } finally {
    host.native.Platform.OS = oldPlatform;
    if (oldTeam === undefined) delete process.env.EXPO_PUBLIC_TEAM_PREVIEW; else process.env.EXPO_PUBLIC_TEAM_PREVIEW = oldTeam;
    if (oldPreview === undefined) delete process.env.EXPO_PUBLIC_PREVIEW_ONLY; else process.env.EXPO_PUBLIC_PREVIEW_ONLY = oldPreview;
  }
});

test('설정의 연결 메뉴에서 건강 화면을 열고 돌아와도 네트워크 요청을 추가하지 않는다', async () => {
  const { App } = await components; let requests = 0;
  globalThis.fetch = async () => { requests += 1; return response([]); };
  const view = harness.renderer(App);
  await view.settle(); const before = requests;
  press(view, '개발 연결 설정'); press(view, '연결'); press(view, '건강 데이터');
  await view.settle();
  assert.match(textOf(view.tree), /최근 7일의 걸음 수와 기록된 운동/);
  assert.match(textOf(view.tree), /웹에서도 사용할 수 없습니다/);
  press(view, '나중에'); await view.settle();
  assert.ok(chat(view)); assert.equal(requests, before);
  view.unmount();
});

test('Google 계정 로그인은 기존 세션 없이 인증하고 사용자 교체 후 로그아웃한다', async () => {
  const { App, operationGuard } = await components; const calls: any[] = [];
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
    nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push({ path, method: init?.method, headers: init?.headers, credentials: init?.credentials });
    if (path === '/v1/auth/google/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/auth/google/complete') return Response.json({ requestId: 'r', data: { sessionToken: 'synthetic-member-token', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'member:123', email: 'synthetic@example.test', displayName: '테스트 사용자' } } });
    if (path === '/v1/auth/logout') return Response.json({ requestId: 'r', data: { status: 'logged_out' } });
    if (path === '/v1/proposals') return response([]);
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'preview-token'); press(view, '설정 적용'); await view.settle();
  const before = chat(view).props.marker;
  press(view, '개발 연결 설정');
  const owner = {}; operationGuard.update(owner, { status: 'pending' });
  press(view, 'Google 로그인 또는 가입'); assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  operationGuard.clear(owner); press(view, 'Google 로그인 또는 가입');
  press(view, 'Google 로그인 시작'); await view.settle(); press(view, 'Google 로그인 화면 열기'); await view.settle();
  enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); press(view, 'Google 로그인 확인'); await view.settle();
  assert.notEqual(chat(view).props.marker, before);
  for (const request of calls.filter(item => item.path.startsWith('/v1/auth/google/'))) {
    assert.equal((request.headers as Record<string, string>).Authorization, undefined); assert.equal(request.credentials, 'omit');
  }
  assert.doesNotMatch(textOf(view.tree), /synthetic-member-token|qqqqqqqqqq|zzzzzzzzzz/);
  press(view, '개발 연결 설정'); assert.match(textOf(view.tree), /테스트 사용자/);
  assert.equal(input(view, '개발 세션 토큰').props.value, '');
  press(view, '로그아웃'); await view.settle();
  assert.equal((calls.find(item => item.path === '/v1/auth/logout').headers as Record<string, string>).Authorization, 'Bearer synthetic-member-token');
  assert.match(textOf(view.tree), /Google 로그인 또는 가입/); view.unmount();
});

test('루틴 생성과 요일 수정 및 회차 생성은 계약을 따르고 기존 회차 보존을 안내한다', async () => {
  const { App } = await components; const writes: any[] = []; let routines: any[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/routines' && method === 'GET') return Response.json({ requestId: 'r', data: { routines } });
    if (path === '/v1/routines' && method === 'POST') {
      writes.push({ path, method, body, headers: init?.headers });
      routines = [{ id: 'routine-1', revision: 1, title: body.title, weekdays: body.weekdays, timezone: body.timezone, startDate: body.startDate, localTime: body.localTime, durationMinutes: body.durationMinutes, active: true }];
      return Response.json({ requestId: 'r', data: { routine: routines[0] } });
    }
    if (path === '/v1/routines/routine-1' && method === 'PATCH') {
      writes.push({ path, method, body, headers: init?.headers });
      routines = [{ ...routines[0], ...body, revision: 2 }]; return Response.json({ requestId: 'r', data: { routine: routines[0] } });
    }
    if (path === '/v1/routines/materialize' && method === 'POST') {
      writes.push({ path, method, body, headers: init?.headers });
      return Response.json({ requestId: 'r', data: { createdCount: 1, existingCount: 0, conflicts: [{ routineId: 'routine-1', date: '2026-11-02', code: 'schedule_conflict' }], scheduleRevision: 1 } });
    }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev'); press(view, '설정 적용'); await view.settle();
  press(view, '루틴'); await view.settle(); assert.match(textOf(view.tree), /이미 생성한 회차는 미래 일정까지 그대로 유지/);
  enter(view, '루틴 이름', '운동'); press(view, '월요일'); enter(view, '루틴 시작일', '2026-11-01'); press(view, '루틴 등록'); await view.settle();
  assert.deepEqual(writes[0].body.weekdays, [1]); assert.ok((writes[0].headers as Record<string, string>)['Idempotency-Key']);
  press(view, '운동 편집'); press(view, '화요일'); press(view, '루틴 변경 저장'); await view.settle();
  assert.equal(writes[1].method, 'PATCH'); assert.deepEqual(writes[1].body.weekdays, [1, 2]); assert.equal(writes[1].body.expectedRevision, 1);
  enter(view, '회차 시작일', '2026-11-01'); enter(view, '회차 종료일', '2026-11-03'); press(view, '회차 생성'); await view.settle();
  assert.match(textOf(view.tree), /생성 1건 · 기존 0건/); assert.match(textOf(view.tree), /일정 충돌/);
  assert.equal(writes[2].body.fromDate, '2026-11-01'); press(view, '하루 일정 보기'); view.unmount();
});

test('로그인 완료 응답 유실은 자동 재시도하지 않고 기존 계정을 유지한다', async () => {
  const { App } = await components; let completions = 0;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
    nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/auth/google/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/auth/google/complete') { completions++; throw new Error('lost'); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'preview'); press(view, '설정 적용'); await view.settle();
  const before = chat(view).props.marker;
  press(view, '개발 연결 설정'); press(view, 'Google 로그인 또는 가입'); press(view, 'Google 로그인 시작'); await view.settle();
  enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); press(view, 'Google 로그인 확인'); await view.settle();
  assert.equal(completions, 1); assert.match(textOf(view.tree), /로그인 결과를 확인하지 못했습니다/);
  assert.equal(nodes(view.tree).some(item => item.type === 'TextInput' && item.props.accessibilityLabel === 'Google 로그인 확인 코드'), false);
  press(view, '뒤로'); assert.equal(chat(view).props.marker, before); view.unmount();
});

test('동기화는 쓰기 권한 캘린더와 명시 선택한 일정만 연결하고 결과 불명을 재전송하지 않는다', async () => {
  const { App } = await components; const calls: any[] = []; let connections: any[] = [];
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw)), path = url.pathname, method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: init?.headers });
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-sync/calendars') return Response.json({ requestId: 'r', data: { calendars: [{ id: 'cal-1', summary: '내 달력', accessRole: 'writer' }, { id: 'cal-2', summary: '읽기 전용', accessRole: 'reader' }] } });
    if (path === '/v1/calendar-sync' && method === 'GET') return Response.json({ requestId: 'r', data: { connections } });
    if (path === '/v1/schedule') {
      const from = Date.parse(url.searchParams.get('from')!); const slot = { startsAt: new Date(from + 3_600_000).toISOString(), endsAt: new Date(from + 7_200_000).toISOString(), timezone: url.searchParams.get('timezone')! };
      const item = { revision: 1, kind: 'event', timeSlot: slot, durationMinutes: null, deadline: null, flexibility: 'fixed', completion: 'pending', sourceRefs: [] };
      return Response.json({ requestId: 'r', data: { items: [{ ...item, id: 'personal-1', title: '개인 일정', involvement: 'personal' }, { ...item, id: 'shared-1', title: '공동 일정', involvement: 'shared' },
        { ...item, id: 'imported-1', title: '가져온 일정', involvement: 'personal', sourceRefs: [{ provider: 'google_calendar', accountRef: 'a', calendarId: 'cal-1', externalEventId: 'e', lastSyncedAt: slot.startsAt }] }], scheduleRevision: 0 } });
    }
    if (path === '/v1/calendar-sync/connect') {
      connections = [{ id: 'sync-1', calendarId: body.calendarId, revision: 1, allowDeletes: body.allowDeletes, status: 'connected', pendingExportCount: body.exportItemIds.length }];
      return Response.json({ requestId: 'r', data: { connection: connections[0] } });
    }
    if (path === '/v1/calendar-sync/sync-1/run') {
      connections = [{ ...connections[0], revision: 2, status: 'review_required' }];
      return Response.json({ requestId: 'r', data: { connection: connections[0], imported: 1, exported: 0, deleted: 0, unsupportedCount: 1, conflicts: [{ reason: 'outcome_unknown', itemId: 'personal-1' }, { reason: 'delete_requires_review', itemId: 'personal-2' }] } });
    }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  press(view, '캘린더'); press(view, 'Google 캘린더 동기화'); await view.settle();
  assert.equal(calls.some(item => item.path === '/v1/calendar/calendars'), false);
  const deleteBox = node(view, 'Pressable', item => item.props.accessibilityLabel === '양방향 삭제 전파 동의');
  assert.equal(deleteBox.props.accessibilityState.checked, false);
  assert.equal(nodes(view.tree).some(item => item.props?.accessibilityLabel === '내보낼 일정 공동 일정'), false);
  assert.equal(nodes(view.tree).some(item => item.props?.accessibilityLabel === '내보낼 일정 가져온 일정'), false);
  press(view, '캘린더 내 달력'); press(view, '내보낼 일정 개인 일정'); press(view, '양방향 삭제 전파 동의'); press(view, '동기화 연결'); await view.settle();
  const connect = calls.find(item => item.path === '/v1/calendar-sync/connect');
  assert.deepEqual({ calendarId: connect.body.calendarId, allowDeletes: connect.body.allowDeletes, exportItemIds: connect.body.exportItemIds }, { calendarId: 'cal-1', allowDeletes: true, exportItemIds: ['personal-1'] });
  assert.ok((connect.headers as Record<string, string>)['Idempotency-Key']);
  press(view, 'cal-1 동기화 실행'); await view.settle();
  assert.match(textOf(view.tree), /일부 항목은 처리하지 못했거나 검토가 필요/); assert.match(textOf(view.tree), /외부 쓰기 결과 불명/); assert.match(textOf(view.tree), /삭제 안전성을 확인할 수 없어 검토 필요/);
  assert.equal(node(view, 'Pressable', item => item.props.accessibilityLabel === 'cal-1 동기화 실행').props.disabled, true);
  visiblePress(view, '캘린더 내 달력'); visiblePress(view, '내보낼 일정 개인 일정');
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '선택한 일정 추가')?.props.disabled, true);
  assert.match(textOf(view.tree), /이 연결은 검토가 필요하여 일정을 추가할 수 없습니다/);
  assert.equal(calls.filter(item => item.path === '/v1/calendar-sync/sync-1/run').length, 1); view.unmount();
});

test('Google 캘린더 쓰기는 별도의 OAuth 권한과 연결 상태를 사용한다', async () => {
  const { App } = await components; const calls: any[] = [];
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
    redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly' })}`;
  globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-connection' || path === '/v1/calendar-write-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', accountLabel: null } });
    if (path === '/v1/email-connection' || path === '/v1/email-reply-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', senderAddress: null } });
    if (path === '/v1/google/oauth/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  press(view, 'Google 연결'); await view.settle(); press(view, 'Google 캘린더 동기화 연결 시작'); await view.settle();
  assert.deepEqual(calls.find(item => item.path === '/v1/google/oauth/start').body, { kind: 'calendar_write' });
  assert.ok(calls.some(item => item.path === '/v1/calendar-write-connection'));
  press(view, 'Google 동의 화면 열기'); await view.settle();
  assert.deepEqual((globalThis as any).__appIntegrationHarness.openedLinks, [authorizationUrl]); view.unmount();
});

test('동기화 응답 유실 후 저장된 결과만 조회하고 완료 시 계정 전환을 허용한다', async () => {
  const { App } = await components; let runs = 0, lists = 0, operationReads = 0, requestId = '';
  globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-sync/calendars') return Response.json({ requestId: 'r', data: { calendars: [{ id: 'cal', summary: '내 달력', accessRole: 'owner' }] } });
    if (path === '/v1/calendar-sync') { lists++; return Response.json({ requestId: 'r', data: { connections: [{ id: 'sync', calendarId: 'cal', revision: 1, allowDeletes: false, status: 'connected', pendingExportCount: 0 }] } }); }
    if (path === '/v1/schedule') return Response.json({ requestId: 'r', data: { items: [], scheduleRevision: 0 } });
    if (path === '/v1/calendar-sync/sync/run') { runs++; requestId = JSON.parse(String(init?.body)).requestId; throw new Error('lost'); }
    if (path.startsWith('/v1/calendar-sync/operations/')) {
      assert.equal(path, `/v1/calendar-sync/operations/${requestId}`); assert.equal(init?.method, 'GET'); operationReads++;
      const connection = { id: 'sync', calendarId: 'cal', revision: 2, allowDeletes: false, status: 'connected', pendingExportCount: 0 };
      return Response.json({ requestId: 'get-r', data: { operation: operationReads === 1 ? { state: 'running' } : { state: 'completed', result: { connection, imported: 1, exported: 0, deleted: 0, unsupportedCount: 0, conflicts: [] } } } });
    }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  press(view, '캘린더'); press(view, 'Google 캘린더 동기화'); await view.settle();
  press(view, 'cal 동기화 실행'); await view.settle();
  assert.match(textOf(view.tree), /처리 결과를 확인하지 못했습니다/);
  assert.equal(nodes(view.tree).some(item => item.props?.accessibilityLabel === '같은 동기화 요청 재시도'), false);
  press(view, '동기화 상태 다시 조회'); await view.settle(); assert.equal(runs, 1); assert.equal(lists, 2);
  press(view, '저장된 동기화 결과 확인'); await view.settle(); assert.equal(operationReads, 1); assert.equal(runs, 1);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'another'); press(view, '설정 적용');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/); assert.equal(runs, 1);
  press(view, '개발 연결 설정'); press(view, '저장된 동기화 결과 확인'); await view.settle();
  assert.equal(operationReads, 2); assert.equal(runs, 1); assert.match(textOf(view.tree), /가져옴 1건/);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'another'); press(view, '설정 적용');
  assert.doesNotMatch(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/); view.unmount();
});

test('인증 화면에서 건강 화면으로 이동하면 인증 초안을 지우고 기존 세션을 보존한다', async () => {
  const { App } = await components; let resolveStart!: (response: Response) => void;
  globalThis.fetch = async raw => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/auth/google/start') return new Promise<Response>(resolve => { resolveStart = resolve; });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'preview'); visiblePress(view, '설정 적용'); await view.settle();
  const previousMarker = chat(view).props.marker;
  visiblePress(view, '개발 연결 설정'); visiblePress(view, 'Google 로그인 또는 가입'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  visiblePress(view, '개발 연결 설정'); visiblePress(view, '연결'); visiblePress(view, '건강 데이터'); await view.settle();
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '걸음 수 선택'), true);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === 'Google 로그인 시작'), false);
  resolveStart(Response.json({ requestId: 'r', data: { authorizationUrl: 'invalid', completionSecret: 'q'.repeat(43) } })); await view.settle();
  visiblePress(view, '나중에'); assert.equal(chat(view).props.marker, previousMarker);
  visiblePress(view, '개발 연결 설정'); visiblePress(view, 'Google 로그인 또는 가입');
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === 'Google 로그인 확인 코드'), false);
  view.unmount();
});

test('로그인 완료 처리 중에는 건강 화면 전환을 차단한다', async () => {
  const { App } = await components; let resolveComplete!: (response: Response) => void;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
    nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;
  globalThis.fetch = async raw => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/auth/google/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/auth/google/complete') return new Promise<Response>(resolve => { resolveComplete = resolve; });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); visiblePress(view, 'Google 로그인 또는 가입'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); visiblePress(view, 'Google 로그인 확인'); await view.settle();
  visiblePress(view, '개발 연결 설정'); visiblePress(view, '연결'); visiblePress(view, '건강 데이터');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '걸음 수 선택'), false);
  resolveComplete(Response.json({ requestId: 'r', data: { sessionToken: 'synthetic', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'member:1', email: 'a@example.test', displayName: 'A' } } }));
  await view.settle(); view.unmount();
});

test('루틴 재진입 시 편집하지 않은 날짜만 선택일로 갱신하고 작성 중인 초안은 보존한다', async () => {
  const { App } = await components;
  globalThis.fetch = async raw => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/routines') return Response.json({ requestId: 'r', data: { routines: [] } });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); visiblePress(view, '설정 적용'); await view.settle();
  visiblePress(view, '루틴'); await view.settle(); visiblePress(view, '뒤로'); visiblePress(view, '캘린더');
  const calendar = node(view, 'CalendarScreen'); const timezone = calendar.props.timezone;
  const localDate = (date: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const first = new Date('2027-01-11T12:00:00Z'); calendar.props.onSelectDate(first); view.flush();
  visiblePress(view, '루틴'); await view.settle();
  assert.equal(input(view, '루틴 시작일').props.value, localDate(first)); assert.equal(input(view, '회차 시작일').props.value, localDate(first)); assert.equal(input(view, '회차 종료일').props.value, localDate(first));
  enter(view, '루틴 이름', '작성 중'); enter(view, '루틴 시작일', '2027-02-01'); enter(view, '회차 시작일', '2027-02-02');
  visiblePress(view, '뒤로'); const second = new Date('2027-01-20T12:00:00Z'); node(view, 'CalendarScreen').props.onSelectDate(second); view.flush();
  visiblePress(view, '루틴'); await view.settle();
  assert.equal(input(view, '루틴 이름').props.value, '작성 중'); assert.equal(input(view, '루틴 시작일').props.value, '2027-02-01');
  assert.equal(input(view, '회차 시작일').props.value, '2027-02-02'); assert.equal(input(view, '회차 종료일').props.value, localDate(second)); view.unmount();
});

test('루틴 회차 요청이 불명일 때 화면 재진입과 날짜 변경이 원래 요청과 초안을 보존한다', async () => {
  const { App, operationGuard } = await components; const writes: any[] = [];
  globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/routines' && init?.method === 'GET') return Response.json({ requestId: 'r', data: { routines: [] } });
    if (path === '/v1/routines/materialize') { writes.push({ body: String(init?.body), key: (init?.headers as Record<string, string>)['Idempotency-Key'] }); throw new Error('lost'); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); visiblePress(view, '설정 적용'); await view.settle();
  visiblePress(view, '루틴'); await view.settle(); enter(view, '루틴 이름', '보존할 초안');
  const original = input(view, '루틴 시작일').props.value;
  visiblePress(view, '회차 생성'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  visiblePress(view, '뒤로'); visiblePress(view, '캘린더'); node(view, 'CalendarScreen').props.onSelectDate(new Date('2027-03-10T12:00:00Z')); view.flush();
  visiblePress(view, '루틴'); await view.settle();
  assert.equal(input(view, '루틴 이름').props.value, '보존할 초안'); assert.equal(input(view, '루틴 시작일').props.value, original);
  assert.match(textOf(view.tree), /결과를 확인하지 못했습니다/); assert.equal(writes.length, 1);
  visiblePress(view, '같은 루틴 요청 재시도'); await view.settle(); assert.deepEqual(writes[1], writes[0]);
  assert.equal(operationGuard.hasUnresolved(), true); view.unmount();
});

test('기존 동기화 연결에 선택 일정을 추가하고 응답 유실 재시도는 같은 내부 요청만 사용한다', async () => {
  const { App, operationGuard } = await components; const writes: any[] = []; let listReads = 0;
  let connection = { id: 'sync-1', calendarId: 'cal-1', revision: 3, allowDeletes: false, status: 'connected', pendingExportCount: 1 };
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw)), path = url.pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-sync') { listReads++; return Response.json({ requestId: 'r', data: { connections: [connection] } }); }
    if (path === '/v1/calendar-sync/calendars') return Response.json({ requestId: 'r', data: { calendars: [{ id: 'cal-1', summary: '내 달력', accessRole: 'owner' }] } });
    if (path === '/v1/schedule') {
      const from = Date.parse(url.searchParams.get('from')!);
      return Response.json({ requestId: 'r', data: { scheduleRevision: 0, items: [{ id: 'item-1', revision: 1, kind: 'event', title: '새 일정',
        timeSlot: { startsAt: new Date(from + 3_600_000).toISOString(), endsAt: new Date(from + 7_200_000).toISOString(), timezone: url.searchParams.get('timezone') },
        durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', sourceRefs: [] }] } });
    }
    if (path === '/v1/calendar-sync/sync-1/exports') {
      writes.push({ path, body: String(init?.body), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
      if (writes.length === 1) throw new Error('lost');
      connection = { ...connection, revision: 4, pendingExportCount: 2 };
      return Response.json({ requestId: 'r', data: { connection } });
    }
    if (path === '/v1/calendar-sync/connect' || path.endsWith('/run')) throw new Error(`unexpected write ${path}`);
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); visiblePress(view, '설정 적용'); await view.settle();
  visiblePress(view, '캘린더'); visiblePress(view, 'Google 캘린더 동기화'); await view.settle();
  assert.match(textOf(view.tree), /내가 주최한 기존 공동 약속은 승인된 연락과 응답/);
  assert.match(textOf(view.tree), /새 공동 약속 내보내기, 삭제, 다른 사람 주최, Google에서 변경된 공동 약속이나 확인되지 않은 변경은 검토 대상/);
  visiblePress(view, '캘린더 내 달력');
  assert.match(textOf(view.tree), /이미 연결된 캘린더/);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '동기화 연결'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '선택한 일정 추가')?.props.disabled, true);
  visiblePress(view, '내보낼 일정 새 일정'); visiblePress(view, '선택한 일정 추가'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(writes.length, 1);
  visiblePress(view, '뒤로'); visiblePress(view, 'Google 캘린더 동기화'); await view.settle();
  assert.ok(listReads >= 2); assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '같은 동기화 요청 재시도'), true);
  visiblePress(view, '같은 동기화 요청 재시도'); await view.settle();
  assert.deepEqual(writes[1], writes[0]); assert.deepEqual(JSON.parse(writes[0].body).exportItemIds, ['item-1']);
  assert.equal(JSON.parse(writes[0].body).expectedRevision, 3); assert.ok(writes[0].key);
  assert.match(textOf(view.tree), /Google 전송은 동기화 실행 시 진행/); assert.equal(operationGuard.hasUnresolved(), false); view.unmount();
});

test('동기화 쓰기 권한 연결 후 화면에 다시 들어오면 목록을 자동으로 새로 조회한다', async () => {
  const { App } = await components; let enabled = false, calendarReads = 0;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
    redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly' })}`;
  globalThis.fetch = async raw => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-sync') return Response.json({ requestId: 'r', data: { connections: [] } });
    if (path === '/v1/calendar-sync/calendars') {
      calendarReads++;
      return enabled ? Response.json({ requestId: 'r', data: { calendars: [{ id: 'cal', summary: '새로 연결된 달력', accessRole: 'owner' }] } }) :
        Response.json({ requestId: 'r', error: { code: 'not_configured', message: 'not configured', retryable: false } }, { status: 503 });
    }
    if (path === '/v1/schedule') return Response.json({ requestId: 'r', data: { items: [], scheduleRevision: 0 } });
    if (path === '/v1/calendar-connection' || path === '/v1/calendar-write-connection') return Response.json({ requestId: 'r', data: { status: enabled ? 'available' : 'not_configured', accountLabel: enabled ? 'test@example.test' : null } });
    if (path === '/v1/email-connection' || path === '/v1/email-reply-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', senderAddress: null } });
    if (path === '/v1/google/oauth/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/google/oauth/complete') { enabled = true; return Response.json({ requestId: 'r', data: { status: 'connected' } }); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  visiblePress(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); visiblePress(view, '설정 적용'); await view.settle();
  visiblePress(view, '캘린더'); visiblePress(view, 'Google 캘린더 동기화'); await view.settle();
  assert.match(textOf(view.tree), /캘린더 목록을 확인하지 못했습니다/); assert.equal(calendarReads, 1);
  visiblePress(view, '뒤로'); visiblePress(view, 'Google 연결'); await view.settle();
  visiblePress(view, 'Google 캘린더 동기화 연결 시작'); await view.settle();
  enter(view, 'Google 연결 확인 코드', 'z'.repeat(43)); visiblePress(view, 'Google 연결 확인'); await view.settle();
  visiblePress(view, '뒤로'); visiblePress(view, 'Google 캘린더 동기화'); await view.settle();
  assert.equal(calendarReads, 2); assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '캘린더 새로 연결된 달력')); view.unmount();
});
