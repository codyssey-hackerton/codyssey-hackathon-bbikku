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
globalThis.__profilePanelHarness = { react, jsx, Fragment, native: { View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', Switch: 'Switch', StyleSheet: { create: styles => styles } } };
const built = await build({ stdin: { contents: "export {usePlanningProfile} from './usePlanningProfile'; export {OnboardingPanel} from './OnboardingPanel'; export {ProfilePanel} from './ProfilePanel'; export {ApiError} from '../api/http'; export {DailyReviewNotifications} from '../review/DailyReviewNotifications'; export {operationGuard} from '../api/operationGuard';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
 plugins: [{ name: 'host', setup(b) { b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*notifications\/adapter|.*ui\/(typography|ActionButton|PikkuCharacter|ProfileAvatar|Icon|DateTimeFields))$/ }, a => ({ path: a.path, namespace: 'host' }));
  b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react' ? 'module.exports=globalThis.__profilePanelHarness.react' :
   path === 'react-native' ? 'module.exports=globalThis.__profilePanelHarness.native' : path.endsWith('/notifications/adapter') ? 'exports.createReminderAdapter=()=>globalThis.__reviewNotificationAdapter || {requestPermission:async()=>"not_supported"}' : path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
   path.endsWith('/ActionButton') ? 'exports.ActionButton=({label,onPress,disabled})=>globalThis.__profilePanelHarness.jsx("Pressable",{accessibilityLabel:label,onPress,disabled,children:label})' :
   path.endsWith('/PikkuCharacter') ? 'exports.PikkuCharacter=()=>null' : path.endsWith('/ProfileAvatar') ? 'exports.ProfileAvatar=()=>null' : path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
   path.endsWith('/DateTimeFields') ? 'exports.DateTimeFields=({label,value,onChange,disabled})=>globalThis.__profilePanelHarness.jsx("Time",{label,value,onChange,disabled})' :
   'exports.jsx=exports.jsxs=globalThis.__profilePanelHarness.jsx;exports.Fragment=globalThis.__profilePanelHarness.Fragment' })); } }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { usePlanningProfile, OnboardingPanel, ProfilePanel, ApiError, DailyReviewNotifications, operationGuard } = mod.exports;
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
const fact = value => ({ id: 'f', revision: 1, kind: 'preference', key: 'planning_preferences', value, source: { type: 'user', ref: 'a' }, recordedAt: '2026-11-01T00:00:00Z', validUntil: null });
function root({ api, onComplete, reviewApi, deviceTimezone, scope }) { const profile = usePlanningProfile(api); return jsx(OnboardingPanel, { profile, onComplete, reviewApi, deviceTimezone, scope }); }
test('review onboarding saves the explicit new defaults and can be skipped without writing', async t => {
 let completed = 0; const writes = [];
 const api = { async get() { return { facts: [], contextRevision: 2 }; }, async post(path, body) { return { fact: fact(body.value), contextRevision: 3 }; } };
 const reviewApi = { async get() { return { reviewSchedule: { revision: 0, timezone: 'UTC', morning: { enabled: false, localTime: null }, evening: { enabled: false, localTime: null } } }; },
   async post(path, body) { writes.push(body); return { reviewSchedule: { ...body, revision: body.expectedRevision + 1 } }; } };
 const view = render(root, { api, reviewApi, deviceTimezone: 'Asia/Seoul', scope: 'member', onComplete: () => completed++ }); t.after(view.close); await view.settle();
 press(view, '다음'); press(view, '저장하고 완료'); await view.settle();
 assert.equal(writes.length, 0); assert.equal(completed, 0);
 press(view, '시간 저장'); await view.settle();
 assert.equal(writes.length, 1); assert.equal(writes[0].timezone, 'Asia/Seoul');
 assert.deepEqual(writes[0].morning, { enabled: true, localTime: '09:00' }); assert.deepEqual(writes[0].evening, { enabled: true, localTime: '21:00' });
 assert.match(text(view.tree), /이 기기의 알림/); press(view, '시작하기'); assert.equal(completed, 1);
 const skip = render(root, { api, reviewApi, deviceTimezone: 'Asia/Seoul', onComplete: () => completed++ }); t.after(skip.close); await skip.settle();
 press(skip, '다음'); press(skip, '저장하고 완료'); await skip.settle(); press(skip, '나중에 설정');
 assert.equal(completed, 2); assert.equal(writes.length, 1);
});

