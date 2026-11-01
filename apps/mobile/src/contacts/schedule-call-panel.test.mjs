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
const built = await build({ stdin: { contents: "export {default as ScheduleCallPanel} from './ScheduleCallPanel'; export {ApiError} from '../api/http';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
 plugins: [{ name: 'host', setup(b) { b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/(typography|ActionButton|PikkuCharacter|ProfileAvatar|Icon))$/ }, a => ({ path: a.path, namespace: 'host' }));
  b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react' ? 'module.exports=globalThis.__profilePanelHarness.react' :
   path === 'react-native' ? 'module.exports=globalThis.__profilePanelHarness.native' : path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
   path.endsWith('/ActionButton') ? 'exports.ActionButton=({label,onPress,disabled})=>globalThis.__profilePanelHarness.jsx("Pressable",{accessibilityLabel:label,onPress,disabled,children:label})' :
   path.endsWith('/PikkuCharacter') ? 'exports.PikkuCharacter=()=>null' : path.endsWith('/ProfileAvatar') ? 'exports.ProfileAvatar=()=>null' : path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
   'exports.jsx=exports.jsxs=globalThis.__profilePanelHarness.jsx;exports.Fragment=globalThis.__profilePanelHarness.Fragment' })); } }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { ScheduleCallPanel, ApiError } = mod.exports;
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

