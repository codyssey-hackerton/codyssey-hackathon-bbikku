import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let current;
const Fragment = Symbol('fragment'), jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const react = { useState(initial) { const instance = current, index = instance.index++; if (!instance.hooks[index]) {
 const state = { value: typeof initial === 'function' ? initial() : initial }; state.set = next => { state.value = typeof next === 'function' ? next(state.value) : next; instance.view.dirty = true; }; instance.hooks[index] = state; }
 const state = instance.hooks[index]; return [state.value, state.set]; },
 useRef(initial) { const instance = current, index = instance.index++; return instance.hooks[index] ??= { current: initial }; },
 useEffect(fn, deps) { const instance = current, index = instance.index++, old = instance.hooks[index] ??= { deps: undefined };
  if (!old.deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) { old.deps = deps; instance.view.effects.push(() => { old.cleanup?.(); old.cleanup = fn(); }); } } };
const native = { Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View', StyleSheet: { create: styles => styles } };
globalThis.__datetimeHarness = { react, native, jsx, Fragment };
const result = await build({ stdin: { contents: "export { DateTimeFields } from './DateTimeFields.native';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
 bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', plugins: [{ name: 'host', setup(b) {
  b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|@react-native-community\/datetimepicker|\.\/typography)$/ }, a => ({ path: a.path, namespace: 'host' }));
  b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react' ? 'module.exports=globalThis.__datetimeHarness.react' :
   path === 'react-native' ? 'module.exports=globalThis.__datetimeHarness.native' : path === './typography' ? 'exports.Text="Text"' :
   path === '@react-native-community/datetimepicker' ? 'module.exports="NativePicker"' : 'exports.jsx=exports.jsxs=globalThis.__datetimeHarness.jsx;exports.Fragment=globalThis.__datetimeHarness.Fragment' }));
 } }] });
const mod = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports);
function render(props) {
 const view = { props, dirty: true, effects: [], hooks: [], tree: null }; const instance = { hooks: view.hooks, index: 0, view };
 function visit(node) { if (node == null || typeof node === 'boolean') return null; if (Array.isArray(node)) return node.map(visit); if (typeof node !== 'object') return node;
  if (node.type === Fragment) return visit(node.props.children); return { ...node, children: visit(node.props.children) }; }
 view.flush = () => { for (let i = 0; view.dirty && i < 10; i++) { view.dirty = false; view.effects = []; instance.index = 0; current = instance; view.tree = visit(mod.exports.DateTimeFields(view.props)); current = null; for (const effect of view.effects) effect(); } };
 view.update = next => { view.props = next; view.dirty = true; view.flush(); }; view.flush(); return view;
}
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.children)]; }
function press(view, label) { const node = nodes(view.tree).find(item => item.type === 'Pressable' && item.props.accessibilityLabel === label); assert.ok(node); assert.notEqual(node.props.disabled, true); node.props.onPress(); view.flush(); }

test('iOS calendar and time picker commit only on done and cancellation preserves value', () => {
 native.Platform.OS = 'ios'; const values = []; const props = { label: '시작 날짜', mode: 'date', value: '2026-11-01', onChange: value => values.push(value), disabled: false };
 const view = render(props); press(view, '시작 날짜'); const calendar = nodes(view.tree).find(node => node.type === 'NativePicker'); assert.equal(calendar.props.display, 'inline');
 calendar.props.onChange({ type: 'set' }, new Date(2026, 10, 4, 12)); view.flush(); assert.deepEqual(values, []);
 press(view, '시작 날짜 선택 취소'); assert.deepEqual(values, []);
 press(view, '시작 날짜'); nodes(view.tree).find(node => node.type === 'NativePicker').props.onChange({ type: 'set' }, new Date(2026, 10, 4, 12)); view.flush();
 press(view, '시작 날짜 선택 완료'); assert.deepEqual(values, ['2026-11-04']);
 view.update({ ...props, label: '시작 시간', mode: 'time', value: '09:00' }); press(view, '시작 시간');
 const picker = nodes(view.tree).find(node => node.type === 'NativePicker'); assert.equal(picker.props.display, 'spinner'); picker.props.onChange({ type: 'set' }, new Date(2026, 10, 4, 14, 15)); view.flush();
 press(view, '시작 시간 선택 완료'); assert.deepEqual(values, ['2026-11-04', '14:15']);
});

test('Android dismissal makes no change and disabled picker closes', () => {
 native.Platform.OS = 'android'; const values = []; const props = { label: '종료 시간', mode: 'time', value: '10:00', onChange: value => values.push(value), disabled: false };
 const view = render(props); press(view, '종료 시간'); nodes(view.tree).find(node => node.type === 'NativePicker').props.onChange({ type: 'dismissed' }); view.flush();
 assert.deepEqual(values, []); assert.ok(!nodes(view.tree).some(node => node.type === 'NativePicker'));
 press(view, '종료 시간'); nodes(view.tree).find(node => node.type === 'NativePicker').props.onChange({ type: 'set' }, new Date(2026, 10, 4, 16, 5)); view.flush();
 assert.deepEqual(values, ['16:05']); assert.ok(!nodes(view.tree).some(node => node.type === 'NativePicker'));
 press(view, '종료 시간'); const late = nodes(view.tree).find(node => node.type === 'NativePicker').props.onChange;
 view.update({ ...props, disabled: true }); assert.ok(!nodes(view.tree).some(node => node.type === 'NativePicker'));
 view.update({ ...props, disabled: false }); assert.ok(!nodes(view.tree).some(node => node.type === 'NativePicker'));
 late({ type: 'set' }, new Date(2026, 10, 4, 18, 45)); view.flush(); assert.deepEqual(values, ['16:05']);
 native.Platform.OS = 'ios';
});
