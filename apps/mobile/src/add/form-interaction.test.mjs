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
  }, useMemo(factory, deps) {
    const instance = current, index = instance.index++, previous = instance.hooks[index];
    if (!previous || previous.deps.length !== deps.length || !deps.every((value, i) => Object.is(value, previous.deps[i]))) instance.hooks[index] = { deps, value: factory() };
    return instance.hooks[index].value;
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
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/typography|.*ui\/typography)$/ }, args => ({ path: args.path, namespace: 'mock' }));
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
  const node = nodes(view.tree).find(item => item.type === 'TextInput' && item.props.accessibilityLabel === label || item.type === 'input' && item.props['aria-label'] === label);
  assert.ok(node, label); if (value !== undefined) { if (node.type === 'input') node.props.onChange({ currentTarget: { value } }); else node.props.onChangeText(value); view.flush(); }
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
  assert.equal(context.startsAt, undefined);
  view.props = { ...props, timezone: 'UTC', pendingDraft: { kind: 'event', fields: { startTime: '10:30', endTime: '11:30' } } }; view.flush();
  assert.doesNotMatch(text(view.tree), /시간대: Asia\/Seoul|IANA|ISO/);
  press(view, '제안 값 적용');
  assert.equal(handled, 1); assert.equal(input(view, '시작 날짜'), '2026-11-01');
  assert.equal(input(view, '시작 시간'), '10:30'); assert.equal(input(view, '종료 시간'), '11:30');
  press(view, '저장');
  assert.equal(saved.title, '회의'); assert.equal(saved.timeSlot.timezone, 'Asia/Seoul');
  assert.equal(saved.timeSlot.startsAt, '2026-11-01T01:30:00.000Z'); assert.equal(saved.timeSlot.endsAt, '2026-11-01T02:30:00.000Z');
});

