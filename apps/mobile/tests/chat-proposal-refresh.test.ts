import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Exercise ChatScreen and the real mutation/client code with a small native host.
// This follows the existing memory panel harness without requiring a native device.
function createHarness() {
  type Instance = { hooks: any[]; index: number; alive: boolean; view: any };
  let current: Instance | undefined;
  const fragment = Symbol('fragment');
  const sameDeps = (a?: unknown[], b?: unknown[]) =>
    a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const jsx = (type: any, props: any, key?: string) => ({ type, props: props ?? {}, key });
  const slot = () => {
    if (!current) throw new Error('hook called outside a component');
    return { instance: current, index: current.index++ };
  };
  const react = {
    useState(initial: any) {
      const { instance, index } = slot();
      if (!instance.hooks[index]) {
        const state = { value: typeof initial === 'function' ? initial() : initial, set: (_update: any) => {} };
        state.set = (update: any) => {
          if (!instance.alive) return;
          const next = typeof update === 'function' ? update(state.value) : update;
          if (!Object.is(next, state.value)) { state.value = next; instance.view.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useRef(initial: any) {
      const { instance, index } = slot();
      return instance.hooks[index] ??= { current: initial };
    },
    useEffect(callback: () => void | (() => void), deps?: unknown[]) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!sameDeps(effect.deps, deps)) {
        effect.deps = deps;
        instance.view.effects.push(() => {
          effect.cleanup?.();
          effect.cleanup = callback();
        });
      }
    },
  };
  const native = {
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles },
  };

  function renderer(Component: any, initialProps: any) {
    const view: any = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    function render(node: any, path: string, seen: Set<string>): any {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`, seen));
      if (node.type === fragment) return render(node.props.children, `${path}.fragment`, seen);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        let instance: Instance = view.instances.get(id);
        if (!instance) {
          instance = { hooks: [], index: 0, alive: true, view };
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
        const seen = new Set<string>();
        view.tree = render(jsx(Component, view.props), 'root', seen);
        for (const [id, instance] of view.instances as Map<string, Instance>) {
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
    view.settle = async () => { for (let i = 0; i < 4; i += 1) { await new Promise((done) => setImmediate(done)); view.flush(); } };
    view.flush();
    return view;
  }
  return { react, native, jsx, fragment, renderer };
}

const harness = createHarness();
const components = build({
  stdin: {
    contents: `export { default as ChatScreen } from './ChatScreen';
      export { createChatClient } from './client'; export { createApiClient } from '../api/http';`,
    resolveDir: resolve(__dirname, '../src/chat'), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface)|\.\/ChatScheduleSummary)$/ },
      (args) => ({ path: args.path, namespace: 'test-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-native' }, ({ path }) => ({
      contents: path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
        path === 'react' ? 'module.exports = __react' :
        path === 'react-native' ? 'module.exports = __native' :
          path === './ChatScheduleSummary' ? 'exports.ChatScheduleSummary = () => null' :
            'exports.jsx = exports.jsxs = __jsx; exports.Fragment = __fragment',
      loader: 'js',
    }));
  } }],
}).then((bundled) => {
  const compiled = { exports: {} };
  new Function('module', 'exports', '__react', '__native', '__jsx', '__fragment', bundled.outputFiles[0].text)(
    compiled, compiled.exports, harness.react, harness.native, harness.jsx, harness.fragment,
  );
  return compiled.exports as {
    ChatScreen: any;
    createApiClient: (options: any) => any;
    createChatClient: (api: any) => any;
  };
});

function nodes(root: any): any[] {
  if (root === null || root === undefined || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.children)];
}
function textOf(root: any): string {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function press(view: any, label: string) {
  const button = nodes(view.tree).find((node) => node.type === 'Pressable' &&
    (node.props.accessibilityLabel === label || textOf(node.children) === label));
  assert.ok(button, `missing button: ${label}`);
  assert.notEqual(button.props.disabled, true, `disabled button: ${label}`);
  button.props.onPress();
  view.flush();
}
function send(view: any, value: string) {
  const input = nodes(view.tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.ok(input);
  assert.equal(input.props.editable, true);
  input.props.onChangeText(value);
  view.flush();
  press(view, '메시지 보내기');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function chatResponse(result: unknown, conversationId = 'conversation-1') {
  return json({ requestId: 'request-1', data: { conversationId, result } });
}
const proposal = { kind: 'proposal', message: '새 제안을 확인하세요.', proposalIds: ['proposal-1'] };

async function screen(fetcher: typeof fetch, onProposalCreated: () => void) {
  const { ChatScreen, createApiClient, createChatClient } = await components;
  const api = createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-session', fetcher });
  const props = {
    client: createChatClient(api), timezone: 'Asia/Seoul', scheduleClient: {}, selectedDate: new Date('2026-10-31T00:00:00Z'),
    refreshVersion: 0, onOpenProposals: () => {}, onOpenMemory: () => {}, onOpenReviewSchedule: () => {}, onClearCoordinationTarget: () => {}, onProposalCreated,
  };
  return { ChatScreen, props, view: harness.renderer(ChatScreen, props) };
}

test('chat offers access to automatic review settings', async () => {
  let opened = 0;
  const { props, view } = await screen(async () => chatResponse({ kind: 'reply', message: 'ok' }), () => {});
  view.update({ ...props, onOpenReviewSchedule: () => { opened += 1; } });
  press(view, '자동 검토 설정');
  assert.equal(opened, 1);
});

test('validated proposals notify the latest parent callback once per successful response', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const requests: RequestInit[] = [];
  let previousCalls = 0;
  let currentCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init!);
    return requests.length === 1 ? first.promise : second.promise;
  };
  const { props, view } = await screen(fetcher, () => { previousCalls += 1; });
  send(view, '일정을 조정해 줘');
  assert.equal(previousCalls, 0);
  assert.match(textOf(view.tree), /서버 응답을 기다리는 중/);
  const updated = { ...props, onProposalCreated: () => { currentCalls += 1; } };
  view.update(updated);
  first.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(previousCalls, 0);
  assert.equal(currentCalls, 1);
  assert.match(textOf(view.tree), /새 제안을 확인하세요/);
  assert.match(textOf(view.tree), /승인 전에는 적용되지 않습니다/);
  view.update(updated);
  assert.equal(currentCalls, 1);

  send(view, '다른 시간도 제안해 줘');
  assert.equal(currentCalls, 1);
  assert.equal(JSON.parse(String(requests[1].body)).conversationId, 'conversation-1');
  second.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(currentCalls, 2);
});

for (const result of [
  { kind: 'reply', message: '일반 답변입니다.' },
  { kind: 'question', message: '시간을 알려주세요.', missingFields: ['time'] },
  { kind: 'failure', message: '제안을 만들지 못했습니다.', code: 'not_ready', retryable: false },
]) {
  test(`${result.kind} results do not notify the parent`, async () => {
    let calls = 0;
    const { view } = await screen(async () => chatResponse(result), () => { calls += 1; });
    send(view, '요청');
    await view.settle();
    assert.equal(calls, 0);
    assert.match(textOf(view.tree), new RegExp(result.message));
    assert.doesNotMatch(textOf(view.tree), /승인 전에는 적용되지 않습니다/);
  });
}

test('HTTP failure does not notify; a successful retry preserves the request and notifies once', async () => {
  const pendingRetry = deferred<Response>();
  const requests: RequestInit[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init!);
    if (requests.length === 1) return json({ requestId: 'r', error: { code: 'not_configured', message: 'unavailable', retryable: false } }, 503);
    return pendingRetry.promise;
  };
  const { view } = await screen(fetcher, () => { calls += 1; });
  send(view, '일정 검토');
  await view.settle();
  assert.equal(calls, 0);
  assert.match(textOf(view.tree), /서버 기능이 아직 설정되지 않았습니다/);
  press(view, '같은 요청 다시 시도');
  assert.equal(calls, 0);
  assert.equal(requests[1].body, requests[0].body);
  assert.equal((requests[1].headers as Record<string, string>)['Idempotency-Key'], (requests[0].headers as Record<string, string>)['Idempotency-Key']);
  pendingRetry.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(calls, 1);
});

test('a malformed proposal response is rejected without notifying the parent', async () => {
  let calls = 0;
  const { view } = await screen(async () => chatResponse({ ...proposal, proposalIds: 'invalid' }), () => { calls += 1; });
  send(view, '일정 검토');
  await view.settle();
  assert.equal(calls, 0);
  assert.match(textOf(view.tree), /서버 응답 형식이 올바르지 않습니다/);
});

test('a late proposal from a remounted session cannot notify either session', async () => {
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let oldCalls = 0;
  let newCalls = 0;
  const oldScreen = await screen(async () => oldResponse.promise, () => { oldCalls += 1; });
  const newScreen = await screen(async () => newResponse.promise, () => { newCalls += 1; });
  const Session = ({ revision, props }: { revision: string; props: any }) => harness.jsx(oldScreen.ChatScreen, props, revision);
  const view = harness.renderer(Session, { revision: 'old', props: oldScreen.props });
  send(view, '이전 세션 요청');
  view.update({ revision: 'new', props: newScreen.props });
  assert.doesNotMatch(textOf(view.tree), /이전 세션 요청/);
  send(view, '새 세션 요청');
  oldResponse.resolve(chatResponse(proposal, 'old-conversation'));
  await view.settle();
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 0);
  assert.match(textOf(view.tree), /서버 응답을 기다리는 중/);
  assert.doesNotMatch(textOf(view.tree), /새 제안을 확인하세요/);
  newResponse.resolve(chatResponse(proposal, 'new-conversation'));
  await view.settle();
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
});


test('starter chips only fill the draft; the user must send it explicitly', async () => {
  let calls = 0;
  const { view } = await screen(async () => { calls += 1; return chatResponse({ kind: 'reply', message: '검토할게요.' }); }, () => {});
  press(view, '오늘 일정을 함께 정리해줘.');
  assert.equal(calls, 0);
  const input = nodes(view.tree).find((item) => item.type === 'TextInput' && item.props.accessibilityLabel === '채팅 메시지');
  assert.equal(input.props.value, '오늘 일정을 함께 정리해줘.');
  press(view, '메시지 보내기');
  await view.settle();
  assert.equal(calls, 1);
});
