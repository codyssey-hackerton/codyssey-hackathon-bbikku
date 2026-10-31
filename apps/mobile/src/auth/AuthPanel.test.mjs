import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jsx = (type, props) => ({ type, props: props ?? {} });
const fragment = Symbol('fragment');
let slots = [], index = 0, effects = [], dirty = false;
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const react = {
  useState(initial) {
    const at = index++;
    if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
    return [slots[at].value, value => { slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; dirty = true; }];
  },
  useRef(initial) { const at = index++; return slots[at] ??= { current: initial }; },
  useMemo(factory, deps) {
    const at = index++;
    if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { value: factory(), deps };
    return slots[at].value;
  },
  useEffect(callback, deps) {
    const at = index++;
    if (!slots[at] || !same(slots[at].deps, deps)) {
      const old = slots[at]; slots[at] = { deps };
      effects.push(() => { old?.cleanup?.(); slots[at].cleanup = callback(); });
    }
  },
};
let client, guard;
const host = globalThis.__authTest = { react, jsx, fragment,
  native: { Linking: { openURL: (...args) => host.open(...args) }, ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
    View: 'View', Platform: { OS: 'ios' }, StyleSheet: { create: value => value } },
  client: () => client, guard: () => guard, open: async () => {},
};
const directory = dirname(fileURLToPath(import.meta.url));
const bundle = await build({ stdin: { contents: "export { default as AuthPanel } from './AuthPanel'; export { WelcomeScreen } from './WelcomeScreen';", resolveDir: directory, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'auth-test', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/client|\.\.\/api\/operationGuard|\.\.\/ui\/(ActionButton|PikkuCharacter|typography|theme))$/ },
      args => ({ path: args.path, namespace: 'auth-mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'auth-mock' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'module.exports=globalThis.__authTest.react' :
      path === 'react/jsx-runtime' ? 'exports.jsx=exports.jsxs=globalThis.__authTest.jsx; exports.Fragment=globalThis.__authTest.fragment' :
      path === 'react-native' ? 'module.exports=globalThis.__authTest.native' :
      path === './client' ? 'exports.createAuthClient=()=>globalThis.__authTest.client()' :
      path.endsWith('operationGuard') ? 'exports.operationGuard={hasUnresolved:(...a)=>globalThis.__authTest.guard().hasUnresolved(...a),clear:(...a)=>globalThis.__authTest.guard().clear(...a),update:(...a)=>globalThis.__authTest.guard().update(...a)}' :
      path.endsWith('ActionButton') ? 'exports.ActionButton="Button"' :
      path.endsWith('PikkuCharacter') ? 'exports.PikkuCharacter="Mascot"' :
      path.endsWith('typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
      'exports.colors={text:"#14151A",muted:"#626B80",surface:"#FFFFFF",border:"#E5EAF4",primary:"#6986FC",primaryPressed:"#5369CA"}' }));
  } }] });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { AuthPanel, WelcomeScreen } = module.exports;
const all = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(all)];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  slots = []; index = 0; effects = []; dirty = false;
  const start = deferred(), complete = deferred(), activity = [], signedIn = [], backs = [];
  client = { start: () => start.promise, complete: () => complete.promise };
  const pending = new Set();
  guard = { hasUnresolved: () => pending.size > 0, clear: owner => pending.delete(owner),
    update: (owner, state) => state.status === 'pending' ? pending.add(owner) : pending.delete(owner) };
  const props = { baseUrl: 'https://example.test', onBack: () => backs.push(true), onSignedIn: result => { signedIn.push(result); return true; },
    onFlowActiveChange: value => activity.push(value), ...overrides };
  let tree;
  function flush() {
    do { dirty = false; index = 0; effects = []; tree = AuthPanel(props); for (const effect of effects) effect(); } while (dirty);
  }
  const find = (type, label) => all(tree).find(node => node.type === type && (node.props.label === label || node.props.accessibilityLabel === label));
  const press = label => { const button = find('Button', label); assert.ok(button, `missing ${label}`); assert.notEqual(button.props.disabled, true); button.props.onPress(); flush(); };
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); flush(); };
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); };
  flush();
  return { start, complete, activity, signedIn, backs, pending, find, press, settle, unmount, flush };
}
const started = { authorizationUrl: 'https://accounts.google.com/example', completionSecret: 's'.repeat(43) };

