import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pressable as WebPressable, Text as WebText } from 'react-native-web';
import { ApiError, createApiClient } from '../src/api/http';
import { createMutationMachine, type Mutation } from '../src/api/mutation';
import { createOperationGuard } from '../src/api/operationGuard';
import { createCalendarClient, selectedEventRefs, validPeriod, type CalendarEvent, type CalendarImportInput } from '../src/calendar/client';

const from = '2026-10-31T00:00:00Z';
const to = '2026-11-07T00:00:00Z';
const calendarId = 'calendar /?&';
const events: CalendarEvent[] = [
  { id: 'event-1', etag: '"version/1"', title: '예시 일정', startsAt: '2026-11-01T01:00:00Z', endsAt: '2026-11-01T02:00:00Z', timezone: 'Asia/Seoul' },
  { id: 'event-2', etag: '"version/2"', title: '다른 일정', startsAt: '2026-11-02T01:00:00Z', endsAt: '2026-11-02T02:00:00Z', timezone: 'Asia/Seoul' },
];
const importedItem = {
  id: 'imported-1', revision: 1, kind: 'event', title: '예시 일정',
  timeSlot: { startsAt: events[0].startsAt, endsAt: events[0].endsAt, timezone: events[0].timezone },
  durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal',
  completion: 'pending', sourceRefs: [{ provider: 'google_calendar', accountRef: 'test-account',
    calendarId, externalEventId: events[0].id, lastSyncedAt: from, sourceVersion: events[0].etag }],
};
const importedItem2 = { ...importedItem, id: 'imported-2', sourceRefs: [{ ...importedItem.sourceRefs[0], externalEventId: events[1].id, sourceVersion: events[1].etag }] };
const input: CalendarImportInput = { calendarId, from, to, selectedEvents: [{ id: events[0].id, etag: events[0].etag }], expectedScheduleRevision: 7 };
const op: Mutation<CalendarImportInput> = { input, requestId: 'request-1', idempotencyKey: 'key-1' };
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test('explicit reads and import use the exact contract and preserve selected etags', async () => {
  const calls: { method: string; url: string; body?: unknown; key?: string }[] = [];
  const responses: unknown[] = [
    { status: 'available', accountLabel: '예시 계정' },
    { calendars: [{ id: calendarId, summary: '예시', timeZone: 'Asia/Seoul' }] },
    { events, unsupportedCount: 2 }, { items: [importedItem], scheduleRevision: 8 },
  ];
  const api = createApiClient({ baseUrl: 'http://localhost:3001', getSessionToken: () => 'test', fetcher: async (url, init) => {
    calls.push({ method: String(init?.method), url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['Idempotency-Key'] } : {}) });
    return Response.json({ requestId: 'response', data: responses.shift() });
  } });
  const client = createCalendarClient(api);
  assert.equal(calls.length, 0);
  assert.equal((await client.connection()).status, 'available');
  assert.equal((await client.calendars())[0].id, calendarId);
  const result = await client.events(calendarId, from, to);
  assert.equal(result.unsupportedCount, 2);
  assert.deepEqual(selectedEventRefs(result.events, new Set(['event-1'])), input.selectedEvents);
  assert.deepEqual(await client.importEvents(op), { items: [importedItem], scheduleRevision: 8 });
  assert.deepEqual(calls, [
    { method: 'GET', url: 'http://localhost:3001/v1/calendar-connection' },
    { method: 'GET', url: 'http://localhost:3001/v1/calendar/calendars' },
    { method: 'GET', url: `http://localhost:3001/v1/calendar/events?calendarId=${encodeURIComponent(calendarId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` },
    { method: 'POST', url: 'http://localhost:3001/v1/calendar/import', body: { requestId: 'request-1', ...input }, key: 'key-1' },
  ]);
});

