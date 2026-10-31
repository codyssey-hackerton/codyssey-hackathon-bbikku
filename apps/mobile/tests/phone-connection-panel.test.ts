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
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
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
function input(view: any, label: string) { const found = nodes(view.tree).find(n => n.type === 'TextInput' && n.props.accessibilityLabel === label); assert.ok(found); return found; }
function press(view: any, label: string) { const found = button(view, label); assert.ok(found); assert.notEqual(found.props.disabled, true); found.props.onPress(); view.flush(); }
function enter(view: any, label: string, value: string) { const found = input(view, label); assert.notEqual(found.props.editable, false); found.props.onChangeText(value); view.flush(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function mockApi(initial: any = { status: 'not_configured', senderNumber: null }) {
  const calls: any[] = [];
  const api: any = { status: initial, postHook: undefined, getHook: undefined,
    async get(path: string) { calls.push({ method: 'GET', path }); if (api.getHook) return api.getHook(path); return api.status; },
    async post(path: string, body: any, options: any) { calls.push({ method: 'POST', path, body, options }); if (api.postHook) return api.postHook(path, body, options); return { status: 'available', senderNumber: body.fromNumber }; },
  };
  return { api, calls };
}
function fill(view: any, number = '+15550000001') {
  press(view, 'Twilio 선택');
  enter(view, '전화 계정 SID', 'test-sid'); enter(view, '전화 인증 토큰', 'test-token'); enter(view, '발신 전화번호', number);
}

test('기본 ClawOps 설정은 모든 자격과 E.164 번호가 필요하고 전송 즉시 입력을 비운다', async t => {
  const { PhoneConnectionPanel, operationGuard } = await components;
  const mock = mockApi(); const pending = deferred<any>(); mock.api.postHook = () => pending.promise;
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack() {} }); t.after(() => view.unmount());
  await view.settle();
  assert.equal(button(view, 'ClawOps 선택').props.accessibilityState.checked, true);
  assert.match(textOf(view.tree), /키패드 선택과 재확인/);
  for (const label of ['ClawOps 계정 ID', 'ClawOps API 키', 'ClawOps 서명 비밀']) assert.equal(input(view, label).props.secureTextEntry, true);
  enter(view, 'ClawOps 계정 ID', 'test-account'); enter(view, 'ClawOps API 키', 'test-key'); enter(view, '발신 전화번호', '+15550000001');
  assert.equal(button(view, '전화 연결 설정').props.disabled, true);
  enter(view, 'ClawOps 서명 비밀', 'test-signing'); press(view, '전화 연결 설정');
  for (const label of ['ClawOps 계정 ID', 'ClawOps API 키', 'ClawOps 서명 비밀', '발신 전화번호']) assert.equal(input(view, label).props.value, '');
  const call = mock.calls.find((item: any) => item.method === 'POST');
  assert.deepEqual({ ...call.body, requestId: 'request' }, { requestId: 'request', provider: 'clawops', accountId: 'test-account', apiKey: 'test-key', signingSecret: 'test-signing', fromNumber: '+15550000001' });
  assert.equal(operationGuard.hasUnresolved(), true);
  pending.resolve({ status: 'available', provider: 'clawops', senderNumber: '+15550000001', lastRequestId: call.body.requestId }); await view.settle();
  assert.match(textOf(view.tree), /제공자: ClawOps/); assert.equal(operationGuard.hasUnresolved(), false);
});

test('ClawOps 요청의 다른 제공자 응답과 불명 복구는 성공으로 처리하지 않는다', async t => {
  const { PhoneConnectionPanel, operationGuard } = await components;
  const mock = mockApi(); mock.api.postHook = (_path: string, body: any) => ({ status: 'available', provider: 'twilio', senderNumber: body.fromNumber, lastRequestId: body.requestId });
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack() {} }); t.after(() => view.unmount());
  await view.settle(); enter(view, 'ClawOps 계정 ID', 'account'); enter(view, 'ClawOps API 키', 'key');
  enter(view, 'ClawOps 서명 비밀', 'signing'); enter(view, '발신 전화번호', '+15550000001'); press(view, '전화 연결 설정'); await view.settle();
  const requestId = mock.calls.find((item: any) => item.method === 'POST').body.requestId;
  assert.equal(operationGuard.hasUnresolved(), true); assert.doesNotMatch(textOf(view.tree), /전화 연결을 확인했습니다/);
  for (const provider of [undefined, 'twilio']) {
    mock.api.status = { status: 'available', senderNumber: '+15550000001', lastRequestId: requestId, ...(provider ? { provider } : {}) };
    press(view, '전화 연결 상태 확인'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  }
  mock.api.status = { status: 'available', provider: 'clawops', senderNumber: '+15550000001', lastRequestId: requestId };
  press(view, '전화 연결 상태 확인'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
});

test('연결 상태 조회와 E.164 검증 후 명시적 설정만 전송하고 즉시 입력을 비운다', async t => {
  const { PhoneConnectionPanel, operationGuard } = await components;
  const mock = mockApi(); const pending = deferred<any>(); mock.api.postHook = () => pending.promise; let backs = 0;
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => backs++ }); t.after(() => view.unmount());
  await view.settle(); assert.match(textOf(view.tree), /설정되지 않았습니다/);
  press(view, 'Twilio 선택');
  assert.equal(input(view, '전화 계정 SID').props.secureTextEntry, true); assert.equal(input(view, '전화 인증 토큰').props.secureTextEntry, true);
  fill(view, '01012345678'); assert.equal(button(view, '전화 연결 설정').props.disabled, true);
  enter(view, '발신 전화번호', '+15550000001'); press(view, '전화 연결 설정');
  for (const label of ['전화 계정 SID', '전화 인증 토큰', '발신 전화번호']) assert.equal(input(view, label).props.value, '');
  assert.equal(button(view, '뒤로').props.disabled, true); assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[1].path, '/v1/phone-connection');
  assert.deepEqual(Object.keys(mock.calls[1].body).sort(), ['accountSid', 'authToken', 'fromNumber', 'requestId']);
  assert.ok(mock.calls[1].options.idempotencyKey);
  pending.resolve({ status: 'available', senderNumber: '+15550000001' }); await view.settle();
  assert.match(textOf(view.tree), /연결됨 · 발신 번호: \+15550000001/); assert.equal(operationGuard.hasUnresolved(), false);
  press(view, '뒤로'); assert.equal(backs, 1);
  assert.equal(mock.calls.some((c: any) => c.path.endsWith('/call')), false);
});

