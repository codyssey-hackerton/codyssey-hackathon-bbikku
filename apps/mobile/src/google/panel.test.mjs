import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

function harness() {
  let current;
  const fragment = Symbol('fragment');
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    useState(initial) {
      const instance = current, index = instance.index++;
      if (!instance.hooks[index]) {
        const state = { value: typeof initial === 'function' ? initial() : initial };
        state.set = next => { state.value = typeof next === 'function' ? next(state.value) : next; instance.view.dirty = true; };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index]; return [state.value, state.set];
    },
    useRef(value) { const instance = current, index = instance.index++; return instance.hooks[index] ??= { current: value }; },
    useMemo(factory, deps) {
      const instance = current, index = instance.index++, old = instance.hooks[index];
      if (!old || !old.deps.every((value, i) => Object.is(value, deps[i]))) instance.hooks[index] = { value: factory(), deps };
      return instance.hooks[index].value;
    },
    useEffect(effect, deps) {
      const instance = current, index = instance.index++, old = instance.hooks[index];
      if (!old || !old.deps.every((value, i) => Object.is(value, deps[i]))) {
        const state = { deps, cleanup: old?.cleanup }; instance.hooks[index] = state;
        instance.view.effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  globalThis.__googlePanelHarness = { react, jsx, fragment, native: { ActivityIndicator: 'ActivityIndicator', Linking: { openURL: async () => { throw new Error('unexpected'); } }, ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: styles => styles } } };
  function render(Component, props) {
    const instances = new Map(), view = { tree: null, effects: [], dirty: true };
    function visit(node, path) {
      if (node == null || typeof node === 'boolean') return null;
      if (typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map((child, i) => visit(child, `${path}.${i}`));
      if (node.type === fragment) return visit(node.props.children, `${path}.fragment`);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        const instance = instances.get(id) ?? { hooks: [], index: 0, view }; instances.set(id, instance); instance.index = 0;
        const old = current; current = instance; const output = node.type(node.props); current = old;
        return visit(output, `${id}.child`);
      }
      return { ...node, children: visit(node.props.children, `${path}.children`) };
    }
    view.flush = () => {
      for (let i = 0; view.dirty && i < 20; i++) { view.dirty = false; view.effects = []; view.tree = visit(jsx(Component, props), 'root'); for (const effect of view.effects) effect(); }
      assert.equal(view.dirty, false, 'render should settle');
    };
    view.settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); view.flush(); } };
    view.flush(); return view;
  }
  return { render };
}
const host = harness();
const bundled = await build({
  stdin: { contents: "export { default as Panel } from './GoogleConnectionPanel';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  plugins: [{ name: 'google-ui-mock', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/(typography|ActionButton))$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path.endsWith('/ActionButton') ? 'exports.ActionButton=({label,...props})=>globalThis.__googlePanelHarness.jsx("Pressable",{...props,children:label})' :
      path === 'react' ? 'module.exports=globalThis.__googlePanelHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__googlePanelHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__googlePanelHarness.jsx;exports.Fragment=globalThis.__googlePanelHarness.fragment' }));
  } }],
});
const compiled = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(compiled, compiled.exports);
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : []; }
function text(node) { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : String(node ?? ''); }

test('actual per-user status distinguishes connected, not connected and server failure without OAuth', async () => {
  const requests = [];
  const api = {
    async get(path) {
      requests.push(['GET', path]);
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: '테스트 계정' };
      if (path === '/v1/calendar-write-connection') return { status: 'not_configured', accountLabel: null };
      if (path === '/v1/email-connection') throw new Error('synthetic network error');
      if (path === '/v1/contacts/google/connection') return { status: 'not_configured', accountLabel: null };
      if (path === '/v1/email-reply-connection') return { status: 'not_configured', senderAddress: null };
      throw new Error('unexpected endpoint');
    },
    async post(path) { requests.push(['POST', path]); throw new Error('unexpected OAuth'); },
  };
  const view = host.render(compiled.exports.Panel, { api, onBack() {} });
  assert.match(text(view.tree), /연결 상태를 확인하는 중/);
  await view.settle();
  const output = text(view.tree);
  assert.match(output, /로그인과 Google 서비스 연결은 별도/);
  assert.equal((output.match(/연결됨/g) ?? []).length, 1);
  assert.equal((output.match(/미연결/g) ?? []).length, 3);
  assert.match(output, /테스트 계정/);
  assert.match(output, /서버 연결을 확인/);
  assert.equal(nodes(view.tree).filter(node => node.type === 'Pressable' && /연결 시작/.test(text(node.children))).length, 5);
  assert.equal(requests.filter(([method]) => method === 'GET').length, 5);
  assert.equal(requests.filter(([method]) => method === 'POST').length, 0);
});
