import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Render the real app/ProposalPanel with native views and unrelated screens replaced by local test doubles.
function createHarness() {
  let current: any;
  const views = new Set<any>();
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
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', Image: 'Image',
    Modal: ({ visible = true, children }: any) => visible ? children : null,
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch',
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove() {} }) },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    BackHandler: { addEventListener: (_event: string, listener: () => boolean) => { backListeners.add(listener); return { remove: () => backListeners.delete(listener) }; } },
    Linking: { openURL: async (url: string) => { openedLinks.push(url); } },
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host: any = { react, native, jsx, fragment, backListeners, openedLinks, marker: 0, fontState: [true, null],
    profile: { scope: 'test', load: { status: 'success', value: null, contextRevision: 0 }, mutation: { state: { status: 'idle' }, canRetry: true }, refresh() {}, save() { return true; }, skip() { return true; } } };
  (globalThis as any).__appIntegrationHarness = host;

  function renderer(Component: any, initialProps: any = {}) {
    const view: any = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    views.add(view);
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
    view.unmount = () => { for (const instance of view.instances.values()) { instance.alive = false; for (const hook of instance.hooks) hook?.cleanup?.(); } view.instances.clear(); views.delete(view); };
    view.flush();
    return view;
  }
  return { renderer, cleanup: () => { for (const view of views) view.unmount(); } };
}

const harness = createHarness();
const testDir = resolve(__dirname);
const components = build({
  stdin: { contents: `export { default } from '../App'; export { operationGuard } from '../src/api/operationGuard';
    import { useMutation } from '../src/api/useMutation'; import { jsx } from 'react/jsx-runtime';
    export function MutationTester({ run }) { const action = useMutation(run); return jsx('MutationTester', action); }`,
    resolveDir: testDir, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.otf': 'empty', '.ttf': 'empty', '.png': 'empty' },
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^\.\/usePlanningProfile$/ }, () => ({ path: 'profile-hook', namespace: 'app-native' }));
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|react-native-safe-area-context|expo-status-bar|expo-font|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface|DateTimeFields))$/ }, (args) => ({ path: args.path, namespace: 'app-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'app-native' }, ({ path }) => ({
      contents: path === 'profile-hook' ? 'exports.usePlanningProfile=()=>globalThis.__appIntegrationHarness.profile' :
        path.endsWith('/DateTimeFields') ? 'exports.DateTimeFields=({label,value,disabled,onChange})=>globalThis.__appIntegrationHarness.jsx("TextInput",{accessibilityLabel:label,value,editable:!disabled,onChangeText:onChange})' :
        path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"; exports.FontReadyContext={Provider:({children})=>children}' :
        path === 'expo-font' ? 'exports.useFonts=()=>globalThis.__appIntegrationHarness.fontState' :
        path === 'react' ? 'module.exports = globalThis.__appIntegrationHarness.react' :
        path === 'react-native' ? 'module.exports = globalThis.__appIntegrationHarness.native' :
        path === 'react-native-safe-area-context' ? 'exports.SafeAreaProvider = ({children}) => children; exports.SafeAreaView = "View"; exports.useSafeAreaInsets=()=>({top:0,right:0,bottom:0,left:0})' :
        path === 'expo-status-bar' ? 'exports.StatusBar = "StatusBar"' :
          'exports.jsx = exports.jsxs = globalThis.__appIntegrationHarness.jsx; exports.Fragment = globalThis.__appIntegrationHarness.fragment', loader: 'js',
    }));
    builder.onResolve({ filter: /^\.\/src\/(chat\/ChatScreen|memory\/MemoryPanel|screens\/CalendarScreen|screens\/DayScreen|screens\/HomeScreen)$/ }, (args) => ({ path: args.path, namespace: 'app-screen' }));
    builder.onLoad({ filter: /.*/, namespace: 'app-screen' }, ({ path }) => ({
      contents: path.endsWith('ChatScreen')
        ? 'const R=require("react"), {jsx}=require("react/jsx-runtime"); module.exports=function ChatScreen(props){const [marker]=R.useState(()=>++globalThis.__appIntegrationHarness.marker);return jsx("ChatScreen",{...props,marker,children:globalThis.__appIntegrationHarness.inlineProposalId ? props.renderProposal?.(globalThis.__appIntegrationHarness.inlineProposalId) : null})}'
        : path.endsWith('HomeScreen')
        ? 'const {jsx}=require("react/jsx-runtime"); module.exports=function HomeScreen(props){return jsx("HomeScreen",{...props,children:jsx("Pressable",{accessibilityLabel:"설정 열기",onPress:props.onOpenSettings})})}'
        : `const {jsx}=require('react/jsx-runtime'); module.exports=function Stub(props){return jsx(${JSON.stringify(path.split('/').pop())},props)}`,
      loader: 'js',
    }));
  } }],
}).then((bundled) => {
  const compiled: any = { exports: {} };
  new Function('module', 'exports', '__DEV__', bundled.outputFiles[0].text)(compiled, compiled.exports, true);
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
  if (!found && label === '개발 연결 설정') { openSettingsOption(view, '계정·앱 설정'); return; }
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
function openConnections(view: any) {
  if (visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '계정·앱 설정')) return;
  if (!visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '홈')) visiblePress(view, '뒤로');
  if (!visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '설정 열기')) visiblePress(view, '홈');
  visiblePress(view, '설정 열기');
  visiblePress(view, '계정');
}
function openSettingsOption(view: any, label: string) { openConnections(view); visiblePress(view, label); }
function press(view: any, label: string) {
  if (label === '개발 연결 설정' && !nodes(view.tree).some(item => item.props?.accessibilityLabel === label)) {
    openSettingsOption(view, '계정·앱 설정'); return;
  }
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
test.afterEach(() => { harness.cleanup(); delete (globalThis as any).__appIntegrationHarness.inlineProposalId; globalThis.fetch = originalFetch; (globalThis as any).__appIntegrationHarness.fontState = [true, null]; (globalThis as any).__appIntegrationHarness.openedLinks.length = 0; });

test('기본 홈과 다섯 진입을 표시하고 추가 시트에서 AI 초안 요청으로 이동한다', async () => {
  const { App } = await components;
  globalThis.fetch = async () => response([]);
  const view = harness.renderer(App);
  assert.match(textOf(view.tree), /당신의 하루를/);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  assert.ok(visibleNodes(view.tree).some(item => item.type === 'HomeScreen'));
  for (const label of ['홈', '캘린더', 'PIKKU', '추가', '루틴']) {
    assert.ok(visibleNodes(view.tree).some(item => item.type === 'Pressable' && item.props.accessibilityLabel === label), label);
  }
  visiblePress(view, '추가');
  assert.match(textOf(view.tree), /무엇을 추가할까요/);
  for (const label of ['PIKKU에게 부탁하기', '일정 추가', '할 일 추가', '루틴 추가']) {
    assert.ok(visibleNodes(view.tree).some(item => item.type === 'Pressable' && (item.props.accessibilityLabel === label || textOf(item.children) === label)), label);
  }
  visiblePress(view, 'PIKKU에게 부탁하기');
  assert.equal(chat(view).props.entryContext.kind, 'create');
  assert.ok(visibleNodes(view.tree).some(item => item.type === 'ChatScreen'));
});

test('선호·상황은 프로필에서만 열리고 뒤로 가면 프로필로 돌아간다', async () => {
  const { App } = await components;
  globalThis.fetch = async () => response([]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  visiblePress(view, '설정 열기'); visiblePress(view, '내 선호와 상황');
  assert.ok(visibleNodes(view.tree).some(item => item.type === 'MemoryPanel'));
  node(view, 'MemoryPanel').props.onBack(); view.flush();
  assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '내 선호와 상황'));
  visiblePress(view, '계정');
  assert.equal(visibleNodes(view.tree).filter(item => item.props?.accessibilityLabel === '내 프로필').length, 1);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '내 정보·선호'), false);
  visiblePress(view, '내 프로필'); visiblePress(view, '내 선호와 상황');
  assert.ok(visibleNodes(view.tree).some(item => item.type === 'MemoryPanel'));
  node(view, 'MemoryPanel').props.onBack(); view.flush();
  assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '내 선호와 상황'));
  view.unmount();
});