test('invalid reads and import responses are rejected, and periods require offset timestamps', async () => {
  let response: unknown;
  const client = createCalendarClient({ get: async <T>() => response as T, post: async <T>() => response as T });
  const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_response';
  for (response of [null, { status: 'unknown', accountLabel: null }, { status: 'available' }]) await assert.rejects(client.connection(), invalid);
  for (response of [{ calendars: [{ id: '', summary: 'x' }] }, { calendars: [{ id: 'a', summary: '' }, { id: 'a', summary: '' }] }]) await assert.rejects(client.calendars(), invalid);
  for (response of [{ events, unsupportedCount: -1 }, { events: [{ ...events[0], etag: '' }], unsupportedCount: 0 }, { events: [events[0], events[0]], unsupportedCount: 0 }]) await assert.rejects(client.events(calendarId, from, to), invalid);
  for (response of [{ items: [], scheduleRevision: -1 }, { items: null, scheduleRevision: 1 }]) await assert.rejects(client.importEvents(op), invalid);
  assert.equal(validPeriod(from, to), true);
  assert.equal(validPeriod(to, from), false);
  assert.equal(validPeriod('2026-10-31T00:00:00', to), false);
  assert.equal(validPeriod('2026-10-31T00:00:00.0001Z', to), false);
  assert.equal(validPeriod('2026-01-01T00:00:00Z', '2027-01-02T00:00:00Z'), true);
  assert.equal(validPeriod('2026-01-01T00:00:00Z', '2027-01-02T00:00:00.001Z'), false);
});