test('all-day date is inclusive in the form and stores the next local midnight across DST', () => {
 let saved; const view = host.render(ScheduleForm, { item: null, initialKind: 'event', defaultDate: '2026-11-01', timezone: 'America/New_York',
  disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 input(view, '제목', '종일 일정'); input(view, '메모', '준비 메모'); press(view, '종일');
 assert.ok(!nodes(view.tree).some(node => node.props?.['aria-label'] === '시작 시간' || node.props?.['aria-label'] === '종료 시간'));
 assert.equal(input(view, '시작 날짜'), '2026-11-01'); assert.equal(input(view, '종료 날짜'), '2026-11-01'); press(view, '저장');
 assert.deepEqual(saved.timeSlot, { startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-11-02T05:00:00.000Z', timezone: 'America/New_York' });
 assert.equal(saved.allDay, true); assert.equal(saved.notes, '준비 메모');
});

test('all-day edit shows the inclusive final date and preserves hidden fields and exact timestamps', () => {
 const item = { id: 'all-day', revision: 1, kind: 'event', title: '기존', timeSlot: { startsAt: '2026-11-01T04:00:00Z', endsAt: '2026-11-03T05:00:00Z', timezone: 'America/New_York' },
  durationMinutes: 35, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'unknown', attendance: 'attended', category: 'work', allDay: true, notes: '기존 메모', sourceRefs: [] };
 let saved; const view = host.render(ScheduleForm, { item, timezone: 'America/New_York', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 assert.equal(input(view, '종료 날짜'), '2026-11-02'); input(view, '제목', '변경 제목'); press(view, '저장');
 assert.deepEqual(saved.timeSlot, item.timeSlot); assert.equal(saved.durationMinutes, 35); assert.equal(saved.flexibility, 'flexible');
 assert.equal(saved.involvement, 'personal'); assert.equal(saved.completion, 'unknown'); assert.equal(saved.attendance, 'attended');
 assert.equal(saved.allDay, true); assert.equal(saved.notes, '기존 메모');
});

test('timed task derives duration while an existing unscheduled task keeps its duration', () => {
 let saved; const base = { timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } };
 const newTask = host.render(ScheduleForm, { ...base, item: null, initialKind: 'task', defaultDate: '2026-11-01' });
 input(newTask, '제목', '작업'); press(newTask, '저장'); assert.match(text(newTask.tree), /시작과 종료를 선택/);
 input(newTask, '시작 시간', '09:00'); input(newTask, '종료 시간', '10:30'); press(newTask, '저장'); assert.equal(saved.durationMinutes, 90);
 const item = { id: 'task', revision: 1, kind: 'task', title: '미배치', timeSlot: null, durationMinutes: 45, deadline: null,
  flexibility: 'flexible', involvement: 'personal', completion: 'pending', sourceRefs: [] };
 const existing = host.render(ScheduleForm, { ...base, item }); input(existing, '제목', '미배치 수정'); press(existing, '저장');
 assert.equal(saved.durationMinutes, 45); assert.equal(saved.timeSlot, null); assert.equal(saved.flexibility, 'flexible');
});

test('timezone change preserves existing instants and hidden fields without exposing technical timezone text', () => {
 const item = { id: 'event', revision: 1, kind: 'event', title: '약속', timeSlot: { startsAt: '2026-11-01T00:30:45.123456Z', endsAt: '2026-11-01T01:30:45.123456Z', timezone: 'Asia/Seoul' },
  durationMinutes: 42, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'unknown', notes: '유지', sourceRefs: [] };
 let saved; const view = host.render(ScheduleForm, { item, timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 press(view, '국가·지역: 미국 서부'); assert.equal(input(view, '시작 날짜'), '2026-10-31');
 assert.doesNotMatch(text(view.tree), /Asia\/Seoul|America\/Los_Angeles|IANA|ISO|HH:mm|YYYY-MM-DD/);
 press(view, '저장'); assert.equal(saved.timeSlot.timezone, 'America/Los_Angeles'); assert.equal(saved.timeSlot.startsAt, item.timeSlot.startsAt);
 assert.equal(saved.timeSlot.endsAt, item.timeSlot.endsAt); assert.equal(saved.durationMinutes, 42); assert.equal(saved.notes, '유지');
});

test('editing one time preserves the other exact timestamp and clearing notes is explicit', () => {
 const item = { id: 'event', revision: 1, kind: 'event', title: '약속', timeSlot: { startsAt: '2026-11-01T00:30:45.123456Z', endsAt: '2026-11-01T01:30:45.123456Z', timezone: 'Asia/Seoul' },
  durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', notes: '기존 메모', sourceRefs: [] };
 let saved; const view = host.render(ScheduleForm, { item, timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 input(view, '시작 시간', '09:15'); input(view, '메모', ''); press(view, '저장');
 assert.equal(saved.timeSlot.startsAt, '2026-11-01T00:15:00.000Z'); assert.equal(saved.timeSlot.endsAt, item.timeSlot.endsAt); assert.equal(saved.notes, null);
});

test('an existing timed task can be made unscheduled without changing its hidden duration', () => {
 const item = { id: 'task', revision: 1, kind: 'task', title: '작업', timeSlot: { startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-01T01:00:00Z', timezone: 'Asia/Seoul' },
  durationMinutes: 35, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', sourceRefs: [] };
 let saved; const view = host.render(ScheduleForm, { item, timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 press(view, '시간 미정으로 변경'); press(view, '저장'); assert.equal(saved.timeSlot, null); assert.equal(saved.durationMinutes, 35);
});

test('ambiguous clock time is rejected and changing region can resolve it', () => {
 let saved; const view = host.render(ScheduleForm, { item: null, initialKind: 'event', defaultDate: '2026-11-01', timezone: 'America/New_York',
  disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 input(view, '제목', '약속'); input(view, '시작 시간', '01:30'); input(view, '종료 시간', '02:30'); press(view, '저장');
 assert.equal(saved, undefined); assert.match(text(view.tree), /중복된 시각/);
 press(view, '국가·지역: 한국'); press(view, '저장'); assert.equal(saved.timeSlot.startsAt, '2026-10-31T16:30:00.000Z');
});

test('ISO AI draft is reviewed as local fields and does not reappear after a region change', () => {
 const pendingDraft = { kind: 'event', fields: { startsAt: '2026-11-02T01:00:00Z', endsAt: '2026-11-02T02:00:00Z' } };
 const view = host.render(ScheduleForm, { item: null, initialKind: 'event', defaultDate: '2026-11-01', timezone: 'Asia/Seoul', pendingDraft,
  disabled: false, cancelDisabled: false, onCancel() {}, onSave() {}, onDraftHandled() {} });
 assert.match(text(view.tree), /AI 초안 확인/); assert.doesNotMatch(text(view.tree), /2026-11-02T01:00:00Z/);
 press(view, '제안 값 적용'); assert.equal(input(view, '시작 날짜'), '2026-11-02'); assert.equal(input(view, '시작 시간'), '10:00');
 press(view, '국가·지역: 미국 서부'); assert.doesNotMatch(text(view.tree), /AI 초안 확인/);
});

test('editing an all-day end date stores the following local date as exclusive', () => {
 const item = { id: 'event', revision: 1, kind: 'event', title: '종일', timeSlot: { startsAt: '2026-11-01T04:00:00Z', endsAt: '2026-11-03T05:00:00Z', timezone: 'America/New_York' },
  durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', allDay: true, sourceRefs: [] };
 let saved; const view = host.render(ScheduleForm, { item, timezone: 'America/New_York', disabled: false, cancelDisabled: false, onCancel() {}, onSave(value) { saved = value; } });
 input(view, '종료 날짜', '2026-11-03'); press(view, '저장');
 assert.equal(saved.timeSlot.startsAt, item.timeSlot.startsAt); assert.equal(saved.timeSlot.endsAt, '2026-11-04T05:00:00.000Z');
});

test('form keeps start above end and hides technical and internal schedule inputs', () => {
 const view = host.render(ScheduleForm, { item: null, initialKind: 'event', defaultDate: '2026-11-01', timezone: 'Asia/Seoul',
  disabled: false, cancelDisabled: false, onCancel() {}, onSave() {} });
 const labels = nodes(view.tree).filter(node => node.type === 'input').map(node => node.props['aria-label']);
 assert.deepEqual(labels, ['시작 날짜', '시작 시간', '종료 날짜', '종료 시간']);
 assert.doesNotMatch(text(view.tree), /IANA|ISO|YYYY-MM-DD|HH:mm|소요시간|시간 유연성|참여 범위/);
 assert.ok(nodes(view.tree).some(node => node.type === 'TextInput' && node.props.accessibilityLabel === '메모'));
});
