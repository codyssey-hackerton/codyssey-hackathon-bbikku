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
  stdin: { contents: "export { default } from './ChatScreen'; export { ApiError } from '../api/http'; export { operationGuard } from '../api/operationGuard';", resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'native-test', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\.\/ui\/(typography|Icon)|\.\/ChatScheduleSummary|\.\/ChatDeviceContext)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'module.exports=globalThis.__chatHarness.react' :
      path === 'react-native' ? 'module.exports=globalThis.__chatHarness.native' :
      path.endsWith('/typography') ? 'exports.Text="Text";exports.TextInput="TextInput"' :
      path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
      path === './ChatScheduleSummary' ? 'exports.ChatScheduleSummary=()=>null' :
      path === './ChatDeviceContext' ? 'module.exports=()=>null' :
      'exports.jsx=exports.jsxs=globalThis.__chatHarness.jsx;exports.Fragment=globalThis.__chatHarness.fragment' }));
  } }],
}).then(result => { const module: any = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports); module.exports.default.ApiError = module.exports.ApiError; module.exports.default.operationGuard = module.exports.operationGuard; return module.exports.default; });

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
  view.unmount = () => { for (const hook of view.hooks) hook?.cleanup?.(); };
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
  onOpenProposals() {}, onProposalCreated() {}, onOpenReviewSchedule() {}, onClearCoordinationTarget() {} };

test('선택지에 실제 본문을 표시하고 같은 대화에 사용자 메시지로 한 번만 보낸다', async t => {
  const Screen = await component, calls: any[] = []; let finish!: (value: unknown) => void;
  let phone = 0, reminder = 0, proposals = 0;
  const choice = { label: '간단히 조정', message: '저녁 7시로 미루는 제안을 만들어줘' };
  const client = { sendMessage(input: any) {
    calls.push(input);
    if (calls.length === 1) return Promise.resolve({ conversationId: 'conversation', result: { kind: 'reply', message: '어떤 방법이 좋을까요?', suggestions: [choice] } });
    return new Promise(resolve => { finish = resolve; });
  } };
  const view = render(Screen, { ...base, client, onOpenScheduleCall() { phone++; }, renderReminder() { reminder++; return null; },
    onProposalCreated() { proposals++; }, renderProposal(id: string) { return jsx('ProposalCard', { id }); } });
  t.after(view.unmount);
  type(view, '계획을 검토해줘'); press(view, '메시지 보내기'); await view.settle();
  assert.match(text(view.tree), /간단히 조정/); assert.match(text(view.tree), /저녁 7시로 미루는 제안을 만들어줘/);
  const label = `${choice.label}. 보낼 메시지: ${choice.message}`;
  const card = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  assert.ok(card); assert.equal(card.props.disabled, false);
  card.props.onPress(); card.props.onPress(); view.flush();
  assert.equal(calls.length, 2); assert.equal(calls[1].message, choice.message); assert.equal(calls[1].conversationId, 'conversation');
  const busyCard = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  assert.equal(busyCard.props.disabled, true); assert.equal(phone, 0); assert.equal(reminder, 0);
  finish({ conversationId: 'conversation', result: { kind: 'proposal', message: '검토해 주세요', proposalIds: ['pending-proposal'] } });
  await view.settle(); assert.equal(proposals, 1); assert.equal(phone, 0); assert.equal(reminder, 0);
  assert.ok(nodes(view.tree).some(node => node.type === 'ProposalCard' && node.props.id === 'pending-proposal'));
});

test('연결이나 입력 맥락 세대가 바뀐 오래된 선택지는 보낼 수 없다', async t => {
  const Screen = await component, calls: any[] = [];
  const choice = { label: '제안', message: '가능한 시간으로 제안해줘' };
  const client = { async sendMessage(input: any) { calls.push(input); return { conversationId: 'c', result: { kind: 'question',
    message: '고르세요', missingFields: [], suggestions: [choice] } }; } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount);
  type(view, '계획'); press(view, '메시지 보내기'); await view.settle();
  const label = `${choice.label}. 보낼 메시지: ${choice.message}`;
  const oldCard = nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  assert.equal(oldCard.props.disabled, false);
  view.props = { ...view.props, client: { async sendMessage() { throw new Error('unexpected'); } } }; view.dirty = true; view.flush();
  assert.equal(nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label).props.disabled, true);
  view.props = { ...view.props, client }; view.dirty = true; view.flush();
  oldCard.props.onPress(); view.flush(); assert.equal(calls.length, 1);
  assert.equal(nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label).props.disabled, true);
  view.props = { ...view.props, entryContext: { kind: 'item', key: 'new-context', id: 'item', expectedRevision: 1, title: '새 일정' } };
  view.dirty = true; view.flush(); oldCard.props.onPress(); view.flush();
  assert.equal(calls.length, 1);
});

