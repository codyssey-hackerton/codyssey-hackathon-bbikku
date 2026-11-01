import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let current;
const fragment = Symbol('fragment');
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const slot = () => ({ instance: current, index: current.index++ });
const react = {
  useState(initial) { const { instance, index } = slot(); if (!instance.hooks[index]) {
    const state = { value: typeof initial === 'function' ? initial() : initial };
    state.set = next => { if (!instance.alive) return; const value = typeof next === 'function' ? next(state.value) : next;
      if (!Object.is(value, state.value)) { state.value = value; instance.view.dirty = true; } }; instance.hooks[index] = state;
  } const state = instance.hooks[index]; return [state.value, state.set]; },
  useRef(initial) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
  useMemo(fn, deps) { const { instance, index } = slot(); if (!instance.hooks[index] || !same(instance.hooks[index].deps, deps)) instance.hooks[index] = { deps, value: fn() }; return instance.hooks[index].value; },
  useEffect(fn, deps) { const { instance, index } = slot(); const effect = instance.hooks[index] ??= {};
    if (!same(effect.deps, deps)) { effect.deps = deps; instance.view.effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
};
const native = { Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', Text: 'Text', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: styles => styles }, AppState: { addEventListener: () => ({ remove() {} }) } };
globalThis.__dayScreenHarness = { react, native, jsx, fragment };
const built = await build({ stdin: { contents: `export {default as DayScreen} from './DayScreen'; export {default as HomeScreen} from './HomeScreen'; export {ChatScheduleSummary} from '../chat/ChatScheduleSummary'; export {ApiError} from '../api/http'; export {operationGuard} from '../api/operationGuard';`,
  resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  loader: { '.png': 'dataurl' }, plugins: [{ name: 'screen-host', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/(typography|ScheduleCard|BottomSheet|PastScheduleStack|Icon|ProfileAvatar)|.*\/(ScheduleForm|PreparationProposalPanel|ScheduleStatus))$/ }, args => ({ path: args.path, namespace: 'screen-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'screen-host' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'module.exports=globalThis.__dayScreenHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__dayScreenHarness.native' :
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path.endsWith('/ProfileAvatar') ? 'exports.ProfileAvatar=()=>null' :
      path.endsWith('/ScheduleForm') ? 'exports.ScheduleForm=()=>null' :
      path.endsWith('/PreparationProposalPanel') ? 'exports.default=()=>null' :
      path.endsWith('/ScheduleStatus') ? 'exports.ScheduleLoading=exports.ScheduleError=()=>null' :
      path.endsWith('/BottomSheet') ? 'exports.BottomSheet=({visible,children})=>visible?children:null' :
      path.endsWith('/PastScheduleStack') ? 'exports.PastScheduleStack=({front,children,expanded,onToggle})=>[front,globalThis.__dayScreenHarness.jsx("Pressable",{accessibilityLabel:"스택 펼치기",onPress:onToggle}),expanded?children:null]' :
      path.endsWith('/ScheduleCard') ? 'exports.ScheduleCard=({item,onStatus,onMore,onPress})=>[globalThis.__dayScreenHarness.jsx("Text",{children:item.title}),globalThis.__dayScreenHarness.jsx("Pressable",{accessibilityLabel:"상태:"+item.id,onPress:onStatus}),globalThis.__dayScreenHarness.jsx("Pressable",{accessibilityLabel:"더보기:"+item.id,onPress:onMore}),globalThis.__dayScreenHarness.jsx("Pressable",{accessibilityLabel:"상세:"+item.id,onPress})]' :
      'exports.jsx=exports.jsxs=globalThis.__dayScreenHarness.jsx;exports.Fragment=globalThis.__dayScreenHarness.fragment' }));
  } }] });