const base = { id: 'call-1', revision: 1, status: 'pending', itemId: 'event-1', itemRevision: 3, title: '약속', question: '장소를 확인해 주세요', toNumber: '+821012345678' };
const transcript = [{ role: 'user', text: '홍대입니다' }];
const correction = { beforeLocation: '강남', afterLocation: '홍대', summary: '상대가 홍대로 정정했습니다' };
function setup(api, changes = {}) {
 const callbacks = { onClose() {}, onFinish() {}, onScheduleChanged() {}, onOpenPhoneSettings() {}, ...changes };
 return render(ScheduleCallPanel, { api, itemId: 'event-1', expectedRevision: 3, ...callbacks });
}
function enterNumber(view) { input(view, '받는 전화번호', '01012345678'); }
test('explicit approval and review precede a location update', async t => {
 const writes = []; let refreshed = 0;
 const api = { async post(path, body, options) { writes.push({ path, body, options });
   if (path === '/v1/schedule-calls') return { call: base };
   if (path.endsWith('/approve')) return { call: { ...base, revision: 3, status: 'submitted' } };
   if (path.endsWith('/check')) return { call: { ...base, revision: 4, status: 'completed', transcript } };
   if (path.endsWith('/propose')) return { call: { ...base, revision: 5, status: 'review_pending', transcript, correction } };
   if (path.endsWith('/decision')) return { call: { ...base, revision: 6, status: 'applied', transcript, correction } };
   throw Error(path);
 }, async get() { throw Error('unexpected'); } };
 const view = setup(api, { onScheduleChanged() { refreshed++; } }); t.after(view.close);
 enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 assert.equal(writes.length, 1); assert.equal(writes[0].body.toNumber, '+821012345678'); assert.match(text(view.tree), /장소를 확인해 주세요/);
 press(view, '승인하고 전화'); await view.settle(); assert.equal(writes.length, 2); assert.match(text(view.tree), /전화 요청 접수/);
 press(view, '통화 결과 확인'); await view.settle(); assert.match(text(view.tree), /상대방: 홍대입니다/); assert.equal(refreshed, 0);
 press(view, '장소 정정 검토'); await view.settle(); assert.match(text(view.tree), /변경 전: 강남/); assert.match(text(view.tree), /변경 제안: 홍대/);
 assert.match(text(view.tree), /Google 원본 장소와는 동기화되지 않습니다/); assert.equal(writes.length, 4);
 press(view, '장소 변경 승인'); await view.settle(); assert.equal(writes[4].body.decision, 'accept'); assert.equal(refreshed, 1);
});
test('phone setup, conflict and unavailable codes show safe guidance without raw server messages', async t => {
 for (const [code, expected] of [['not_configured', /전화 계정 연결/], ['conflict', /최신 일정을 다시 조회/], ['provider_unavailable', /직접 연락/]]) {
  let settings = 0, refresh = 0, finished = 0;
  const api = { async post() { throw new ApiError(code, 'sensitive internal detail', true, code === 'conflict' ? 409 : 503); }, async get() {} };
  const view = setup(api, { onOpenPhoneSettings() { settings++; }, onScheduleChanged() { refresh++; }, onFinish() { finished++; } });
  enterNumber(view); press(view, '전화 내용 확인'); await view.settle(); assert.match(text(view.tree), expected); assert.doesNotMatch(text(view.tree), /sensitive internal detail/);
  if (code === 'not_configured') { press(view, '전화 연결 설정 열기'); assert.equal(settings, 1); }
  if (code === 'conflict') { press(view, '일정 다시 조회'); assert.equal(refresh, 1); assert.equal(finished, 1); }
  if (code === 'provider_unavailable') assert.match(text(view.tree), /같은 요청만 다시/);
  view.close();
 }
});
test('uncertain approval cannot be duplicated or unlocked by a status read', async t => {
 const writes = []; let attempts = 0;
 const api = { async post(path, body, options) { writes.push({ path, body, options }); if (path === '/v1/schedule-calls') return { call: base };
  attempts++; if (attempts === 1) throw new ApiError('timeout', 'timeout', true); return { call: { ...base, revision: 3, status: 'submitted' } }; },
  async get() { return { call: { ...base, revision: 3, status: 'submitted' } }; } };
 const view = setup(api); t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 press(view, '승인하고 전화'); await view.settle(); assert.equal(writes.length, 2); press(view, '저장된 전화 상태 조회'); await view.settle();
 assert.match(text(view.tree), /이전 요청의 결과를 확인할 때까지/); assert.equal(writes.length, 2);
 assert.equal(nodes(view.tree).find(n => n.props?.accessibilityLabel === '승인하고 전화').props.disabled, true);
 press(view, '같은 요청 다시 시도'); await view.settle(); assert.deepEqual(writes[1], writes[2]); assert.match(text(view.tree), /전화 요청 접수/);
});
test('no inferred location means only rejection is offered', async t => {
 const responses = [base, { ...base, revision: 3, status: 'submitted' }, { ...base, revision: 4, status: 'completed', transcript },
  { ...base, revision: 5, status: 'review_pending', transcript, reviewNote: '장소 확인 불가' }, { ...base, revision: 6, status: 'rejected', transcript }];
 const api = { async post() { return { call: responses.shift() }; }, async get() {} };
 const view = setup(api); t.after(view.close); enterNumber(view);
 for (const label of ['전화 내용 확인', '승인하고 전화', '통화 결과 확인', '장소 정정 검토']) { press(view, label); await view.settle(); }
 assert.match(text(view.tree), /변경할 장소가 확인되지 않았습니다/); assert.ok(!nodes(view.tree).some(n => n.props?.accessibilityLabel === '장소 변경 승인'));
 press(view, '변경 거절'); await view.settle(); assert.match(text(view.tree), /변경 거절됨/);
});
test('a rejected approval requires an authoritative status read before a new action', async t => {
 const writes = []; let finished = 0;
 const api = { async post(path) { writes.push(path); if (path === '/v1/schedule-calls') return { call: base }; throw new ApiError('conflict', 'conflict', false, 409); },
  async get() { return { call: { ...base, revision: 2, status: 'dispatching' } }; } };
 const view = setup(api, { onFinish() { finished++; } }); t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 press(view, '승인하고 전화'); await view.settle();
 assert.equal(nodes(view.tree).find(n => n.props?.accessibilityLabel === '오류 닫기').props.disabled, true);
 assert.equal(nodes(view.tree).find(n => n.props?.accessibilityLabel === '이 전화 요청 닫기').props.disabled, true);
 press(view, '저장된 전화 상태 조회'); await view.settle(); press(view, '오류 닫기');
 assert.match(text(view.tree), /발신 요청 중/); assert.equal(finished, 0); assert.equal(writes.length, 2);
});
test('server question can include a maximum-length title and previous location', async t => {
 const question = `${'장'.repeat(2000)} ${'소'.repeat(2000)} 맞나요?`;
 const api = { async post() { return { call: { ...base, title: '장'.repeat(2000), question } }; }, async get() {} };
 const view = setup(api); t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 assert.ok(nodes(view.tree).some(n => n.props?.accessibilityLabel === '승인하고 전화'));
});
test('a response for a different phone target is rejected before approval', async t => {
 const api = { async post() { return { call: { ...base, toNumber: '+821099999999' } }; }, async get() {} };
 const view = setup(api); t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 assert.match(text(view.tree), /요청 결과를 확인하지 못했습니다/);
 assert.ok(!nodes(view.tree).some(n => n.props?.accessibilityLabel === '승인하고 전화'));
});
test('selected Google contact only fills a number; sending still needs separate approval', async t => {
 const writes = []; const api = { async get(path) { assert.match(path, /^\/v1\/contacts\/google\/search\?/); return { contacts: [{ id: 'contact-0', displayName: '친구', phoneNumbers: [{ number: '010-1234-5678' }] }], truncated: false }; },
  async post(path, body) { writes.push({ path, body }); return { call: base }; } };
 const view = setup(api); t.after(view.close); press(view, '연락처에서 선택'); press(view, 'Google 연락처'); input(view, '연락처 이름 검색', '친구'); press(view, '이름 검색'); await view.settle();
 press(view, '친구 · 전화 · 010-1234-5678'); assert.equal(input(view, '받는 전화번호'), '+821012345678'); assert.equal(writes.length, 0);
 press(view, '전화 내용 확인'); await view.settle(); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/v1/schedule-calls');
 assert.match(text(view.tree), /선택한 상대: 친구/); assert.ok(nodes(view.tree).some(n => n.props?.accessibilityLabel === '승인하고 전화'));
});
test('search failure permits manual input and explicit selection of one of multiple numbers never dispatches', async t => {
 const writes = []; let searches = 0;
 const api = { async get() { searches++; if (searches === 1) throw new ApiError('provider_unavailable', 'internal', true, 503);
   return { contacts: [{ id: 'contact-0', displayName: '친구', phoneNumbers: [
     { label: '휴대폰', number: '010-1111-2222' }, { label: '직장', number: '010-9876-5432' },
   ] }], truncated: false }; },
  async post(path, body) { writes.push({ path, body }); return { call: { ...base, toNumber: body.toNumber } }; } };
 const view = setup(api); t.after(view.close);
 press(view, '연락처에서 선택'); press(view, 'Google 연락처'); input(view, '연락처 이름 검색', '친구'); press(view, '이름 검색'); await view.settle();
 assert.match(text(view.tree), /검색하지 못했습니다/); assert.doesNotMatch(text(view.tree), /internal/);
 press(view, '연락처 선택 취소'); input(view, '받는 전화번호', '01012345678'); assert.equal(writes.length, 0);
 press(view, '전화 내용 확인'); await view.settle(); assert.equal(writes.length, 1);
 assert.equal(writes[0].body.toNumber, '+821012345678'); assert.ok(!writes.some(write => write.path.endsWith('/approve')));
 view.close();
 const selectedView = setup(api); t.after(selectedView.close);
 press(selectedView, '연락처에서 선택'); press(selectedView, 'Google 연락처'); input(selectedView, '연락처 이름 검색', '친구'); press(selectedView, '이름 검색'); await selectedView.settle();
 assert.ok(nodes(selectedView.tree).some(n => n.props?.accessibilityLabel === '친구 · 휴대폰 · 010-1111-2222'));
 assert.ok(nodes(selectedView.tree).some(n => n.props?.accessibilityLabel === '친구 · 직장 · 010-9876-5432'));
 assert.equal(input(selectedView, '받는 전화번호'), ''); assert.equal(writes.length, 1);
 press(selectedView, '친구 · 직장 · 010-9876-5432'); assert.equal(input(selectedView, '받는 전화번호'), '+821098765432'); assert.equal(writes.length, 1);
 press(selectedView, '전화 내용 확인'); await selectedView.settle();
 assert.equal(writes.length, 2); assert.equal(writes[1].path, '/v1/schedule-calls'); assert.equal(writes[1].body.toNumber, '+821098765432');
 assert.match(text(selectedView.tree), /선택한 상대: 친구/); assert.match(text(selectedView.tree), /받는 번호: \+821098765432/);
 assert.ok(nodes(selectedView.tree).some(n => n.props?.accessibilityLabel === '승인하고 전화'));
 assert.ok(!writes.some(write => write.path.endsWith('/approve')));
});