test('다른 작업 또는 미확정 요청이 있으면 선택지를 사용할 수 없다', async t => {
  const Screen = await component, calls: any[] = [];
  const choice = { label: '제안', message: '새 제안을 만들어줘' };
  const client = { async sendMessage(input: any) {
    calls.push(input);
    if (calls.length === 1) return { conversationId: 'c', result: { kind: 'reply', message: '선택', suggestions: [choice] } };
    throw new Screen.ApiError('timeout', 'synthetic', true);
  } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount);
  type(view, '계획'); press(view, '메시지 보내기'); await view.settle();
  const label = `${choice.label}. 보낼 메시지: ${choice.message}`;
  const card = () => nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  const beforeGuard = card();
  const owner = {}; Screen.operationGuard.update(owner, { status: 'pending' });
  beforeGuard.props.onPress(); assert.equal(calls.length, 1);
  view.dirty = true; view.flush(); assert.equal(card().props.disabled, true);
  card().props.onPress(); view.flush(); assert.equal(calls.length, 1);
  Screen.operationGuard.clear(owner); view.dirty = true; view.flush(); assert.equal(card().props.disabled, false);
  press(view, label); await view.settle(); assert.equal(calls.length, 2); assert.equal(card().props.disabled, true);
  card().props.onPress(); view.flush(); assert.equal(calls.length, 2);
});

function fakeWaitTimer(t: any) {
  const timers = new Map<number, () => void>(); let next = 0;
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    assert.equal(delay, 15_000); const id = ++next; timers.set(id, callback); return id;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((id: number) => { timers.delete(id); }) as typeof clearTimeout);
  return { timers, fire() { const [id, callback] = [...timers.entries()][0]; timers.delete(id); callback(); } };
}

test('대기 시간 안내는 실제 진행률을 주장하지 않고 완료·언마운트에서 타이머를 정리한다', async t => {
  const Screen = await component; const clock = fakeWaitTimer(t); const calls: any[] = []; let navigations = 0;
  let complete!: (value: unknown) => void;
  const waiting = new Promise(resolve => { complete = resolve; });
  const view = render(Screen, { ...base, onOpenProposals() { navigations++; }, client: { sendMessage(input: any) { calls.push(input); return waiting; } } });
  t.after(view.unmount);
  assert.doesNotMatch(text(view.tree), /선호·상황/);
  type(view, '안녕'); press(view, '메시지 보내기');
  assert.match(text(view.tree), /답변을 준비하고 있어요/); assert.equal(clock.timers.size, 1);
  clock.fire(); view.flush();
  assert.match(text(view.tree), /답변이 오래 걸리고 있어요/);
  assert.match(text(view.tree), /다른 화면을 확인해도 요청은 취소되지 않아요/);
  press(view, '제안 기록'); assert.equal(navigations, 1);
  assert.equal(calls.length, 1);
  complete({ conversationId: 'c', result: { kind: 'reply', message: '답변' } }); await view.settle();
  assert.doesNotMatch(text(view.tree), /답변이 오래 걸리고 있어요/); assert.equal(clock.timers.size, 0);
  let finish!: (value: unknown) => void;
  view.props = { ...view.props, client: { sendMessage() { return new Promise(resolve => { finish = resolve; }); } } }; view.dirty = true; view.flush();
  type(view, '다시'); press(view, '메시지 보내기'); assert.equal(clock.timers.size, 1);
  view.unmount(); assert.equal(clock.timers.size, 0); finish({ conversationId: 'c', result: { kind: 'reply', message: '끝' } });
});