test('설정의 예시 일정은 기존 대화와 미해결 요청을 유지하며 읽기 전용이다', async t => {
  const { App, operationGuard } = await components;
  const owner = {}; t.after(() => operationGuard.clear(owner));
  const writes: string[] = [];
  globalThis.fetch = async (raw, init) => {
    if (init?.method && init.method !== 'GET') writes.push(new URL(String(raw)).pathname);
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  const marker = chat(view).props.marker;
  openConnections(view);
  operationGuard.update(owner, { status: 'pending' });
  visiblePress(view, '예시 일정 미리보기');
  assert.equal(chat(view).props.marker, marker); assert.equal(operationGuard.hasUnresolved(), true);
  assert.match(textOf(view.tree), /시연용 예시입니다/);
  const list = node(view, 'ScrollView', item => item.props.accessibilityLabel === '예시 일정 목록');
  const cards = nodes(list.children).filter(item => item.type === 'Pressable' &&
    item.props.accessibilityRole === undefined && item.props.accessibilityLabel?.startsWith('예시 · '));
  assert.equal(cards.length, 10); assert.ok(cards.every(item => item.props.disabled === true));
  const previewControls = nodes(list.children).filter(item => item.type === 'Pressable' && item.props.accessibilityLabel?.startsWith('예시 · '));
  assert.ok(previewControls.length > cards.length); assert.ok(previewControls.every(item => item.props.disabled === true));
  assert.deepEqual(writes, []);
  visiblePress(view, '예시 닫기');
  assert.equal(chat(view).props.marker, marker); assert.equal(operationGuard.hasUnresolved(), true);
  assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '예시 일정 미리보기'));
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '예시 일정 목록'), false);
  assert.deepEqual(writes, []);
  view.unmount();
});