test('시작과 ready는 활성 상태를 유지하고 명시적 뒤로는 인증을 취소한다', async () => {
  const view = setup({ mode: 'signup' });
  view.press('Google 로그인 시작');
  assert.deepEqual(view.activity, [true]);
  assert.equal(view.find('Button', '뒤로').props.disabled, true);
  view.start.resolve(started); await view.settle();
  host.open = async () => { throw new Error('unavailable'); };
  view.press('Google 로그인 화면 열기'); await view.settle();
  assert.deepEqual(view.activity, [true]);
  view.press('뒤로');
  assert.deepEqual(view.activity, [true, false]); assert.equal(view.backs.length, 1);
  view.unmount(); host.open = async () => {};
});

test('완료 중 잠금을 유지하고 완료 결과를 받으면 세션 전환 전에 해제한다', async () => {
  const view = setup({ mode: 'login' });
  view.press('Google 로그인 시작'); view.start.resolve(started); await view.settle();
  view.find('TextInput', 'Google 로그인 확인 코드').props.onChangeText('z'.repeat(43)); view.flush();
  view.press('Google 로그인 확인');
  assert.deepEqual(view.activity, [true]); assert.equal(view.pending.size, 1);
  view.complete.resolve({ sessionToken: 'synthetic', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'test', email: 'test@example.test', displayName: 'test' } });
  await view.settle();
  assert.deepEqual(view.activity, [true, false]); assert.equal(view.pending.size, 0); assert.equal(view.signedIn.length, 1);
  view.unmount();
});

test('시작 실패와 언마운트는 연결 변경 잠금을 해제하고 늦은 응답을 무시한다', async () => {
  const failed = setup(); failed.press('Google 로그인 시작'); failed.start.reject(new Error('synthetic')); await failed.settle();
  assert.deepEqual(failed.activity, [true, false]); failed.unmount();
  const abandoned = setup(); abandoned.press('Google 로그인 시작'); abandoned.unmount();
  assert.deepEqual(abandoned.activity, [true, false]);
  abandoned.start.resolve(started); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(abandoned.activity, [true, false]);
});

test('완료 결과 불명은 자동 재시도하지 않고 활성 상태를 해제한다', async () => {
  const view = setup(); view.press('Google 로그인 시작'); view.start.resolve(started); await view.settle();
  view.find('TextInput', 'Google 로그인 확인 코드').props.onChangeText('z'.repeat(43)); view.flush(); view.press('Google 로그인 확인');
  view.complete.reject(new Error('synthetic')); await view.settle();
  assert.deepEqual(view.activity, [true, false]); assert.equal(view.pending.size, 0); assert.equal(view.signedIn.length, 0);
  assert.equal(view.find('Button', 'Google 로그인 확인'), undefined); view.unmount();
});

test('환영 화면의 개발 설정은 개발 환경에서만 보조 진입으로 표시한다', () => {
  const old = globalThis.__DEV__; globalThis.__DEV__ = false;
  const props = { onStart() {}, onLogin() {}, onDeveloperSettings() {} };
  assert.equal(all(WelcomeScreen(props)).some(node => node.props?.label === '개발 연결 설정'), false);
  globalThis.__DEV__ = true;
  assert.equal(all(WelcomeScreen(props)).some(node => node.props?.label === '개발 연결 설정'), true);
  globalThis.__DEV__ = old;
});

test('다른 미해결 요청은 완료를 막되 현재 인증 흐름은 유지한다', async () => {
  const view = setup(); view.press('Google 로그인 시작'); view.start.resolve(started); await view.settle();
  view.find('TextInput', 'Google 로그인 확인 코드').props.onChangeText('z'.repeat(43)); view.flush();
  const other = {}; view.pending.add(other); view.press('Google 로그인 확인');
  assert.deepEqual(view.activity, [true]); assert.equal(view.pending.size, 1); assert.equal(view.signedIn.length, 0);
  view.pending.delete(other); view.press('Google 로그인 확인'); assert.equal(view.pending.size, 1);
  view.complete.resolve({ sessionToken: 'synthetic', expiresAt: '2030-01-01T00:00:00Z', member: { id: 'test', email: 'test@example.test', displayName: 'test' } });
  await view.settle(); assert.deepEqual(view.activity, [true, false]); view.unmount();
});

test('10분이 지난 인증은 열지 않고 활성 상태를 해제한다', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let now = 100;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  try {
    const view = setup(); view.press('Google 로그인 시작'); view.start.resolve(started); await view.settle();
    now += 600_000; view.press('Google 로그인 화면 열기');
    assert.deepEqual(view.activity, [true, false]);
    assert.equal(view.find('Button', 'Google 로그인 확인'), undefined);
    view.unmount();
  } finally { if (original) Object.defineProperty(globalThis, 'performance', original); }
});