test('빠른 응답은 대기 안내 타이머를 취소한다', async t => {
  const Screen = await component; const clock = fakeWaitTimer(t);
  const view = render(Screen, { ...base, client: { async sendMessage() { return { conversationId: 'c', result: { kind: 'reply', message: '안녕' } }; } } });
  t.after(view.unmount); type(view, '안녕'); press(view, '메시지 보내기'); assert.equal(clock.timers.size, 1);
  await view.settle(); assert.equal(clock.timers.size, 0); assert.doesNotMatch(text(view.tree), /오래 걸리고 있어요/);
});

test('불확정 오류는 같은 요청만 재시도하고 중복 재시도를 보내지 않는다', async t => {
  const Screen = await component; const clock = fakeWaitTimer(t); const calls: any[] = []; let retryFinish!: (value: unknown) => void;
  const view = render(Screen, { ...base, client: { async sendMessage(input: any) {
    calls.push(input); if (calls.length === 1) throw new Screen.ApiError('provider_unavailable', 'synthetic', false, 503);
    return new Promise(resolve => { retryFinish = resolve; });
  } } });
  t.after(view.unmount); type(view, '요청'); press(view, '메시지 보내기'); await view.settle();
  assert.equal(clock.timers.size, 0); assert.match(text(view.tree), /AI 연결을 사용할 수 없어요/);
  assert.match(text(view.tree), /결과를 확인할 때까지/); assert.doesNotMatch(text(view.tree), /메시지 수정/);
  const retry = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '같은 요청 다시 시도');
  assert.ok(retry); retry.props.onPress(); retry.props.onPress(); view.flush();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.equal(clock.timers.size, 1);
  retryFinish({ conversationId: 'c', result: { kind: 'reply', message: '완료' } }); await view.settle();
  assert.equal(clock.timers.size, 0); assert.doesNotMatch(text(view.tree), /결과를 확인할 때까지/);
});

test('확정 입력 오류는 메시지 수정 경로를 유지한다', async t => {
  const Screen = await component; const view = render(Screen, { ...base, client: { async sendMessage() {
    throw new Screen.ApiError('invalid_request', 'synthetic', false, 400);
  } } });
  t.after(view.unmount); type(view, '입력'); press(view, '메시지 보내기'); await view.settle();
  assert.match(text(view.tree), /입력 내용을 확인해 주세요/); press(view, '메시지 수정');
  assert.equal(nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지').props.value, '입력');
});

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
  assert.match(text(view.tree), /결과를 확인할 때까지/); press(view, '같은 요청 다시 시도'); await view.settle();
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

test('결과 확인 중 재시도는 잠기고 저장된 제안 응답은 원래 성공 경로를 한 번 실행한다', async t => {
  const Screen = await component; const calls: any[] = [], checks: any[] = []; let finish!: (value: unknown) => void; let refreshed = 0;
  const client = { async sendMessage(input: any) { calls.push(input); throw new Screen.ApiError('timeout', 'timeout', true); },
    checkRequest(input: any) { checks.push(input); return new Promise(resolve => { finish = resolve; }); } };
  const view = render(Screen, { ...base, client, onProposalCreated() { refreshed++; }, renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); } }); t.after(view.unmount);
  type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle();
  assert.equal(Screen.operationGuard.hasUnresolved(), true);
  const retry = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '같은 요청 다시 시도');
  const check = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '처리 결과 확인');
  check.props.onPress(); check.props.onPress(); retry.props.onPress(); view.flush();
  assert.equal(checks.length, 1); assert.equal(calls.length, 1);
  assert.deepEqual(checks[0], { requestId: calls[0].requestId, idempotencyKey: calls[0].idempotencyKey, conversationId: null });
  finish({ status: 'completed', result: { response: { conversationId: 'c', result: { kind: 'proposal', message: '복구된 제안', proposalIds: ['p'] } } } });
  await view.settle(); assert.equal(refreshed, 1); assert.match(text(view.tree), /복구된 제안/);
  assert.deepEqual(nodes(view.tree).filter(node => node.type === 'ProposalCard').map(node => node.props.proposalId), ['p']);
  assert.equal(Screen.operationGuard.hasUnresolved(), false); assert.equal(calls.length, 1);
});

