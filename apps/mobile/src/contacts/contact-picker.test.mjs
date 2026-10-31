import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let current;
const Fragment = Symbol('fragment'), jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const slot = () => ({ instance: current, index: current.index++ });
const react = {
 useState(initial) { const { instance, index } = slot(); if (!instance.hooks[index]) { const s = { value: typeof initial === 'function' ? initial() : initial };
  s.set = next => { if (!instance.alive) return; const value = typeof next === 'function' ? next(s.value) : next; if (!Object.is(value, s.value)) { s.value = value; instance.view.dirty = true; } }; instance.hooks[index] = s; } const s = instance.hooks[index]; return [s.value, s.set]; },
 useRef(initial) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
 useMemo(fn, deps) { const { instance, index } = slot(); if (!instance.hooks[index] || !same(instance.hooks[index].deps, deps)) instance.hooks[index] = { deps, value: fn() }; return instance.hooks[index].value; },
 useEffect(fn, deps) { const { instance, index } = slot(), effect = instance.hooks[index] ??= {}; if (!same(effect.deps, deps)) { effect.deps = deps; instance.view.effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
};
globalThis.__profilePanelHarness = { react, jsx, Fragment, native: { View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', Platform: { OS: 'ios' }, StyleSheet: { create: styles => styles } } };
const built = await build({ stdin: { contents: "export {ContactPicker, normalizeContactNumber} from './ContactPicker'; export {ApiError} from '../api/http';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
 plugins: [{ name: 'host', setup(b) { b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/device-contacts|.*ui\/(typography|ActionButton|PikkuCharacter|ProfileAvatar|Icon))$/ }, a => ({ path: a.path, namespace: 'host' }));
  b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react' ? 'module.exports=globalThis.__profilePanelHarness.react' :
   path === 'react-native' ? 'module.exports=globalThis.__profilePanelHarness.native' : path === './device-contacts' ? 'exports.searchDeviceContacts=(query)=>globalThis.__deviceSearch(query)' : path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
   path.endsWith('/ActionButton') ? 'exports.ActionButton=({label,onPress,disabled})=>globalThis.__profilePanelHarness.jsx("Pressable",{accessibilityLabel:label,onPress,disabled,children:label})' :
   path.endsWith('/PikkuCharacter') ? 'exports.PikkuCharacter=()=>null' : path.endsWith('/ProfileAvatar') ? 'exports.ProfileAvatar=()=>null' : path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
   'exports.jsx=exports.jsxs=globalThis.__profilePanelHarness.jsx;exports.Fragment=globalThis.__profilePanelHarness.Fragment' })); } }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { ContactPicker, normalizeContactNumber, ApiError } = mod.exports;
function render(Component, props) {
 const view = { props, dirty: true, effects: [], instances: new Map(), tree: null };
 function node(value, path, seen) {
  if (value == null || typeof value === 'boolean') return null; if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((v, i) => node(v, `${path}.${i}`, seen)); if (value.type === Fragment) return node(value.props.children, `${path}.f`, seen);
  if (typeof value.type === 'function') { const id = `${path}:${value.type.name}:${value.key ?? ''}`; let instance = view.instances.get(id);
   if (!instance) { instance = { hooks: [], index: 0, alive: true, view }; view.instances.set(id, instance); }
   seen.add(id); instance.index = 0; const previous = current; current = instance; const output = value.type(value.props); current = previous; return node(output, `${id}.child`, seen); }
  return { type: value.type, props: value.props, children: node(value.props.children, `${path}.children`, seen) };
 }
 view.flush = () => { for (let i = 0; view.dirty && i < 40; i++) { view.dirty = false; view.effects = []; const seen = new Set(); view.tree = node(jsx(Component, view.props), 'root', seen);
  for (const [id, instance] of view.instances) if (!seen.has(id)) { instance.alive = false; for (const h of instance.hooks) h?.cleanup?.(); view.instances.delete(id); } for (const effect of view.effects) effect(); } if (view.dirty) throw Error('not settled'); };
 view.settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); view.flush(); } };
 view.update = props => { view.props = props; view.dirty = true; view.flush(); };
 view.close = () => { for (const instance of view.instances.values()) { instance.alive = false; for (const h of instance.hooks) h?.cleanup?.(); } };
 view.flush(); return view;
}
function nodes(v) { if (!v || typeof v !== 'object') return []; if (Array.isArray(v)) return v.flatMap(nodes); return [v, ...nodes(v.children)]; }
function text(v) { if (v == null) return ''; if (typeof v === 'string' || typeof v === 'number') return String(v); if (Array.isArray(v)) return v.map(text).join(''); return text(v.children); }
function press(view, label) { const n = nodes(view.tree).find(n => n.type === 'Pressable' && (n.props.accessibilityLabel === label || text(n.children) === label)); assert.ok(n, `missing ${label}`); assert.notEqual(n.props.disabled, true); n.props.onPress(); view.flush(); }
function input(view, label, value) { const n = nodes(view.tree).find(n => n.type === 'TextInput' && n.props.accessibilityLabel === label); assert.ok(n, label); if (value !== undefined) { n.props.onChangeText(value); view.flush(); return; } return n.props.value; }