test('import rejects missing or extra items and revisions other than the next revision', async () => {
  let response: unknown;
  const client = createCalendarClient({ get: async <T>() => response as T, post: async <T>() => response as T });
  const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_response';
  for (response of [
    { items: [], scheduleRevision: 8 },
    { items: [importedItem, importedItem], scheduleRevision: 8 },
    { items: [importedItem], scheduleRevision: 7 },
    { items: [importedItem], scheduleRevision: 9 },
    { items: [importedItem], scheduleRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(client.importEvents(op), invalid);
  response = { items: [importedItem], scheduleRevision: 8 };
  assert.deepEqual(await client.importEvents(op), response);
  const twoEvents = { ...op, input: { ...input, expectedScheduleRevision: 0, selectedEvents: selectedEventRefs(events, new Set(events.map(event => event.id))) } };
  response = { items: [importedItem], scheduleRevision: 1 };
  await assert.rejects(client.importEvents(twoEvents), invalid);
  response = { items: [importedItem, importedItem2], scheduleRevision: 1 };
  assert.deepEqual(await client.importEvents(twoEvents), response);
});

test('automatic import accepts only consistent partial or unchanged results', async () => {
  let response: unknown;
  const client = createCalendarClient({ get: async <T>() => response as T, post: async <T>() => response as T });
  const auto = { ...op, input: { ...input, selectedEvents: events.map(({ id, etag }) => ({ id, etag })), skipExisting: true } };
  for (response of [{ items: [], scheduleRevision: 7 }, { items: [importedItem], scheduleRevision: 8 }]) {
    assert.deepEqual(await client.importEvents(auto), response);
  }
  for (response of [{ items: [], scheduleRevision: 8 }, { items: [importedItem], scheduleRevision: 7 },
    { items: [importedItem, importedItem, importedItem], scheduleRevision: 8 }]) {
    await assert.rejects(client.importEvents(auto), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
});

test('automatic import rejects malformed, unrelated or duplicated returned source items', async () => {
  let response: unknown;
  const client = createCalendarClient({ get: async <T>() => response as T, post: async <T>() => response as T });
  const auto = { ...op, input: { ...input, selectedEvents: events.map(({ id, etag }) => ({ id, etag })), expectedAccountRef: 'test-account', skipExisting: true } };
  const ref = importedItem.sourceRefs[0];
  for (const items of [
    [null], [{ ...importedItem, timeSlot: null }], [{ ...importedItem, sourceRefs: [] }],
    [{ ...importedItem, sourceRefs: [{ ...ref, accountRef: 'other' }] }],
    [{ ...importedItem, sourceRefs: [{ ...ref, calendarId: 'other' }] }],
    [{ ...importedItem, sourceRefs: [{ ...ref, externalEventId: 'other' }] }],
    [{ ...importedItem, sourceRefs: [{ ...ref, sourceVersion: 'old' }] }],
    [importedItem, { ...importedItem, id: 'other-id' }],
    [importedItem, { ...importedItem2, id: importedItem.id }],
    [{ ...importedItem, sourceRefs: [{ ...ref, occurrenceKey: 'series-instance' }] },
      { ...importedItem2, sourceRefs: [{ ...importedItem2.sourceRefs[0], occurrenceKey: 'series-instance' }] }],
  ]) {
    response = { items, scheduleRevision: 8 };
    await assert.rejects(client.importEvents(auto), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
});

test('uncertain import blocks the guard and retries the same immutable intent until resolved', async () => {
  const attempts: Mutation<CalendarImportInput>[] = [];
  const guard = createOperationGuard();
  const owner = {};
  let release: (() => void) | undefined;
  const machine = createMutationMachine<CalendarImportInput, { scheduleRevision: number }>({
    execute: async operation => {
      attempts.push(operation);
      if (attempts.length === 1) { await new Promise<void>(resolve => { release = resolve; }); throw new ApiError('timeout', 'timeout'); }
      return { scheduleRevision: 8 };
    },
    changed: state => guard.update(owner, state),
  });
  const draft = structuredClone(input);
  machine.submit(draft);
  assert.equal(guard.hasUnresolved(), true);
  draft.selectedEvents[0].etag = 'changed-after-submit';
  machine.submit(draft);
  assert.equal(attempts.length, 1);
  release?.(); await wait();
  assert.equal(machine.getState().status, 'error');
  assert.equal(guard.hasUnresolved(), true);
  machine.reset();
  assert.equal(machine.getState().status, 'error');
  machine.retry(); await wait();
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(attempts[1].input.selectedEvents[0].etag, events[0].etag);
  assert.equal(machine.getState().status, 'success');
  assert.equal(guard.hasUnresolved(), false);
});

// Render the actual panel with mocked React Native primitives and transport.
function createHarness() {
  let current: any;
  const fragment = Symbol('fragment');
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const jsx = (type: any, props: any, key?: any) => ({ type, props: props ?? {}, key });
  const slot = () => {
    if (!current) throw new Error('hook outside component');
    return { instance: current, index: current.index++ };
  };
  const react: any = {
    useState(initial: any) {
      const { instance, index } = slot();
      if (!instance.hooks[index]) {
        const state: any = { value: typeof initial === 'function' ? initial() : initial };
        state.set = (update: any) => {
          if (!instance.alive) return;
          const value = typeof update === 'function' ? update(state.value) : update;
          if (!Object.is(value, state.value)) { state.value = value; instance.renderer.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useRef(initial: any) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
    useMemo(factory: () => any, deps: any[]) {
      const { instance, index } = slot();
      const old = instance.hooks[index];
      if (!old || !same(old.deps, deps)) instance.hooks[index] = { deps, value: factory() };
      return instance.hooks[index].value;
    },
    useCallback(callback: any, deps: any[]) { return react.useMemo(() => callback, deps); },
    useEffect(callback: any, deps: any[]) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!same(effect.deps, deps)) {
        effect.deps = deps;
        instance.renderer.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const native = {
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch',
    BackHandler: { addEventListener: (_event: string, callback: () => boolean) => { (globalThis as any).__calendarBack = callback; return { remove() { (globalThis as any).__calendarBack = null; } }; } },
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host = { react, native, jsx, fragment, fontState: [true, null] };
  (globalThis as any).__calendarPanelHarness = host;

  function renderer(Component: any, initialProps: any = {}) {
    const view: any = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    function render(node: any, path: string, seen: Set<string>): any {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`, seen));
      if (node.type === fragment) return render(node.props.children, `${path}.fragment`, seen);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        let instance = view.instances.get(id);
        if (!instance) { instance = { hooks: [], alive: true, renderer: view, index: 0 }; view.instances.set(id, instance); }
        seen.add(id); instance.index = 0;
        const previous = current; current = instance;
        const output = node.type(node.props); current = previous;
        return render(output, `${id}.child`, seen);
      }
      return { type: node.type, props: node.props, children: render(node.props.children, `${path}.children`, seen) };
    }
    view.flush = () => {
      for (let count = 0; view.dirty && count < 50; count += 1) {
        view.dirty = false; view.effects = [];
        const seen = new Set<string>();
        view.tree = render(jsx(Component, view.props), 'root', seen);
        for (const [id, instance] of view.instances as Map<string, any>) {
          if (!seen.has(id)) {
            instance.alive = false;
            for (const hook of instance.hooks) hook?.cleanup?.();
            view.instances.delete(id);
          }
        }
        for (const effect of view.effects) effect();
      }
      if (view.dirty) throw new Error('render did not settle');
    };
    view.update = (props: any) => { view.props = props; view.dirty = true; view.flush(); };
    view.settle = async () => { for (let i = 0; i < 5; i += 1) { await new Promise(done => setImmediate(done)); view.flush(); } };
    view.unmount = () => {
      for (const instance of view.instances.values() as Iterable<any>) {
        instance.alive = false;
        for (const hook of instance.hooks) hook?.cleanup?.();
      }
      view.instances.clear();
    };
    view.flush();
    return view;
  }
  return { renderer, jsx };
}


const harness = createHarness();
const panelModule = build({
  stdin: { contents: `export { default as Panel } from '../src/calendar/CalendarImportPanel'; export { default as AutoImport } from '../src/calendar/AutoCalendarImport'; export { ScheduleForm } from '../src/schedule/ScheduleForm'; export { operationGuard } from '../src/api/operationGuard'; export { ApiError } from '../src/api/http';`, resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'mock-native-calendar', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*\/typography)$/ }, args => ({ path: args.path, namespace: 'calendar-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'calendar-native' }, ({ path }) => ({ contents:
      path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
      path === 'react' ? 'module.exports=globalThis.__calendarPanelHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__calendarPanelHarness.native' :
      'exports.jsx=exports.jsxs=globalThis.__calendarPanelHarness.jsx; exports.Fragment=globalThis.__calendarPanelHarness.fragment', loader: 'js' }));
  } }],
}).then(bundled => {
  const compiled: any = { exports: {} };
  new Function('module', 'exports', bundled.outputFiles[0].text)(compiled, compiled.exports);
  return compiled.exports;
});

function nodes(root: any): any[] {
  if (root === null || root === undefined) return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object') return [];
  return [root, ...nodes(root.children)];
}

function assertWebChecked(node: any, checked: boolean) {
  assert.equal(node.props.accessibilityState.checked, checked);
  assert.equal(node.props['aria-checked'], checked);
  const markup = renderToStaticMarkup(React.createElement(WebPressable, {
    accessibilityRole: node.props.accessibilityRole, 'aria-checked': node.props['aria-checked'],
  }, React.createElement(WebText, null, '선택')));
  assert.match(markup, new RegExp(`aria-checked="${checked}"`));
  assert.match(markup, new RegExp(`role="${node.props.accessibilityRole}"`));
}
function textOf(root: any): string {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function button(view: any, label: string) {
  return nodes(view.tree).find(node => node.type === 'Pressable' &&
    (node.props.accessibilityLabel === label || textOf(node.children) === label));
}
function press(view: any, label: string) {
  const found = button(view, label);
  assert.ok(found, `missing button: ${label}`);
  assert.notEqual(found.props.disabled, true, `disabled button: ${label}`);
  found.props.onPress(); view.flush();
}
function inputNode(view: any, label: string) {
  const found = nodes(view.tree).find(node => (node.type === 'TextInput' && node.props.accessibilityLabel === label) || (node.type === 'input' && node.props['aria-label'] === label));
  assert.ok(found, `missing input: ${label}`); return found;
}
function enter(view: any, label: string, value: string) {
  const found = inputNode(view, label);
  assert.notEqual(found.props.editable, false, `locked input: ${label}`);
  assert.notEqual(found.props.disabled, true, `locked input: ${label}`);
  if (found.type === 'input') found.props.onChange({ currentTarget: { value } });
  else found.props.onChangeText(value);
  view.flush();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('mount defaults to the current local month and queries through the next midnight across DST', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-08T15:00:00Z') });
  const { Panel } = await panelModule; const paths: string[] = [];
  const api = { get: async (path: string) => { paths.push(path); return path === '/v1/calendar-connection'
    ? { status: 'available', accountLabel: null } : path === '/v1/calendar/calendars' ? { calendars: [{ id: 'calendar', summary: '예시' }] } : { events: [], unsupportedCount: 0 }; }, post: async () => assert.fail('unexpected write') };
  const view = harness.renderer(Panel, { api, timezone: 'America/New_York', onBack() {}, onScheduleChanged() {} });
  t.after(() => view.unmount());
  await view.settle();
  assert.deepEqual(paths, ['/v1/calendar-connection', '/v1/calendar/calendars']);
  assertWebChecked(nodes(view.tree).find(node => node.props?.accessibilityRole === 'radio'), false);
  assert.equal(nodes(view.tree).some(node => node.type === 'TextInput'), false);
  press(view, '예시');
  assert.equal(inputNode(view, '조회 시작일').props.value, '2026-03-01');
  assert.equal(inputNode(view, '조회 마지막 날').props.value, '2026-03-31');
  assert.equal(inputNode(view, '조회 시작일').props.type, 'date');
  assert.equal(paths.length, 2);
  press(view, '이 기간 일정 조회'); await view.settle();
  const query = new URLSearchParams(paths[2].split('?')[1]);
  assert.equal(query.get('from'), '2026-03-01T05:00:00.000Z');
  assert.equal(query.get('to'), '2026-04-01T04:00:00.000Z');
});

test('a replaced client ignores the old connection response', async t => {
  const { Panel } = await panelModule; const old = deferred<unknown>(); const paths: string[] = [];
  const first = { get: async () => old.promise, post: async () => assert.fail('unexpected write') };
  const second = { get: async (path: string) => { paths.push(path); return path === '/v1/calendar-connection'
    ? { status: 'available', accountLabel: 'new' } : { calendars: [{ id: 'new', summary: '새 캘린더' }] }; }, post: async () => assert.fail('unexpected write') };
  const props = { api: first, timezone: 'Asia/Seoul', onBack() {}, onScheduleChanged() {} };
  const view = harness.renderer(Panel, props); t.after(() => view.unmount());
  view.update({ ...props, api: second }); await view.settle();
  old.resolve({ status: 'available', accountLabel: 'old' }); await view.settle();
  assert.deepEqual(paths, ['/v1/calendar-connection', '/v1/calendar/calendars']);
  assert.match(textOf(view.tree), /새 캘린더/); assert.doesNotMatch(textOf(view.tree), /old/);
});

test('event selection stops at 100 and lets a selected item be deselected', async t => {
  const { Panel } = await panelModule;
  const many = Array.from({ length: 101 }, (_, index) => ({ ...events[0], id: `event-${index}`, title: `일정 ${index}` }));
  const api = { get: async (path: string) => path === '/v1/calendar-connection' ? { status: 'available', accountLabel: null }
    : path === '/v1/calendar/calendars' ? { calendars: [{ id: calendarId, summary: '예시' }] } : { events: many, unsupportedCount: 0 },
  post: async () => assert.fail('unexpected write') };
  const view = harness.renderer(Panel, { api, timezone: 'Asia/Seoul', onBack() {}, onScheduleChanged() {} });
  t.after(() => view.unmount()); await view.settle(); press(view, '예시');
  enter(view, '조회 시작일', '2026-11-01'); enter(view, '조회 마지막 날', '2026-11-06'); press(view, '이 기간 일정 조회'); await view.settle();
  const choices = () => nodes(view.tree).filter(node => node.props?.accessibilityRole === 'checkbox');
  for (let index = 0; index < 100; index++) { choices()[index].props.onPress(); view.flush(); }
  assert.equal(choices()[100].props.disabled, true); assert.equal(button(view, '선택한 100개 가져오기').props.disabled, false);
  choices()[0].props.onPress(); view.flush(); assert.equal(choices()[100].props.disabled, false);
});

test('일정 폼 라디오는 선택 전후 네이티브 상태와 웹 aria-checked를 함께 갱신한다', async t => {
  const { ScheduleForm } = await panelModule;
  const view = harness.renderer(ScheduleForm, { item: null, timezone: 'Asia/Seoul', disabled: false, cancelDisabled: false, onCancel() {}, onSave() {} });
  t.after(() => view.unmount());
  const find = (label: string) => nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  assertWebChecked(find('종류: 일정'), true); assertWebChecked(find('종류: 할 일'), false);
  press(view, '종류: 할 일');
  assertWebChecked(find('종류: 일정'), false); assertWebChecked(find('종류: 할 일'), true);
  assertWebChecked(find('분류: 미분류'), true); press(view, '분류: 업무');
  assertWebChecked(find('분류: 미분류'), false); assertWebChecked(find('분류: 업무'), true);
});

test('웹에서는 하드웨어 뒤로가기를 등록하지 않고 종료 후 늦은 조회를 무시한다', async t => {
  const { Panel } = await panelModule;
  const native = (globalThis as any).__calendarPanelHarness.native;
  const originalOs = native.Platform.OS, originalBack = native.BackHandler;
  native.Platform.OS = 'web'; native.BackHandler = { addEventListener() { throw new Error('unexpected web listener'); } };
  t.after(() => { native.Platform.OS = originalOs; native.BackHandler = originalBack; });
  const pending = deferred<any>(); const calls: string[] = [];
  const api = { get: (path: string) => { calls.push(path); return pending.promise; }, post: async () => ({}) };
  const view = harness.renderer(Panel, { api, timezone: 'Asia/Seoul', scheduleClient: { list: async () => ({ items: [], scheduleRevision: 1 }) }, onBack() {}, onScheduleChanged() {} });
  view.unmount();
  pending.resolve({ status: 'available', accountLabel: null }); await view.settle();
  assert.deepEqual(calls, ['/v1/calendar-connection']);
});


test('panel treats an incomplete success as uncertain and retries the same import without claiming success', async () => {
  const { Panel, operationGuard } = await panelModule;
  const revision = deferred<{ items: never[]; scheduleRevision: number }>();
  const first = deferred<unknown>();
  const requests: { body: any; key: string }[] = [];
  let reads = 0; let backs = 0; let changed = 0;
  const api = {
    get: async (path: string) => {
      reads += 1;
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: null };
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: calendarId, summary: '예시' }] };
      return { events, unsupportedCount: 2 };
    },
    post: async (_path: string, body: any, options: any) => {
      requests.push({ body, key: options.idempotencyKey });
      if (requests.length === 1) return first.promise;
      return { items: [importedItem], scheduleRevision: 8 };
    },
  };
  const view = harness.renderer(Panel, { api, timezone: 'Asia/Seoul', scheduleClient: { list: () => revision.promise }, onBack: () => { backs += 1; }, onScheduleChanged: () => { changed += 1; } });
  assert.equal(reads, 1);
  await view.settle();
  assert.equal(reads, 2);
  const calendarChoice = () => nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'radio');
  assertWebChecked(calendarChoice(), false);
  press(view, '예시');
  assertWebChecked(calendarChoice(), true);
  enter(view, '조회 시작일', '2026-11-01'); enter(view, '조회 마지막 날', '2026-11-06');
  press(view, '이 기간 일정 조회'); await view.settle();
  assert.match(textOf(view.tree), /지원하지 않는 일정 2개/);
  assert.equal(requests.length, 0);
  assert.equal(button(view, '선택한 0개 가져오기').props.disabled, true);
  const choice = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox' && textOf(node.children).includes('예시 일정'));
  assertWebChecked(choice, false);
  choice.props.onPress(); view.flush();
  assertWebChecked(nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox' && textOf(node.children).includes('예시 일정')), true);
  press(view, '선택한 1개 가져오기');
  assert.equal(button(view, '뒤로').props.disabled, true);
  (globalThis as any).__calendarBack(); assert.equal(backs, 0);
  assert.equal(requests.length, 0);
  revision.resolve({ items: [], scheduleRevision: 7 }); await view.settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.selectedEvents, [{ id: events[0].id, etag: events[0].etag }]);
  assert.equal(requests[0].body.expectedScheduleRevision, 7);
  assert.equal(requests[0].body.from, '2026-10-31T15:00:00.000Z');
  assert.equal(requests[0].body.to, '2026-11-06T15:00:00.000Z');
  assert.equal(operationGuard.hasUnresolved(), true);
  first.resolve({ items: [], scheduleRevision: 8 }); await view.settle();
  assert.match(textOf(view.tree), /처리 결과를 확인할 수 없습니다/);
  assert.match(textOf(view.tree), /서버 응답을 확인할 수 없습니다/);
  assert.doesNotMatch(textOf(view.tree), /선택한 일정을 앱에 가져왔습니다/);
  assert.equal(changed, 0);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(button(view, '뒤로').props.disabled, true);
  (globalThis as any).__calendarBack(); assert.equal(backs, 0);
  press(view, '같은 요청 다시 확인'); await view.settle();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(changed, 1);
  press(view, '뒤로'); assert.equal(backs, 1);
  view.unmount();
});

test('panel shows an unconfigured connection and opens Google settings without requesting calendars', async () => {
  const { Panel } = await panelModule;
  const paths: string[] = []; let opened = 0;
  const view = harness.renderer(Panel, { api: { get: async (path: string) => { paths.push(path); return { status: 'not_configured', accountLabel: null }; }, post: async () => { throw new Error('unexpected write'); } }, timezone: 'Asia/Seoul', onBack: () => {}, onOpenGoogle: () => { opened++; }, onScheduleChanged: () => {} });
  await view.settle();
  assert.deepEqual(paths, ['/v1/calendar-connection']);
  assert.match(textOf(view.tree), /연결이 설정되지 않았습니다/);
  press(view, 'Google 연결 열기'); assert.equal(opened, 1);
  view.unmount();
});

test('a confirmed conflict requires fresh event read before another import', async () => {
  const { Panel, ApiError: PanelApiError } = await panelModule;
  let writes = 0;
  const api = { get: async (path: string) => path === '/v1/calendar-connection' ? { status: 'available', accountLabel: null } : path === '/v1/calendar/calendars' ? { calendars: [{ id: calendarId, summary: '예시' }] } : { events, unsupportedCount: 0 },
    post: async () => { writes += 1; throw new PanelApiError('conflict', 'changed', false, 409); } };
  const view = harness.renderer(Panel, { api, timezone: 'Asia/Seoul', scheduleClient: { list: async () => ({ items: [], scheduleRevision: 7 }) }, onBack: () => {}, onScheduleChanged: () => assert.fail('must not report success') });
  await view.settle(); press(view, '예시');
  enter(view, '조회 시작일', '2026-11-01'); enter(view, '조회 마지막 날', '2026-11-06'); press(view, '이 기간 일정 조회'); await view.settle();
  nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox').props.onPress(); view.flush();
  press(view, '선택한 1개 가져오기'); await view.settle();
  assert.equal(writes, 1); assert.match(textOf(view.tree), /변경되었습니다/);
  press(view, '다시 조회하기');
  assert.equal(nodes(view.tree).some(node => node.props?.accessibilityRole === 'checkbox'), false);
  assert.equal(button(view, '이 기간 일정 조회').props.disabled, false);
  view.unmount();
});

test('automatic import uses only the primary calendar and skips this account’s imported events', async () => {
  const { AutoImport } = await panelModule;
  const calls: any[] = []; let changed = 0;
  const api = {
    async get(path: string) {
      calls.push({ method: 'GET', path });
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: '테스트', accountRef: 'test-account' };
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: 'other', summary: '다른 캘린더' }, { id: calendarId, summary: '기본', primary: true }] };
      if (path.startsWith('/v1/calendar/events?')) return { events, unsupportedCount: 0 };
      if (path.startsWith('/v1/schedule?')) return { items: [importedItem], scheduleRevision: 7 };
      throw new Error('unexpected GET');
    },
    async post(path: string, body: any, options: any) {
      calls.push({ method: 'POST', path, body, key: options.idempotencyKey });
      return { items: [importedItem2], scheduleRevision: 8 };
    },
  };
  const view = harness.renderer(AutoImport, { api, timezone: 'Asia/Seoul', selectedDate: new Date('2026-11-02T00:00:00Z'), enabled: true, refreshVersion: 0, onScheduleChanged: () => { changed++; } });
  await view.settle(); await view.settle();
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].body.calendarId, calendarId);
  assert.equal(posts[0].body.expectedAccountRef, 'test-account');
  assert.equal(posts[0].body.skipExisting, true);
  assert.deepEqual(posts[0].body.selectedEvents, [{ id: 'event-2', etag: events[1].etag }]);
  assert.equal(posts[0].body.from, '2026-10-31T15:00:00.000Z'); assert.equal(posts[0].body.to, '2026-11-30T15:00:00.000Z');
  assert.equal(changed, 1);
  assert.equal(view.tree, null, 'successful automatic import leaves no banner above the app');
  view.unmount();
});

test('automatic import requires a choice without a primary and reuses the same key after an uncertain outcome', async () => {
  const { AutoImport, ApiError: PanelError } = await panelModule;
  const posts: any[] = [];
  const api = {
    async get(path: string) {
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: null, accountRef: 'test-account' };
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: calendarId, summary: '직접 선택' }] };
      if (path.startsWith('/v1/calendar/events?')) return { events: [events[0]], unsupportedCount: 0 };
      if (path.startsWith('/v1/schedule?')) return { items: [], scheduleRevision: 0 };
      throw new Error('unexpected GET');
    },
    async post(path: string, body: any, options: any) {
      posts.push({ path, body, key: options.idempotencyKey });
      if (posts.length === 1) throw new PanelError('timeout', 'timeout');
      return { items: [importedItem], scheduleRevision: 1 };
    },
  };
  const props = { api, timezone: 'Asia/Seoul', selectedDate: new Date('2026-11-02T00:00:00Z'), enabled: true, refreshVersion: 0, onScheduleChanged: () => {} };
  const view = harness.renderer(AutoImport, props); await view.settle();
  assert.equal(posts.length, 0); assert.match(textOf(view.tree), /캘린더를 선택/);
  button(view, '직접 선택').props.onPress(); view.flush(); await view.settle(); await view.settle();
  assert.equal(posts.length, 1); assert.match(textOf(view.tree), /결과를 확인하지 못했습니다/);
  button(view, '같은 요청 다시 확인').props.onPress(); view.flush(); await view.settle();
  assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0]); view.unmount();
});

test('invalid automatic import response stays uncertain and retries the identical request', async () => {
  const { AutoImport } = await panelModule;
  const posts: any[] = []; let changed = 0;
  const api = {
    async get(path: string) {
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: null, accountRef: 'test-account' };
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: calendarId, summary: '기본', primary: true }] };
      if (path.startsWith('/v1/calendar/events?')) return { events: [events[0]], unsupportedCount: 0 };
      if (path.startsWith('/v1/schedule?')) return { items: [], scheduleRevision: 7 };
      throw new Error('unexpected GET');
    },
    async post(path: string, body: any, options: any) {
      posts.push({ path, body, key: options.idempotencyKey });
      return { items: posts.length === 1 ? [null] : [importedItem], scheduleRevision: 8 };
    },
  };
  const view = harness.renderer(AutoImport, { api, timezone: 'Asia/Seoul', selectedDate: new Date('2026-11-02T00:00:00Z'), enabled: true,
    refreshVersion: 0, onScheduleChanged: () => { changed++; } });
  await view.settle(); await view.settle();
  assert.equal(posts.length, 1); assert.equal(changed, 0); assert.match(textOf(view.tree), /결과를 확인하지 못했습니다/);
  button(view, '같은 요청 다시 확인').props.onPress(); view.flush(); await view.settle();
  assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0]); assert.equal(changed, 1); view.unmount();
});

test('automatic import does not write when disabled while a read is pending', async () => {
  const { AutoImport } = await panelModule;
  let release!: (value: unknown) => void; let posts = 0;
  const api = {
    async get(path: string) {
      if (path === '/v1/calendar-connection') return new Promise(resolve => { release = resolve; });
      throw new Error('unexpected GET');
    },
    async post() { posts++; throw new Error('unexpected POST'); },
  };
  const props = { api, timezone: 'Asia/Seoul', selectedDate: new Date('2026-11-02T00:00:00Z'), enabled: true, refreshVersion: 0, onScheduleChanged: () => {} };
  const view = harness.renderer(AutoImport, props); view.update({ ...props, enabled: false });
  release({ status: 'available', accountLabel: null, accountRef: 'test-account' }); await view.settle();
  assert.equal(posts, 0); view.unmount();
});

test('automatic import follows a new visible month after an earlier read completes', async () => {
  const { AutoImport } = await panelModule;
  let release!: (value: unknown) => void; let connectionReads = 0; const eventReads: string[] = [];
  const api = {
    async get(path: string) {
      if (path === '/v1/calendar-connection') {
        connectionReads++;
        if (connectionReads === 1) return new Promise(resolve => { release = resolve; });
        return { status: 'available', accountLabel: null, accountRef: 'test-account' };
      }
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: calendarId, summary: '기본', primary: true }] };
      if (path.startsWith('/v1/calendar/events?')) { eventReads.push(path); return { events: [], unsupportedCount: 0 }; }
      if (path.startsWith('/v1/schedule?')) return { items: [], scheduleRevision: 0 };
      throw new Error('unexpected GET');
    },
    async post() { throw new Error('unexpected POST'); },
  };
  const props = { api, timezone: 'Asia/Seoul', selectedDate: new Date('2026-11-02T00:00:00Z'), enabled: true, refreshVersion: 0, onScheduleChanged: () => {} };
  const view = harness.renderer(AutoImport, props);
  view.update({ ...props, selectedDate: new Date('2026-12-02T00:00:00Z') });
  release({ status: 'available', accountLabel: null, accountRef: 'test-account' });
  await view.settle(); await view.settle();
  assert.equal(eventReads.length, 1); assert.match(eventReads[0], /2026-11-30T15%3A00%3A00\.000Z/);
  assert.match(eventReads[0], /2026-12-31T15%3A00%3A00\.000Z/); view.unmount();
});

test('manual calendar import labels all-day and nonblocking events', async t => {
  const { Panel } = await panelModule;
  const allDay = { ...events[0], allDay: true, blocksTime: false, startsAt: '2026-11-01T15:00:00Z', endsAt: '2026-11-02T15:00:00Z' };
  const api = {
    async get(path: string) {
      if (path === '/v1/calendar-connection') return { status: 'available', accountLabel: null };
      if (path === '/v1/calendar/calendars') return { calendars: [{ id: calendarId, summary: '기본' }] };
      if (path.startsWith('/v1/calendar/events?')) return { events: [allDay], unsupportedCount: 0 };
      throw new Error('unexpected GET');
    },
    async post() { throw new Error('unexpected POST'); },
  };
  const view = harness.renderer(Panel, { api, timezone: 'Asia/Seoul', onBack() {}, onScheduleChanged() {} });
  t.after(() => view.unmount()); await view.settle(); press(view, '기본');
  enter(view, '조회 시작일', '2026-11-01'); enter(view, '조회 마지막 날', '2026-11-06'); press(view, '이 기간 일정 조회'); await view.settle();
  assert.match(textOf(view.tree), /종일/); assert.match(textOf(view.tree), /시간 비차단/);
});