const compiled = { exports: {} }; new Function('module','exports',built.outputFiles[0].text)(compiled, compiled.exports);
const { DayScreen, HomeScreen, ChatScheduleSummary, ApiError, operationGuard } = compiled.exports;
function render(Component, initialProps) {
  const view = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
  function node(value, path, seen) {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'string' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((child, index) => node(child, `${path}.${index}`, seen));
    if (value.type === fragment) return node(value.props.children, `${path}.f`, seen);
    if (typeof value.type === 'function') {
      const id = `${path}:${value.type.name}:${value.key ?? ''}`; let instance = view.instances.get(id);
      if (!instance) { instance = { hooks: [], alive: true, view, index: 0 }; view.instances.set(id, instance); }
      seen.add(id); instance.index = 0; const old = current; current = instance; const output = value.type(value.props); current = old;
      return node(output, `${id}.child`, seen);
    }
    return { type: value.type, props: value.props, children: node(value.props.children, `${path}.children`, seen) };
  }
  view.flush = () => { for (let count = 0; view.dirty && count < 50; count++) {
    view.dirty = false; view.effects = []; const seen = new Set(); view.tree = node(jsx(Component, view.props), 'root', seen);
    for (const [id, instance] of view.instances) if (!seen.has(id)) { instance.alive = false; for (const hook of instance.hooks) hook?.cleanup?.(); view.instances.delete(id); }
    for (const effect of view.effects) effect();
  } if (view.dirty) throw new Error('render did not settle'); };
  view.settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(done => setImmediate(done)); view.flush(); } };
  view.update = props => { view.props = props; view.dirty = true; view.flush(); };
  view.unmount = () => { for (const instance of view.instances.values()) { instance.alive = false; for (const hook of instance.hooks) hook?.cleanup?.(); } view.instances.clear(); };
  view.flush(); return view;
}
function nodes(value) { if (!value || typeof value !== 'object') return []; if (Array.isArray(value)) return value.flatMap(nodes); return [value, ...nodes(value.children)]; }
function text(value) { if (value == null) return ''; if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(text).join(''); return text(value.children); }
function press(view, label) { const node = nodes(view.tree).find(item => item.type === 'Pressable' && (item.props.accessibilityLabel === label || text(item.children) === label));
  assert.ok(node, `missing ${label}`); assert.notEqual(node.props.disabled, true); node.props.onPress(); view.flush(); }
const slotTime = () => { const start = new Date(Date.now() - 60_000); const end = new Date(Date.now() + 3_600_000); return { startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: 'UTC' }; };
function item(id, kind, involvement = 'personal') { return { id, revision: 1, kind, title: id, timeSlot: slotTime(), durationMinutes: kind === 'task' ? 60 : null,
  deadline: null, flexibility: 'flexible', involvement, completion: 'pending', sourceRefs: [] }; }