test('결과 불명은 정확한 번호와 요청 receipt가 모두 일치해야 복구한다', async t => {
  const { PhoneConnectionPanel, ApiError, operationGuard } = await components;
  const mock = mockApi(); mock.api.postHook = () => { throw new ApiError('timeout', 'secret should not appear', true); };
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => {} }); t.after(() => view.unmount());
  await view.settle(); fill(view); press(view, '전화 연결 설정'); await view.settle();
  const requestId = mock.calls.find((c: any) => c.method === 'POST').body.requestId;
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true);
  assert.doesNotMatch(textOf(view.tree), /secret should not appear|test-token|test-sid/);
  for (const status of [
    { status: 'available', senderNumber: '+15550000002', lastRequestId: requestId },
    { status: 'available', senderNumber: '+15550000001' },
    { status: 'available', senderNumber: '+15550000001', lastRequestId: null },
    { status: 'available', senderNumber: '+15550000001', lastRequestId: 'previous-request' },
    { status: 'not_configured', senderNumber: null, lastRequestId: requestId },
  ]) {
    mock.api.status = status; press(view, '전화 연결 상태 확인'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true);
  }
  mock.api.status = { status: 'available', senderNumber: '+15550000001', lastRequestId: requestId };
  press(view, '전화 연결 상태 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false); assert.equal(button(view, '뒤로').props.disabled, false);
  assert.equal(mock.calls.filter((c: any) => c.method === 'POST').length, 1);
});

test('기존과 동일한 발신 번호도 새 요청 receipt가 일치하면 복구한다', async t => {
  const { PhoneConnectionPanel, ApiError, operationGuard } = await components;
  const mock = mockApi({ status: 'available', senderNumber: '+15550000001', lastRequestId: 'old-request' });
  mock.api.postHook = () => { throw new ApiError('timeout', 'timeout', true); };
  const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => {} }); t.after(() => view.unmount());
  await view.settle(); fill(view); press(view, '전화 연결 설정'); await view.settle();
  const requestId = mock.calls.find((c: any) => c.method === 'POST').body.requestId;
  press(view, '전화 연결 상태 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true);
  mock.api.status = { status: 'available', senderNumber: '+15550000001', lastRequestId: requestId };
  press(view, '전화 연결 상태 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false); assert.equal(button(view, '뒤로').props.disabled, false);
});

test('정상 POST의 다른 receipt 또는 null은 불명 상태로 보존한다', async t => {
  const { PhoneConnectionPanel, operationGuard } = await components;
  for (const receipt of ['other-request', null]) {
    const mock = mockApi();
    mock.api.postHook = () => ({ status: 'available', senderNumber: '+15550000001', lastRequestId: receipt });
    const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => {} });
    await view.settle(); fill(view); press(view, '전화 연결 설정'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '뒤로').props.disabled, true);
    const requestId = mock.calls.find((c: any) => c.method === 'POST').body.requestId;
    mock.api.status = { status: 'available', senderNumber: '+15550000001', lastRequestId: requestId };
    press(view, '전화 연결 상태 확인'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), false);
    view.unmount();
  }
});

test('정상 POST는 일치 receipt 또는 레거시 누락 receipt를 수용한다', async t => {
  const { PhoneConnectionPanel, operationGuard } = await components;
  for (const receipt of ['matching', 'missing']) {
    const mock = mockApi();
    mock.api.postHook = (_path: string, body: any) => ({ status: 'available', senderNumber: body.fromNumber,
      ...(receipt === 'missing' ? {} : { lastRequestId: body.requestId }) });
    const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => {} });
    await view.settle(); fill(view); press(view, '전화 연결 설정'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), false, receipt); assert.equal(button(view, '뒤로').props.disabled, false);
    view.unmount();
  }
});

test('인증 실패는 안전한 문구만 보여주고 뒤로 이동 후 재진입 시 입력이 없다', async t => {
  const { PhoneConnectionPanel, ApiError } = await components;
  const mock = mockApi(); mock.api.postHook = () => { throw new ApiError('unauthenticated', 'sensitive server error', false, 401); };
  let backs = 0; const view = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => backs++ });
  await view.settle(); fill(view); press(view, '전화 연결 설정'); await view.settle();
  assert.match(textOf(view.tree), /연결된 세션을 확인/); assert.doesNotMatch(textOf(view.tree), /sensitive server error|test-token/);
  press(view, '뒤로'); assert.equal(backs, 1); view.unmount();
  const reopened = harness.renderer(PhoneConnectionPanel, { api: mock.api, onBack: () => {} }); t.after(() => reopened.unmount());
  await reopened.settle(); press(reopened, 'Twilio 선택'); assert.equal(input(reopened, '전화 인증 토큰').props.value, ''); assert.equal(input(reopened, '전화 계정 SID').props.value, '');
});
