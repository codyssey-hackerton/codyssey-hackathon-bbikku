import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { durationBetween, endTime } from './form.ts';

let current, submitted;
const fragment = Symbol('fragment');
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const react = {
  useState(initial) {
    const instance = current, index = instance.index++;
    if (!instance.hooks[index]) {
      const state = { value: typeof initial === 'function' ? initial() : initial };
      state.set = next => { state.value = typeof next === 'function' ? next(state.value) : next; };
      instance.hooks[index] = state;
    }
    const state = instance.hooks[index]; return [state.value, state.set];
  },
  useRef(initial) { const instance = current, index = instance.index++; return instance.hooks[index] ??= { current: initial }; },
  useMemo(factory, deps) {
    const instance = current, index = instance.index++, previous = instance.hooks[index];
    if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) instance.hooks[index] = { deps, value: factory() };
    return instance.hooks[index].value;
  },
  useEffect() {},
};
globalThis.__routineFormHarness = { react, jsx, fragment, native: { Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: styles => styles } } };
const bundle = await build({
  stdin: { contents: "export { default as Panel } from './RoutinesPanel';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'routine-mocks', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*\/typography|.*\/api\/useMutation|.*\/RoutineOccurrences|\.\/Icon)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path.endsWith('/useMutation') ? 'exports.useMutation=()=>({state:{status:"idle"},submit:globalThis.__routineSubmit,reset(){}})' :
      path.endsWith('/RoutineOccurrences') ? 'exports.RoutineOccurrences=()=>null' :
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path === 'react' ? 'module.exports=globalThis.__routineFormHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__routineFormHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__routineFormHarness.jsx;exports.Fragment=globalThis.__routineFormHarness.fragment' }));
  } }],
});
const compiled = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(compiled, compiled.exports);
globalThis.__routineSubmit = value => { submitted = value; };
function render(props) {
  const instances = new Map(), view = { props };
  function visit(node, path) {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => visit(child, `${path}.${i}`));
    if (node.type === fragment) return visit(node.props.children, `${path}.fragment`);
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}:${node.key ?? ''}`, instance = instances.get(id) ?? { hooks: [], index: 0 };
      instances.set(id, instance); instance.index = 0;
      const previous = current; current = instance; const output = node.type(node.props); current = previous;
      return visit(output, `${id}.child`);
    }
    return { ...node, children: visit(node.props.children, `${path}.children`) };
  }
  view.flush = () => { view.tree = visit(jsx(compiled.exports.Panel, view.props), 'root'); };
  view.flush(); return view;
}
function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.children)] : []; }
function text(value) { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children) : String(value ?? ''); }
function input(view, label, value) {
  const node = nodes(view.tree).find(item => item.type === 'TextInput' && item.props.accessibilityLabel === label || item.type === 'input' && item.props['aria-label'] === label);
  assert.ok(node, label);
  if (value !== undefined) { if (node.type === 'input') node.props.onChange({ currentTarget: { value } }); else node.props.onChangeText(value); view.flush(); }
  return node.props.value;
}
function press(view, label) {
  const node = nodes(view.tree).find(item => item.type === 'Pressable' && (item.props.accessibilityLabel === label || text(item.children) === label));
  assert.ok(node, label); assert.notEqual(node.props.disabled, true); node.props.onPress(); view.flush();
}

test('time conversion preserves overnight and full-day durations', () => {
  assert.equal(endTime('23:30', '90'), '01:00');
  assert.equal(durationBetween('23:30', '01:00'), '90');
  assert.equal(endTime('09:00', '1440'), '09:00');
  assert.equal(durationBetween('09:00', '09:00'), '1440');
  assert.equal(durationBetween('', '09:00'), '');
});

test('routine date and time inputs save the selected overnight duration and retain the AI contract', () => {
  submitted = null; let context;
  const view = render({ api: {}, timezone: 'Asia/Seoul', selectedDate: '2026-11-01', visible: true, formOnly: true,
    onBack() {}, onDay() {}, onScheduleChanged() {}, onAskDraft(value) { context = value; } });
  input(view, '루틴 이름', '운동'); press(view, '월요일');
  input(view, '루틴 시작일', '2026-11-02'); input(view, '루틴 시작 시각', '23:30'); input(view, '루틴 종료 시각', '01:00');
  assert.match(text(view.tree), /다음 날 종료 · 소요 시간 90분/);
  assert.doesNotMatch(text(view.tree), /Asia\/Seoul|YYYY-MM-DD|HH:mm/);
  press(view, 'AI로 작성하기'); assert.equal(context.duration, '90'); assert.equal(context.localTime, '23:30');
  press(view, '루틴 등록');
  assert.equal(submitted.input.durationMinutes, 90); assert.equal(submitted.input.startDate, '2026-11-02');
  assert.equal(submitted.input.localTime, '23:30'); assert.equal(submitted.input.timezone, 'Asia/Seoul');
});

test('applying an AI duration updates the displayed end time without changing the draft contract', () => {
  const view = render({ api: {}, timezone: 'Asia/Seoul', selectedDate: '2026-11-01', visible: true, formOnly: true,
    onBack() {}, onDay() {}, onScheduleChanged() {}, pendingDraft: { kind: 'routine', fields: { localTime: '23:45', duration: '60' } } });
  press(view, '제안 값 적용');
  assert.equal(input(view, '루틴 시작 시각'), '23:45');
  assert.equal(input(view, '루틴 종료 시각'), '00:45');
  assert.match(text(view.tree), /다음 날 종료 · 소요 시간 60분/);
});

test('occurrence generation uses inclusive selected dates', () => {
  submitted = null;
  const view = render({ api: {}, timezone: 'Asia/Seoul', selectedDate: '2026-11-01', visible: true,
    onBack() {}, onDay() {}, onScheduleChanged() {} });
  press(view, '전체 루틴');
  input(view, '회차 시작일', '2026-11-02'); input(view, '회차 종료일', '2026-11-04');
  press(view, '회차 생성');
  assert.deepEqual(submitted, { kind: 'materialize', input: { fromDate: '2026-11-02', toDate: '2026-11-04' } });
});