test('review onboarding preserves existing schedule until explicitly changed', async t => {
 const api = { async get() { return { facts: [], contextRevision: 2 }; }, async post(path, body) { return { fact: fact(body.value), contextRevision: 3 }; } };
 const existing = { revision: 5, timezone: 'America/New_York', morning: { enabled: true, localTime: '07:00' }, evening: { enabled: false, localTime: null } }; let written;
 const reviewApi = { async get() { return { reviewSchedule: existing }; }, async post(path, body) { written = body; return { reviewSchedule: { ...body, revision: 6 } }; } };
 const view = render(root, { api, reviewApi, deviceTimezone: 'Asia/Seoul', onComplete() {} }); t.after(view.close); await view.settle();
 press(view, '다음'); press(view, '저장하고 완료'); await view.settle(); press(view, '시간 저장'); await view.settle();
 assert.equal(written.expectedRevision, 5); assert.equal(written.timezone, existing.timezone); assert.deepEqual(written.morning, existing.morning); assert.deepEqual(written.evening, existing.evening);
});

test('onboarding requests device permission only on explicit connection and uses saved times', async t => {
 const calls = []; globalThis.__reviewNotificationAdapter = {
   async requestPermission() { calls.push('permission'); return 'granted'; },
   async scheduleDaily(input) { calls.push(input); return { status: 'scheduled', identifier: input.id, delivery: 'device' }; },
   async cancel(id) { calls.push({ cancel: id }); return { status: 'cancelled' }; },
 }; t.after(() => { delete globalThis.__reviewNotificationAdapter; });
 const api = { async get() { return { facts: [], contextRevision: 2 }; }, async post(path, body) { return { fact: fact(body.value), contextRevision: 3 }; } };
 const reviewApi = { async get() { return { reviewSchedule: { revision: 0, timezone: 'UTC', morning: { enabled: false, localTime: null }, evening: { enabled: false, localTime: null } } }; },
   async post(path, body) { return { reviewSchedule: { ...body, revision: 1 } }; } };
 const view = render(root, { api, reviewApi, deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, scope: 'member', onComplete() {} }); t.after(view.close); await view.settle();
 press(view, '다음'); press(view, '저장하고 완료'); await view.settle(); press(view, '시간 저장'); await view.settle();
 assert.deepEqual(calls, []); press(view, '이 기기에 알림 설정'); await view.settle();
 assert.equal(calls[0], 'permission'); assert.deepEqual(calls.slice(1).map(call => call.localTime), ['09:00', '21:00']);
 assert.match(text(view.tree), /이 기기의 알림 설정을 적용/);
});