test('진행중을 안내하고 retryable 이후 원래 키로만 재시도한다', async t => {
  const Screen = await component; const calls: any[] = []; let checks = 0;
  const client = { async sendMessage(input: any) { calls.push(input); if (calls.length === 1) throw new Screen.ApiError('timeout', 'timeout', true);
    return { conversationId: 'c', result: { kind: 'reply', message: '재시도 결과' } }; },
    async checkRequest() { return { status: ++checks === 1 ? 'running' : 'retryable' }; } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount);
  type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle();
  press(view, '처리 결과 확인'); await view.settle(); assert.match(text(view.tree), /서버에서 요청을 처리 중/);
  const retry = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '같은 요청 다시 시도'); assert.equal(retry.props.disabled, false);
  assert.equal(Screen.operationGuard.hasUnresolved(), true); press(view, '처리 결과 확인'); await view.settle();
  assert.match(text(view.tree), /같은 요청을 다시 시도할 수 있습니다/); press(view, '같은 요청 다시 시도'); await view.settle();
  assert.deepEqual(calls[1], calls[0]); assert.match(text(view.tree), /재시도 결과/); assert.equal(Screen.operationGuard.hasUnresolved(), false);
});

test('조회 404 또는 네트워크 오류는 원본과 미확정 가드를 유지한다', async t => {
  const Screen = await component; let attempts = 0, checkCount = 0;
  const client = { async sendMessage() { attempts++; throw new Screen.ApiError('timeout', 'timeout', true); },
    async checkRequest() { if (++checkCount === 1) throw new Screen.ApiError('not_found', '404', false, 404); throw new Screen.ApiError('network', 'offline', true); } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount); type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle();
  for (let i = 0; i < 2; i++) { press(view, '처리 결과 확인'); await view.settle();
    assert.match(text(view.tree), /결과를 확인하지 못했습니다/); assert.equal(Screen.operationGuard.hasUnresolved(), true); assert.equal(attempts, 1); }
  assert.doesNotMatch(text(view.tree), /메시지 수정/);
});

test('저장된 오류는 성공으로 취급하지 않고 5xx 불명 가드를 유지한다', async t => {
  const Screen = await component; let refreshed = 0;
  const client = { async sendMessage() { throw new Screen.ApiError('timeout', 'timeout', true); },
    async checkRequest() { return { status: 'completed', result: { error: new Screen.ApiError('provider_unavailable', 'failed', false, 503) } }; } };
  const view = render(Screen, { ...base, client, onProposalCreated() { refreshed++; } }); t.after(view.unmount);
  type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle(); press(view, '처리 결과 확인'); await view.settle();
  assert.match(text(view.tree), /서버에 저장된 요청 오류/); assert.match(text(view.tree), /AI 연결을 사용할 수 없어요/);
  assert.equal(refreshed, 0); assert.equal(Screen.operationGuard.hasUnresolved(), true); assert.doesNotMatch(text(view.tree), /메시지 수정/);
});

test('연결이 바뀐 뒤 늦게 온 조회 응답은 이전 결과를 적용하거나 재시도하지 않는다', async t => {
  const Screen = await component; let finish!: (value: unknown) => void, refreshed = 0, calls = 0;
  const original = { async sendMessage() { calls++; throw new Screen.ApiError('timeout', 'timeout', true); },
    checkRequest() { return new Promise(resolve => { finish = resolve; }); } };
  const replacement = { async sendMessage() { throw Error('unexpected'); }, async checkRequest() { throw Error('unexpected'); } };
  const view = render(Screen, { ...base, client: original, onProposalCreated() { refreshed++; } }); t.after(view.unmount);
  type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle(); press(view, '처리 결과 확인');
  view.props = { ...view.props, client: replacement }; view.dirty = true; view.flush();
  finish({ status: 'completed', result: { response: { conversationId: 'c', result: { kind: 'proposal', message: '잘못된 적용', proposalIds: ['p'] } } } });
  await view.settle(); assert.doesNotMatch(text(view.tree), /잘못된 적용/); assert.equal(refreshed, 0); assert.equal(calls, 1);
  assert.equal(Screen.operationGuard.hasUnresolved(), true);
  const retry = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '같은 요청 다시 시도'); assert.equal(retry.props.disabled, true);
});