test('폼 AI 초안 왕복에서 원래 날짜와 입력을 보존하고 새 요청을 구분한다', async () => {
  const { App } = await components; let writes = 0;
  globalThis.fetch = async (raw, init) => {
    if (init?.method && init.method !== 'GET') { writes++; throw new Error('unexpected synthetic write'); }
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/schedule') return apiResponse({ items: [], scheduleRevision: 0 });
    if (path === '/v1/proposals') return response([]);
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  visiblePress(view, '캘린더');
  const first = new Date('2027-01-11T12:00:00Z'); node(view, 'CalendarScreen').props.onSelectDate(first); view.flush();
  visiblePress(view, '추가'); visiblePress(view, '일정 추가'); await view.settle();
  const originalDate = input(view, '시작 날짜').props.value;
  assert.ok(originalDate); enter(view, '제목', '직접 작성');
  visiblePress(view, 'AI로 작성하기');
  const firstContext = chat(view).props.entryContext;
  assert.equal(firstContext.kind, 'form'); assert.equal(firstContext.draft.fields.title, '직접 작성');
  visiblePress(view, '캘린더'); visiblePress(view, '월간 캘린더로');
  node(view, 'CalendarScreen').props.onSelectDate(new Date('2027-01-20T12:00:00Z')); view.flush();
  visiblePress(view, 'PIKKU');
  chat(view).props.onApplyDraft({ kind: 'event', fields: { title: 'AI 제안' } }); view.flush(); await view.settle();
  assert.equal(input(view, '시작 날짜').props.value, originalDate);
  assert.equal(input(view, '제목').props.value, '직접 작성');
  assert.match(textOf(view.tree), /AI 초안 확인/); visiblePress(view, '제안 값 적용');
  assert.equal(input(view, '제목').props.value, 'AI 제안');
  visiblePress(view, 'AI로 작성하기');
  const secondContext = chat(view).props.entryContext;
  assert.equal(secondContext.kind, 'form'); assert.notEqual(secondContext.key, firstContext.key);
  assert.equal(secondContext.draft.fields.title, 'AI 제안');
  chat(view).props.onApplyDraft({ kind: 'event', fields: { title: '두 번째 제안' } }); view.flush();
  visiblePress(view, '기존 값 유지'); assert.equal(input(view, '제목').props.value, 'AI 제안');
  assert.equal(input(view, '시작 날짜').props.value, originalDate); assert.equal(writes, 0);
});

test('미확정 요청 중 추가 폼을 작성하고 확인 화면을 오가며 저장은 해결 후에만 한다', async () => {
  const { App, operationGuard } = await components;
  const owner = {}; const writes: any[] = [];
  globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/schedule') return apiResponse({ items: [], scheduleRevision: 0 });
    if (path === '/v1/schedule/commands') { writes.push(JSON.parse(String(init?.body))); return apiResponse({ outcome: 'applied', items: [], deletedIds: [], scheduleRevision: 1 }); }
    return response([]);
  };
  const view = harness.renderer(App);
  try {
    press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
    visiblePress(view, '추가'); visiblePress(view, 'PIKKU에게 부탁하기');
    const existingContext = chat(view).props.entryContext; assert.equal(existingContext.kind, 'create');
    visiblePress(view, '캘린더'); node(view, 'CalendarScreen').props.onSelectDate(new Date('2027-01-11T12:00:00Z')); view.flush();
    operationGuard.update(owner, { status: 'pending' });
    node(view, 'DayScreen').props.createRequest(); view.flush(); visiblePress(view, '할 일 추가'); await view.settle();
    assert.match(textOf(view.tree), /초안은 작성할 수 있습니다/);
    enter(view, '제목', '보존할 초안'); enter(view, '시작 시간', '09:00'); enter(view, '종료 시간', '09:30');
    visiblePress(view, '저장'); assert.equal(writes.length, 0);
    assert.match(textOf(view.tree), /요청을 시작한 화면에서 확인한 뒤 저장/);
    operationGuard.update(owner, { status: 'error', error: new Error('timeout'), uncertain: true });
    visiblePress(view, '저장'); assert.equal(writes.length, 0);
    const marker = chat(view).props.marker; const oldContext = chat(view).props.entryContext;
    visiblePress(view, 'AI로 작성하기'); assert.equal(chat(view).props.entryContext, oldContext);
    assert.equal(input(view, '제목').props.value, '보존할 초안');
    visiblePress(view, 'PIKKU 열기'); assert.equal(chat(view).props.marker, marker);
    visiblePress(view, '추가'); visiblePress(view, 'PIKKU에게 부탁하기');
    assert.equal(chat(view).props.entryContext, existingContext);
    visiblePress(view, '추가'); visiblePress(view, '일정 추가'); await view.settle();
    assert.equal(input(view, '제목').props.value, '보존할 초안');
    assert.equal(input(view, '시작 시간').props.value, '09:00'); assert.equal(input(view, '종료 시간').props.value, '09:30');
    operationGuard.update(owner, { status: 'success', result: null });
    visiblePress(view, '저장'); await view.settle();
    assert.equal(writes.length, 1); assert.equal(writes[0].changeSet.changes[0].after.title, '보존할 초안');
  } finally { operationGuard.clear(owner); view.unmount(); }
});

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
  assert.match(textOf(view.tree), /제안 목록/); assert.match(textOf(view.tree), /일정/); assert.doesNotMatch(textOf(view.tree), /새로운 제안/);
  view.unmount();
});