test('unmount and failed cancellation retain a scope-bound guard until explicit recovery', async t => {
 let release, count = 0, cancellations = 0; const gate = new Promise(resolve => { release = resolve; });
 globalThis.__reviewNotificationAdapter = {
   async requestPermission() { return 'granted'; },
   async scheduleDaily() { count++; await gate; return { status: 'error' }; },
   async cancel() { cancellations++; return { status: cancellations === 1 ? 'error' : 'cancelled' }; },
 }; t.after(() => { delete globalThis.__reviewNotificationAdapter; });
 const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
 const schedule = { revision: 1, timezone, morning: { enabled: true, localTime: '09:00' }, evening: { enabled: true, localTime: '21:00' } };
 const original = render(DailyReviewNotifications, { schedule, deviceTimezone: timezone, scope: 'owner-a' });
 press(original, '이 기기에 알림 설정'); await original.settle(); assert.equal(count, 1); assert.equal(operationGuard.hasUnresolved(), true);
 original.close(); release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
 assert.equal(operationGuard.hasUnresolved(), true); assert.equal(cancellations, 1);
 const other = render(DailyReviewNotifications, { schedule, deviceTimezone: timezone, scope: 'owner-b' }); t.after(other.close);
 press(other, '이 기기에 알림 설정'); await other.settle(); assert.equal(count, 1);
 const reopened = render(DailyReviewNotifications, { deviceTimezone: timezone, scope: 'owner-a' }); t.after(reopened.close);
 assert.match(text(reopened.tree), /아침 알림 결과를 확인하지 못했습니다/);
 press(reopened, '아침 알림 취소 확인'); await reopened.settle();
 assert.equal(cancellations, 2); assert.equal(operationGuard.hasUnresolved(), false);
});
test('onboarding saves selected inputs only and completion follows explicit success', async t => {
 let finish, completed = 0, sent;
 const api = { async get() { return { facts: [], contextRevision: 2 }; }, post(path, body) { sent = body; return new Promise(resolve => { finish = resolve; }); } };
 const view = render(root, { api, onComplete: () => completed++ }); t.after(view.close); await view.settle();
 assert.match(text(view.tree), /1 \/ 2/); press(view, '운동·건강건강한 루틴 이어가기'); press(view, '다음');
 assert.match(text(view.tree), /2 \/ 2/); assert.doesNotMatch(text(view.tree), /준비시간|이동시간|여유시간/);
 press(view, '오전이 편해요'); press(view, '저장하고 완료'); await view.settle();
 assert.equal(completed, 0); assert.deepEqual(sent.value.goals, ['health']); assert.deepEqual(sent.value.timing, { preparationMinutes: null, travelEstimateMinutes: null, bufferMinutes: null }); assert.equal(sent.value.preferredPeriod, 'morning');
 finish({ fact: fact(sent.value), contextRevision: 3 }); await view.settle(); assert.match(text(view.tree), /준비가 끝났어요/); assert.equal(completed, 0);
 press(view, '시작하기'); assert.equal(completed, 1);
});
test('skip does not complete after a timeout; successful retry retains the operation', async t => {
 let completed = 0, calls = [];
 const api = { async get() { return { facts: [], contextRevision: 2 }; }, async post(path, body, options) { calls.push({ body: structuredClone(body), options: structuredClone(options) });
  if (calls.length === 1) throw new ApiError('timeout', 'timeout', true); return { fact: fact(body.value), contextRevision: 3 }; } };
 const view = render(root, { api, onComplete: () => completed++ }); t.after(view.close); await view.settle();
 press(view, '운동·건강건강한 루틴 이어가기'); assert.match(text(view.tree), /지금까지 선택한 내용은 저장하지 않아요/);
 press(view, '설정은 모두 나중에'); await view.settle(); assert.deepEqual(calls[0].body.value.goals, []);
 assert.equal(completed, 0); assert.match(text(view.tree), /같은 요청으로 다시 확인/); press(view, '같은 요청 다시 확인'); await view.settle();
 assert.equal(completed, 1); assert.deepEqual(calls[0], calls[1]);
});
function profileRoot({ api, callbacks }) { const profile = usePlanningProfile(api); return jsx(ProfilePanel, { profile, member: { id: 'member', displayName: '실제 사용자', email: 'member@example.test' }, ...callbacks }); }
test('profile goal and period edits preserve existing timing and explicit member info', async t => {
 const initial = { version: 1, goals: ['work'], timing: { preparationMinutes: 0, travelEstimateMinutes: 22, bufferMinutes: null }, preferredPeriod: 'morning', onboardingStatus: 'completed' };
 let saved; const api = { async get() { return { facts: [fact(initial)], contextRevision: 7 }; }, async post(path, body) { saved = body; return { fact: fact(body.value), contextRevision: 8 }; } };
 const callbacks = { onBack() {}, onOpenGoogle() {}, onOpenReview() {}, onOpenAccount() {}, onOpenMemory() {} };
 const view = render(profileRoot, { api, callbacks }); t.after(view.close); await view.settle(); assert.match(text(view.tree), /실제 사용자/);
 assert.match(text(view.tree), /목표: 업무·공부 · 편한 시간대: 오전/);
 assert.doesNotMatch(text(view.tree), /준비시간|이동 예상시간|도착 여유시간/);
 press(view, '목표·활동 및 선호'); assert.equal(nodes(view.tree).find(node => node.props?.accessibilityLabel === '목표·활동 및 선호').props.accessibilityState.expanded, true);
 press(view, '생활 선호 수정'); press(view, '운동·건강건강한 루틴 이어가기'); press(view, '오후가 편해요'); press(view, '저장'); await view.settle();
 assert.deepEqual(saved.value, { ...initial, goals: ['work', 'health'], preferredPeriod: 'afternoon' }); assert.equal(saved.expectedContextRevision, 7);
 assert.match(text(view.tree), /내 프로필/);
});
test('optional time editor preserves null and zero, validates, and saves only explicit changes', async t => {
 const initial = { version: 1, goals: ['work'], timing: { preparationMinutes: 0, travelEstimateMinutes: 22, bufferMinutes: null }, preferredPeriod: 'morning', onboardingStatus: 'completed' };
 const writes = []; const api = { async get() { return { facts: [fact(initial)], contextRevision: 7 }; }, async post(path, body) { writes.push(body); return { fact: fact(body.value), contextRevision: 8 }; } };
 const callbacks = { onBack() {}, onOpenGoogle() {}, onOpenReview() {}, onOpenAccount() {}, onOpenMemory() {} };
 const view = render(profileRoot, { api, callbacks }); t.after(view.close); await view.settle();
 assert.doesNotMatch(text(view.tree), /저장된 시간 기준 수정/); press(view, '목표·활동 및 선호'); press(view, '생활 선호 수정');
 const toggle = nodes(view.tree).find(node => node.props?.accessibilityLabel === '저장된 시간 기준 수정');
 assert.equal(toggle.props.accessibilityState.expanded, false);
 assert.ok(!nodes(view.tree).some(node => node.type === 'TextInput')); press(view, '저장된 시간 기준 수정');
 assert.equal(nodes(view.tree).find(node => node.props?.accessibilityLabel === '저장된 시간 기준 수정').props.accessibilityState.expanded, true);
 assert.equal(input(view, '준비시간 분'), '0'); assert.equal(input(view, '이동 예상시간 분'), '22'); assert.equal(input(view, '도착 여유시간 분'), '');
 input(view, '도착 여유시간 분', '1441'); press(view, '저장'); assert.equal(writes.length, 0); assert.match(text(view.tree), /0부터 1440/);
 input(view, '준비시간 분', ''); input(view, '이동 예상시간 분', '0'); input(view, '도착 여유시간 분', '25');
 press(view, '저장된 시간 기준 수정'); press(view, '저장'); await view.settle();
 assert.equal(writes.length, 1); assert.equal(writes[0].expectedContextRevision, 7);
 assert.deepEqual(writes[0].value, { ...initial, timing: { preparationMinutes: null, travelEstimateMinutes: 0, bufferMinutes: 25 } });
});
test('onboarding completion retains previously saved timing exactly', async t => {
 const initial = { version: 1, goals: ['work'], timing: { preparationMinutes: 0, travelEstimateMinutes: 42, bufferMinutes: null }, preferredPeriod: null, onboardingStatus: 'skipped' };
 let saved; const api = { async get() { return { facts: [fact(initial)], contextRevision: 7 }; }, async post(path, body) { saved = body; return { fact: fact(body.value), contextRevision: 8 }; } };
 const view = render(root, { api, onComplete() {} }); t.after(view.close); await view.settle();
 press(view, '다음'); press(view, '오전이 편해요'); press(view, '저장하고 완료'); await view.settle();
 assert.deepEqual(saved.value.timing, initial.timing); assert.equal(saved.value.onboardingStatus, 'completed');
});
test('a failed profile load still permits returning to the previous screen', async t => {
 let back = 0; const api = { async get() { throw new ApiError('network', 'offline', true); } };
 const callbacks = { onBack() { back++; }, onOpenGoogle() {}, onOpenReview() {}, onOpenAccount() {}, onOpenMemory() {} };
 const view = render(profileRoot, { api, callbacks }); t.after(view.close); await view.settle();
 assert.match(text(view.tree), /설정을 확인할 수 없습니다/); press(view, '뒤로'); assert.equal(back, 1);
});
test('invalid stored profile shows a format warning and cannot be overwritten', async t => {
 let writes = 0; const api = { async get() { return { facts: [fact({ malformed: true })], contextRevision: 7 }; }, async post() { writes++; } };
 const view = render(root, { api, onComplete() {} }); t.after(view.close); await view.settle();
 assert.match(text(view.tree), /서버에 저장된 설정의 형식/); assert.match(text(view.tree), /덮어쓰지 않습니다/);
 const skip = nodes(view.tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === '설정은 모두 나중에');
 assert.equal(skip.props.disabled, true); assert.equal(writes, 0);
});