test('running 확인 후에도 원래 요청 재시도로 만료된 lease를 회수할 수 있다', async t => {
  const Screen = await component; const calls: any[] = []; let checks = 0;
  const client = { async sendMessage(input: any) { calls.push(input);
    if (calls.length === 1) throw new Screen.ApiError('timeout', 'timeout', true);
    if (calls.length === 2) throw new Screen.ApiError('operation_in_progress', 'running', true, 409);
    return { conversationId: 'c', result: { kind: 'reply', message: '원래 요청 완료' } }; },
    async checkRequest() { checks++; return { status: 'running' }; } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount);
  type(view, '원래 요청'); press(view, '메시지 보내기'); await view.settle();
  press(view, '처리 결과 확인'); await view.settle(); assert.match(text(view.tree), /서버에서 요청을 처리 중/);
  press(view, '같은 요청 다시 시도'); await view.settle();
  assert.equal(Screen.operationGuard.hasUnresolved(), true); assert.equal(checks, 1); assert.deepEqual(calls[1], calls[0]);
  press(view, '같은 요청 다시 시도'); await view.settle();
  assert.deepEqual(calls[2], calls[0]); assert.match(text(view.tree), /원래 요청 완료/); assert.equal(Screen.operationGuard.hasUnresolved(), false);
});

test('저장된 확정 4xx는 오류로 복구하고 메시지 수정만 허용한다', async t => {
  const Screen = await component; let refreshed = 0;
  const client = { async sendMessage() { throw new Screen.ApiError('timeout', 'timeout', true); },
    async checkRequest() { return { status: 'completed', result: { error: new Screen.ApiError('conflict', 'changed', false, 409) } }; } };
  const view = render(Screen, { ...base, client, onProposalCreated() { refreshed++; } }); t.after(view.unmount);
  type(view, '수정할 메시지'); press(view, '메시지 보내기'); await view.settle(); press(view, '처리 결과 확인'); await view.settle();
  assert.match(text(view.tree), /기준 정보가 바뀌었어요/); assert.match(text(view.tree), /서버에 저장된 요청 오류/);
  assert.equal(refreshed, 0); assert.equal(Screen.operationGuard.hasUnresolved(), false); press(view, '메시지 수정');
  const input = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.equal(input.props.value, '수정할 메시지');
});

test('재시도 시작 직후의 오래된 조회 버튼은 GET을 보내지 않는다', async t => {
  const Screen = await component; let finish!: (value: unknown) => void, calls = 0, checks = 0;
  const client = { async sendMessage() { calls++; if (calls === 1) throw new Screen.ApiError('timeout', 'timeout', true); return new Promise(resolve => { finish = resolve; }); },
    async checkRequest() { checks++; return { status: 'running' }; } };
  const view = render(Screen, { ...base, client }); t.after(view.unmount); type(view, '요청'); press(view, '메시지 보내기'); await view.settle();
  const retry = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '같은 요청 다시 시도');
  const check = nodes(view.tree).find(node => node.type === 'Pressable' && text(node.children) === '처리 결과 확인');
  retry.props.onPress(); check.props.onPress(); view.flush(); await view.settle(); assert.equal(calls, 2); assert.equal(checks, 0);
  finish({ conversationId: 'c', result: { kind: 'reply', message: '완료' } }); await view.settle();
});

test('전화 요청 응답은 사용자가 확인 버튼을 눌러야 대상과 버전을 전달한다', async t => {
  const Screen = await component; const targets: any[] = [];
  const view = render(Screen, { ...base, onOpenScheduleCall: (target: any) => targets.push(target),
    client: { async sendMessage() { return { conversationId: 'c', result: { kind: 'phone_request', message: '전화 내용을 확인해 주세요.', itemId: 'i1', expectedRevision: 2 } }; } } });
  t.after(view.unmount); type(view, '전화해줘'); press(view, '메시지 보내기'); await view.settle();
  assert.match(text(view.tree), /전화 내용을 확인/); assert.deepEqual(targets, []);
  press(view, '전화 요청 확인'); assert.deepEqual(targets, [{ itemId: 'i1', expectedRevision: 2 }]);
});

