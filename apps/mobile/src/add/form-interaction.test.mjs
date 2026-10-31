import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

function harness() {
  let current;
  const fragment = Symbol('fragment');
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = { useState(initial) {
    const instance = current, index = instance.index++;
    if (!instance.hooks[index]) {
      const state = { value: typeof initial === 'function' ? initial() : initial };
      state.set = next => { state.value = typeof next === 'function' ? next(state.value) : next; };
      instance.hooks[index] = state;
    }
    const state = instance.hooks[index];
    return [state.value, state.set];
  } };
  globalThis.__formHarness = { react, jsx, fragment, native: { Pressable: 'Pressable', View: 'View', StyleSheet: { create: styles => styles } } };
  function render(Component, props) {
    const instances = new Map();
    const view = { props, tree: null };
    function visit(node, path) {
      if (node == null || typeof node === 'boolean') return null;
      if (typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map((child, index) => visit(child, `${path}.${index}`));
      if (node.type === fragment) return visit(node.props.children, `${path}.fragment`);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        const instance = instances.get(id) ?? { hooks: [], index: 0 };
        instances.set(id, instance); instance.index = 0;
        const previous = current; current = instance;
        const output = node.type(node.props); current = previous;
        return visit(output, `${id}.child`);
      }
      return { ...node, children: visit(node.props.children, `${path}.children`) };
    }
    view.flush = () => { view.tree = visit(jsx(Component, view.props), 'root'); };
    view.flush(); return view;
  }
  return { render };
}

const host = harness();
const bundle = await build({
  stdin: { contents: "export { ScheduleForm } from '../schedule/ScheduleForm';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  plugins: [{ name: 'form-mocks', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/typography)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path === 'react' ? 'module.exports=globalThis.__formHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__formHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__formHarness.jsx;exports.Fragment=globalThis.__formHarness.fragment' }));
  } }],
});
const compiled = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(compiled, compiled.exports);
const { ScheduleForm } = compiled.exports;
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === 'object' ? [value, ...nodes(value.children)] : [];
}
function text(value) { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children) : String(value ?? ''); }
function input(view, label, value) {
  const node = nodes(view.tree).find(item => item.type === 'TextInput' && item.props.accessibilityLabel === label);
  assert.ok(node, label); if (value !== undefined) { node.props.onChangeText(value); view.flush(); }
  return node.props.value;
}
function press(view, label) {
  const node = nodes(view.tree).find(item => item.type === 'Pressable' && (item.props.accessibilityLabel === label || text(item.children) === label));
  assert.ok(node, label); assert.notEqual(node.props.disabled, true); node.props.onPress(); view.flush();
}

test('local-only AI proposal uses current timezone, preserves other input and saves the displayed times', () => {
  let context, saved, handled = 0;
  const props = { item: null, initialKind: 'event', defaultDate: '2026-11-01', timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false,
    onCancel() {}, onSave(value) { saved = value; }, onAskDraft(value) { context = value; }, onDraftHandled() { handled++; } };
  const view = host.render(ScheduleForm, props);
  input(view, '제목', '회의'); input(view, '시작 시간', '09:00'); input(view, '종료 시간', '10:00');
  press(view, 'AI로 작성하기');
  assert.equal(context.startDate, '2026-11-01'); assert.equal(context.startTime, '09:00');
  assert.equal(context.endDate, '2026-11-01'); assert.equal(context.endTime, '10:00');
  assert.equal(context.startsAt, '2026-11-01T00:00:00.000Z');
  view.props = { ...props, timezone: 'UTC', pendingDraft: { kind: 'event', fields: { startTime: '10:30', endTime: '11:30' } } }; view.flush();
  assert.match(text(view.tree), /시간대: Asia\/Seoul/);
  press(view, '제안 값 적용');
  assert.equal(handled, 1); assert.equal(input(view, '시작 날짜'), '2026-11-01');
  assert.equal(input(view, '시작 시간'), '10:30'); assert.equal(input(view, '종료 시간'), '11:30');
  press(view, '저장');
  assert.equal(saved.title, '회의'); assert.equal(saved.timeSlot.timezone, 'Asia/Seoul');
  assert.equal(saved.timeSlot.startsAt, '2026-11-01T01:30:00.000Z'); assert.equal(saved.timeSlot.endsAt, '2026-11-01T02:30:00.000Z');
});