test('제안의 준비시간 관계는 연결된 일정과 확인 필요 여부로 표시한다', async () => {
  const { App } = await components;
  const item = proposal('시간 관계 제안');
  const withTiming = { ...item, changeSet: { ...item.changeSet, timingConstraints: [{ appointment: { kind: 'existing', id: 'event-1', expectedRevision: 2 },
    preparationMinutes: 15, travelMinutes: 0, bufferMinutes: null, segments: { preparation: 'c1', travel: null, buffer: null } }] } };
  globalThis.fetch = async (url) => new URL(String(url)).pathname === '/v1/proposals/p1'
    ? Response.json({ requestId: 'r', data: { proposal: withTiming } }) : response([withTiming]);
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용'); await view.settle();
  chat(view).props.onOpenProposals(); view.flush(); press(view, '제안 일정, 확인 대기, 상세 보기'); await view.settle();
  assert.match(textOf(view.tree), /준비와 이동/); assert.match(textOf(view.tree), /관련 약속 확인 필요/);
  assert.match(textOf(view.tree), /준비 15분 · 이동 0분 · 여유 미확인/); assert.match(textOf(view.tree), /준비 일정: 일정/);
  assert.match(textOf(view.tree), /이동 일정: 별도 일정 없음/); assert.doesNotMatch(textOf(view.tree), /기준 약속: event-1|연결된 변경 ID/);
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
    const item = proposal('새 사용자 제안'); item.changeSet.changes[0].after.title = '새 사용자 일정'; return response([item]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'old-user'); press(view, '설정 적용');
  await view.settle();
  const oldMarker = chat(view).props.marker;
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'new-user'); press(view, '설정 적용');
  await view.settle();
  assert.notEqual(chat(view).props.marker, oldMarker);
  assert.match(textOf(view.tree), /새 사용자 일정/);
  const oldItem = proposal('이전 사용자 제안'); oldItem.changeSet.changes[0].after.title = '이전 사용자 일정'; resolveOld(response([oldItem]));
  await view.settle();
  assert.doesNotMatch(textOf(view.tree), /이전 사용자 일정/);
  assert.match(textOf(view.tree), /새 사용자 일정/);
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
    if (path === '/v1/google/oauth/complete') return Response.json({ requestId: 'r', data: { status: init?.body && JSON.parse(String(init.body)).confirmationCode ? 'connected' : 'pending' } });
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'old-user'); press(view, '설정 적용'); await view.settle();
  openSettingsOption(view, 'Google 연결'); await view.settle();
  press(view, 'Gmail 발송 연결 시작'); await view.settle();
  assert.equal((globalThis as any).__appIntegrationHarness.openedLinks.length, 0);
  assert.doesNotMatch(textOf(view.tree), /ssssssssss|qqqqqqqqqq|accounts\.google\.com/);
  assert.deepEqual(requests.find((item) => item.path === '/v1/google/oauth/start').body, { kind: 'gmail_send' });
  press(view, 'Google 동의 화면 열기'); await view.settle();
  assert.deepEqual((globalThis as any).__appIntegrationHarness.openedLinks, [authorizationUrl]);
  press(view, '자동 확인이 안 되나요?'); assert.match(textOf(view.tree), /다른 사람에게 전달하지 마세요/);
  assert.equal(input(view, 'Google 연결 확인 코드').props.secureTextEntry, true);
  enter(view, 'Google 연결 확인 코드', confirmationCode); press(view, 'Google 연결 확인'); await view.settle();
  assert.deepEqual(requests.find((item) => item.path === '/v1/google/oauth/complete' && item.body.confirmationCode).body, { completionSecret, confirmationCode });
  assert.equal(requests.filter((item) => item.path === '/v1/google/oauth/complete' && item.body.confirmationCode).length, 1);
  assert.doesNotMatch(textOf(view.tree), /qqqqqqqqqq|zzzzzzzzzz/);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'new-user'); press(view, '설정 적용'); await view.settle();
  openSettingsOption(view, 'Google 연결'); await view.settle();
  for (const resolve of releaseOld) resolve(Response.json({ requestId: 'r', data: { status: 'available', accountLabel: '이전 계정' } })); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /이전 계정|ssssssssss/);
  assert.equal(nodes(view.tree).some((item) => item.type === 'Pressable' && textOf(item.children) === 'Google 동의 화면 열기'), false);
  view.unmount();
});

