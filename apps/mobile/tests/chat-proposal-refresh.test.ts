import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Exercise ChatScreen and the real mutation/client code with a small native host.
// This follows the existing memory panel harness without requiring a native device.
function createHarness() {
  type Instance = { hooks: any[]; index: number; alive: boolean; view: any };
  let current: Instance | undefined;
  const views = new Set<any>();
  const fragment = Symbol('fragment');
  const sameDeps = (a?: unknown[], b?: unknown[]) =>
    a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const jsx = (type: any, props: any, key?: string) => ({ type, props: props ?? {}, key });
  const slot = () => {
    if (!current) throw new Error('hook called outside a component');
    return { instance: current, index: current.index++ };
  };
  const react = {
    useState(initial: any) {
      const { instance, index } = slot();
      if (!instance.hooks[index]) {
        const state = { value: typeof initial === 'function' ? initial() : initial, set: (_update: any) => {} };
        state.set = (update: any) => {
          if (!instance.alive) return;
          const next = typeof update === 'function' ? update(state.value) : update;
          if (!Object.is(next, state.value)) { state.value = next; instance.view.dirty = true; }
        };
        instance.hooks[index] = state;
      }
      const state = instance.hooks[index];
      return [state.value, state.set];
    },
    useMemo(factory: () => any, deps: unknown[]) {
      const { instance, index } = slot();
      const previous = instance.hooks[index];
      if (!previous || !sameDeps(previous.deps, deps)) instance.hooks[index] = { deps, value: factory() };
      return instance.hooks[index].value;
    },
    useRef(initial: any) {
      const { instance, index } = slot();
      return instance.hooks[index] ??= { current: initial };
    },
    useEffect(callback: () => void | (() => void), deps?: unknown[]) {
      const { instance, index } = slot();
      let effect = instance.hooks[index];
      if (!effect) effect = instance.hooks[index] = { deps: undefined, cleanup: undefined };
      if (!sameDeps(effect.deps, deps)) {
        effect.deps = deps;
        instance.view.effects.push(() => {
          effect.cleanup?.();
          effect.cleanup = callback();
        });
      }
    },
  };
  (react as any).useLayoutEffect = react.useEffect;
  const native = {
    ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles },
  };

  function renderer(Component: any, initialProps: any) {
    const view: any = { props: initialProps, dirty: true, effects: [], instances: new Map(), tree: null };
    views.add(view);
    function render(node: any, path: string, seen: Set<string>): any {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`, seen));
      if (node.type === fragment) return render(node.props.children, `${path}.fragment`, seen);
      if (typeof node.type === 'function') {
        const id = `${path}:${node.type.name}:${node.key ?? ''}`;
        let instance: Instance = view.instances.get(id);
        if (!instance) {
          instance = { hooks: [], index: 0, alive: true, view };
          view.instances.set(id, instance);
        }
        seen.add(id);
        instance.index = 0;
        const previous = current;
        current = instance;
        const output = node.type(node.props);
        current = previous;
        return render(output, `${id}.child`, seen);
      }
      return { type: node.type, props: node.props, children: render(node.props.children, `${path}.children`, seen) };
    }
    view.flush = () => {
      for (let count = 0; view.dirty && count < 30; count += 1) {
        view.dirty = false;
        view.effects = [];
        const seen = new Set<string>();
        view.tree = render(jsx(Component, view.props), 'root', seen);
        for (const [id, instance] of view.instances as Map<string, Instance>) {
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
    view.settle = async () => { for (let i = 0; i < 4; i += 1) { await new Promise((done) => setImmediate(done)); view.flush(); } };
    view.unmount = () => { for (const instance of view.instances.values() as Iterable<Instance>) { instance.alive = false; for (const hook of instance.hooks) hook?.cleanup?.(); } view.instances.clear(); views.delete(view); };
    view.flush();
    return view;
  }
  return { react, native, jsx, fragment, renderer, cleanup: () => { for (const view of views) view.unmount(); } };
}

const harness = createHarness();
test.afterEach(() => harness.cleanup());
const components = build({
  stdin: {
    contents: `export { default as ChatScreen } from './ChatScreen';
      export { default as ProposalPanel, ChatProposalCard } from '../proposals/ProposalPanel';
      export { createChatClient } from './client'; export { createApiClient, ApiError } from '../api/http';`,
    resolveDir: resolve(__dirname, '../src/chat'), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface)|\.\/ChatScheduleSummary|\.\.\/contacts\/ContactPanel)$/ },
      (args) => ({ path: args.path, namespace: 'test-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-native' }, ({ path }) => ({
      contents: path.endsWith('/ContactPanel') ? 'module.exports=()=>null' : path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"' :
        path === 'react' ? 'module.exports = __react' :
        path === 'react-native' ? 'module.exports = __native' :
          path === './ChatScheduleSummary' ? 'exports.ChatScheduleSummary = () => null' :
            'exports.jsx = exports.jsxs = __jsx; exports.Fragment = __fragment',
      loader: 'js',
    }));
  } }],
}).then((bundled) => {
  const compiled = { exports: {} };
  new Function('module', 'exports', '__react', '__native', '__jsx', '__fragment', bundled.outputFiles[0].text)(
    compiled, compiled.exports, harness.react, harness.native, harness.jsx, harness.fragment,
  );
  return compiled.exports as {
    ChatScreen: any;
    ProposalPanel: any;
    ChatProposalCard: any;
    createApiClient: (options: any) => any;
    createChatClient: (api: any) => any;
    ApiError: new (code: string, message: string) => Error;
  };
});

function nodes(root: any): any[] {
  if (root === null || root === undefined || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.children)];
}
function textOf(root: any): string {
  if (root === null || root === undefined) return '';
  if (Array.isArray(root)) return root.map(textOf).join('');
  return typeof root === 'object' ? textOf(root.children) : String(root);
}
function press(view: any, label: string) {
  const button = nodes(view.tree).find((node) => node.type === 'Pressable' &&
    (node.props.accessibilityLabel === label || textOf(node.children) === label));
  assert.ok(button, `missing button: ${label}`);
  assert.notEqual(button.props.disabled, true, `disabled button: ${label}`);
  button.props.onPress();
  view.flush();
}
function send(view: any, value: string) {
  const input = nodes(view.tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.ok(input);
  assert.equal(input.props.editable, true);
  input.props.onChangeText(value);
  view.flush();
  press(view, '메시지 보내기');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function chatResponse(result: unknown, conversationId = 'conversation-1') {
  return json({ requestId: 'request-1', data: { conversationId, result } });
}
const proposal = { kind: 'proposal', message: '새 제안을 확인하세요.', proposalIds: ['proposal-1'] };

async function screen(fetcher: typeof fetch, onProposalCreated: () => void) {
  const { ChatScreen, createApiClient, createChatClient } = await components;
  const api = createApiClient({ baseUrl: 'https://mock.invalid', getSessionToken: () => 'test-session', fetcher });
  const props = {
    client: createChatClient(api), timezone: 'Asia/Seoul', scheduleClient: {}, selectedDate: new Date('2026-10-31T00:00:00Z'),
    refreshVersion: 0, onOpenProposals: () => {}, onOpenMemory: () => {}, onOpenReviewSchedule: () => {}, onClearCoordinationTarget: () => {}, onProposalCreated,
  };
  return { ChatScreen, props, view: harness.renderer(ChatScreen, props) };
}

test('chat offers access to automatic review settings', async () => {
  let opened = 0;
  const { props, view } = await screen(async () => chatResponse({ kind: 'reply', message: 'ok' }), () => {});
  view.update({ ...props, onOpenReviewSchedule: () => { opened += 1; } });
  press(view, '자동 검토 설정');
  assert.equal(opened, 1);
});

test('location is requested only on tap and the chosen mode reaches chat; reminder remains a confirmation candidate', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete (globalThis as any).navigator; });
  let locationCalls = 0;
  const timestamp = Date.now();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: {
    getCurrentPosition(success: (position: unknown) => void) {
      locationCalls++;
      success({ coords: { latitude: 37.5, longitude: 127, accuracy: 10 }, timestamp });
    },
  } } });
  const appointment = timestamp + 3_600_000;
  const reminder = { itemId: 'item-1', expectedRevision: 1, title: '합성 약속', timezone: 'Asia/Seoul',
    appointmentAt: new Date(appointment).toISOString(), appointmentEndsAt: new Date(appointment + 3_600_000).toISOString(),
    basis: 'event_start', minutesBefore: 10, reminderAt: new Date(appointment - 600_000).toISOString(),
    expiresAt: new Date(timestamp + 300_000).toISOString() };
  let body: any, shown: unknown;
  const { view, props } = await screen(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return chatResponse({ kind: 'reminder_request', message: '알림을 확인해 주세요.', reminder });
  }, () => assert.fail('reminder candidate is not a saved proposal'));
  view.update({ ...props, renderReminder: (value: unknown) => { shown = value; return '알림 확인 카드'; } });
  assert.equal(locationCalls, 0);
  press(view, '위치·이동수단');
  assert.equal(locationCalls, 0);
  press(view, '현재 위치 사용');
  await view.settle();
  assert.equal(locationCalls, 1);
  press(view, '대중교통');
  send(view, '10분 전에 알림 해줘');
  await view.settle();
  assert.deepEqual(body.deviceContext, { currentLocation: { latitude: 37.5, longitude: 127, accuracyMeters: 10,
    capturedAt: new Date(timestamp).toISOString() }, travelMode: 'transit', notificationSupport: 'device' });
  assert.deepEqual(shown, reminder);
  assert.match(textOf(view.tree), /알림 확인 카드/);
  press(view, '위치 공유 끄기');
  send(view, '다시 확인해줘');
  await view.settle();
  assert.equal(body.deviceContext.currentLocation, undefined);
  assert.equal(body.deviceContext.travelMode, 'transit');
});

test('expired location after an unknown outcome keeps the original request guarded even when status is retryable', async () => {
  const { ApiError } = await components;
  let attempts = 0, checks = 0;
  const { props, view } = await screen(async () => assert.fail('unexpected fetch'), () => {});
  view.update({ ...props, client: {
    async sendMessage() { throw new ApiError(++attempts === 1 ? 'network' : 'location_expired', 'synthetic'); },
    async checkRequest() { checks++; return { status: 'retryable' }; },
  } });
  send(view, '출발 전에 알려줘');
  await view.settle();
  press(view, '같은 요청 다시 시도');
  await view.settle();
  assert.match(textOf(view.tree), /공유한 위치가 만료/);
  assert.doesNotMatch(textOf(view.tree), /같은 요청 다시 시도|메시지 수정/);
  press(view, '처리 결과 확인');
  await view.settle();
  assert.equal(checks, 1);
  assert.equal(attempts, 2);
  assert.match(textOf(view.tree), /중복 방지를 위해 새 요청을 열지 않습니다/);
  const input = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
  assert.equal(input.props.editable, false);
});

test('validated proposals notify the latest parent callback once per successful response', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const requests: RequestInit[] = [];
  let previousCalls = 0;
  let currentCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init!);
    return requests.length === 1 ? first.promise : second.promise;
  };
  const { props, view } = await screen(fetcher, () => { previousCalls += 1; });
  send(view, '일정을 조정해 줘');
  assert.equal(previousCalls, 0);
  assert.match(textOf(view.tree), /답변을 준비하고 있어요/);
  const updated = { ...props, onProposalCreated: () => { currentCalls += 1; } };
  view.update(updated);
  first.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(previousCalls, 0);
  assert.equal(currentCalls, 1);
  assert.match(textOf(view.tree), /새 제안을 확인하세요/);
  assert.match(textOf(view.tree), /승인 전에는 적용되지 않습니다/);
  view.update(updated);
  assert.equal(currentCalls, 1);

  send(view, '다른 시간도 제안해 줘');
  assert.equal(currentCalls, 1);
  assert.equal(JSON.parse(String(requests[1].body)).conversationId, 'conversation-1');
  second.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(currentCalls, 2);
});

for (const result of [
  { kind: 'reply', message: '일반 답변입니다.' },
  { kind: 'question', message: '시간을 알려주세요.', missingFields: ['time'] },
  { kind: 'failure', message: '제안을 만들지 못했습니다.', code: 'not_ready', retryable: false },
]) {
  test(`${result.kind} results do not notify the parent`, async () => {
    let calls = 0;
    const { view } = await screen(async () => chatResponse(result), () => { calls += 1; });
    send(view, '요청');
    await view.settle();
    assert.equal(calls, 0);
    assert.match(textOf(view.tree), new RegExp(result.message));
    assert.doesNotMatch(textOf(view.tree), /승인 전에는 적용되지 않습니다/);
  });
}

test('HTTP failure does not notify; a successful retry preserves the request and notifies once', async () => {
  const pendingRetry = deferred<Response>();
  const requests: RequestInit[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init!);
    if (requests.length === 1) return json({ requestId: 'r', error: { code: 'not_configured', message: 'unavailable', retryable: false } }, 503);
    return pendingRetry.promise;
  };
  const { view } = await screen(fetcher, () => { calls += 1; });
  send(view, '일정 검토');
  await view.settle();
  assert.equal(calls, 0);
  assert.match(textOf(view.tree), /AI 연결이 아직 설정되지 않았어요/);
  press(view, '같은 요청 다시 시도');
  assert.equal(calls, 0);
  assert.equal(requests[1].body, requests[0].body);
  assert.equal((requests[1].headers as Record<string, string>)['Idempotency-Key'], (requests[0].headers as Record<string, string>)['Idempotency-Key']);
  pendingRetry.resolve(chatResponse(proposal));
  await view.settle();
  assert.equal(calls, 1);
});

test('a malformed proposal response is rejected without notifying the parent', async () => {
  let calls = 0;
  const { view } = await screen(async () => chatResponse({ ...proposal, proposalIds: 'invalid' }), () => { calls += 1; });
  send(view, '일정 검토');
  await view.settle();
  assert.equal(calls, 0);
  assert.match(textOf(view.tree), /서버 응답을 확인하지 못했어요/);
});

test('a late proposal from a remounted session cannot notify either session', async () => {
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let oldCalls = 0;
  let newCalls = 0;
  const oldScreen = await screen(async () => oldResponse.promise, () => { oldCalls += 1; });
  const newScreen = await screen(async () => newResponse.promise, () => { newCalls += 1; });
  const Session = ({ revision, props }: { revision: string; props: any }) => harness.jsx(oldScreen.ChatScreen, props, revision);
  const view = harness.renderer(Session, { revision: 'old', props: oldScreen.props });
  send(view, '이전 세션 요청');
  view.update({ revision: 'new', props: newScreen.props });
  assert.doesNotMatch(textOf(view.tree), /이전 세션 요청/);
  send(view, '새 세션 요청');
  oldResponse.resolve(chatResponse(proposal, 'old-conversation'));
  await view.settle();
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 0);
  assert.match(textOf(view.tree), /답변을 준비하고 있어요/);
  assert.doesNotMatch(textOf(view.tree), /새 제안을 확인하세요/);
  newResponse.resolve(chatResponse(proposal, 'new-conversation'));
  await view.settle();
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
});


test('starter chips only fill the draft; the user must send it explicitly', async () => {
  let calls = 0;
  const { view } = await screen(async () => { calls += 1; return chatResponse({ kind: 'reply', message: '검토할게요.' }); }, () => {});
  press(view, '오늘 일정을 함께 정리해줘.');
  assert.equal(calls, 0);
  const input = nodes(view.tree).find((item) => item.type === 'TextInput' && item.props.accessibilityLabel === '채팅 메시지');
  assert.equal(input.props.value, '오늘 일정을 함께 정리해줘.');
  press(view, '메시지 보내기');
  await view.settle();
  assert.equal(calls, 1);
});

function chatInput(view: any) {
  return nodes(view.tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '채팅 메시지');
}

test('revision drafts preserve normal and recovery drafts and use only the original proposal target', async () => {
  const requests: any[] = [];
  const { props, view } = await screen(async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return chatResponse({ kind: 'reply', message: '확인' });
  }, () => {});
  const generalTarget = { id: 'other', expectedRevision: 2, title: '다른 일정' };
  view.update({ ...props, coordinationTarget: generalTarget });
  chatInput(view).props.onChangeText('기존 일반 초안'); view.flush();
  const recovery = { key: 'recovery-key', title: '복구 작업', dateLabel: '2026-10-31', text: '복구 초안' };
  view.update({ ...props, coordinationTarget: generalTarget, recoveryRequest: recovery });
  chatInput(view).props.onChangeText('편집한 복구 초안'); view.flush();
  const revision = { key: 'proposal-1:3', proposalId: 'proposal-1', text: '제안 전체 변경 내용', coordinationTarget: { id: 'original', expectedRevision: 4, title: '원래 일정' } };
  view.update({ ...props, coordinationTarget: generalTarget, recoveryRequest: recovery, revisionRequest: revision });
  assert.equal(chatInput(view).props.value, revision.text);
  assert.equal(requests.length, 0);
  assert.match(textOf(view.tree), /별도 승인이 필요/);
  chatInput(view).props.onChangeText('편집한 수정 요청'); view.flush();
  press(view, '복구 작업 2026-10-31 복구 상담 초안');
  assert.equal(chatInput(view).props.value, '편집한 복구 초안');
  press(view, '기존 대화 초안으로');
  assert.equal(chatInput(view).props.value, '기존 일반 초안');
  press(view, '제안 proposal-1 수정 요청 초안');
  assert.equal(chatInput(view).props.value, '편집한 수정 요청');
  press(view, '메시지 보내기'); await view.settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message, '편집한 수정 요청');
  assert.deepEqual(requests[0].coordinationTarget, { id: 'original', expectedRevision: 4 });
  press(view, '기존 대화 초안으로');
  assert.equal(chatInput(view).props.value, '기존 일반 초안');
  assert.match(textOf(view.tree), /다른 일정/);
});

test('pending and uncertain requests defer revision selection and preserve the retry body', async () => {
  const pending = deferred<Response>();
  const retry = deferred<Response>();
  const requests: RequestInit[] = [];
  const { props, view } = await screen(async (_url, init) => {
    requests.push(init!);
    return requests.length === 1 ? pending.promise : retry.promise;
  }, () => {});
  send(view, '진행 중인 요청');
  const revision = { key: 'p:1', proposalId: 'p', text: '새 수정 초안' };
  view.update({ ...props, revisionRequest: revision });
  assert.equal(chatInput(view).props.editable, false);
  assert.equal(chatInput(view).props.value, '');
  pending.resolve(new Response('invalid', { status: 200 }));
  await view.settle();
  assert.equal(chatInput(view).props.editable, false);
  assert.match(textOf(view.tree), /결과를 확인할 때까지/);
  press(view, '같은 요청 다시 시도');
  assert.equal(requests[1].body, requests[0].body);
  assert.equal((requests[1].headers as Record<string, string>)['Idempotency-Key'], (requests[0].headers as Record<string, string>)['Idempotency-Key']);
  retry.resolve(chatResponse({ kind: 'reply', message: '완료' }));
  await view.settle();
  assert.equal(chatInput(view).props.value, '새 수정 초안');
  assert.equal(requests.length, 2);
});

test('proposal detail revision is read-only and unavailable during an unresolved decision', async () => {
  const { ProposalPanel } = await components;
  const item = { id: 'event-1', revision: 3, kind: 'event', title: '원래 회의', timeSlot: { startsAt: '2026-10-31T10:00:00Z', endsAt: '2026-10-31T11:00:00Z', timezone: 'UTC' }, durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', sourceRefs: [] };
  const { id, revision, sourceRefs, ...fields } = item;
  const proposal = { id: 'p-1', revision: 2, mode: 'personal', baseScheduleRevision: 1, baseContextRevision: 1,
    changeSet: { changes: [{ changeId: 'a', operation: 'update', targetId: id, expectedRevision: revision, after: { ...fields, title: '바뀐 회의' } }, { changeId: 'b', operation: 'create', after: { ...fields, title: '추가 회의' } }] },
    beforeItems: [item], reason: '이유', evidenceRefs: [], validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 1, checkedContextRevision: 1, checkedAt: '2026-10-31T00:00:00Z' }, createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', status: 'pending', coordinationTarget: null };
  let selected: any;
  let rejectDecision!: (error: Error) => void;
  const firstDecision = new Promise((_resolve, reject) => { rejectDecision = reject; });
  const decision = deferred<any>();
  const calls: string[] = [];
  const decisions: any[] = [];
  const api = { get: async (path: string) => { calls.push(path); return path === '/v1/proposals' ? { proposals: [proposal], nextCursor: null } : { proposal }; }, post: async (path: string, body: any, options: any) => { calls.push('POST'); decisions.push({ path, body, options }); return decisions.length === 1 ? firstDecision : decision.promise; } };
  const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {}, onRequestRevision: (value: any) => { selected = value; } });
  await view.settle();
  press(view, '제안 바뀐 회의 외 1개, 확인 대기, 상세 보기'); await view.settle();
  press(view, '수정 요청');
  assert.deepEqual(selected, proposal);
  assert.equal(calls.includes('POST'), false);
  selected = undefined;
  press(view, '제안 승인');
  assert.equal(nodes(view.tree).some((node) => node.type === 'Pressable' && node.props.accessibilityLabel === '수정 요청'), false);
  rejectDecision(new Error('network')); await view.settle();
  assert.match(textOf(view.tree), /처리 여부를 확인하지 못했습니다/);
  assert.equal(nodes(view.tree).some((node) => node.type === 'Pressable' && node.props.accessibilityLabel === '수정 요청'), false);
  press(view, '동일 요청 다시 시도');
  assert.deepEqual(decisions[0], decisions[1]);
  decision.resolve({ outcome: 'applied', proposal: { ...proposal, status: 'applied' }, scheduleRevision: 2 });
  await view.settle();
  assert.equal(selected, undefined);
});

test('proposal summary keeps all decision-relevant changes visible without internal identifiers', async () => {
  const { ProposalPanel } = await components;
  const item = { id: 'private-event-id', revision: 3, kind: 'event', title: '기존 회의',
    timeSlot: { startsAt: '2026-11-02T09:00:00.123456+09:00', endsAt: '2026-11-02T10:00:00+09:00', timezone: 'Asia/Seoul' },
    durationMinutes: null, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending', category: 'personal', attendance: 'unknown',
    sourceRefs: [{ provider: 'google_calendar', accountRef: 'private@example.test', calendarId: 'private-calendar', externalEventId: 'private-external', lastSyncedAt: '2026-11-01T00:00:00Z' }] };
  const { id, revision, sourceRefs, ...fields } = item;
  const proposal = { id: 'private-proposal-id', revision: 2, mode: 'personal', baseScheduleRevision: 1, baseContextRevision: 1,
    changeSet: { changes: [{ changeId: 'private-change-id', operation: 'update', targetId: id, expectedRevision: revision,
      after: { ...fields, title: '변경 회의', timeSlot: { ...fields.timeSlot, startsAt: '2026-11-02T11:00:00+09:00', endsAt: '2026-11-02T12:00:00+09:00' },
        durationMinutes: 60, deadline: '2026-11-03T12:00:00+09:00', flexibility: 'fixed', involvement: 'shared', category: 'work', attendance: 'absent', completion: 'incomplete' } }] },
    beforeItems: [item], reason: '일정을 옮겨요', evidenceRefs: ['private-evidence'],
    validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 1, checkedContextRevision: 1, checkedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-11-03T12:00:00+09:00', status: 'pending', coordinationTarget: null };
  const decisions: any[] = [];
  const api = { get: async (path: string) => path === '/v1/proposals' ? { proposals: [proposal], nextCursor: null } : { proposal },
    post: async (_path: string, body: any) => { decisions.push(body); return { outcome: 'applied', proposal: { ...proposal, status: 'applied' }, scheduleRevision: 2 }; } };
  const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {}, onRequestRevision: () => {} });
  await view.settle();
  assert.doesNotMatch(textOf(view.tree), /private-proposal-id|생성:|버전:/);
  press(view, '제안 변경 회의, 확인 대기, 상세 보기'); await view.settle();
  const text = textOf(view.tree);
  for (const value of ['기존 회의', '변경 회의', '.123456', '확인 기한:', '소요 시간:', '마감:', '시간 조정:', '참여 범위:', '분류:', '완료 상태:', '참석 상태:', '연결된 원본이 있는 일정']) assert.ok(text.includes(value), `missing ${value}`);
  assert.doesNotMatch(text, /private-proposal-id|private-change-id|private-event-id|private@example\.test|private-calendar|private-external|private-evidence|서버 검증 결과|기준 일정 버전/);
  assert.equal(decisions.length, 0);
  press(view, '제안 승인'); await view.settle();
  assert.equal(decisions.length, 1); assert.equal(decisions[0].proposalRevision, 2);
});

test('invalid proposal displays actionable conflict and missing information while approval stays disabled', async () => {
  const { ProposalPanel } = await components;
  const item = { id: 'event-hidden', revision: 1, kind: 'event', title: '겹치는 일정',
    timeSlot: { startsAt: '2026-11-02T09:00:00+09:00', endsAt: '2026-11-02T10:00:00+09:00', timezone: 'Asia/Seoul' },
    durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending', sourceRefs: [] };
  const { id, revision, sourceRefs, ...fields } = item;
  const proposal = { id: 'p-invalid', revision: 1, mode: 'personal', baseScheduleRevision: 1, baseContextRevision: 1,
    changeSet: { changes: [{ changeId: 'c-invalid', operation: 'update', targetId: id, expectedRevision: revision, after: { ...fields, title: '새 일정' } }] },
    beforeItems: [item], reason: '일정 변경', evidenceRefs: [],
    validation: { valid: false, conflicts: [{ targetIds: [id], reason: 'overlap:c-invalid' }], missingFields: ['changes[0].after.deadline'], protectedTargets: [id], checkedScheduleRevision: 1, checkedContextRevision: 1, checkedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z', expiresAt: null, status: 'pending', coordinationTarget: null };
  const api = { get: async (path: string) => path === '/v1/proposals' ? { proposals: [proposal], nextCursor: null } : { proposal }, post: async () => { throw new Error('unexpected write'); } };
  const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {}, onRequestRevision: () => {} });
  await view.settle(); press(view, '제안 새 일정, 확인 대기, 상세 보기'); await view.settle();
  const text = textOf(view.tree);
  assert.match(text, /시간이 겹칩니다/); assert.match(text, /빠진 정보: 마감/); assert.match(text, /보호된 일정: 겹치는 일정/);
  assert.doesNotMatch(text, /overlap:|c-invalid|event-hidden/);
  assert.equal(nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '제안 승인')?.props.disabled, true);
  assert.equal(nodes(view.tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '제안 거절')?.props.disabled, false);
});

test('create and delete show meaningful values while default fields stay in collapsed details', async () => {
  const { ProposalPanel } = await components;
  const timeSlot = { startsAt: '2026-11-02T09:00:00+09:00', endsAt: '2026-11-02T10:00:00+09:00', timezone: 'Asia/Seoul' };
  const item = { id: 'e1', revision: 1, kind: 'event', title: '기존 공동 일정', timeSlot, durationMinutes: 60,
    deadline: '2026-11-03T10:00:00+09:00', flexibility: 'fixed', involvement: 'shared', completion: 'completed',
    attendance: 'absent', category: 'work', sourceRefs: [] };
  const created = { kind: 'event', title: '새 일정', timeSlot, durationMinutes: null, deadline: null,
    flexibility: 'flexible', involvement: 'personal', completion: 'pending' };
  const proposal = { id: 'p1', revision: 1, mode: 'personal', baseScheduleRevision: 0, baseContextRevision: 0,
    changeSet: { changes: [{ changeId: 'add', operation: 'create', after: created }, { changeId: 'remove', operation: 'delete', targetId: item.id, expectedRevision: item.revision }] },
    beforeItems: [item], reason: '일정 정리', evidenceRefs: [],
    validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 0, checkedContextRevision: 0, checkedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z', expiresAt: null, status: 'pending', coordinationTarget: null };
  const api = { get: async (path: string) => path === '/v1/proposals' ? { proposals: [proposal], nextCursor: null } : { proposal },
    post: async () => { throw new Error('unexpected write'); } };
  const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged() {}, onBack() {}, onRequestRevision() {} });
  await view.settle(); press(view, '제안 새 일정 외 1개, 확인 대기, 상세 보기'); await view.settle();
  const collapsed = textOf(view.tree);
  for (const value of ['새 일정', '기존 공동 일정', '공동', '고정', '소요 60분', '마감 ', '분류 업무', '완료 완료', '참석 불참']) assert.ok(collapsed.includes(value), `missing ${value}`);
  assert.doesNotMatch(collapsed, /소요 미설정|마감 미설정|분류 미분류|완료 대기|참석 미기록/);
  press(view, '상세 정보 보기');
  assert.match(textOf(view.tree), /소요 미설정/); assert.match(textOf(view.tree), /마감 미설정/);
  assert.match(textOf(view.tree), /분류 미분류/); assert.match(textOf(view.tree), /완료 대기/); assert.match(textOf(view.tree), /참석 미기록/);
});

test('proposal confirmation deadline displays exact instant in the device timezone', async () => {
  const previousTimezone = process.env.TZ; process.env.TZ = 'Asia/Seoul';
  try {
    const { ProposalPanel } = await components;
    const slot = { startsAt: '2026-11-02T09:00:00Z', endsAt: '2026-11-02T10:00:00Z', timezone: 'UTC' };
    const after = { kind: 'event', title: '일정', timeSlot: slot, durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' };
    const proposal = { id: 'p-time', revision: 1, mode: 'personal', baseScheduleRevision: 0, baseContextRevision: 0,
      changeSet: { changes: [{ changeId: 'c', operation: 'create', after }] }, beforeItems: [], reason: '시각 확인', evidenceRefs: [],
      validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [], checkedScheduleRevision: 0, checkedContextRevision: 0, checkedAt: '2026-10-31T00:00:00Z' },
      createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-10-31T23:56:31.276123Z', status: 'pending', coordinationTarget: null };
    let writes = 0;
    const api = { get: async (path: string) => path === '/v1/proposals' ? { proposals: [proposal], nextCursor: null } : { proposal },
      post: async () => { writes++; throw new Error('unexpected write'); } };
    const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {}, onRequestRevision: () => {} });
    {
      await view.settle(); press(view, '제안 일정, 확인 대기, 상세 보기'); await view.settle();
      const deadline = nodes(view.tree).find(node => node.type === 'Text' && textOf(node.children).startsWith('확인 기한:'));
      assert.ok(deadline); const label = textOf(deadline.children);
      assert.match(label, /2026\D+11\D+1\D+오전\s+8:56:31\.276123/); assert.doesNotMatch(label, /2026-10-31T23:56/);
      assert.equal(proposal.expiresAt, '2026-10-31T23:56:31.276123Z'); assert.equal(writes, 0);
    }
  } finally { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; }
});

function inlineProposal(id: string, title: string, status = 'pending') {
  const after = { kind: 'event', title, timeSlot: { startsAt: '2026-11-02T09:00:00Z', endsAt: '2026-11-02T10:00:00Z', timezone: 'UTC' },
    durationMinutes: null, deadline: null, flexibility: 'fixed', involvement: 'personal', completion: 'pending' };
  return { id, revision: 1, mode: 'personal', baseScheduleRevision: 1, baseContextRevision: 0, changeSet: { changes: [{ changeId: 'c1', operation: 'create', after }] },
    beforeItems: [], reason: '상세에서만 보이는 긴 설명입니다.', evidenceRefs: [], validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [],
      checkedScheduleRevision: 1, checkedContextRevision: 0, checkedAt: '2026-10-31T00:00:00Z' }, createdAt: '2026-10-31T00:00:00Z', expiresAt: null, status, coordinationTarget: null };
}

test('normal inline proposal offers only accept and reject without status or reason', async () => {
  const { ChatProposalCard } = await components; const proposal = inlineProposal('p/1', '운동'); const reads: string[] = []; const writes: any[] = [];
  const api = { async get(path: string) { reads.push(path); return { proposal }; }, async post(path: string, body: any, options: any) {
    writes.push({ path, body, options }); return { outcome: 'rejected', proposal: { ...proposal, status: 'rejected' }, scheduleRevision: 1 }; } };
  const view = harness.renderer(ChatProposalCard, { api, id: 'p/1', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} });
  await view.settle(); assert.deepEqual(reads, ['/v1/proposals/p%2F1']); assert.match(textOf(view.tree), /운동/);
  assert.equal(nodes(view.tree).filter(node => node.type === 'Text' && textOf(node.children) === '운동').length, 1);
  assert.doesNotMatch(textOf(view.tree), /상세에서만 보이는 긴 설명/); assert.ok(!nodes(view.tree).some(node => node.type === 'ScrollView'));
  assert.deepEqual(nodes(view.tree).filter(node => node.type === 'Pressable').map(node => node.props.accessibilityLabel), ['수락', '거절']);
  assert.doesNotMatch(textOf(view.tree), /확인 대기|이유 보기|수정/); assert.match(textOf(view.tree), /일정 추가/);
  assert.doesNotMatch(textOf(view.tree), /변경 전|변경 후|없음 \(새 일정\)/); assert.equal(writes.length, 0);
  press(view, '거절'); await view.settle(); assert.equal(writes.length, 1); assert.equal(writes[0].body.decision, 'reject');
  assert.match(textOf(view.tree), /제안을 거절했습니다/);
});

test('inline pending and uncertain decision keep original ID, API and retry identifiers until resolved', async () => {
  const { ChatProposalCard } = await components; const oldProposal = inlineProposal('old', '기존 운동'), newProposal = inlineProposal('new', '새 운동');
  const first = deferred<any>(), retry = deferred<any>(); const oldPosts: any[] = [], newReads: string[] = [];
  const api = { async get(path: string) { assert.equal(path, '/v1/proposals/old'); return { proposal: oldProposal }; }, post(path: string, body: any, options: any) {
    oldPosts.push({ path, body, options }); return oldPosts.length === 1 ? first.promise : retry.promise; } };
  const nextApi = { async get(path: string) { newReads.push(path); return { proposal: newProposal }; }, async post() { throw new Error('unexpected new write'); } };
  const props = { api, id: 'old', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} };
  const view = harness.renderer(ChatProposalCard, props); await view.settle();
  press(view, '수락'); assert.equal(oldPosts.length, 1);
  assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '제안 접기')); assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '수락'));
  view.update({ ...props, api: nextApi, id: 'new' }); assert.match(textOf(view.tree), /진행 중인 제안 요청/); assert.deepEqual(newReads, []);
  first.reject(new Error('network')); await view.settle(); assert.match(textOf(view.tree), /동일한 요청만 다시 시도/); assert.deepEqual(newReads, []);
  press(view, '동일 요청 다시 시도'); assert.deepEqual(oldPosts[1], oldPosts[0]);
  retry.resolve({ outcome: 'applied', proposal: { ...oldProposal, status: 'applied' }, scheduleRevision: 2 }); await view.settle();
  assert.deepEqual(newReads, ['/v1/proposals/new']); assert.match(textOf(view.tree), /새 운동/); assert.doesNotMatch(textOf(view.tree), /기존 운동/);
});

test('inline card rejects mismatched IDs and stale proposals do not offer approval', async () => {
  const { ChatProposalCard } = await components; let posts = 0;
  const wrong = inlineProposal('wrong', '다른 일정'); const stale = inlineProposal('stale', '기한 지난 일정', 'expired');
  const api = { async get(path: string) { return { proposal: path.endsWith('/stale') ? stale : wrong }; }, async post() { posts++; } };
  const props = { api, id: 'expected', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} };
  const view = harness.renderer(ChatProposalCard, props); await view.settle(); assert.match(textOf(view.tree), /제안 응답을 확인할 수 없습니다/);
  assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '수락'));
  view.update({ ...props, id: 'stale' }); await view.settle(); assert.match(textOf(view.tree), /만료됨/);
  assert.ok(!nodes(view.tree).some(node => node.props?.accessibilityLabel === '수락')); assert.equal(posts, 0);
});

test('separate inline cards cannot start a second approval while one is unresolved', async () => {
  const { ChatProposalCard } = await components; const pending = deferred<any>(); const first = inlineProposal('first', '첫 일정'); const second = inlineProposal('second', '둘째 일정'); const posts: string[] = [];
  const api = { async get(path: string) { return { proposal: path.endsWith('/first') ? first : second }; }, post(path: string) { posts.push(path); return pending.promise; } };
  const props = { api, refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} };
  const a = harness.renderer(ChatProposalCard, { ...props, id: 'first' }); const b = harness.renderer(ChatProposalCard, { ...props, id: 'second' });
  await a.settle(); await b.settle();
  press(a, '수락'); press(b, '수락'); assert.deepEqual(posts, ['/v1/proposals/first/decision']);
  assert.match(textOf(b.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  pending.resolve({ outcome: 'applied', proposal: { ...first, status: 'applied' }, scheduleRevision: 2 }); await a.settle();
});

test('proposal list titles use changed fields, deletion uses before title and reason stays in detail', async () => {
  const { ProposalPanel } = await components; const source = inlineProposal('delete', '미사용');
  const before = { ...source.changeSet.changes[0].after, id: 'target', revision: 1, title: '기존 운동', sourceRefs: [] };
  const deleted = { ...source, changeSet: { changes: [{ changeId: 'd', operation: 'delete', targetId: 'target', expectedRevision: 1 }] }, beforeItems: [before], reason: '삭제 설명 원문' };
  const multi = inlineProposal('multi', '운동'); multi.changeSet.changes.push({ ...multi.changeSet.changes[0], changeId: 'c2' }); multi.reason = '긴 이유 원문';
  const api = { async get(path: string) { if (path === '/v1/proposals') return { proposals: [deleted, multi], nextCursor: null }; return { proposal: deleted }; }, async post() { throw new Error('unexpected write'); } };
  const view = harness.renderer(ProposalPanel, { api, refreshVersion: 0, onScheduleChanged() {}, onBack() {}, onRequestRevision() {} }); await view.settle();
  assert.ok(nodes(view.tree).some(node => node.props?.accessibilityLabel === '제안 기존 운동, 확인 대기, 상세 보기'));
  assert.ok(nodes(view.tree).some(node => node.props?.accessibilityLabel === '제안 운동 외 1개, 확인 대기, 상세 보기'));
  assert.doesNotMatch(textOf(view.tree), /삭제 설명 원문|긴 이유 원문/);
  press(view, '제안 기존 운동, 확인 대기, 상세 보기'); await view.settle();
  assert.match(textOf(view.tree), /삭제 설명 원문/); assert.match(textOf(view.tree), /변경 전/); assert.match(textOf(view.tree), /변경 후/); assert.match(textOf(view.tree), /없음 \(삭제\)/);
});

test('proposal cards use the device timezone across Korean and US date boundaries without losing precision', async () => {
  const oldTimezone = process.env.TZ;
  try {
    const { ChatProposalCard } = await components; const proposal = inlineProposal('timezone', '시각 검사');
    proposal.changeSet.changes[0].after.timeSlot = { startsAt: '2026-11-04T00:30:05.123456Z', endsAt: '2026-11-04T02:00:00Z', timezone: 'Pacific/Honolulu' };
    const original = structuredClone(proposal); const writes: any[] = [];
    const api = { async get() { return { proposal }; }, async post(path: string, body: any) { writes.push({ path, body }); return { outcome: 'applied', proposal: { ...proposal, status: 'applied' }, scheduleRevision: 2 }; } };
    process.env.TZ = 'Asia/Seoul';
    const korean = harness.renderer(ChatProposalCard, { api, id: 'timezone', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} }); await korean.settle();
    assert.match(textOf(korean.tree), /2026년 11월 4일 오전 9:30:05\.123456 ~ 오전 11:00/);
    assert.doesNotMatch(textOf(korean.tree), /GMT|UTC|Pacific\/Honolulu|2026-11-04T/);
    press(korean, '수락'); await korean.settle(); assert.equal(writes.length, 1); assert.deepEqual(proposal, original);
    korean.unmount();
    process.env.TZ = 'America/Los_Angeles';
    const american = harness.renderer(ChatProposalCard, { api, id: 'timezone', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} }); await american.settle();
    assert.match(textOf(american.tree), /2026년 11월 3일 오후 4:30:05\.123456 ~ 오후 6:00/);
    assert.doesNotMatch(textOf(american.tree), /GMT|UTC|Pacific\/Honolulu|2026-11-04T/); assert.deepEqual(proposal, original);
  } finally { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; }
});

test('compact changes expose update and delete approval scope and enforce validation', async () => {
  const { ChatProposalCard } = await components; const start = inlineProposal('compact', '새 제목');
  const after = { ...start.changeSet.changes[0].after, location: '홍대', category: 'work', durationMinutes: 60 };
  const before = { ...after, id: 'event', revision: 1, title: '기존 제목', location: '강남', category: 'personal', durationMinutes: 30, sourceRefs: [] };
  const update = { ...start, id: 'update', beforeItems: [before], changeSet: { changes: [{ changeId: 'update', operation: 'update', targetId: 'event', expectedRevision: 1, after }] } };
  const removed = { ...update, id: 'removed', changeSet: { changes: [{ changeId: 'delete', operation: 'delete', targetId: 'event', expectedRevision: 1 }] } };
  const invalid = { ...update, id: 'invalid', validation: { ...update.validation, valid: false, conflicts: [{ reason: 'overlap', targetIds: ['event'] }], missingFields: ['deadline'], protectedTargets: ['event'] } };
  const byId: Record<string, any> = { update, removed, invalid }; let writes = 0;
  const api = { async get(path: string) { return { proposal: byId[path.split('/').pop()!] }; }, async post() { writes++; } };
  const props = { api, id: 'update', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} };
  const view = harness.renderer(ChatProposalCard, props); await view.settle(); let text = textOf(view.tree);
  for (const value of ['기존 제목', '새 제목', '변경 전', '변경 후', '강남', '홍대', '소요 시간:', '분류:']) assert.ok(text.includes(value), `missing ${value}`);
  assert.doesNotMatch(text, /제안 이유|확인 기한:|GMT|UTC/); assert.ok(nodes(view.tree).some(node => node.props?.accessibilityLabel === '수락'));
  view.update({ ...props, id: 'removed' }); await view.settle(); text = textOf(view.tree);
  assert.match(text, /기존 제목/); assert.match(text, /변경 후: 삭제/);
  view.update({ ...props, id: 'invalid' }); await view.settle(); text = textOf(view.tree);
  assert.match(text, /시간이 겹칩니다/); assert.match(text, /빠진 정보: 마감/); assert.match(text, /보호된 일정: 기존 제목/);
  assert.equal(nodes(view.tree).find(node => node.props?.accessibilityLabel === '수락').props.disabled, true); assert.equal(writes, 0);
});

test('shared inline acceptance preserves the original schedule and only then offers contact preparation', async () => {
  const { ChatProposalCard } = await components; const base = inlineProposal('shared', '공동 약속');
  const proposal = { ...base, mode: 'coordination', coordinationTarget: { id: 'event', expectedRevision: 1 } }; const writes: any[] = [];
  const api = { async get() { return { proposal }; }, async post(_path: string, body: any) {
    writes.push(body); return { outcome: 'awaiting_contact', proposal: { ...proposal, status: 'awaiting_contact' }, scheduleRevision: 1 }; } };
  const view = harness.renderer(ChatProposalCard, { api, id: 'shared', refreshVersion: 0, onScheduleChanged() {}, onRequestRevision() {} });
  await view.settle(); assert.match(textOf(view.tree), /원 일정은 유지되며 연락은 별도로 진행/);
  assert.deepEqual(nodes(view.tree).filter(node => node.type === 'Pressable').map(node => node.props.accessibilityLabel), ['수락', '거절']);
  assert.equal(writes.length, 0); press(view, '수락'); await view.settle(); assert.equal(writes.length, 1);
  assert.match(textOf(view.tree), /원 일정은 유지됩니다/); assert.match(textOf(view.tree), /연락 대기/);
  assert.ok(nodes(view.tree).some(node => node.props?.accessibilityLabel === '연락 준비'));
});