test('general inquiry confirms server-stored question and number before approval and only shows transcript', async t => {
 const writes = []; let refreshed = 0;
 const saved = { id: 'inquiry-1', revision: 1, status: 'pending', mode: 'inquiry', brief: '영업시간을 알려 주세요', question: '영업시간을 알려 주세요', toNumber: '+821012345678' };
 const api = { async post(path, body, options) { writes.push({ path, body, options });
   if (path === '/v1/schedule-calls') return { call: saved };
   if (path.endsWith('/approve')) return { call: { ...saved, revision: 2, status: 'submitted' } };
   if (path.endsWith('/check')) return { call: { ...saved, revision: 3, status: 'completed', transcript: [{ role: 'user', text: '오후 여섯 시입니다' }] } };
   throw Error('unexpected write'); }, async get() { throw Error('unexpected read'); } };
 const view = render(ScheduleCallPanel, { api, mode: 'inquiry', brief: '영업시간을 알려 주세요', onClose() {}, onFinish() {}, onScheduleChanged() { refreshed++; }, onOpenPhoneSettings() {} });
 t.after(view.close); enterNumber(view); assert.equal(input(view, '문의 내용'), saved.brief);
 press(view, '전화 내용 확인'); await view.settle();
 assert.equal(writes.length, 1); assert.equal(writes[0].body.mode, 'inquiry'); assert.equal(writes[0].body.brief, saved.brief);
 assert.equal(writes[0].body.itemId, undefined); assert.match(text(view.tree), /받는 번호: \+821012345678/); assert.match(text(view.tree), /문의 내용: 영업시간을 알려 주세요/);
 assert.equal(writes.some(write => write.path.endsWith('/approve')), false);
 press(view, '승인하고 전화'); await view.settle(); press(view, '통화 결과 확인'); await view.settle();
 assert.match(text(view.tree), /상대방: 오후 여섯 시입니다/); assert.equal(refreshed, 0);
 assert.ok(!nodes(view.tree).some(node => ['장소 정정 검토', '장소 변경 승인'].includes(node.props?.accessibilityLabel)));
});