test('Google 연결 확인 응답 유실은 같은 흐름을 잠그고 명시 취소로 해제한다', async () => {
  const { App, operationGuard } = await components; let completions = 0;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code',
    state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send' })}`;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/calendar-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', accountLabel: null } });
    if (path === '/v1/email-connection' || path === '/v1/email-reply-connection') return Response.json({ requestId: 'r', data: { status: 'not_configured', senderAddress: null } });
    if (path === '/v1/google/oauth/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/google/oauth/complete') { const body = JSON.parse(String(init?.body));
      if (body.cancel) return apiResponse({ status: 'cancelled' });
      if (!body.confirmationCode) return apiResponse({ status: 'pending' });
      completions++; throw new Error('connection lost'); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test-user'); press(view, '설정 적용'); await view.settle();
  openSettingsOption(view, 'Google 연결'); await view.settle(); press(view, 'Gmail 발송 연결 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 연결 확인 코드', 'z'.repeat(43)); press(view, 'Google 연결 확인'); await view.settle();
  assert.equal(completions, 1); assert.match(textOf(view.tree), /연결 결과를 확인하고 있습니다/);
  assert.equal(operationGuard.hasUnresolved(), true);
  press(view, '진행 중인 Google 연결 취소'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
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

const reviewDefaults = { revision: 0, timezone: 'Asia/Seoul', evening: { enabled: false, localTime: null }, morning: { enabled: false, localTime: null } };
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
  enter(view, '저녁 시각', '21:45');
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
  toggle(view, '저녁 자동 검토', true); enter(view, '저녁 시각', '21:00');
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
  press(view, '제안 일정 외 1개, 확인 대기, 상세 보기'); await view.settle();
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
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용'); await view.settle();
  press(view, '캘린더');
  openSettingsOption(view, '캘린더 일정 가져오기');
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
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용');
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
    if (path === '/v1/auth/google/complete') return Response.json({ requestId: 'r', data: JSON.parse(String(init?.body)).confirmationCode
      ? { sessionToken: 'synthetic-member-token', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'member:123', email: 'synthetic@example.test', displayName: '테스트 사용자' } }
      : { status: 'pending' } });
    if (path === '/v1/calendar-connection') return apiResponse({ status: 'not_configured', accountLabel: null, accountRef: null });
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
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); press(view, 'Google 로그인 확인'); await view.settle();
  assert.match(textOf(view.tree), /PERSONALIZE · 1 \/ 2/);
  press(view, '다음'); assert.match(textOf(view.tree), /PERSONALIZE · 2 \/ 2/);
  press(view, '이전'); press(view, '이전'); await view.settle();
  assert.notEqual(chat(view).props.marker, before);
  assert.equal(calls.filter(item => item.path === '/v1/calendar-connection').length, 1);
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
  assert.match(textOf(view.tree), /목요일 루틴 미리보기/);
  for (const title of ['아침 스트레칭', '독서', '가벼운 걷기']) assert.match(textOf(view.tree), new RegExp(title));
  assert.match(textOf(view.tree), /예시이며 등록된 루틴이나 완료 기록이 아닙니다/); assert.equal(writes.length, 0);
  press(view, '전체 루틴');
  enter(view, '루틴 이름', '운동'); press(view, '월요일'); enter(view, '루틴 시작일', '2026-11-01'); press(view, '루틴 등록'); await view.settle();
  assert.doesNotMatch(textOf(view.tree), /목요일 루틴 미리보기/);
  assert.deepEqual(writes[0].body.weekdays, [1]); assert.ok((writes[0].headers as Record<string, string>)['Idempotency-Key']);
  press(view, '운동 편집'); press(view, '화요일'); press(view, '루틴 변경 저장'); await view.settle();
  assert.equal(writes[1].method, 'PATCH'); assert.deepEqual(writes[1].body.weekdays, [1, 2]); assert.equal(writes[1].body.expectedRevision, 1);
  enter(view, '회차 시작일', '2026-11-01'); enter(view, '회차 종료일', '2026-11-03'); press(view, '회차 생성'); await view.settle();
  assert.match(textOf(view.tree), /생성 1건 · 기존 0건/); assert.match(textOf(view.tree), /일정 충돌/);
  assert.equal(writes[2].body.fromDate, '2026-11-01'); press(view, '하루 일정 보기'); view.unmount();
});

