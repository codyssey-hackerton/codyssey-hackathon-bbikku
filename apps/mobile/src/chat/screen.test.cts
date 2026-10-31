import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let current: any;
const fragment = Symbol('fragment');
const jsx = (type: any, props: any, key?: any) => ({ type, props: props ?? {}, key });
const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const slot = () => ({ instance: current, index: current.index++ });
const react = {
  useState(initial: any) {
    const { instance, index } = slot();
    const state = instance.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    state.set ??= (update: any) => { const next = typeof update === 'function' ? update(state.value) : update; if (!Object.is(next, state.value)) { state.value = next; instance.view.dirty = true; } };
    return [state.value, state.set];
  },
  useRef(initial: any) { const { instance, index } = slot(); return instance.hooks[index] ??= { current: initial }; },
  useEffect(callback: any, deps: any[]) {
    const { instance, index } = slot(); const effect = instance.hooks[index] ??= { deps: undefined, cleanup: undefined };
    if (!same(effect.deps, deps)) { effect.deps = deps; instance.view.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); }); }
  },
};
const native = { ActivityIndicator: 'ActivityIndicator', Image: 'Image', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: (styles: any) => styles } };
(globalThis as any).__chatHarness = { react, native, jsx, fragment };
const component = build({
  entryPoints: [resolve(__dirname, 'ChatScreen.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'native-test', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\.\/ui\/(typography|Icon)|\.\/ChatScheduleSummary)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'module.exports=globalThis.__chatHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__chatHarness.native' :
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path === './ChatScheduleSummary' ? 'exports.ChatScheduleSummary=()=>null' :
      'exports.jsx=exports.jsxs=globalThis.__chatHarness.jsx;exports.Fragment=globalThis.__chatHarness.fragment' }));
  } }],
}).then(result => { const module: any = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports); return module.exports.default; });

function render(Component: any, props: any) {
  const view: any = { dirty: true, effects: [], hooks: [], props };
  const renderNode = (node: any): any => {
    if (node == null || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node !== 'object') return node;
    if (node.type === fragment) return renderNode(node.props.children);
    if (typeof node.type === 'function') return renderNode(node.type(node.props));
    return { type: node.type, props: node.props, children: renderNode(node.props.children) };
  };
  view.flush = () => {
    for (let count = 0; view.dirty && count < 30; count++) {
      view.dirty = false; view.effects = []; current = { hooks: view.hooks, index: 0, view };
      const root = Component(view.props); current = undefined; view.tree = renderNode(root);
      for (const effect of view.effects) effect();
    }
    assert.equal(view.dirty, false, 'render settles');
  };
  view.settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(done => setImmediate(done)); view.flush(); } };
  view.flush(); return view;
}
function nodes(node: any): any[] { return node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.children)]; }
function text(node: any): string { return node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.children) : String(node); }
function press(view: any, label: string) {
  const button = nodes(view.tree).find(node => node.type === 'Pressable' && (node.props.accessibilityLabel === label || text(node.children) === label));
  assert.ok(button, `missing button ${label}`); assert.notEqual(button.props.disabled, true); button.props.onPress(); view.flush();
}
function type(view: any, value: string) {
  const input = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.ok(input); input.props.onChangeText(value); view.flush();
}
const base = { timezone: 'Asia/Seoul', scheduleClient: {}, selectedDate: new Date('2026-11-01'), refreshVersion: 0,
  onOpenProposals() {}, onProposalCreated() {}, onOpenMemory() {}, onOpenReviewSchedule() {}, onClearCoordinationTarget() {} };