test('all-day items show an all-day label in the timeline, detail and chat summary', async t => {
  const allDay = { ...item('종일 일정', 'event'), allDay: true, notes: '확인할 메모', timeSlot: { startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z', timezone: 'UTC' } };
  const client = { async list() { return { items: [allDay], scheduleRevision: 1 }; } };
  const date = new Date('2026-11-01T12:00:00Z');
  const day = render(DayScreen, { selectedDate: date, onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false });
  const summary = render(ChatScheduleSummary, { client, selectedDate: date, timezone: 'UTC', refreshVersion: 0 });
  t.after(() => { day.unmount(); summary.unmount(); }); await day.settle(); await summary.settle();
  assert.match(text(day.tree), /종일/); assert.doesNotMatch(text(day.tree), /다음 날 00:00/);
  assert.match(text(summary.tree), /종일/); assert.doesNotMatch(text(summary.tree), /00:00/);
  press(day, '상세:종일 일정'); assert.match(text(day.tree), /메모: 확인할 메모/); assert.doesNotMatch(text(day.tree), /다음 날 00:00/);
});

test('day week strip follows the reference Saturday start across month boundaries', t => {
  let selected;
  const props = { selectedDate: new Date('2026-11-01T12:00:00Z'), onSelectDate(value) { selected = value; },
    client: { async list() { return { items: [], scheduleRevision: 1 }; } }, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false };
  const view = render(DayScreen, props); t.after(() => view.unmount());
  const days = () => nodes(view.tree).filter(node => node.type === 'Pressable' && node.props.accessibilityState?.selected !== undefined);
  const expected = ['2026년 10월 31일 토요일', ...['일', '월', '화', '수', '목', '금'].map((day, index) => `2026년 11월 ${index + 1}일 ${day}요일`)];
  assert.deepEqual(days().map(node => node.props.accessibilityLabel), expected);
  assert.equal(days().findIndex(node => node.props.accessibilityState.selected), 1);
  view.update({ ...props, selectedDate: new Date('2026-11-02T12:00:00Z') });
  assert.deepEqual(days().map(node => node.props.accessibilityLabel), expected);
  assert.equal(days().findIndex(node => node.props.accessibilityState.selected), 2);
  press(view, expected[0]); assert.equal(selected.toISOString(), '2026-10-31T00:00:00.000Z');
  view.update({ ...props, selectedDate: new Date('2026-11-30T12:00:00Z') });
  assert.equal(days()[0].props.accessibilityLabel, '2026년 11월 28일 토요일');
  assert.equal(days()[6].props.accessibilityLabel, '2026년 12월 4일 금요일');
});

test('changing home filters closes the previous target without changing it', async t => {
  const personal = { ...item('personal', 'task'), category: 'personal' };
  const work = { ...item('work', 'task'), category: 'work' };
  let writes = 0;
  const client = { async list() { return { items: [personal, work], scheduleRevision: 1 }; }, async checkin() { writes++; } };
  const view = render(HomeScreen, { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: true });
  t.after(() => view.unmount()); await view.settle();
  press(view, '상태:personal'); assert.match(text(view.tree), /수행 상태를 선택해 주세요/);
  press(view, '업무'); assert.doesNotMatch(text(view.tree), /수행 상태를 선택해 주세요/);
  assert.equal(writes, 0); assert.doesNotMatch(text(view.tree), /personal/); assert.match(text(view.tree), /work/);
  press(view, '전체'); assert.doesNotMatch(text(view.tree), /수행 상태를 선택해 주세요/);
});

test('home profile button identifies the default illustration and opens settings', async t => {
  let opened = 0;
  const client = { async list() { return { items: [], scheduleRevision: 1 }; } };
  const view = render(HomeScreen, { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false, onOpenSettings() { opened++; } });
  t.after(() => view.unmount()); await view.settle();
  const button = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '설정 열기');
  assert.equal(button.props.accessibilityHint, '기본 프로필 그림'); press(view, '설정 열기'); assert.equal(opened, 1);
});

test('day add opens the draft chooser while another request is unresolved', async t => {
  let opened = 0; const owner = {};
  const client = { async list() { return { items: [], scheduleRevision: 1 }; } };
  const view = render(DayScreen, { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false, createRequest() { opened++; } });
  t.after(() => { operationGuard.clear(owner); view.unmount(); }); await view.settle();
  operationGuard.update(owner, { status: 'error', error: new Error('timeout'), uncertain: true });
  press(view, '추가'); assert.equal(opened, 1); assert.equal(operationGuard.hasUnresolved(), true);
});

test('changing date hides the old target while loading and never shows a zero summary', async t => {
  let resolveNext;
  const client = { list({ from }) { return from.startsWith('2026-11-01')
    ? Promise.resolve({ items: [item('old-target', 'task')], scheduleRevision: 1 })
    : new Promise(resolve => { resolveNext = resolve; }); } };
  const props = { selectedDate: new Date('2026-11-01T12:00:00Z'), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false };
  const view = render(DayScreen, props); t.after(() => view.unmount()); await view.settle();
  press(view, '상태:old-target'); assert.match(text(view.tree), /수행 상태를 선택해 주세요/);
  view.update({ ...props, selectedDate: new Date('2026-11-02T12:00:00Z') }); await view.settle();
  assert.doesNotMatch(text(view.tree), /수행 상태를 선택해 주세요|old-target|0%/);
  resolveNext({ items: [], scheduleRevision: 1 }); await view.settle();
  assert.doesNotMatch(text(view.tree), /수행 상태를 선택해 주세요|old-target/);
});

test('home and day share real check-in state; attendance remains separate and no_undo is actionable', async t => {
  let items = [item('task', 'task'), item('event', 'event', 'shared')], revision = 1, calls = 0, reads = 0;
  const client = { async list() { reads++; return { items: structuredClone(items), scheduleRevision: revision }; },
    async checkin(op) { calls++; items = items.map(value => value.id === op.input.id ? { ...value, completion: op.input.completion, revision: value.revision + 1 } : value); revision++; return { item: items[0], scheduleRevision: revision }; },
    async attendance(op) { calls++; items = items.map(value => value.id === op.input.id ? { ...value, attendance: op.input.attendance, revision: value.revision + 1 } : value); revision++; return { item: items[1], scheduleRevision: revision }; },
    async undo() { throw new ApiError('no_undo', 'no history', false, 409); }, async command() { throw new Error('unexpected'); } };
  const props = { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: true };
  const home = render(HomeScreen, props), day = render(DayScreen, props); t.after(() => { home.unmount(); day.unmount(); });
  await home.settle(); await day.settle();
  press(home, '상태:task'); press(home, '완료'); await home.settle(); assert.equal(calls, 1);
  home.update({ ...props, refreshVersion: 1 }); day.update({ ...props, refreshVersion: 1 }); await home.settle(); await day.settle();
  assert.match(text(home.tree), /1개 중 1개 완료/); assert.equal(items[0].completion, 'completed');
  press(day, '상태:event'); press(day, '참석'); await day.settle();
  assert.equal(items[1].attendance, 'attended'); assert.equal(items[1].completion, 'pending'); assert.equal(calls, 2);
  day.update({ ...props, refreshVersion: 2 }); await day.settle(); press(day, '상태:task'); press(day, '이전 상태로 되돌리기'); await day.settle();
  assert.match(text(day.tree), /이전 상태를 확인할 수 없어 되돌릴 수 없습니다\. 상태를 직접 선택해 주세요\./);
  assert.doesNotMatch(text(day.tree), /같은 요청 재시도/); const previous = reads;
  press(day, '닫고 최신 목록 확인'); await day.settle(); assert.ok(reads > previous);
  press(day, '더보기:event'); assert.match(text(day.tree), /공동 일정은 직접 삭제할 수 없습니다/);
});

test('a definite status error can be closed and refreshes the schedule', async t => {
  let reads = 0;
  const client = { async list() { reads++; return { items: [item('task', 'task')], scheduleRevision: 1 }; },
    async checkin() { throw new ApiError('stale_revision', 'stale', false, 409); } };
  const view = render(DayScreen, { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: true });
  t.after(() => view.unmount()); await view.settle();
  press(view, '상태:task'); press(view, '완료'); await view.settle();
  assert.match(text(view.tree), /일정이 다른 곳에서 변경되었습니다/); const previous = reads;
  press(view, '오류 닫고 다시 입력'); await view.settle();
  assert.ok(reads > previous); assert.doesNotMatch(text(view.tree), /일정이 다른 곳에서 변경되었습니다/);
});

test('home proposal preview distinguishes an empty result from a failed read', async t => {
  const client = { async list() { return { items: [], scheduleRevision: 1 }; } };
  const props = { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, onOpenProposals() {}, visible: true,
    api: { async get() { return { proposals: [], nextCursor: null }; } } };
  const view = render(HomeScreen, props); t.after(() => view.unmount()); await view.settle();
  assert.match(text(view.tree), /아직 확인할 제안이 없어요/);
  view.update({ ...props, api: { async get() { throw new Error('offline'); } } }); await view.settle();
  assert.match(text(view.tree), /제안을 불러오지 못했어요/); assert.doesNotMatch(text(view.tree), /아직 확인할 제안이 없어요/);
});

test('home and day describe empty timed schedules without hiding unscheduled tasks', async t => {
  const unscheduled = { ...item('미배치 작업', 'task'), timeSlot: null };
  const client = { async list({ includeUnscheduled }) { return { items: includeUnscheduled ? [unscheduled] : [], scheduleRevision: 1 }; } };
  const props = { selectedDate: new Date(), onSelectDate() {}, client, timezone: 'UTC', refreshVersion: 0,
    onScheduleChanged() {}, onCoordinate() {}, onRecovery() {}, onOpenPreparationProposals() {}, api: {}, visible: false };
  const home = render(HomeScreen, props), day = render(DayScreen, props);
  t.after(() => { home.unmount(); day.unmount(); }); await home.settle(); await day.settle();
  assert.match(text(home.tree), /해당하는 시간 지정 일정이 없어요/);
  assert.match(text(day.tree), /이 날짜에 시간이 정해진 일정이 없어요/);
  assert.match(text(day.tree), /미배치 작업/);
});