test('로그인 완료 응답 유실은 같은 흐름을 잠그고 취소 후 기존 계정을 유지한다', async () => {
  const { App, operationGuard } = await components; let completions = 0;
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
    nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/proposals') return response([]);
    if (path === '/v1/auth/google/start') return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: 'q'.repeat(43) } });
    if (path === '/v1/auth/google/complete') { const body = JSON.parse(String(init?.body));
      if (body.cancel) return apiResponse({ status: 'cancelled' });
      if (!body.confirmationCode) return apiResponse({ status: 'pending' });
      completions++; throw new Error('lost'); }
    throw new Error(`unexpected ${path}`);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'preview'); press(view, '설정 적용'); await view.settle();
  const before = chat(view).props.marker;
  press(view, '개발 연결 설정'); press(view, 'Google 로그인 또는 가입'); press(view, 'Google 로그인 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); press(view, 'Google 로그인 확인'); await view.settle();
  assert.equal(completions, 1); assert.match(textOf(view.tree), /로그인 결과를 확인하고 있습니다/);
  assert.equal(operationGuard.hasUnresolved(), true);
  press(view, '진행 중인 로그인 취소'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false); assert.equal(chat(view).props.marker, before); view.unmount();
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
  press(view, '캘린더'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
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
  openSettingsOption(view, 'Google 연결'); await view.settle(); press(view, 'Google 캘린더 동기화 연결 시작'); await view.settle();
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
  press(view, '캘린더'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
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

test('인증을 취소한 뒤 건강 화면으로 이동해도 기존 세션을 보존한다', async () => {
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
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '개발 연결 설정'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '뒤로')?.props.disabled, true);
  resolveStart(memberAuthFixture()); await view.settle(); visiblePress(view, '뒤로');
  visiblePress(view, '개발 연결 설정'); visiblePress(view, '연결'); visiblePress(view, '건강 데이터'); await view.settle();
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '걸음 수 선택'), true);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === 'Google 로그인 시작'), false);
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
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); visiblePress(view, 'Google 로그인 확인'); await view.settle();
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '개발 연결 설정'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '뒤로')?.props.disabled, true);
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
  visiblePress(view, '루틴'); await view.settle(); visiblePress(view, '전체 루틴'); visiblePress(view, '캘린더');
  const calendar = node(view, 'CalendarScreen'); const timezone = calendar.props.timezone;
  const localDate = (date: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const first = new Date('2027-01-11T12:00:00Z'); calendar.props.onSelectDate(first); view.flush();
  visiblePress(view, '루틴'); await view.settle();
  assert.equal(input(view, '루틴 시작일').props.value, localDate(first)); assert.equal(input(view, '회차 시작일').props.value, localDate(first)); assert.equal(input(view, '회차 종료일').props.value, localDate(first));
  enter(view, '루틴 이름', '작성 중'); enter(view, '루틴 시작일', '2027-02-01'); enter(view, '회차 시작일', '2027-02-02');
  visiblePress(view, '캘린더'); const second = new Date('2027-01-20T12:00:00Z'); node(view, 'CalendarScreen').props.onSelectDate(second); view.flush();
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
  visiblePress(view, '루틴'); await view.settle(); visiblePress(view, '전체 루틴'); enter(view, '루틴 이름', '보존할 초안');
  const original = input(view, '루틴 시작일').props.value;
  visiblePress(view, '회차 생성'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  visiblePress(view, '캘린더'); node(view, 'CalendarScreen').props.onSelectDate(new Date('2027-03-10T12:00:00Z')); view.flush();
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
  visiblePress(view, '캘린더'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
  assert.match(textOf(view.tree), /내가 주최한 기존 공동 약속은 승인된 연락과 응답/);
  assert.match(textOf(view.tree), /새 공동 약속 내보내기, 삭제, 다른 사람 주최, Google에서 변경된 공동 약속이나 확인되지 않은 변경은 검토 대상/);
  visiblePress(view, '캘린더 내 달력');
  assert.match(textOf(view.tree), /이미 연결된 캘린더/);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '동기화 연결'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '선택한 일정 추가')?.props.disabled, true);
  visiblePress(view, '내보낼 일정 새 일정'); visiblePress(view, '선택한 일정 추가'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(writes.length, 1);
  visiblePress(view, '뒤로'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
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
  visiblePress(view, '캘린더'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
  assert.match(textOf(view.tree), /캘린더 목록을 확인하지 못했습니다/); assert.equal(calendarReads, 1);
  visiblePress(view, '뒤로'); openSettingsOption(view, 'Google 연결'); await view.settle();
  visiblePress(view, 'Google 캘린더 동기화 연결 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 연결 확인 코드', 'z'.repeat(43)); visiblePress(view, 'Google 연결 확인'); await view.settle();
  visiblePress(view, '뒤로'); openSettingsOption(view, 'Google 캘린더 동기화'); await view.settle();
  assert.equal(calendarReads, 2); assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '캘린더 새로 연결된 달력')); view.unmount();
});

function memberAuthFixture(secret = 'q'.repeat(43)) {
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: 'test-client', response_type: 'code', state: `member_${'s'.repeat(43)}`,
    nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', redirect_uri: 'https://example.test/v1/google/oauth/callback', scope: 'openid email profile' })}`;
  return Response.json({ requestId: 'r', data: { authorizationUrl, completionSecret: secret } });
}

test('인증 준비 중에는 연결 전환이 숨겨지고 명시적 취소 후에만 새 서버를 사용한다', async t => {
  const { App } = await components; const requests: { origin: string; path: string; body?: any }[] = [];
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw)); requests.push({ origin: url.origin, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname === '/v1/auth/google/start') return memberAuthFixture();
    throw new Error('unexpected synthetic request');
  };
  const view = harness.renderer(App); t.after(() => view.unmount());
  visiblePress(view, '로그인'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43));
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '개발 연결 설정'), false);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === 'API 서버 주소'), false);
  visiblePress(view, '뒤로');
  visiblePress(view, '개발 연결 설정'); enter(view, 'API 서버 주소', 'https://new.example.test'); visiblePress(view, '설정 적용');
  visiblePress(view, '로그인'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); assert.equal(input(view, 'Google 로그인 확인 코드').props.value, '');
  assert.equal(requests.filter(item => item.path === '/v1/auth/google/start').at(-1)?.origin, 'https://new.example.test');
  assert.equal(requests.some(item => item.path === '/v1/auth/google/complete' && !item.body?.cancel), false);
});