test('폼 AI 초안은 미리보기 후 명시적으로 입력 화면에 전달되며 직접 저장하지 않는다', async () => {
  const Screen = await component; const calls: any[] = []; const applied: any[] = [];
  const proposed = { kind: 'routine', fields: { title: '운동', weekdays: ['1', '3'] } };
  const entryContext = { key: 'form:1', kind: 'form', draft: { kind: 'routine', fields: { title: '기존', weekdays: ['1'] } } };
  const view = render(Screen, { ...base, entryContext, onApplyDraft: (value: any) => applied.push(value),
    client: { async sendMessage(input: any) { calls.push(input); return { conversationId: 'c', result: { kind: 'reply', message: '확인', draft: proposed } }; } } });
  assert.ok(nodes(view.tree).some(node => node.type === 'Image' && node.props.pointerEvents === 'none'));
  assert.ok(nodes(view.tree).some(node => node.type === 'KeyboardAvoidingView' && node.props.behavior === 'padding' && !node.props.style.backgroundColor));
  type(view, '추천해줘'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(calls[0].entryContext, { kind: 'form', draft: entryContext.draft });
  assert.deepEqual(applied, []); assert.match(text(view.tree), /제목: 운동/); assert.match(text(view.tree), /월, 수/);
  press(view, '입력 화면에서 검토'); assert.deepEqual(applied, [proposed]);
});

test('선택 항목에는 화면 제목 없이 id와 버전만 전송한다', async () => {
  const Screen = await component; const calls: any[] = [];
  const view = render(Screen, { ...base, entryContext: { key: 'item:1', kind: 'item', id: 'i1', expectedRevision: 2, title: '화면용 제목' },
    client: { async sendMessage(input: any) { calls.push(input); return { conversationId: 'c', result: { kind: 'reply', message: '답변' } }; } } });
  type(view, '설명해줘'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(calls[0].entryContext, { kind: 'item', id: 'i1', expectedRevision: 2 });
});

test('복구 상담도 같은 항목의 서버 확인 맥락을 전달한다', async () => {
  const Screen = await component; const calls: any[] = [];
  const view = render(Screen, { ...base, entryContext: { key: 'recovery:1', kind: 'item', id: 'i1', expectedRevision: 2, title: '운동' },
    recoveryRequest: { key: 'recovery:1', title: '운동', dateLabel: '11월 1일', text: '복구 상담' },
    client: { async sendMessage(input: any) { calls.push(input); return { conversationId: 'c', result: { kind: 'reply', message: '답변' } }; } } });
  press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(calls[0].entryContext, { kind: 'item', id: 'i1', expectedRevision: 2 });
});

test('같은 복구 초안을 다시 열면 대화와 입력은 유지하고 최신 항목 버전을 전송한다', async () => {
  const Screen = await component; const calls: any[] = [];
  const entryContext = { key: 'same', kind: 'item', id: 'i1', expectedRevision: 2, title: '운동' };
  const recoveryRequest = { key: 'same', title: '운동', dateLabel: '11월 1일', text: '복구 상담' };
  const view = render(Screen, { ...base, entryContext, recoveryRequest,
    client: { async sendMessage(input: any) { calls.push(input); return { conversationId: 'conversation', result: { kind: 'reply', message: '이전 답변' } }; } } });
  press(view, '메시지 보내기'); await view.settle(); type(view, '보관할 초안');
  view.props = { ...view.props, entryContext: { ...entryContext, expectedRevision: 3 }, recoveryRequest: { ...recoveryRequest } };
  view.dirty = true; view.flush();
  const input = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.equal(input.props.value, '보관할 초안'); assert.match(text(view.tree), /이전 답변/);
  press(view, '메시지 보내기'); await view.settle();
  assert.equal(calls[1].entryContext.expectedRevision, 3); assert.equal(calls[1].conversationId, 'conversation');
});

test('요청 중 같은 복구 맥락의 버전 갱신은 완료 후 적용한다', async () => {
  const Screen = await component; const calls: any[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entryContext = { key: 'same', kind: 'item', id: 'i1', expectedRevision: 2, title: '운동' };
  const view = render(Screen, { ...base, entryContext,
    recoveryRequest: { key: 'same', title: '운동', dateLabel: '11월 1일', text: '복구 상담' },
    client: { async sendMessage(input: any) { calls.push(input); if (calls.length === 1) await gate; return { conversationId: 'conversation', result: { kind: 'reply', message: '답변' } }; } } });
  press(view, '메시지 보내기');
  view.props = { ...view.props, entryContext: { ...entryContext, expectedRevision: 3 } }; view.dirty = true; view.flush();
  assert.equal(calls[0].entryContext.expectedRevision, 2);
  release(); await view.settle(); type(view, '다시 질문'); press(view, '메시지 보내기'); await view.settle();
  assert.equal(calls[1].entryContext.expectedRevision, 3);
});

test('다른 폼 세션으로 이동하면 이전 초안의 적용 버튼이 사라진다', async () => {
  const Screen = await component; const applied: any[] = [];
  const draft = { kind: 'task', fields: { title: '추천' } };
  const view = render(Screen, { ...base, entryContext: { key: 'old', kind: 'form', draft: { kind: 'task', fields: { title: '' } } },
    onApplyDraft: (value: any) => applied.push(value),
    client: { async sendMessage() { return { conversationId: 'c', result: { kind: 'reply', message: '초안', draft } }; } } });
  type(view, '추천'); press(view, '메시지 보내기'); await view.settle();
  assert.match(text(view.tree), /입력 화면에서 검토/);
  view.props = { ...view.props, entryContext: { key: 'new', kind: 'form', draft: { kind: 'task', fields: { title: '새 폼' } } } };
  view.dirty = true; view.flush();
  assert.doesNotMatch(text(view.tree), /입력 화면에서 검토/);
  assert.deepEqual(applied, []);
});

test('폼 재요청 중 결과 불명 재시도는 원래 맥락과 키를 유지하고 이전 초안을 새 폼에 표시하지 않는다', async () => {
  const Screen = await component; const calls: any[] = []; let reject!: (error: Error) => void;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const firstContext = { key: 'form-request-1', kind: 'form', draft: { kind: 'task', fields: { title: '처음 입력' } } };
  const nextContext = { key: 'form-request-2', kind: 'form', draft: { kind: 'task', fields: { title: '수정 입력' } } };
  const view = render(Screen, { ...base, entryContext: firstContext, onApplyDraft() {}, client: { async sendMessage(input: any) {
    calls.push(input); if (calls.length === 1) return pending;
    return { conversationId: `conversation-${calls.length}`, result: { kind: 'reply', message: '초안',
      draft: { kind: 'task', fields: { title: calls.length === 2 ? '이전 제안' : '새 제안' } } } };
  } } });
  type(view, '처음 요청'); press(view, '메시지 보내기');
  view.props = { ...view.props, entryContext: nextContext }; view.dirty = true; view.flush();
  reject(new Error('network')); await view.settle();
  assert.match(text(view.tree), /같은 요청만 다시 시도/); press(view, '같은 요청 다시 시도'); await view.settle();
  assert.deepEqual(calls[1], calls[0]); assert.doesNotMatch(text(view.tree), /이전 제안/);
  assert.doesNotMatch(text(view.tree), /입력 화면에서 검토/);
  type(view, '두 번째 요청'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(calls[2].entryContext, { kind: 'form', draft: nextContext.draft });
  assert.notEqual(calls[2].idempotencyKey, calls[0].idempotencyKey);
  assert.match(text(view.tree), /새 제안/);
});

test('같은 작성 폼에서 새 AI 요청을 열면 이전 제안은 숨기고 새 입력으로 대화한다', async () => {
  const Screen = await component; const calls: any[] = [];
  const first = { key: 'first-request', kind: 'form', draft: { kind: 'task', fields: { title: '첫 입력' } } };
  const second = { key: 'second-request', kind: 'form', draft: { kind: 'task', fields: { title: '새 입력' } } };
  const view = render(Screen, { ...base, entryContext: first, onApplyDraft() {}, client: { async sendMessage(input: any) {
    calls.push(input); return { conversationId: `c${calls.length}`, result: { kind: 'reply', message: '초안',
      draft: { kind: 'task', fields: { title: calls.length === 1 ? '첫 제안' : '새 제안' } } } };
  } } });
  type(view, '첫 요청'); press(view, '메시지 보내기'); await view.settle(); assert.match(text(view.tree), /첫 제안/);
  view.props = { ...view.props, entryContext: second }; view.dirty = true; view.flush();
  assert.doesNotMatch(text(view.tree), /첫 제안/); assert.doesNotMatch(text(view.tree), /입력 화면에서 검토/);
  type(view, '새 요청'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(calls[1].entryContext, { kind: 'form', draft: second.draft });
  assert.equal(calls[1].conversationId, null); assert.match(text(view.tree), /새 제안/);
});
