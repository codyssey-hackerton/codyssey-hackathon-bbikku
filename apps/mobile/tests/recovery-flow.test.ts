import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Render the real App, DayScreen and ChatScreen with local native and client doubles.
function createHarness() {
  let current: any;
  const fragment = Symbol('fragment');
  const same = (a?: any[], b?: any[]) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
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
          if (!Object.is(value, state.value)) { state.value = value; instance.view.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useRef(initial: any) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
    useMemo(factory: () => any, deps: any[]) {
      const { instance, index } = slot();
      const previous = instance.hooks[index];
      if (!previous || !same(previous.deps, deps)) instance.hooks[index] = { deps, value: factory() };
      return instance.hooks[index].value;
    },
    useCallback(callback: any, deps: any[]) { return react.useMemo(() => callback, deps); },
    useEffect(callback: any, deps?: any[]) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!same(effect.deps, deps)) {
        effect.deps = deps;
        instance.view.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const listeners = new Set<(state: string) => void>();
  const native = {
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch',
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
    AppState: {
      currentState: 'active',
      addEventListener(event: string, listener: (state: string) => void) {
        assert.equal(event, 'change');
        listeners.add(listener);
        return { remove() { listeners.delete(listener); } };
      },
    },
  };
  const host: any = { react, native, jsx, fragment, listeners };
  (globalThis as any).__recoveryFlowHarness = host;

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
        if (!instance) { instance = { hooks: [], alive: true, view, index: 0 }; view.instances.set(id, instance); }
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
    view.update = (props: any) => { view.props = props; view.dirty = true; view.flush(); };
    view.settle = async () => { for (let i = 0; i < 5; i += 1) { await new Promise((done) => setImmediate(done)); view.flush(); } };
    view.unmount = () => {
      for (const instance of view.instances.values()) {
        instance.alive = false;
        for (const hook of instance.hooks) hook?.cleanup?.();
      }
      view.instances.clear();
    };
    view.flush();
    return view;
  }
  return { host, renderer };
}

const harness = createHarness();
const components = build({
  stdin: {
    contents: `export { default as App } from '../App';
      export { default as DayScreen } from '../src/screens/DayScreen';
      export { default as ChatScreen } from '../src/chat/ChatScreen';
      export { createChatClient } from '../src/chat/client';
      export { ApiError } from '../src/api/http';`,
    resolveDir: resolve(__dirname), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  loader: { '.otf': 'empty', '.ttf': 'empty' },
  plugins: [{ name: 'recovery-test-host', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|react-native-safe-area-context|expo-status-bar|expo-font|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface))$/ },
      (args) => ({ path: args.path, namespace: 'recovery-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'recovery-native' }, ({ path }) => ({
      contents: path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"; exports.FontReadyContext={Provider:({children})=>children}' :
        path === 'expo-font' ? 'exports.useFonts=()=>[true,null]' :
        path === 'react' ? 'module.exports=globalThis.__recoveryFlowHarness.react' :
        path === 'react-native' ? 'module.exports=globalThis.__recoveryFlowHarness.native' :
        path === 'react-native-safe-area-context' ? 'exports.SafeAreaProvider=({children})=>children; exports.SafeAreaView="View"' :
        path === 'expo-status-bar' ? 'exports.StatusBar="StatusBar"' :
          'exports.jsx=exports.jsxs=globalThis.__recoveryFlowHarness.jsx; exports.Fragment=globalThis.__recoveryFlowHarness.fragment',
      loader: 'js',
    }));
    builder.onResolve({ filter: /^\.\/src\/(api\/http|chat\/client|schedule\/client|proposals\/ProposalPanel|memory\/MemoryPanel|review\/ReviewPanel|screens\/CalendarScreen)$/ },
      (args) => ({ path: args.path, namespace: 'recovery-app-stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'recovery-app-stub' }, ({ path }) => ({
      contents: path.endsWith('api/http') ? 'exports.createApiClient=()=>({})' :
        path.endsWith('chat/client') ? 'exports.createChatClient=()=>globalThis.__recoveryFlowHarness.chatClient' :
        path.endsWith('schedule/client') ? 'exports.createScheduleClient=()=>globalThis.__recoveryFlowHarness.scheduleClient' :
          'module.exports=()=>null',
      loader: 'js',
    }));
  } }],
}).then((bundled) => {
  const compiled: any = { exports: {} };
  new Function('module', 'exports', 'process', bundled.outputFiles[0].text)(compiled, compiled.exports, { env: {} });
  return compiled.exports as { App: any; DayScreen: any; ChatScreen: any; createChatClient: any; ApiError: any };
});