test('editing a pending inquiry creates a new confirmation and never approves the old subject', async t => {
 const writes = [];
 const api = { async post(path, body, options) { writes.push({ path, body, options });
   assert.equal(path, '/v1/schedule-calls'); return { call: { id: `inquiry-${writes.length}`, revision: 1, status: 'pending', mode: 'inquiry',
     brief: body.brief, question: body.brief, toNumber: body.toNumber } }; }, async get() {} };
 const view = render(ScheduleCallPanel, { api, mode: 'inquiry', brief: '원래 문의', onClose() {}, onFinish() {}, onScheduleChanged() {}, onOpenPhoneSettings() {} });
 t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
 press(view, '번호 또는 문의 내용 수정'); input(view, '문의 내용', '변경한 문의'); input(view, '받는 전화번호', '01098765432');
 assert.equal(writes.length, 1); assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '승인하고 전화'));
 press(view, '전화 내용 확인'); await view.settle(); assert.equal(writes.length, 2);
 assert.notEqual(writes[0].options.idempotencyKey, writes[1].options.idempotencyKey);
 assert.equal(writes[1].body.brief, '변경한 문의'); assert.equal(writes[1].body.toNumber, '+821098765432');
 assert.match(text(view.tree), /문의 내용: 변경한 문의/); assert.ok(!writes.some(write => write.path.endsWith('/approve')));
});

test('mismatched inquiry question or recipient is never approved', async t => {
 for (const changed of [{ question: '다른 문의' }, { toNumber: '+821099999999' }, { brief: '다른 문의' }]) {
  const api = { async post() { return { call: { id: 'inquiry', revision: 1, status: 'pending', mode: 'inquiry', brief: '문의', question: '문의', toNumber: '+821012345678', ...changed } }; }, async get() {} };
  const view = render(ScheduleCallPanel, { api, mode: 'inquiry', brief: '문의', onClose() {}, onFinish() {}, onScheduleChanged() {}, onOpenPhoneSettings() {} });
  enterNumber(view); press(view, '전화 내용 확인'); await view.settle();
  assert.match(text(view.tree), /요청 결과를 확인하지 못했습니다/); assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '승인하고 전화')); view.close();
 }
});

test('uncertain inquiry approval retries the same intent and cannot create another request', async t => {
 const writes = []; const saved = { id: 'inquiry', revision: 1, status: 'pending', mode: 'inquiry', brief: '문의', question: '문의', toNumber: '+821012345678' };
 const api = { async post(path, body, options) { writes.push({ path, body, options });
   if (path === '/v1/schedule-calls') return { call: saved };
   if (writes.length === 2) throw new ApiError('timeout', 'timeout', true);
   return { call: { ...saved, revision: 2, status: 'submitted' } }; }, async get() { return { call: { ...saved, revision: 2, status: 'submitted' } }; } };
 const view = render(ScheduleCallPanel, { api, mode: 'inquiry', brief: '문의', onClose() {}, onFinish() {}, onScheduleChanged() {}, onOpenPhoneSettings() {} });
 t.after(view.close); enterNumber(view); press(view, '전화 내용 확인'); await view.settle(); press(view, '승인하고 전화'); await view.settle();
 assert.equal(nodes(view.tree).find(node => node.props?.accessibilityLabel === '번호 또는 문의 내용 수정').props.disabled, true);
 press(view, '저장된 전화 상태 조회'); await view.settle(); assert.equal(writes.length, 2);
 press(view, '같은 요청 다시 시도'); await view.settle(); assert.deepEqual(writes[1], writes[2]); assert.match(text(view.tree), /전화 요청 접수/);
});

test('inquiry disallows control characters and unpaired surrogates before creating a request', async t => {
 let writes = 0; const api = { async post() { writes++; throw Error('unexpected'); }, async get() {} };
 const view = render(ScheduleCallPanel, { api, mode: 'inquiry', brief: '문의', onClose() {}, onFinish() {}, onScheduleChanged() {}, onOpenPhoneSettings() {} });
 t.after(view.close); enterNumber(view);
 for (const bad of [' ', 'x'.repeat(1001), '문의\u202e추가', '\ud800', '문의\ufffe', '문의\uffff']) {
  input(view, '문의 내용', bad); assert.equal(nodes(view.tree).find(node => node.props?.accessibilityLabel === '전화 내용 확인').props.disabled, true);
 }
 assert.equal(writes, 0);
});