test('일반 문의는 일정을 선택하지 않고 확인 버튼을 눌러야 전화 초안으로 전달된다', async t => {
  const Screen = await component; const targets: any[] = [];
  const view = render(Screen, { ...base, onOpenScheduleCall: (target: any) => targets.push(target), client: { async sendMessage() {
    return { conversationId: 'c', result: { kind: 'phone_request', mode: 'inquiry', message: '문의 내용을 확인해 주세요.', brief: '영업시간을 알려 주세요' } };
  } } });
  t.after(view.unmount); type(view, '전화로 물어봐 줘'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(targets, []); press(view, '전화 요청 확인');
  assert.deepEqual(targets, [{ mode: 'inquiry', brief: '영업시간을 알려 주세요' }]);
});

test('복구한 전화 요청도 버튼을 직접 누르기 전에는 전화 단계로 이동하지 않는다', async t => {
  const Screen = await component; const targets: any[] = [];
  const client = { async sendMessage() { throw new Screen.ApiError('timeout', 'timeout', true); }, async checkRequest() {
    return { status: 'completed', result: { response: { conversationId: 'c', result: { kind: 'phone_request', message: '전화 확인', itemId: 'i1', expectedRevision: 2 } } } };
  } };
  const view = render(Screen, { ...base, client, onOpenScheduleCall: (target: any) => targets.push(target) });
  t.after(view.unmount); type(view, '전화해줘'); press(view, '메시지 보내기'); await view.settle();
  press(view, '처리 결과 확인'); await view.settle(); assert.deepEqual(targets, []);
  press(view, '전화 요청 확인'); assert.deepEqual(targets, [{ itemId: 'i1', expectedRevision: 2 }]);
});

test('서버가 반환한 제안만 해당 답변 아래에 표시하며 같은 ID는 중복하지 않는다', async t => {
  const Screen = await component; let sends = 0;
  const view = render(Screen, { ...base, renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); },
    client: { async sendMessage() { sends++; return { conversationId: 'c', result: { kind: 'proposal', message: `제안 답변 ${sends}`,
      proposalIds: sends === 1 ? ['server-a', 'server-b', 'server-a'] : ['server-a'] } }; } } });
  t.after(view.unmount);
  type(view, '제안해줘'); press(view, '메시지 보내기'); await view.settle();
  const tree = nodes(view.tree);
  const cards = tree.filter(node => node.type === 'ProposalCard');
  assert.deepEqual(cards.map(card => card.props.proposalId), ['server-a', 'server-b']);
  assert.ok(tree.findIndex(node => node.type === 'Text' && text(node.children) === '제안 답변 1') < tree.indexOf(cards[0]));
  assert.match(text(view.tree), /아래 제안을 확인해 주세요/);
  assert.doesNotMatch(text(view.tree), /제안 목록에서/);
  type(view, '다시'); press(view, '메시지 보내기'); await view.settle();
  assert.deepEqual(nodes(view.tree).filter(node => node.type === 'ProposalCard').map(node => node.props.proposalId), ['server-a', 'server-b']);
});

test('일반·질문·실패·전화 요청에는 제안 카드를 만들지 않는다', async t => {
  const Screen = await component;
  for (const result of [
    { kind: 'reply', message: '일반 답변' }, { kind: 'question', message: '언제인가요?', missingFields: ['time'] },
    { kind: 'failure', message: '실패', code: 'not_ready', retryable: false },
    { kind: 'phone_request', message: '전화할까요?', itemId: 'event', expectedRevision: 1 },
  ]) {
    const view = render(Screen, { ...base, renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); },
      onOpenScheduleCall() {}, client: { async sendMessage() { return { conversationId: 'c', result }; } } });
    t.after(view.unmount); type(view, '요청'); press(view, '메시지 보내기'); await view.settle();
    assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 0, result.kind);
    if (result.kind === 'phone_request') assert.match(text(view.tree), /전화 요청 확인/);
  }
});

test('비어 있는 제안 ID는 카드로 추측하지 않고 기록 확인을 안내한다', async t => {
  const Screen = await component;
  const view = render(Screen, { ...base, renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); },
    client: { async sendMessage() { return { conversationId: 'c', result: { kind: 'proposal', message: '제안', proposalIds: ['', '  '] } }; } } });
  t.after(view.unmount); type(view, '요청'); press(view, '메시지 보내기'); await view.settle();
  assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 0);
  assert.match(text(view.tree), /제안 정보를 확인할 수 없어요/);
});