const rows = [
 { id: '1', displayName: '김민수', phoneNumbers: [{ label: '휴대폰', number: '010-1234-5678' }, { label: '직장', number: '+1 (212) 555-0123' }] },
 { id: '2', displayName: '김민수', phoneNumbers: [{ number: '010-9876-5432' }] }
];
function picker(api, onSelect = () => {}, more = {}) { return render(ContactPicker, { api, disabled: false, onSelect, ...more }); }
function buttonExists(view, label) { return nodes(view.tree).some(n => n.props?.accessibilityLabel === label); }
test('device search separates duplicate names and numbers and never sends a result to server', async t => {
 let selected, writes = 0; globalThis.__deviceSearch = async query => { assert.equal(query, '김민수'); return { status: 'ok', contacts: rows, limited: true, truncated: false }; };
 const api = { async get() { writes++; }, async post() { writes++; } };
 const view = picker(api, value => { selected = value; }); t.after(view.close);
 press(view, '연락처에서 선택'); input(view, '연락처 이름 검색', '김민수'); press(view, '이름 검색'); await view.settle();
 assert.match(text(view.tree), /허용된 연락처만/); assert.ok(buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
 assert.ok(buttonExists(view, '김민수 · 직장 · +1 (212) 555-0123')); assert.ok(buttonExists(view, '김민수 · 전화 · 010-9876-5432'));
 press(view, '김민수 · 직장 · +1 (212) 555-0123'); assert.deepEqual(selected, { name: '김민수', number: '+12125550123' }); assert.equal(writes, 0);
});
test('google search encodes query and returns only explicit selected number', async t => {
 const calls = []; let selected; const api = { async get(path) { calls.push(path); return { contacts: rows, truncated: true }; } };
 const view = picker(api, value => { selected = value; }); t.after(view.close);
 press(view, '연락처에서 선택'); press(view, 'Google 연락처'); input(view, '연락처 이름 검색', '김민수'); press(view, '이름 검색'); await view.settle();
 assert.equal(calls[0], '/v1/contacts/google/search?q=%EA%B9%80%EB%AF%BC%EC%88%98'); assert.match(text(view.tree), /일부 결과만/);
 press(view, '김민수 · 전화 · 010-9876-5432'); assert.deepEqual(selected, { name: '김민수', number: '+821098765432' }); assert.equal(calls.length, 1);
});
test('denied, limited empty, web unsupported and google disconnected are distinct', async t => {
 let mode = 'denied', connected = 0; globalThis.__deviceSearch = async () => mode === 'empty' ? { status: 'ok', contacts: [], limited: true, truncated: false } : { status: mode };
 const api = { async get() { throw new ApiError('not_configured', 'secret', false, 503); } };
 const view = picker(api, () => {}, { onOpenGoogleContacts() { connected++; } }); t.after(view.close);
 press(view, '연락처에서 선택'); input(view, '연락처 이름 검색', '김'); press(view, '이름 검색'); await view.settle(); assert.match(text(view.tree), /접근이 거부/);
 mode = 'empty'; press(view, '이름 검색'); await view.settle(); assert.match(text(view.tree), /허용된 연락처만/); assert.match(text(view.tree), /검색 결과가 없습니다/);
 mode = 'unavailable'; press(view, '이름 검색'); await view.settle(); assert.match(text(view.tree), /이 기기에서는/);
 press(view, 'Google 연락처'); press(view, '이름 검색'); await view.settle(); assert.match(text(view.tree), /Google 연락처 연결이 필요/);
 assert.doesNotMatch(text(view.tree), /secret/); press(view, 'Google 연락처 연결 열기'); assert.equal(connected, 1);
});
test('cancel and query changes discard late results without selecting a person', async t => {
 let finish, selected = 0; globalThis.__deviceSearch = () => new Promise(resolve => { finish = resolve; });
 const view = picker({}, () => selected++); t.after(view.close); press(view, '연락처에서 선택'); input(view, '연락처 이름 검색', '김'); press(view, '이름 검색');
 press(view, '연락처 선택 취소'); finish({ status: 'ok', contacts: rows, limited: false, truncated: false }); await view.settle();
 assert.equal(selected, 0); assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
});
test('phone normalization only strips formatting and rejects extensions or malformed Korean country codes', () => {
 assert.equal(normalizeContactNumber('010 1234-5678'), '+821012345678'); assert.equal(normalizeContactNumber('+82 10 1234 5678'), '+821012345678');
 assert.equal(normalizeContactNumber('010/1234/5678'), '+821012345678');
 assert.equal(normalizeContactNumber('+82 (0)10-1234-5678'), null); assert.equal(normalizeContactNumber('010-1234-5678 ext 12'), null);
});
test('API change closes picker and clears previous account search and results while preserving disabled state', async t => {
 const oldApi = { async get() { return { contacts: rows, truncated: false }; } }, nextApi = { async get() { return { contacts: [], truncated: false }; } };
 const onSelect = () => {}; const view = picker(oldApi, onSelect); t.after(view.close);
 press(view, '연락처에서 선택'); press(view, 'Google 연락처'); input(view, '연락처 이름 검색', '김'); press(view, '이름 검색'); await view.settle();
 assert.ok(buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
 view.update({ api: nextApi, disabled: true, onSelect });
 assert.equal(nodes(view.tree).find(n => n.props?.accessibilityLabel === '연락처에서 선택').props.disabled, true);
 assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
 view.update({ api: nextApi, disabled: false, onSelect }); press(view, '연락처에서 선택');
 assert.equal(input(view, '연락처 이름 검색'), ''); assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
});
test('old API response cannot replace new account search results', async t => {
 let finish; const oldApi = { get: () => new Promise(resolve => { finish = resolve; }) };
 const nextRows = [{ id: 'new', displayName: '새 계정', phoneNumbers: [{ number: '010-1111-2222' }] }];
 const nextApi = { async get() { return { contacts: nextRows, truncated: false }; } }; const onSelect = () => {};
 const view = picker(oldApi, onSelect); t.after(view.close);
 press(view, '연락처에서 선택'); press(view, 'Google 연락처'); input(view, '연락처 이름 검색', '김'); press(view, '이름 검색');
 view.update({ api: nextApi, disabled: false, onSelect }); press(view, '연락처에서 선택'); input(view, '연락처 이름 검색', '새'); press(view, '이름 검색'); await view.settle();
 finish({ contacts: rows, truncated: false }); await view.settle();
 assert.ok(buttonExists(view, '새 계정 · 전화 · 010-1111-2222')); assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
});
test('changing source or query discards earlier pending searches', async t => {
 let finish; globalThis.__deviceSearch = () => new Promise(resolve => { finish = resolve; });
 const api = { async get() { return { contacts: [], truncated: false }; } }; const view = picker(api); t.after(view.close);
 press(view, '연락처에서 선택'); input(view, '연락처 이름 검색', '김'); press(view, '이름 검색');
 press(view, 'Google 연락처'); finish({ status: 'ok', contacts: rows, limited: false, truncated: false }); await view.settle();
 assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678'));
 press(view, '휴대폰 연락처'); press(view, '이름 검색'); input(view, '연락처 이름 검색', '박');
 finish({ status: 'ok', contacts: rows, limited: false, truncated: false }); await view.settle();
 assert.ok(!buttonExists(view, '김민수 · 휴대폰 · 010-1234-5678')); assert.equal(input(view, '연락처 이름 검색'), '박');
});
test('web defaults to Google contacts and native platforms default to device contacts', () => {
 const platform = globalThis.__profilePanelHarness.native.Platform;
 try {
  for (const [os, expected] of [['web', 'Google 연락처 선택됨'], ['ios', '휴대폰 연락처 선택됨'], ['android', '휴대폰 연락처 선택됨']]) {
   platform.OS = os; const view = picker({}); press(view, '연락처에서 선택'); assert.ok(buttonExists(view, expected)); view.close();
  }
 } finally { platform.OS = 'ios'; }
});