test('인증 시작 요청 중에는 전환과 취소가 막히고 응답 후 취소할 수 있다', async t => {
  const { App } = await components; let resolveOld!: (value: Response) => void; let starts = 0;
  globalThis.fetch = async raw => {
    const url = new URL(String(raw));
    if (url.pathname === '/v1/auth/google/start') {
      starts++;
      if (starts === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
      assert.equal(url.origin, 'https://new.example.test'); return memberAuthFixture('n'.repeat(43));
    }
    throw new Error('unexpected synthetic request');
  };
  const view = harness.renderer(App); t.after(() => view.unmount());
  visiblePress(view, '로그인'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '개발 연결 설정'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '뒤로')?.props.disabled, true);
  resolveOld(memberAuthFixture()); await view.settle();
  visiblePress(view, '뒤로'); visiblePress(view, '개발 연결 설정');
  enter(view, 'API 서버 주소', 'https://new.example.test'); visiblePress(view, '설정 적용');
  visiblePress(view, '로그인'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); assert.equal(input(view, 'Google 로그인 확인 코드').props.value, ''); assert.equal(starts, 2);
});

test('로그인 완료 응답 대기 중에는 API 서버를 바꾸지 않고 원래 요청을 보존한다', async t => {
  const { App, operationGuard } = await components; let resolveComplete!: (value: Response) => void; const requests: { origin: string; path: string }[] = [];
  globalThis.fetch = async raw => {
    const url = new URL(String(raw)); requests.push({ origin: url.origin, path: url.pathname });
    if (url.pathname === '/v1/auth/google/start') return memberAuthFixture();
    if (url.pathname === '/v1/auth/google/complete') return new Promise<Response>(resolve => { resolveComplete = resolve; });
    throw new Error('unexpected synthetic request');
  };
  const view = harness.renderer(App); t.after(() => view.unmount());
  visiblePress(view, '개발 연결 설정'); visiblePress(view, 'Google 로그인 또는 가입'); visiblePress(view, 'Google 로그인 시작'); await view.settle();
  press(view, '자동 확인이 안 되나요?'); enter(view, 'Google 로그인 확인 코드', 'z'.repeat(43)); visiblePress(view, 'Google 로그인 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '개발 연결 설정'), false);
  assert.equal(visibleNodes(view.tree).find(item => item.props?.accessibilityLabel === '뒤로')?.props.disabled, true);
  assert.match(textOf(view.tree), /로그인 결과를 확인하고 있습니다/);
  assert.equal(requests.filter(item => item.path === '/v1/auth/google/complete').length, 1);
  resolveComplete(Response.json({ requestId: 'r', data: { sessionToken: 'synthetic-session', expiresAt: '2035-01-01T00:00:00Z', member: { id: 'member:synthetic', email: 'test@example.test', displayName: '테스트' } } }));
  await view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
  assert.match(textOf(view.tree), /PERSONALIZE/); visiblePress(view, '이전');
  visiblePress(view, '개발 연결 설정'); assert.match(textOf(view.tree), /로그인: 테스트/);
  assert.notEqual(input(view, 'API 서버 주소').props.value, 'https://new.example.test');
});

test('전화 미연결 안내에서 설정을 열고 돌아와도 입력한 번호와 요청이 유지된다', async () => {
  const { App } = await components; let calls = 0;
  globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/v1/schedule-calls' && init?.method === 'POST') {
      calls++;
      return Response.json({ requestId: 'r', error: { code: 'not_configured', message: 'internal', retryable: false } }, { status: 503 });
    }
    if (path === '/v1/phone-connection') return apiResponse({ status: 'not_configured', senderNumber: null, lastRequestId: null });
    return response([]);
  };
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'test'); press(view, '설정 적용'); await view.settle();
  chat(view).props.onOpenScheduleCall({ itemId: 'event-1', expectedRevision: 3 }); view.flush();
  enter(view, '받는 전화번호', '01012345678'); visiblePress(view, '전화 내용 확인'); await view.settle();
  assert.match(textOf(visibleNodes(view.tree)), /전화 계정 연결/); assert.equal(calls, 1);
  visiblePress(view, '전화 연결 설정 열기'); await view.settle(); assert.match(textOf(visibleNodes(view.tree)), /전화 외부 연결/);
  visiblePress(view, '뒤로'); assert.equal(input(view, '받는 전화번호').props.value, '01012345678');
  assert.match(textOf(visibleNodes(view.tree)), /전화 계정 연결/); assert.equal(calls, 1);
  view.unmount();
});