function nodes(root: any): any[] {
  if (root === null || root === undefined || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (root.props?.accessibilityElementsHidden || root.props?.importantForAccessibility === 'no-hide-descendants') return [];
  return [root, ...nodes(root.children)];
}
function textOf(root: any): string {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function node(view: any, type: string, predicate: (item: any) => boolean) {
  const found = nodes(view.tree).find((item) => item.type === type && predicate(item));
  assert.ok(found, `missing ${type}`);
  return found;
}
function button(view: any, label: string) {
  return node(view, 'Pressable', (item) => item.props.accessibilityLabel === label || textOf(item.children) === label);
}
function press(view: any, label: string) {
  const control = button(view, label);
  assert.notEqual(control.props.disabled, true, `${label} is disabled`);
  control.props.onPress(); view.flush();
}
function input(view: any) { return node(view, 'TextInput', (item) => item.props.accessibilityLabel === '채팅 메시지'); }
function enter(view: any, value: string) {
  const control = input(view);
  assert.notEqual(control.props.editable, false);
  control.props.onChangeText(value); view.flush();
}
function selectedTab(view: any, label: string) {
  return button(view, label).props.accessibilityState?.selected;
}
function dayLabel(view: any) {
  const heading = node(view, 'Text', (item) => item.props.accessibilityRole === 'header' && /^\d{4}년 \d+월 \d+일/.test(textOf(item.children)));
  return textOf(heading.children);
}
function recoveryLabel(title: string, date: string) { return `${title} ${date} 복구 상담 초안`; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const now = '2026-10-31T12:00:00.000Z';
const selectedDate = new Date(now);
function item(id: string, title: string, kind: 'task' | 'event', completion: string, start?: string, end?: string, involvement = 'personal') {
  return { id, title, kind, completion, revision: 3, timeSlot: start && end ? { startsAt: start, endsAt: end, timezone: 'UTC' } : null,
    durationMinutes: kind === 'task' ? 30 : null, deadline: null, flexibility: 'flexible', involvement, sourceRefs: [] };
}
function defaultItems() {
  return [
    item('task-a', '테스트 작업 가', 'task', 'incomplete'),
    item('task-b', '테스트 작업 나', 'task', 'incomplete'),
    item('task-done', '완료된 테스트 작업', 'task', 'completed'),
    item('task-pending', '대기 테스트 작업', 'task', 'pending'),
    item('task-unknown', '미확인 테스트 작업', 'task', 'unknown'),
    item('event-incomplete', '미완료 테스트 일정', 'event', 'incomplete', '2026-10-31T10:00:00Z', '2026-10-31T10:30:00Z'),
    item('shared-event', '테스트 공동 일정', 'event', 'pending', '2026-10-31T15:00:00Z', '2026-10-31T16:00:00Z', 'shared'),
  ];
}
function reply(result: any = { kind: 'reply', message: '테스트 응답' }) {
  return { conversationId: 'test-conversation', result };
}

async function setup(t: any, options: { items?: any[]; send?: (request: any) => Promise<any>; checkin?: (op: any) => Promise<any> } = {}) {
  const { App, DayScreen, ChatScreen, createChatClient, ApiError } = await components;
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let intervalId = 0;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
    const id = ++intervalId; intervals.set(id, { callback, delay }); return id as any;
  });
  t.mock.method(globalThis, 'clearInterval', (id: number) => { intervals.delete(id); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  const items = options.items ?? defaultItems();
  const requests: any[] = [];
  const checkins: any[] = [];
  const commands: any[] = [];
  const scheduleClient = {
    async list(query: any) { return { items: items.filter((entry) => query.includeUnscheduled || entry.timeSlot !== null), scheduleRevision: 8 }; },
    async checkin(op: any) {
      checkins.push(structuredClone(op));
      if (options.checkin) return options.checkin(op);
      const target = items.find((entry) => entry.id === op.input.id)!;
      Object.assign(target, { completion: op.input.completion, revision: target.revision + 1 });
      return { item: target, scheduleRevision: 9 };
    },
    async command(op: any) { commands.push(structuredClone(op)); throw new Error('Unexpected schedule command'); },
  };
  const chatClient = {
    async sendMessage(request: any) {
      requests.push(structuredClone(request));
      return options.send ? options.send(request) : reply();
    },
  };
  Object.assign(harness.host, { chatClient, scheduleClient });
  let view: any;
  t.after(() => {
    view?.unmount();
    assert.equal(intervals.size, 0, 'all intervals must be cleared');
    assert.equal(harness.host.listeners.size, 0, 'all AppState subscriptions must be removed');
  });
  return {
    App, DayScreen, ChatScreen, createChatClient, ApiError, items, requests, checkins, commands, intervals, scheduleClient,
    render(Component: any, props?: any) { view = harness.renderer(Component, props); return view; },
    setTime(value: string) { t.mock.timers.setTime(Date.parse(value)); },
    emitAppState(state: string) { for (const listener of harness.host.listeners) listener(state); },
  };
}

async function openDay(view: any) { press(view, '하루 일정'); await view.settle(); }
function assertNoWrites(ctx: any) {
  assert.equal(ctx.checkins.length, 0);
  assert.equal(ctx.commands.length, 0);
}
function assertLocked(view: any, draftLabels: string[]) {
  assert.equal(input(view).props.editable, false);
  assert.equal(button(view, '메시지 보내기').props.disabled, true);
  for (const label of draftLabels) assert.equal(button(view, label).props.disabled, true, label);
}

const taskA = '테스트 작업 가';
const taskB = '테스트 작업 나';
const regularDraft = '테스트 일반 대화 초안';

test('real App routes only incomplete tasks into editable recovery and preserves multiple drafts', async (t) => {
  const ctx = await setup(t);
  const view = ctx.render(ctx.App);
  await view.settle();
  assert.equal(ctx.intervals.size, 0);
  assert.equal(harness.host.listeners.size, 0);
  enter(view, regularDraft);
  await openDay(view);
  assert.equal(ctx.intervals.size, 1);
  assert.equal(harness.host.listeners.size, 1);
  const date = dayLabel(view);
  for (const title of ['완료된 테스트 작업', '대기 테스트 작업', '미확인 테스트 작업', '미완료 테스트 일정']) {
    assert.equal(nodes(view.tree).some((entry) => entry.type === 'Pressable' && entry.props.accessibilityLabel === `${title} 복구 상담`), false);
  }
  press(view, `${taskA} 복구 상담`);
  assert.equal(selectedTab(view, 'AI 채팅'), true);
  assert.equal(ctx.intervals.size, 0);
  assert.equal(harness.host.listeners.size, 0);
  assert.match(input(view).props.value, new RegExp(taskA));
  assert.ok(input(view).props.value.includes(date));
  assert.match(input(view).props.value, /필요한지/);
  assert.match(input(view).props.value, /기한/);
  assert.equal(ctx.requests.length, 0);
  assertNoWrites(ctx);
  enter(view, '수정한 첫 번째 복구 초안');
  press(view, '기존 대화 초안으로');
  assert.equal(input(view).props.value, regularDraft);
  press(view, recoveryLabel(taskA, date));
  assert.equal(input(view).props.value, '수정한 첫 번째 복구 초안');

  await openDay(view);
  press(view, `${taskB} 복구 상담`);
  assert.match(input(view).props.value, new RegExp(taskB));
  enter(view, '수정한 두 번째 복구 초안');
  press(view, recoveryLabel(taskA, date));
  assert.equal(input(view).props.value, '수정한 첫 번째 복구 초안');
  press(view, recoveryLabel(taskB, date));
  assert.equal(input(view).props.value, '수정한 두 번째 복구 초안');
  await openDay(view);
  press(view, `${taskA} 복구 상담`);
  assert.equal(input(view).props.value, '수정한 첫 번째 복구 초안');
  await openDay(view);
  press(view, '다음 날짜');
  await view.settle();
  const nextDate = dayLabel(view);
  assert.notEqual(nextDate, date);
  press(view, `${taskA} 복구 상담`);
  assert.ok(input(view).props.value.includes(nextDate));
  enter(view, '다른 날짜의 복구 초안');
  press(view, recoveryLabel(taskA, date));
  assert.equal(input(view).props.value, '수정한 첫 번째 복구 초안');
  press(view, recoveryLabel(taskA, nextDate));
  assert.equal(input(view).props.value, '다른 날짜의 복구 초안');
  press(view, '기존 대화 초안으로');
  assert.equal(input(view).props.value, regularDraft);
  assert.equal(ctx.requests.length, 0);
  assertNoWrites(ctx);
});

test('coordination still sends its target; recovery question and follow-up never send it', async (t) => {
  let count = 0;
  const ctx = await setup(t, { send: async () => ++count === 2
    ? reply({ kind: 'question', message: '아직 필요한가요?', missingFields: ['validity'] }) : reply() });
  const view = ctx.render(ctx.App);
  await view.settle();
  await openDay(view);
  press(view, '테스트 공동 일정 공동 약속 조정 검토');
  assert.equal(selectedTab(view, 'AI 채팅'), true);
  enter(view, '공동 일정 조정 요청');
  press(view, '메시지 보내기');
  assert.deepEqual(ctx.requests[0].coordinationTarget, { id: 'shared-event', expectedRevision: 3 });
  await view.settle();
  enter(view, regularDraft);
  await openDay(view);
  const date = dayLabel(view);
  press(view, `${taskA} 복구 상담`);
  assert.equal(ctx.requests.length, 1);
  enter(view, '수정한 복구 질문');
  press(view, '메시지 보내기');
  assert.equal(ctx.requests[1].message, '수정한 복구 질문');
  assert.equal('coordinationTarget' in ctx.requests[1], false);
  await view.settle();
  assert.match(textOf(view.tree), /아직 필요한가요/);
  assert.equal(button(view, recoveryLabel(taskA, date)).props.accessibilityState.selected, true);
  assert.equal(input(view).props.value, '');
  assert.equal(button(view, '메시지 보내기').props.disabled, true);
  enter(view, '네, 여전히 필요합니다');
  press(view, '메시지 보내기');
  assert.equal(ctx.requests[2].message, '네, 여전히 필요합니다');
  assert.equal('coordinationTarget' in ctx.requests[2], false);
  await view.settle();
  assert.equal(button(view, recoveryLabel(taskA, date)).props.accessibilityState.selected, true);
  assert.equal(input(view).props.value, '');
  press(view, '기존 대화 초안으로');
  assert.equal(input(view).props.value, regularDraft);
  assertNoWrites(ctx);
});

test('real chat client retains the wire body and idempotency key across a recovery retry', async (t) => {
  const first = deferred<any>();
  const second = deferred<any>();
  const third = deferred<any>();
  const calls: any[] = [];
  const pending = [first, second, third];
  const ctx = await setup(t);
  const client = ctx.createChatClient({
    post(path: string, body: any, options: any) {
      calls.push(structuredClone({ path, body, options }));
      return pending[calls.length - 1].promise;
    },
  });
  const view = ctx.render(ctx.ChatScreen, {
    client, timezone: 'UTC', scheduleClient: ctx.scheduleClient, selectedDate, refreshVersion: 0,
    onOpenProposals: () => {}, onProposalCreated: () => {}, onOpenMemory: () => {}, onOpenReviewSchedule: () => {},
    coordinationTarget: { id: 'shared-event', expectedRevision: 3, title: '테스트 공동 일정' },
    onClearCoordinationTarget: () => {},
    recoveryRequest: { key: 'recovery-1', title: taskA, dateLabel: '2026년 10월 31일 토요일', text: '복구할 필요가 있나요?' },
  });
  await view.settle();
  assert.equal(calls.length, 0);
  enter(view, '검사할 복구 요청');
  press(view, '메시지 보내기');
  assert.equal(calls[0].path, '/v1/chat');
  assert.equal(calls[0].body.message, '검사할 복구 요청');
  assert.equal('coordinationTarget' in calls[0].body, false);
  assert.ok(calls[0].body.requestId);
  assert.ok(calls[0].options.idempotencyKey);
  first.reject(new Error('synthetic network failure'));
  await view.settle();
  press(view, '같은 요청 다시 시도');
  assert.deepEqual(calls[1], calls[0]);
  second.resolve(reply({ kind: 'question', message: '계속 필요한가요?', missingFields: ['validity'] }));
  await view.settle();
  assert.equal(input(view).props.value, '');
  enter(view, '네, 필요합니다');
  press(view, '메시지 보내기');
  assert.equal(calls[2].body.message, '네, 필요합니다');
  assert.equal(calls[2].body.conversationId, 'test-conversation');
  assert.equal('coordinationTarget' in calls[2].body, false);
  third.resolve(reply());
  await view.settle();
  assertNoWrites(ctx);
});

test('pending and uncertain recovery lock draft switching and retry the identical request', async (t) => {
  const first = deferred<any>();
  const second = deferred<any>();
  const third = deferred<any>();
  let count = 0;
  const ctx = await setup(t, { send: () => [first, second, third][count++].promise });
  const view = ctx.render(ctx.App);
  await view.settle();
  enter(view, regularDraft);
  await openDay(view);
  press(view, '테스트 공동 일정 공동 약속 조정 검토');
  assert.equal(input(view).props.value, regularDraft);
  await openDay(view);
  const date = dayLabel(view);
  press(view, `${taskA} 복구 상담`);
  enter(view, '실패해도 유지할 복구 요청');
  await openDay(view);
  press(view, `${taskB} 복구 상담`);
  enter(view, '두 번째 작업 초안');
  press(view, recoveryLabel(taskA, date));
  press(view, '메시지 보내기');
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].message, '실패해도 유지할 복구 요청');
  assert.ok(ctx.requests[0].requestId);
  assert.ok(ctx.requests[0].idempotencyKey);
  assert.equal('coordinationTarget' in ctx.requests[0], false);
  assertLocked(view, [recoveryLabel(taskA, date), recoveryLabel(taskB, date), '기존 대화 초안으로']);
  await openDay(view);
  press(view, `${taskB} 복구 상담`);
  assert.equal(input(view).props.value, '실패해도 유지할 복구 요청');
  assertLocked(view, [recoveryLabel(taskA, date), recoveryLabel(taskB, date), '기존 대화 초안으로']);
  first.reject(new Error('synthetic network failure'));
  await view.settle();
  assert.match(textOf(view.tree), /결과를 확인할 때까지 같은 요청만/);
  assertLocked(view, [recoveryLabel(taskA, date), recoveryLabel(taskB, date), '기존 대화 초안으로']);
  assert.equal(nodes(view.tree).some((entry) => entry.type === 'Pressable' && textOf(entry.children) === '메시지 수정'), false);
  press(view, '같은 요청 다시 시도');
  assert.deepEqual(ctx.requests[1], ctx.requests[0]);
  assertLocked(view, [recoveryLabel(taskA, date), recoveryLabel(taskB, date), '기존 대화 초안으로']);
  second.reject(new ctx.ApiError('not_configured', 'synthetic unavailable', false, 503));
  await view.settle();
  assert.match(textOf(view.tree), /결과를 확인할 때까지 같은 요청만/);
  assertLocked(view, [recoveryLabel(taskA, date), recoveryLabel(taskB, date), '기존 대화 초안으로']);
  press(view, '같은 요청 다시 시도');
  assert.deepEqual(ctx.requests[2], ctx.requests[0]);
  third.resolve(reply());
  await view.settle();
  assert.equal(input(view).props.value, '두 번째 작업 초안');
  press(view, recoveryLabel(taskA, date));
  assert.equal(input(view).props.value, '');
  press(view, '기존 대화 초안으로');
  assert.equal(input(view).props.value, regularDraft);
  assertNoWrites(ctx);
});

test('a definite chat error keeps recovery and general drafts locked until editing is chosen', async (t) => {
  let reject!: (error: unknown) => void;
  const ctx = await setup(t, { send: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const view = ctx.render(ctx.App);
  await view.settle();
  enter(view, regularDraft);
  await openDay(view);
  const date = dayLabel(view);
  press(view, `${taskA} 복구 상담`);
  enter(view, '확실한 오류 뒤 편집할 문구');
  press(view, '메시지 보내기');
  reject(new ctx.ApiError('not_configured', 'synthetic unavailable', false, 503));
  await view.settle();
  assertLocked(view, [recoveryLabel(taskA, date), '기존 대화 초안으로']);
  press(view, '메시지 수정');
  assert.equal(input(view).props.value, '확실한 오류 뒤 편집할 문구');
  enter(view, '다시 수정한 복구 문구');
  press(view, '기존 대화 초안으로');
  assert.equal(input(view).props.value, regularDraft);
  press(view, recoveryLabel(taskA, date));
  assert.equal(input(view).props.value, '다시 수정한 복구 문구');
  assert.equal(ctx.requests.length, 1);
  assertNoWrites(ctx);
});

test('day check-in remains explicit and blocks recovery while saving', async (t) => {
  const pending = deferred<any>();
  const ctx = await setup(t, { checkin: () => pending.promise });
  const view = ctx.render(ctx.App);
  await view.settle();
  await openDay(view);
  assertNoWrites(ctx);
  press(view, '대기 테스트 작업 미완료 체크인');
  assert.deepEqual(ctx.checkins[0].input, { id: 'task-pending', expectedRevision: 3, completion: 'incomplete' });
  assert.equal(button(view, `${taskA} 복구 상담`).props.disabled, true);
  pending.resolve({ item: { ...ctx.items.find((entry) => entry.id === 'task-pending'), completion: 'incomplete' }, scheduleRevision: 9 });
  await view.settle();
  assert.notEqual(button(view, `${taskA} 복구 상담`).props.disabled, true);
  assert.equal(ctx.commands.length, 0);
  assert.equal(ctx.requests.length, 0);
});

test('day preparation opens explicit inputs and routes a saved proposal to review', async (t) => {
  const ctx = await setup(t);
  const posts: any[] = [];
  let opened = 0;
  const api = { post: async (path: string, body: any, options: any) => {
    posts.push({ path, body, options });
    return { result: { kind: 'proposal', message: '제안을 확인하세요.', proposalIds: ['synthetic-proposal'] } };
  } };
  const view = ctx.render(ctx.DayScreen, { selectedDate, onSelectDate: () => {}, client: ctx.scheduleClient, api,
    timezone: 'UTC', refreshVersion: 0, onScheduleChanged: () => {}, onCoordinate: () => {}, onRecovery: () => {},
    onOpenPreparationProposals: () => { opened += 1; } });
  await view.settle();
  press(view, '테스트 공동 일정 준비계획');
  assert.equal(button(view, '제안 생성').props.disabled, true);
  for (const [label, value] of [['준비 시간 (분)', '15'], ['이동 시간 (분)', '0'], ['여유 시간 (분)', '10']]) {
    node(view, 'TextInput', entry => entry.props.accessibilityLabel === label).props.onChangeText(value); view.flush();
  }
  assert.equal(posts.length, 0);
  press(view, '제안 생성'); await view.settle();
  assert.equal(posts.length, 1);
  assert.deepEqual({ targetId: posts[0].body.targetId, targetRevision: posts[0].body.expectedTargetRevision,
    scheduleRevision: posts[0].body.expectedScheduleRevision, preparation: posts[0].body.preparationMinutes,
    travel: posts[0].body.travelMinutes, buffer: posts[0].body.bufferMinutes },
  { targetId: 'shared-event', targetRevision: 3, scheduleRevision: 8, preparation: 15, travel: 0, buffer: 10 });
  assert.equal(opened, 1);
  assertNoWrites(ctx);
});

test('day renders current/next times and unknown status and refreshes only while visible or active', async (t) => {
  const items = [
    item('current', '현재 테스트 일정', 'event', 'unknown', '2026-10-31T11:30:00Z', '2026-10-31T12:30:00Z'),
    item('next', '다음 테스트 일정', 'event', 'pending', '2026-10-31T12:45:00Z', '2026-10-31T13:30:00Z'),
    item('later', '나중 테스트 일정', 'event', 'pending', '2026-10-31T14:00:00Z', '2026-10-31T15:00:00Z'),
  ];
  const ctx = await setup(t, { items });
  const props = { selectedDate, onSelectDate: () => {}, client: ctx.scheduleClient, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged: () => {}, onCoordinate: () => {}, onRecovery: () => {}, visible: true };
  const view = ctx.render(ctx.DayScreen, props);
  await view.settle();
  assert.match(textOf(view.tree), /이 시간의 일정현재 테스트 일정11:30 – 12:30수행 상태: 상태 미확인다음 행동다음 테스트 일정12:45 – 13:30수행 상태: 대기/);
  assert.equal(ctx.intervals.size, 1);
  assert.equal([...ctx.intervals.values()][0].delay, 30_000);
  assert.equal(harness.host.listeners.size, 1);
  ctx.setTime('2026-10-31T12:50:00Z');
  ctx.emitAppState('background'); view.flush();
  assert.match(textOf(view.tree), /이 시간의 일정현재 테스트 일정/);
  ctx.emitAppState('active'); view.flush();
  assert.match(textOf(view.tree), /이 시간의 일정다음 테스트 일정12:45 – 13:30/);
  view.update({ ...props, visible: false });
  assert.equal(ctx.intervals.size, 0);
  assert.equal(harness.host.listeners.size, 0);
  ctx.setTime('2026-10-31T13:40:00Z');
  view.update({ ...props, visible: true });
  assert.match(textOf(view.tree), /다음 행동나중 테스트 일정14:00 – 15:00/);
  ctx.setTime('2026-10-31T14:05:00Z');
  [...ctx.intervals.values()][0].callback(); view.flush();
  assert.match(textOf(view.tree), /이 시간의 일정나중 테스트 일정14:00 – 15:00/);
  assertNoWrites(ctx);
});

test('day shows the empty next-action message for completed, past and unscheduled items', async (t) => {
  const items = [
    item('past', '지난 테스트 일정', 'event', 'pending', '2026-10-31T09:00:00Z', '2026-10-31T10:00:00Z'),
    item('completed', '완료 테스트 일정', 'event', 'completed', '2026-10-31T12:30:00Z', '2026-10-31T13:00:00Z'),
    item('unscheduled', '미배치 테스트 작업', 'task', 'incomplete'),
  ];
  const ctx = await setup(t, { items });
  const view = ctx.render(ctx.DayScreen, { selectedDate, onSelectDate: () => {}, client: ctx.scheduleClient, timezone: 'UTC',
    refreshVersion: 0, onScheduleChanged: () => {}, onCoordinate: () => {}, onRecovery: () => {} });
  await view.settle();
  assert.match(textOf(view.tree), /선택한 날짜에 지금 진행 중이거나 앞으로 시작할 배치된 일정이 없습니다/);
  assert.equal(nodes(view.tree).some((entry) => entry.type === 'Text' && ['이 시간의 일정', '다음 행동'].includes(textOf(entry.children))), false);
  assertNoWrites(ctx);
});
