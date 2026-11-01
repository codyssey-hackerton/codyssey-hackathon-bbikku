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
globalThis.__reminderHarness = { react, jsx, Fragment, native: { View: 'View', Pressable: 'Pressable', StyleSheet: { create: styles => styles } } };
const built = await build({ stdin: { contents: "export {default as ReminderCard} from './ReminderCard'; export {operationGuard} from '../api/operationGuard';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'mock-reminder', setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/adapter|.*ui\/(typography|ActionButton))$/ }, a => ({ path: a.path, namespace: 'host' }));
    b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react' ? 'module.exports=globalThis.__reminderHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__reminderHarness.native' : path === './adapter' ? 'exports.createReminderAdapter=()=>globalThis.__reminderAdapter' :
      path.endsWith('/typography') ? 'exports.Text="Text"' : path.endsWith('/ActionButton') ? 'exports.ActionButton=({label,onPress,disabled})=>globalThis.__reminderHarness.jsx("Pressable",{accessibilityLabel:label,onPress,disabled,children:label})' :
      'exports.jsx=exports.jsxs=globalThis.__reminderHarness.jsx;exports.Fragment=globalThis.__reminderHarness.Fragment' }));
  } }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { ReminderCard, operationGuard } = mod.exports;
function render(props) {
  const view = { props, dirty: true, effects: [], instances: new Map(), tree: null };
  function node(value, path, seen) {
    if (value == null || typeof value === 'boolean') return null; if (typeof value === 'string' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((v, i) => node(v, `${path}.${i}`, seen)); if (value.type === Fragment) return node(value.props.children, `${path}.f`, seen);
    if (typeof value.type === 'function') { const id = `${path}:${value.type.name}:${value.key ?? ''}`; let instance = view.instances.get(id);
      if (!instance) { instance = { hooks: [], index: 0, alive: true, view }; view.instances.set(id, instance); }
      seen.add(id); instance.index = 0; const previous = current; current = instance; const output = value.type(value.props); current = previous; return node(output, `${id}.child`, seen); }
    return { type: value.type, props: value.props, children: node(value.props.children, `${path}.children`, seen) };
  }
  view.flush = () => { for (let i = 0; view.dirty && i < 40; i++) { view.dirty = false; view.effects = []; const seen = new Set(); view.tree = node(jsx(ReminderCard, view.props), 'root', seen);
    for (const [id, instance] of view.instances) if (!seen.has(id)) { instance.alive = false; for (const h of instance.hooks) h?.cleanup?.(); view.instances.delete(id); } for (const effect of view.effects) effect(); } if (view.dirty) throw Error('not settled'); };
  view.settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); view.flush(); } };
  view.update = props => { view.props = props; view.dirty = true; view.flush(); };
  view.close = () => { for (const instance of view.instances.values()) { instance.alive = false; for (const h of instance.hooks) h?.cleanup?.(); } };
  view.flush(); return view;
}
function nodes(v) { if (!v || typeof v !== 'object') return []; if (Array.isArray(v)) return v.flatMap(nodes); return [v, ...nodes(v.children)]; }
function text(v) { if (v == null) return ''; if (typeof v === 'string' || typeof v === 'number') return String(v); if (Array.isArray(v)) return v.map(text).join(''); return text(v.children); }
function button(view, label) { return nodes(view.tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label); }
function press(view, label) { const n = button(view, label); assert.ok(n, label); assert.notEqual(n.props.disabled, true); n.props.onPress(); view.flush(); }
function confirmDestination(view) { const n = nodes(view.tree).find(value => value.props?.accessibilityRole === 'checkbox'); assert.ok(n); assert.notEqual(n.props.disabled, true); n.props.onPress(); view.flush(); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const reminder = { itemId: 'item', expectedRevision: 2, title: '친구 약속', appointmentAt: '2099-11-02T03:00:00Z', appointmentEndsAt: '2099-11-02T04:00:00Z',
  timezone: 'Asia/Seoul', basis: 'departure', minutesBefore: 10, reminderAt: '2099-11-02T02:20:00Z', expiresAt: '2099-11-01T00:00:00Z',
  appointmentLocation: '서울역', departureAt: '2099-11-02T02:30:00Z',
  travel: { mode: 'car', durationMinutes: 30, provider: 'kakao', basis: 'current_time', destinationName: '부산역', destinationAddress: '부산로 1' } };
const item = { id: 'item', revision: 2, kind: 'event', title: '친구 약속', timeSlot: { startsAt: reminder.appointmentAt, endsAt: reminder.appointmentEndsAt, timezone: reminder.timezone },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', location: '서울역', sourceRefs: [] };
function setup(options = {}) {
  const calls = []; let requestCount = 0;
  globalThis.__reminderAdapter = { getPermission: async () => options.initial ?? 'undetermined', requestPermission: async () => { calls.push('permission'); return options.access ?? 'granted'; },
    schedule: async (input, settings) => { calls.push({ input, settings }); return options.schedule ? options.schedule(input, settings) : { status: 'scheduled', identifier: 'own', delivery: 'device' }; },
    cancel: async id => { calls.push({ cancel: id }); return options.cancel ? options.cancel(id) : { status: 'cancelled' }; } };
  const api = { async get(path) { requestCount++; calls.push(path); return { items: [options.item ?? item], scheduleRevision: 1 }; }, async post() { assert.fail('unexpected write'); } };
  const props = { api, reminder, scope: 'member' }; const view = render({ ...props, ...options.props });
  return { view, calls, props, count: () => requestCount };
}

test('web and missing member never request permission or schedule', async t => {
  const web = setup({ initial: 'not_supported' }); await web.view.settle(); assert.match(text(web.view.tree), /설치형 앱이 필요/);
  assert.equal(button(web.view, '알림 설정'), undefined); assert.deepEqual(web.calls, []); web.view.close();
  const missing = setup({ props: { scope: undefined } }); t.after(missing.view.close); await missing.view.settle();
  assert.match(text(missing.view.tree), /정식 로그인이 필요/); assert.equal(button(missing.view, '알림 설정').props.disabled, true);
});

test('reminder times display in the device timezone rather than the appointment timezone', async t => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = setup(); t.after(f.view.close); await f.view.settle();
  const format = options => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', ...options }).format(new Date(reminder.reminderAt));
  assert.notEqual(format({}), format({ timeZone: reminder.timezone }));
  assert.match(text(f.view.tree), new RegExp(`알림 시각: ${format({}).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(text(f.view.tree), /GMT/);
});

test('button requests permission once, rechecks the original item and does not double schedule', async t => {
  const gate = deferred(), f = setup({ schedule: () => gate.promise }); t.after(f.view.close); await f.view.settle();
  assert.deepEqual(f.calls, []); assert.equal(button(f.view, '알림 설정').props.disabled, true);
  assert.equal(nodes(f.view.tree).find(value => value.props?.accessibilityRole === 'checkbox').props.accessibilityState.checked, false);
  confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(f.count(), 1);
  assert.equal(f.calls.filter(value => typeof value === 'object' && value.input).length, 1);
  assert.equal(f.calls.find(value => value?.input).settings.validUntil, reminder.expiresAt);
  assert.equal(f.calls.find(value => value?.input).input.title, '일정 알림');
  assert.doesNotMatch(JSON.stringify(f.calls.find(value => value?.input).input), /친구 약속/);
  assert.match(text(f.view.tree), /실제 이동시간은 달라질 수/);
  assert.match(text(f.view.tree), /일정의 원래 장소: 서울역/); assert.match(text(f.view.tree), /도착지: 부산역 · 부산로 1/);
  assert.equal(button(f.view, '알림 처리 중').props.disabled, true);
  gate.resolve({ status: 'scheduled', identifier: 'own', delivery: 'device' }); await f.view.settle();
  assert.equal(operationGuard.hasUnresolved(), false); assert.equal(button(f.view, '알림 설정됨').props.disabled, true);
  press(f.view, '알림 취소'); await f.view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(f.calls.find(value => value?.cancel)?.cancel, JSON.stringify(['member', 'item', 'departure']));
});

test('denied permission or changed revision cannot schedule', async t => {
  const denied = setup({ access: 'denied' }); await denied.view.settle(); confirmDestination(denied.view); press(denied.view, '알림 설정'); await denied.view.settle();
  assert.equal(denied.count(), 0); assert.equal(operationGuard.hasUnresolved(), false); denied.view.close();
  const changed = setup({ item: { ...item, revision: 3 } }); t.after(changed.view.close); await changed.view.settle();
  confirmDestination(changed.view); press(changed.view, '알림 설정'); await changed.view.settle(); assert.match(text(changed.view.tree), /일정이 바뀌었거나/);
  assert.equal(changed.calls.filter(value => typeof value === 'object' && value.input).length, 0); assert.equal(operationGuard.hasUnresolved(), false);
});

test('unknown scheduling outcome retains guard until explicit cancellation', async t => {
  let cancellation = 0;
  const f = setup({ schedule: async () => ({ status: 'error' }), cancel: async () => ({ status: ++cancellation === 1 ? 'error' : 'cancelled' }) }); t.after(f.view.close); await f.view.settle();
  confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  assert.match(text(f.view.tree), /예약 결과를 확인하지 못했습니다/); assert.equal(button(f.view, '알림 설정').props.disabled, true);
  press(f.view, '알림 취소'); await f.view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  press(f.view, '알림 취소'); await f.view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
});

test('a new scope cannot cancel an already scheduled old-scope reminder', async t => {
  const f = setup(); t.after(f.view.close); await f.view.settle(); confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle();
  assert.ok(button(f.view, '알림 취소')); f.view.update({ ...f.props, scope: 'other' }); await f.view.settle();
  assert.equal(button(f.view, '알림 취소'), undefined); assert.equal(f.calls.filter(value => value?.cancel).length, 0);
  f.view.update(f.props); await f.view.settle(); press(f.view, '알림 취소'); await f.view.settle();
});

test('a legacy departure without a confirmed destination cannot be scheduled', async t => {
  const legacy = { ...reminder, travel: { ...reminder.travel, destinationAddress: '' } };
  const f = setup({ props: { reminder: legacy } }); t.after(f.view.close); await f.view.settle();
  assert.match(text(f.view.tree), /도착지 정보를 확인할 수 없습니다/); assert.equal(button(f.view, '알림 설정').props.disabled, true);
  assert.deepEqual(f.calls, []);
});

test('a changed original location blocks scheduling even at the same revision', async t => {
  const f = setup({ item: { ...item, location: '다른 장소' } }); t.after(f.view.close); await f.view.settle();
  confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle();
  assert.match(text(f.view.tree), /일정이 바뀌었거나/); assert.equal(f.calls.filter(value => value?.input).length, 0);
  assert.equal(operationGuard.hasUnresolved(), false);
});

test('expiry during schedule lookup stops before native scheduling', async t => {
  let now = Date.parse('2098-01-01T00:00:00Z'); t.mock.method(Date, 'now', () => now);
  const gate = deferred(), f = setup(); t.after(f.view.close);
  f.props.api.get = async () => gate.promise; await f.view.settle();
  confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); now = Date.parse(reminder.expiresAt);
  gate.resolve({ items: [item], scheduleRevision: 1 }); await f.view.settle();
  assert.match(text(f.view.tree), /제안이 만료/); assert.equal(f.calls.filter(value => value?.input).length, 0);
  assert.equal(operationGuard.hasUnresolved(), false);
});

test('event-start reminders need no destination confirmation', async t => {
  const event = { ...reminder, basis: 'event_start', reminderAt: '2099-11-02T02:50:00Z', travel: undefined, departureAt: undefined };
  const f = setup({ props: { reminder: event } }); t.after(f.view.close); await f.view.settle();
  assert.equal(nodes(f.view.tree).some(value => value.props?.accessibilityRole === 'checkbox'), false);
  press(f.view, '알림 설정'); await f.view.settle(); assert.ok(button(f.view, '알림 설정됨'));
  press(f.view, '알림 취소'); await f.view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
});

test('cards for the same reminder share the existing schedule and cancellation', async t => {
  const a = setup(); const b = setup({ props: { reminder: { ...reminder, reminderAt: '2099-11-02T02:10:00Z' } } });
  t.after(() => { a.view.close(); b.view.close(); }); await a.view.settle(); await b.view.settle();
  confirmDestination(a.view); press(a.view, '알림 설정'); await a.view.settle(); await b.view.settle();
  assert.equal(button(a.view, '알림 설정됨').props.disabled, true); assert.equal(button(b.view, '기존 알림 있음').props.disabled, true);
  assert.match(text(b.view.tree), /기존 알림이 있습니다/); assert.equal(b.calls.filter(value => value?.input).length, 0);
  press(b.view, '기존 알림 취소'); await b.view.settle(); await a.view.settle();
  assert.equal(button(a.view, '알림 취소'), undefined); assert.equal(button(a.view, '알림 설정').props.disabled, false);
  assert.equal(operationGuard.hasUnresolved(), false);
});

test('concurrent cancellation from two cards stays guarded and executes only once', async t => {
  const gate = deferred(), a = setup({ cancel: () => gate.promise }), b = setup();
  t.after(() => { a.view.close(); b.view.close(); }); await a.view.settle(); await b.view.settle();
  confirmDestination(a.view); press(a.view, '알림 설정'); await a.view.settle(); await b.view.settle();
  const stale = button(b.view, '알림 취소'); assert.ok(stale); press(a.view, '알림 취소'); await b.view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(b.view, '알림 처리 중').props.disabled, true);
  stale.props.onPress(); await b.view.settle(); assert.equal(b.calls.filter(value => value?.cancel).length, 0);
  gate.resolve({ status: 'cancelled' }); await a.view.settle(); await b.view.settle();
  assert.equal(operationGuard.hasUnresolved(), false); assert.equal(button(b.view, '알림 취소'), undefined);
});

test('connection change aborts late scheduling and cancels only the original reminder', async t => {
  const gate = deferred(), f = setup({ schedule: () => gate.promise }); t.after(f.view.close); await f.view.settle();
  confirmDestination(f.view); press(f.view, '알림 설정'); await f.view.settle(); const operation = f.calls.find(value => value?.input); assert.equal(operationGuard.hasUnresolved(), true);
  f.view.update({ ...f.props, scope: 'other' }); assert.equal(operation.settings.signal.aborted, true);
  gate.resolve({ status: 'scheduled', identifier: 'own', delivery: 'device' }); await f.view.settle();
  assert.equal(f.calls.find(value => value?.cancel)?.cancel, JSON.stringify(['member', 'item', 'departure']));
  assert.equal(operationGuard.hasUnresolved(), false); assert.doesNotMatch(text(f.view.tree), /이 기기에 알림을 예약했습니다/);
});