test('새 메시지만 자동 스크롤하고 제안 카드 크기 변경은 검토 위치를 유지한다', async t => {
  const Screen = await component; let finish!: (value: unknown) => void; let scrolls = 0;
  const view = render(Screen, { ...base, renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); },
    client: { sendMessage() { return new Promise(resolve => { finish = resolve; }); } } });
  t.after(view.unmount);
  const scroll = () => nodes(view.tree).find(node => node.type === 'ScrollView');
  scroll().props.ref.current = { scrollToEnd() { scrolls++; } };
  type(view, '일정 제안'); press(view, '메시지 보내기');
  scroll().props.onContentSizeChange(); assert.equal(scrolls, 1);
  finish({ conversationId: 'c', result: { kind: 'proposal', message: '제안을 확인해 주세요', proposalIds: ['p'] } });
  await view.settle(); scroll().props.onContentSizeChange(); assert.equal(scrolls, 2);
  scroll().props.onContentSizeChange(); scroll().props.onContentSizeChange(); assert.equal(scrolls, 2);
});

test('다른 제안의 미해결 승인 중 전송과 맥락 전환을 막고 카드와 초안을 보존한다', async t => {
  const Screen = await component; const owner = {}; let interval: (() => void) | undefined; let calls = 0; let cleared = 0;
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => { interval = callback; return 1; }) as typeof setInterval);
  t.mock.method(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  const oldEntry = { key: 'old', kind: 'item', id: 'item-1', expectedRevision: 1, title: '기존 일정' };
  const nextEntry = { key: 'next', kind: 'item', id: 'item-2', expectedRevision: 1, title: '새 일정' };
  const props = { ...base, entryContext: oldEntry, onClearEntryContext() { cleared++; },
    renderProposal(id: string) { return jsx('ProposalCard', { proposalId: id }); },
    client: { async sendMessage() { calls++; return { conversationId: 'c', result: { kind: 'proposal', message: '승인할 제안', proposalIds: ['p'] } }; } } };
  const view = render(Screen, props);
  t.after(() => { Screen.operationGuard.clear(owner); view.unmount(); });
  type(view, '첫 요청'); press(view, '메시지 보내기'); await view.settle();
  assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 1);
  Screen.operationGuard.update(owner, { status: 'pending' });
  type(view, '보존할 초안'); press(view, '메시지 보내기');
  assert.equal(calls, 1); assert.match(text(view.tree), /변경 요청을 먼저 확인/);
  press(view, '맥락 닫기'); assert.equal(cleared, 0);
  view.props = { ...props, entryContext: nextEntry, revisionRequest: { key: 'revision', proposalId: 'p', text: '수정 초안' } };
  view.dirty = true; view.flush();
  assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 1);
  assert.match(text(view.tree), /기존 일정/); assert.doesNotMatch(text(view.tree), /선택한 일정: 새 일정/);
  assert.equal(nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지').props.value, '보존할 초안');
  Screen.operationGuard.update(owner, { status: 'error', error: new Error('timeout'), uncertain: true });
  interval?.(); view.flush();
  assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 1);
  assert.equal(calls, 1);
  Screen.operationGuard.clear(owner); assert.ok(interval); interval!(); view.flush();
  assert.equal(nodes(view.tree).filter(node => node.type === 'ProposalCard').length, 0);
  assert.match(text(view.tree), /선택한 일정: 새 일정|제안 수정 요청 초안/);
});

test('사용자 말풍선은 헤더 없이 본문만 표시하고 AI 응답은 레이블을 유지한다', async t => {
  const Screen = await component;
  const view = render(Screen, { ...base, client: { async sendMessage() { return { conversationId: 'c', result: { kind: 'reply', message: 'AI의 답변' } }; } } });
  t.after(view.unmount); type(view, '사용자의 메시지'); press(view, '메시지 보내기'); await view.settle();
  const userBubble = nodes(view.tree).find(node => node.type === 'View' && Array.isArray(node.children) &&
    node.children.some((child: any) => child?.type === 'Text' && text(child.children) === '사용자의 메시지'));
  assert.ok(userBubble);
  assert.deepEqual(userBubble.children.filter(Boolean).map((child: any) => child.type), ['Text']);
  assert.equal(userBubble.children.find((child: any) => child?.type === 'Text').props.accessibilityLabel, '내 메시지: 사용자의 메시지');
  assert.match(text(view.tree), /AI 응답/);
  assert.match(text(view.tree), /AI의 답변/);
  assert.equal(nodes(view.tree).some(node => node.type === 'Text' && text(node.children) === '나'), false);
});