test('normal chat proposal shows only accept and reject actions and can be accepted directly', async t => {
  const { App, operationGuard } = await components;
  const owner = {}; t.after(() => operationGuard.clear(owner));
  const item = proposal('운동을 추천하는 자세한 이유는 상세에서만 보여야 합니다.');
  item.changeSet.changes[0].after.title = '운동';
  const writes: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') {
      writes.push(path);
      return apiResponse({ outcome: 'applied', proposal: { ...item, revision: 2, status: 'applied' }, scheduleRevision: 1 });
    }
    return path === '/v1/proposals/p1' ? apiResponse({ proposal: item }) : response([item]);
  };
  (globalThis as any).__appIntegrationHarness.inlineProposalId = 'p1';
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용'); await view.settle();
  visiblePress(view, 'PIKKU'); await view.settle();
  const marker = chat(view).props.marker;
  assert.doesNotMatch(textOf(view.tree), /자세한 이유는 상세|제안 상세|GMT|확인 기한/);
  assert.ok(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '수락'));
  assert.doesNotMatch(textOf(chat(view).children), /확인 대기|이유 보기/);
  assert.equal(visibleNodes(view.tree).some(item => item.props?.accessibilityLabel === '수정'), false);
  assert.doesNotMatch(textOf(view.tree), /없음 \(새 일정\)/);
  assert.deepEqual(writes, []);
  operationGuard.update(owner, { status: 'pending' });
  chat(view).props.renderProposal('p1').props.onRequestRevision(item); view.flush();
  assert.equal(chat(view).props.revisionRequest, undefined);
  assert.equal(chat(view).props.marker, marker);
  assert.match(textOf(view.tree), /현재 대화와 제안을 유지/);
  operationGuard.clear(owner);
  visiblePress(view, '수락'); await view.settle();
  assert.deepEqual(writes, ['/v1/proposals/p1/decision']);
  assert.equal(chat(view).props.marker, marker);
  assert.ok(visibleNodes(view.tree).some(item => item.type === 'ChatScreen'));
  assert.match(textOf(view.tree), /일정이 반영되었습니다/);
  view.unmount();
});

test('approval card shows all-day dates and explicit note and time-block changes without expanding notes', async () => {
  const { App } = await components;
  const item: any = proposal('변경 검토');
  const base = item.changeSet.changes[0].after;
  const original = '기존 메모' + '가'.repeat(19_990);
  const updated = '변경 메모' + '나'.repeat(19_990);
  const allDay = { startsAt: '2026-11-01T00:00:00+09:00', endsAt: '2026-11-03T00:00:00+09:00', timezone: 'Asia/Seoul' };
  item.beforeItems = [
    { ...base, id: 'old', revision: 1, sourceRefs: [], notes: original },
    { ...base, id: 'kept', revision: 1, sourceRefs: [], allDay: true, timeSlot: allDay, blocksTime: false, notes: '유지 메모' },
    { ...base, id: 'removed', revision: 1, sourceRefs: [], notes: '삭제 전 메모' },
  ];
  item.changeSet.changes = [
    { changeId: 'c1', operation: 'update', targetId: 'old', expectedRevision: 1, after: { ...base, allDay: true, timeSlot: allDay, blocksTime: false, notes: updated } },
    { changeId: 'c2', operation: 'update', targetId: 'kept', expectedRevision: 1, after: { ...base, title: '제목만 변경', timeSlot: allDay } },
    { changeId: 'c3', operation: 'update', targetId: 'removed', expectedRevision: 1, after: { ...base, notes: null } },
    { changeId: 'c4', operation: 'create', after: { ...base, notes: '새 메모' } },
  ];
  globalThis.fetch = async url => new URL(String(url)).pathname === '/v1/proposals/p1' ? apiResponse({ proposal: item }) : response([item]);
  (globalThis as any).__appIntegrationHarness.inlineProposalId = 'p1';
  const view = harness.renderer(App);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'dev-token'); press(view, '설정 적용'); await view.settle();
  visiblePress(view, 'PIKKU'); await view.settle();
  const shown = textOf(chat(view).children);
  assert.match(shown, /종일 · 2026년 11월 1일 ~ 2026년 11월 2일/);
  assert.match(shown, /종일: 시간 지정 → 종일/);
  assert.match(shown, /시간 차단: 함 → 안 함/);
  assert.match(shown, /메모 변경 \(수정\)/); assert.match(shown, /메모 변경 \(삭제\)/); assert.match(shown, /메모 변경 \(추가\)/);
  assert.doesNotMatch(shown, /기존 메모|변경 메모|유지 메모|삭제 전 메모|새 메모/);
  assert.equal((shown.match(/메모 변경/g) ?? []).length, 3);
  visiblePress(view, '메모 변경 (수정) · 펼치기');
  assert.ok(textOf(chat(view).children).includes(original)); assert.ok(textOf(chat(view).children).includes(updated));
  visiblePress(view, '메모 변경 (삭제) · 펼치기'); assert.match(textOf(chat(view).children), /삭제 전 메모/);
  visiblePress(view, '메모 변경 (추가) · 펼치기'); assert.match(textOf(chat(view).children), /새 메모/);
  view.unmount();
});
