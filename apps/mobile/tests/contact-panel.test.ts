import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// The same small host-renderer approach used by app-integration.test.ts; no native device or server.
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
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: any) => styles },
  };
  const host = { react, native, jsx, fragment, fontState: [true, null] };
  (globalThis as any).__contactPanelHarness = host;

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
const components = build({
  stdin: { contents: `export { default as ContactPanel } from '../src/contacts/ContactPanel';
    export { default as ProposalPanel } from '../src/proposals/ProposalPanel';
    export { default as App } from '../App'; export { ApiError } from '../src/api/http';
    export { operationGuard } from '../src/api/operationGuard';`, resolveDir: resolve(__dirname), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.otf': 'empty', '.ttf': 'empty' },
  plugins: [{ name: 'mock-native', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|react-native-safe-area-context|expo-status-bar|expo-font|\.\/(Icon|typography)|.*ui\/(typography|Icon|GlassSurface))$/ },
      args => ({ path: args.path, namespace: 'contact-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'contact-native' }, ({ path }) => ({
      contents: path.endsWith('/Icon') ? 'exports.Icon=()=>null' :
        path.endsWith('ui/GlassSurface') ? 'exports.GlassSurface=({children})=>children' :
        path.endsWith('/typography') ? 'exports.Text="Text"; exports.TextInput="TextInput"; exports.FontReadyContext={Provider:({children})=>children}' :
        path === 'expo-font' ? 'exports.useFonts=()=>globalThis.__contactPanelHarness.fontState' :
        path === 'react' ? 'module.exports=globalThis.__contactPanelHarness.react' :
        path === 'react-native' ? 'module.exports=globalThis.__contactPanelHarness.native' :
        path === 'react-native-safe-area-context' ? 'exports.SafeAreaProvider=({children})=>children; exports.SafeAreaView="View"' :
        path === 'expo-status-bar' ? 'exports.StatusBar="StatusBar"' :
          'exports.jsx=exports.jsxs=globalThis.__contactPanelHarness.jsx; exports.Fragment=globalThis.__contactPanelHarness.fragment', loader: 'js',
    }));
    builder.onResolve({ filter: /^\.\/src\/(chat\/ChatScreen|memory\/MemoryPanel|screens\/CalendarScreen|screens\/DayScreen)$/ },
      args => ({ path: args.path, namespace: 'contact-screen' }));
    builder.onLoad({ filter: /.*/, namespace: 'contact-screen' }, ({ path }) => ({
      contents: `const {jsx}=require('react/jsx-runtime'); module.exports=function Stub(props){return jsx(${JSON.stringify(path.split('/').pop())},props)}`,
      loader: 'js',
    }));
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
function input(view: any, label: string) {
  const found = nodes(view.tree).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  assert.ok(found, `missing input: ${label}`); return found;
}
function enter(view: any, label: string, value: string) {
  const found = input(view, label);
  assert.notEqual(found.props.editable, false, `locked input: ${label}`);
  found.props.onChangeText(value); view.flush();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const oldSlot = { startsAt: '2026-11-02T09:00:00+09:00', endsAt: '2026-11-02T10:00:00+09:00', timezone: 'Asia/Seoul' };
const newSlot = { startsAt: '2026-11-02T11:00:00+09:00', endsAt: '2026-11-02T12:00:00+09:00', timezone: 'Asia/Seoul' };
const before = { id: 'event-1', revision: 3, kind: 'event', title: '기존 회의', timeSlot: oldSlot, durationMinutes: null,
  deadline: null, flexibility: 'flexible', involvement: 'shared', completion: 'pending', sourceRefs: [] };
const { id: _id, revision: _revision, sourceRefs: _sources, ...fields } = before;
const proposal = {
  id: 'proposal-1', revision: 2, mode: 'coordination', coordinationTarget: { id: before.id, expectedRevision: 3 },
  baseScheduleRevision: 7, baseContextRevision: 2, beforeItems: [before],
  changeSet: { changes: [{ changeId: 'move-1', operation: 'update', targetId: before.id, expectedRevision: 3,
    after: { ...fields, title: '옮긴 회의', timeSlot: newSlot } }] },
  reason: '시간 조정', evidenceRefs: [], validation: { valid: true, conflicts: [], missingFields: [], protectedTargets: [],
    checkedScheduleRevision: 7, checkedContextRevision: 2, checkedAt: '2026-10-31T10:00:00Z' },
  createdAt: '2026-10-31T10:00:00Z', expiresAt: null, status: 'pending',
};
const alternative = { ...proposal, id: 'proposal-2', revision: 4, reason: '취소 대안',
  changeSet: { changes: [{ changeId: 'delete-2', operation: 'delete', targetId: before.id, expectedRevision: 3 }] } };
const recipient = { id: 'recipient-1', displayName: '테스트 상대', channel: 'email', address: 'recipient@example.test',
  confirmedByUserAt: '2026-10-31T10:00:00Z' };
const draft = { id: 'contact-1', revision: 1, baseScheduleRevision: 7, baseContextRevision: 2,
  recipientRef: recipient.id, recipientSnapshot: { displayName: recipient.displayName, channel: 'email', address: recipient.address },
  channel: 'email', purpose: '회의 일정 조정', messageOrCallBrief: '가능하신 시간을 알려 주세요.',
  allowedOptions: [{ optionId: 'option-1', proposalId: proposal.id, proposalRevision: proposal.revision }],
  approvalId: null, executionKey: 'execution-1', providerOperationId: null, deliveryStatus: 'pending_approval',
  negotiationStatus: 'not_started', createdAt: '2026-10-31T10:00:00Z' };
const ready = { ...draft, approvalId: 'approval-1', deliveryStatus: 'ready' };
const sent = { ...ready, deliveryStatus: 'sent_or_connected', negotiationStatus: 'awaiting_response', providerOperationId: 'provider-1' };

type Call = { method: 'GET' | 'POST'; path: string; body?: any; options?: any };
function memoryApi(initial: any[] = []) {
  const calls: Call[] = [];
  const contacts = new Map<string, any>(initial.map(item => [item.id, structuredClone(item)]));
  const proposals = new Map([[proposal.id, proposal], [alternative.id, alternative]]);
  const api: any = {
    connection: { status: 'available', senderAddress: 'sender@example.test' },
    replyConnection: { status: 'available', senderAddress: 'sender@example.test' },
    phoneConnection: { status: 'available', senderNumber: '+15550000001' },
    getHook: undefined, postHook: undefined,
    async get(path: string) {
      calls.push({ method: 'GET', path });
      if (api.getHook) { const result = api.getHook(path); if (result !== undefined) return await result; }
      const url = new URL(path, 'https://api.example.test');
      if (url.pathname === '/v1/proposals') return { proposals: [...proposals.values()], nextCursor: null };
      if (url.pathname.startsWith('/v1/proposals/')) {
        const item = proposals.get(decodeURIComponent(url.pathname.slice('/v1/proposals/'.length)));
        if (!item) throw new Error('unknown mock proposal');
        return { proposal: structuredClone(item) };
      }
      if (url.pathname === '/v1/contact-requests') {
        const proposalId = url.searchParams.get('proposalId');
        return { contactRequests: [...contacts.values()].filter(item => item.allowedOptions.some((option: any) => option.proposalId === proposalId)).map(item => structuredClone(item)) };
      }
      if (url.pathname.startsWith('/v1/contact-requests/')) {
        const item = contacts.get(decodeURIComponent(url.pathname.slice('/v1/contact-requests/'.length)));
        if (!item) throw new Error('unknown mock contact');
        return { contactRequest: structuredClone(item) };
      }
      if (url.pathname === '/v1/email-connection') return structuredClone(api.connection);
      if (url.pathname === '/v1/email-reply-connection') return structuredClone(api.replyConnection);
      if (url.pathname === '/v1/phone-connection') return structuredClone(api.phoneConnection);
      throw new Error(`unexpected mock GET ${path}`);
    },
    async post(path: string, body: any, options: any) {
      calls.push({ method: 'POST', path, body: structuredClone(body), options: structuredClone(options) });
      if (path.endsWith('/send')) assert.ok(typeof body.expectedSenderAddress === 'string' && body.expectedSenderAddress.trim());
      if (api.postHook) { const result = api.postHook(path, body, options); if (result !== undefined) return await result; }
      if (path === '/v1/recipients') { api.savedRecipient = { ...recipient, displayName: body.displayName, address: body.address, channel: body.channel }; return { recipient: api.savedRecipient }; }
      if (path === '/v1/contact-requests') {
        const savedRecipient = api.savedRecipient ?? recipient;
        const contactRequest = { ...draft, channel: body.channel, recipientSnapshot: { displayName: savedRecipient.displayName, channel: savedRecipient.channel, address: savedRecipient.address }, recipientRef: body.recipientRef, purpose: body.purpose,
          messageOrCallBrief: body.messageOrCallBrief, allowedOptions: structuredClone(body.allowedOptions) };
        contacts.set(contactRequest.id, structuredClone(contactRequest));
        return { contactRequest };
      }
      if (path === '/v1/contact-requests/contact-1/decision') {
        const current = contacts.get('contact-1');
        const contactRequest = { ...current, approvalId: 'approval-1', deliveryStatus: body.decision === 'accept' ? 'ready' : 'rejected' };
        contacts.set(contactRequest.id, structuredClone(contactRequest));
        return { contactRequest };
      }
      if (path === '/v1/phone-connection') { api.phoneConnection = { status: 'available', senderNumber: body.fromNumber }; return api.phoneConnection; }
      if (path === '/v1/contact-requests/contact-1/send' || path === '/v1/contact-requests/contact-1/call') {
        const contactRequest = { ...contacts.get('contact-1'), deliveryStatus: 'sent_or_connected',
          negotiationStatus: 'awaiting_response', providerOperationId: 'provider-1' };
        contacts.set(contactRequest.id, structuredClone(contactRequest));
        return { contactRequest };
      }
      throw new Error(`unexpected mock POST ${path}`);
    },
  };
  return { api, calls, contacts, proposals };
}
function directProps(api: any, selectedProposal: any = proposal) {
  return { api, proposal: selectedProposal, proposalClient: { get: async (id: string) => {
    const data = await api.get(`/v1/proposals/${encodeURIComponent(id)}`); return data.proposal;
  } }, renderProposal: (item: any) => harness.jsx('Text', { children: `${item.id}: ${JSON.stringify(item.changeSet)}` }), onBack: () => {} };
}
function fillDraft(view: any) {
  enter(view, '수신자 이름', recipient.displayName);
  enter(view, '수신자 이메일', recipient.address);
  enter(view, '메일 제목', draft.purpose);
  enter(view, '메일 본문', draft.messageOrCallBrief);
}
async function openContact(view: any, id = 'contact-1') {
  await view.settle(); press(view, `연락 ${id} 상세`); await view.settle();
}
async function openProposalContact(view: any) {
  await view.settle(); press(view, '제안 시간 조정, 확인 대기, 상세 보기'); await view.settle();
  press(view, '연락 준비'); await view.settle();
}
const posts = (calls: Call[], suffix?: string) => calls.filter(call => call.method === 'POST' && (!suffix || call.path.endsWith(suffix)));

test('수신자 확인과 초안 저장 전에는 발송하지 않으며 확인 후에도 별도 승인이 필요하다', async t => {
  const { ContactPanel, operationGuard } = await components;
  const pending = deferred<any>();
  const mock = memoryApi();
  mock.api.postHook = (path: string) => path === '/v1/recipients' ? pending.promise : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await view.settle(); press(view, '새 연락 초안 작성'); fillDraft(view);
  assert.equal(button(view, '연락 초안 저장').props.disabled, true);
  assert.equal(button(view, 'Gmail 발송'), undefined);
  assert.equal(posts(mock.calls).length, 0);
  press(view, '입력한 수신자 이름과 이메일 확인');
  enter(view, '수신자 이메일', 'other@example.test');
  assert.equal(button(view, '연락 초안 저장').props.disabled, true, '수신자 변경 시 확인을 다시 받아야 한다');
  enter(view, '수신자 이메일', recipient.address);
  press(view, '입력한 수신자 이름과 이메일 확인'); press(view, '연락 초안 저장');
  assert.equal(posts(mock.calls, '/recipients').length, 1);
  assert.equal(posts(mock.calls, '/send').length, 0);
  assert.equal(button(view, '작성 취소').props.disabled, true);
  assert.equal(operationGuard.hasUnresolved(), true);
  pending.resolve({ recipient }); await view.settle();
  assert.equal(posts(mock.calls, '/contact-requests').length, 1);
  assert.deepEqual(posts(mock.calls, '/recipients')[0].body.confirmed, true);
  assert.equal(posts(mock.calls, '/send').length, 0);
  assert.ok(button(view, '연락 내용 승인'));
  assert.equal(button(view, 'Gmail 발송'), undefined);
});

for (const [kind, selectedProposal] of [['시간 변경', proposal], ['삭제', alternative]] as const) {
  test(`${kind} 제안 기반 제목과 본문을 미리 채우고 사용자가 본문을 수정해 저장할 수 있다`, async t => {
    const { ContactPanel } = await components;
    const mock = memoryApi();
    const view = harness.renderer(ContactPanel, directProps(mock.api, selectedProposal)); t.after(() => view.unmount());
    await view.settle(); press(view, '새 연락 초안 작성');
    const title = input(view, '메일 제목');
    const body = input(view, '메일 본문');
    assert.match(textOf(view.tree), /제안 기반 초안/);
    assert.ok(title.props.value.trim(), '제목을 제안에서 미리 채워야 한다');
    assert.ok(body.props.value.trim(), '본문을 제안에서 미리 채워야 한다');
    assert.ok(`${title.props.value} ${body.props.value}`.includes(before.title), '원 일정 제목을 포함해야 한다');
    if (kind === '시간 변경') {
      assert.match(body.props.value, /11(?::00|시)/, '변경 후 시작 시각을 포함해야 한다');
      assert.match(body.props.value, /12(?::00|시)/, '변경 후 종료 시각을 포함해야 한다');
    } else {
      assert.match(body.props.value, /취소|삭제/, '삭제 제안임을 설명해야 한다');
    }
    assert.notEqual(title.props.editable, false);
    assert.notEqual(body.props.editable, false);
    enter(view, '수신자 이름', recipient.displayName);
    enter(view, '수신자 이메일', recipient.address);
    enter(view, '메일 본문', '직접 수정한 합성 본문입니다.');
    press(view, '입력한 수신자 이름과 이메일 확인'); press(view, '연락 초안 저장'); await view.settle();
    assert.equal(posts(mock.calls, '/contact-requests')[0].body.messageOrCallBrief, '직접 수정한 합성 본문입니다.');
    assert.equal(posts(mock.calls, '/send').length, 0);
  });
}

test('실제 제안 화면의 승인 preview는 수신자, 제목, 본문과 모든 대안 변경을 보여주고 발송은 별도 동작이다', async t => {
  const { ProposalPanel } = await components;
  const twoOptions = { ...draft, allowedOptions: [...draft.allowedOptions,
    { optionId: 'option-2', proposalId: alternative.id, proposalRevision: alternative.revision }] };
  const mock = memoryApi([twoOptions]);
  const view = harness.renderer(ProposalPanel, { api: mock.api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {} });
  t.after(() => view.unmount());
  await openProposalContact(view); await openContact(view);
  const preview = textOf(view.tree);
  for (const value of [recipient.displayName, recipient.address, draft.purpose, draft.messageOrCallBrief,
    'move-1', 'delete-2', '기존 회의', '옮긴 회의', oldSlot.startsAt, newSlot.startsAt, '없음 (삭제)']) {
    assert.ok(preview.includes(value), `preview missing ${value}`);
  }
  assert.equal(button(view, 'Gmail 발송'), undefined);
  assert.equal(posts(mock.calls, '/send').length, 0);
  press(view, '연락 내용 승인'); await view.settle();
  assert.equal(posts(mock.calls, '/decision').length, 1);
  assert.equal(posts(mock.calls, '/send').length, 0, '승인만으로 발송하지 않는다');
  assert.ok(button(view, 'Gmail 발송'));
  assert.notEqual(button(view, 'Gmail 발송').props.disabled, true);
  press(view, 'Gmail 발송'); await view.settle();
  assert.equal(posts(mock.calls, '/send').length, 1);
  assert.match(textOf(view.tree), /발송됨/);
});

test('발신 Gmail이 미설정이면 승인된 초안도 발송할 수 없다', async t => {
  const { ContactPanel } = await components;
  const mock = memoryApi([ready]); mock.api.connection = { status: 'not_configured', senderAddress: null };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view);
  assert.match(textOf(view.tree), /발신 Gmail 계정이 설정되지 않았습니다/);
  assert.equal(button(view, 'Gmail 발송').props.disabled, true);
  assert.equal(posts(mock.calls, '/send').length, 0);
});

for (const senderAddress of [null, '', '  ']) {
  test(`발신 계정 주소가 ${JSON.stringify(senderAddress)}인 available 응답은 발송을 허용하지 않는다`, async t => {
    const { ContactPanel } = await components;
    const mock = memoryApi([ready]);
    mock.api.connection = { status: 'available', senderAddress };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view);
    assert.equal(button(view, 'Gmail 발송').props.disabled, true);
    assert.ok(button(view, '발신 계정 다시 확인'));
    assert.equal(posts(mock.calls, '/send').length, 0);
  });
}

for (const [code, status, retryable] of [
  ['timeout', undefined, true], ['network', undefined, true], ['invalid_response', undefined, false],
  ['operation_in_progress', 409, false], ['provider_unavailable', 503, false], ['internal_error', 500, true],
] as const) {
  test(`${code} 후 상태 조회가 ready인 경우에만 같은 발송 요청을 재시도한다`, async t => {
    const { ContactPanel, ApiError, operationGuard } = await components;
    const mock = memoryApi([ready]); let attempts = 0;
    mock.api.postHook = (path: string) => {
      if (path.endsWith('/send') && ++attempts === 1) throw new ApiError(code, code, retryable, status);
      return undefined;
    };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view); press(view, 'Gmail 발송'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), true);
    assert.equal(button(view, '연락 목록').props.disabled, true);
    assert.equal(button(view, 'Gmail 발송'), undefined);
    assert.equal(button(view, '발송 오류 닫기'), undefined);
    assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
    assert.equal(posts(mock.calls, '/send').length, 1);
    press(view, '연락 상태 조회'); await view.settle();
    assert.ok(button(view, '동일 발송 요청 재시도'));
    press(view, '동일 발송 요청 재시도'); await view.settle();
    const sends = posts(mock.calls, '/send');
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1], sends[0], '경로, 본문, requestId 및 멱등 키가 동일해야 한다');
    assert.notEqual(sends[0].body.requestId, sends[0].options.idempotencyKey);
    assert.equal(operationGuard.hasUnresolved(), false);
    assert.match(textOf(view.tree), /발송됨/);
  });
}

for (const code of ['conflict', 'stale_proposal'] as const) {
  test(`발송 전 ${code} 오류는 확정 실패로 닫을 수 있으며 자동 재발송하지 않는다`, async t => {
    const { ContactPanel, ApiError, operationGuard } = await components;
    const mock = memoryApi([ready]);
    mock.api.postHook = (path: string) => {
      if (path.endsWith('/send')) throw new ApiError(code, code, false, 409);
      return undefined;
    };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view); press(view, 'Gmail 발송'); await view.settle();
    assert.equal(operationGuard.hasUnresolved(), false);
    assert.ok(button(view, '발송 오류 닫기'));
    assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
    assert.doesNotMatch(textOf(view.tree), /발송 결과를 확인하지 못했습니다/);
    press(view, '발송 오류 닫기');
    if (code === 'conflict') {
      assert.equal(button(view, 'Gmail 발송').props.disabled, true);
      press(view, '발신 계정 다시 확인'); await view.settle();
    }
    assert.equal(button(view, 'Gmail 발송').props.disabled, false);
    assert.equal(posts(mock.calls, '/send').length, 1, '오류 닫기는 새로운 발송 요청이 아니다');
    press(view, '연락 목록');
  });
}

for (const dismiss of ['발송 오류 닫기', '연락 상태 조회'] as const) {
  test(`표시한 A 계정에서 서버가 B로 바뀌면 A로 요청하고 ${dismiss} 후 B를 확인해야 새 발송한다`, async t => {
    const { ContactPanel, ApiError } = await components;
    const mock = memoryApi([ready]);
    const senderA = 'sender-a@example.test';
    const senderB = 'sender-b@example.test';
    mock.api.connection = { status: 'available', senderAddress: senderA };
    mock.api.postHook = (path: string, body: any) => {
      if (path.endsWith('/send') && body.expectedSenderAddress !== mock.api.connection.senderAddress) {
        throw new ApiError('conflict', '발신 계정이 변경되었습니다.', false, 409);
      }
      return undefined;
    };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view);
    assert.ok(textOf(view.tree).includes(senderA));
    assert.ok(button(view, '발신 계정 다시 확인'));
    mock.api.connection = { status: 'available', senderAddress: senderB };
    press(view, 'Gmail 발송'); await view.settle();
    const first = posts(mock.calls, '/send')[0];
    assert.equal(first.body.expectedSenderAddress, senderA);
    assert.doesNotMatch(textOf(view.tree), /발송됨/);
    press(view, dismiss); await view.settle();
    assert.equal(button(view, 'Gmail 발송').props.disabled, true);
    assert.match(textOf(view.tree), /발신 계정을 다시 확인/);
    press(view, '발신 계정 다시 확인'); await view.settle();
    assert.ok(textOf(view.tree).includes(senderB));
    press(view, 'Gmail 발송'); await view.settle();
    const second = posts(mock.calls, '/send')[1];
    assert.equal(second.body.expectedSenderAddress, senderB);
    assert.notEqual(second.options.idempotencyKey, first.options.idempotencyKey);
    assert.match(textOf(view.tree), /발송됨/);
  });
}

test('서버 발신 계정이 바뀌어도 불확실한 발송의 동일 요청 재시도는 기존 주소와 키를 보존한다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const mock = memoryApi([ready]); let attempts = 0;
  const senderA = 'sender-a@example.test';
  mock.api.connection = { status: 'available', senderAddress: senderA };
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/send')) {
      attempts += 1;
      throw attempts === 1 ? new ApiError('network', 'offline', true) : new ApiError('conflict', 'sender changed', false, 409);
    }
    return undefined;
  };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송'); await view.settle();
  mock.api.connection = { status: 'available', senderAddress: 'sender-b@example.test' };
  assert.equal(button(view, '발신 계정 다시 확인').props.disabled, true);
  press(view, '연락 상태 조회'); await view.settle();
  press(view, '동일 발송 요청 재시도'); await view.settle();
  const sends = posts(mock.calls, '/send');
  assert.equal(sends[0].body.expectedSenderAddress, senderA);
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(button(view, '발송 오류 닫기'), undefined);
});

test('불확실한 발송 뒤 같은 요청에서 충돌해도 기존 결과 불명은 해소되지 않는다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const mock = memoryApi([ready]); let attempts = 0;
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/send')) {
      attempts += 1;
      throw attempts === 1 ? new ApiError('timeout', 'timeout', true) : new ApiError('conflict', 'conflict', false, 409);
    }
    return undefined;
  };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송'); await view.settle();
  press(view, '연락 상태 조회'); await view.settle();
  press(view, '동일 발송 요청 재시도'); await view.settle();
  const sends = posts(mock.calls, '/send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(button(view, '발송 오류 닫기'), undefined);
  assert.equal(button(view, '연락 목록').props.disabled, true);
});

test('불확실한 발송 후 상태 조회가 실패하면 재시도 버튼을 열지 않는다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const mock = memoryApi([ready]);
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/send')) throw new ApiError('network', 'offline', true);
    return undefined;
  };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송'); await view.settle();
  mock.api.getHook = (path: string) => {
    if (path === '/v1/contact-requests/contact-1') throw new Error('조회 실패');
    return undefined;
  };
  press(view, '연락 상태 조회'); await view.settle();
  assert.match(textOf(view.tree), /연락 상태를 조회하지 못했습니다/);
  assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
  assert.equal(operationGuard.hasUnresolved(), true);
  assert.equal(posts(mock.calls, '/send').length, 1);
});

for (const status of ['submitting', 'outcome_unknown']) {
  test(`${status} 연락은 조회만 가능하고 새 초안이나 재발송을 허용하지 않는다`, async t => {
    const { ContactPanel } = await components;
    const mock = memoryApi([{ ...ready, deliveryStatus: status }]);
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await view.settle();
    assert.equal(button(view, '새 연락 초안 작성').props.disabled, true);
    await openContact(view);
    assert.equal(button(view, 'Gmail 발송'), undefined);
    assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
    assert.equal(button(view, '연락 내용 승인'), undefined);
    press(view, '연락 상태 조회'); await view.settle();
    assert.equal(button(view, 'Gmail 발송'), undefined);
    assert.equal(posts(mock.calls).length, 0);
  });

  test(`발송 timeout 후 조회 결과가 ${status}이면 같은 키라도 재발송하지 않는다`, async t => {
    const { ContactPanel, ApiError } = await components;
    const mock = memoryApi([ready]);
    mock.api.postHook = (path: string) => {
      if (path.endsWith('/send')) throw new ApiError('timeout', 'timeout', true);
      return undefined;
    };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view); press(view, 'Gmail 발송'); await view.settle();
    mock.contacts.set('contact-1', { ...ready, deliveryStatus: status });
    press(view, '연락 상태 조회'); await view.settle();
    assert.equal(button(view, 'Gmail 발송'), undefined);
    assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
    assert.equal(posts(mock.calls, '/send').length, 1);
    press(view, '연락 상태 조회'); await view.settle();
    assert.equal(posts(mock.calls, '/send').length, 1);
  });
}

test('발송 처리 중 상태 조회가 submitting으로 바뀌어도 미결 요청을 잃지 않는다', async t => {
  const { ContactPanel, operationGuard } = await components;
  const pending = deferred<any>();
  const mock = memoryApi([ready]);
  mock.api.postHook = (path: string) => path.endsWith('/send') ? pending.promise : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송');
  assert.equal(operationGuard.hasUnresolved(), true);
  mock.contacts.set('contact-1', { ...ready, deliveryStatus: 'submitting' });
  press(view, '연락 상태 조회'); await view.settle();
  assert.match(textOf(view.tree), /발송(?: 요청)? 처리 중/);
  assert.equal(button(view, 'Gmail 발송'), undefined);
  assert.equal(operationGuard.hasUnresolved(), true, '진행 중인 실제 mutation의 연결 잠금이 유지되어야 한다');
  pending.resolve({ contactRequest: sent }); await view.settle();
  assert.match(textOf(view.tree), /발송됨/);
  assert.equal(operationGuard.hasUnresolved(), false);
});

test('상태 조회 중 먼저 시작한 발송의 늦은 성공 응답도 현재 화면에 반영한다', async t => {
  const { ContactPanel } = await components;
  const pending = deferred<any>(); const mock = memoryApi([ready]);
  mock.api.postHook = (path: string) => path.endsWith('/send') ? pending.promise : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송');
  mock.contacts.set('contact-1', { ...ready, deliveryStatus: 'submitting' });
  press(view, '연락 상태 조회'); await view.settle();
  pending.resolve({ contactRequest: sent }); await view.settle();
  assert.match(textOf(view.tree), /발송됨/, '진행 중 요청의 성공 응답을 버리면 안 된다');
  assert.equal(posts(mock.calls, '/send').length, 1);
});

test('발송 성공 이후 늦게 도착한 submitting 조회 응답은 성공 상태를 덮어쓰지 않는다', async t => {
  const { ContactPanel, operationGuard } = await components;
  const pendingSend = deferred<any>(); const pendingLookup = deferred<any>();
  const mock = memoryApi([ready]);
  mock.api.postHook = (path: string) => path.endsWith('/send') ? pendingSend.promise : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Gmail 발송');
  mock.api.getHook = (path: string) => path === '/v1/contact-requests/contact-1' ? pendingLookup.promise : undefined;
  press(view, '연락 상태 조회');
  assert.equal(button(view, '연락 상태 조회').props.disabled, true);
  pendingSend.resolve({ contactRequest: sent }); await view.settle();
  assert.match(textOf(view.tree), /발송됨/);
  pendingLookup.resolve({ contactRequest: { ...ready, deliveryStatus: 'submitting' } }); await view.settle();
  assert.match(textOf(view.tree), /발송됨/);
  assert.doesNotMatch(textOf(view.tree), /발송 상태: 발송 처리 중/);
  assert.equal(button(view, 'Gmail 발송'), undefined);
  assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(posts(mock.calls, '/send').length, 1);
});

test('실제 ProposalPanel에서 refreshVersion이 바뀌어도 연락 초안과 미결 요청이 유지된다', async t => {
  const { ProposalPanel, operationGuard } = await components;
  const pending = deferred<any>(); const refresh = deferred<any>();
  const mock = memoryApi(); let reads = 0;
  mock.api.postHook = (path: string) => path === '/v1/recipients' ? pending.promise : undefined;
  mock.api.getHook = (path: string) => path === '/v1/proposals/proposal-1' && ++reads === 2 ? refresh.promise : undefined;
  const props = { api: mock.api, refreshVersion: 0, onScheduleChanged: () => {}, onBack: () => {} };
  const view = harness.renderer(ProposalPanel, props); t.after(() => view.unmount());
  await openProposalContact(view); press(view, '새 연락 초안 작성'); fillDraft(view);
  press(view, '입력한 수신자 이름과 이메일 확인'); press(view, '연락 초안 저장');
  assert.equal(operationGuard.hasUnresolved(), true);
  view.update({ ...props, refreshVersion: 1 }); await view.settle();
  assert.equal(input(view, '수신자 이메일').props.value, recipient.address);
  assert.equal(button(view, '작성 취소').props.disabled, true);
  assert.equal(operationGuard.hasUnresolved(), true);
  refresh.resolve({ proposal }); pending.resolve({ recipient }); await view.settle();
  assert.equal(posts(mock.calls, '/recipients').length, 1);
  assert.equal(posts(mock.calls, '/contact-requests').length, 1);
  assert.match(textOf(view.tree), /승인할 내용 미리보기/);
  assert.equal(posts(mock.calls, '/send').length, 0);
});

test('실제 앱 연결 설정은 미결 연락 저장 중 다른 계정으로 전환되지 않는다', async t => {
  const { App, operationGuard } = await components;
  const pending = deferred<any>(); const mock = memoryApi();
  mock.api.postHook = (path: string) => path === '/v1/recipients' ? pending.promise : undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://api.example.test');
    const path = target.pathname + target.search;
    const data = init?.method === 'POST' ? await mock.api.post(path, JSON.parse(String(init.body)),
      { idempotencyKey: (init.headers as Record<string, string>)['Idempotency-Key'] }) : await mock.api.get(path);
    return Response.json({ requestId: 'mock-response', data });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const view = harness.renderer(App); t.after(() => view.unmount());
  press(view, '개발 연결 설정'); enter(view, 'API 서버 주소', 'https://api.example.test');
  enter(view, '개발 세션 토큰', 'test-user'); press(view, '설정 적용'); await view.settle();
  const chat = nodes(view.tree).find(node => node.type === 'ChatScreen');
  assert.ok(chat); chat.props.onOpenProposals(); view.flush();
  await openProposalContact(view); press(view, '새 연락 초안 작성'); fillDraft(view);
  press(view, '입력한 수신자 이름과 이메일 확인'); press(view, '연락 초안 저장');
  assert.equal(operationGuard.hasUnresolved(), true);
  press(view, '개발 연결 설정'); enter(view, '개발 세션 토큰', 'other-user'); press(view, '설정 적용');
  assert.match(textOf(view.tree), /처리 중이거나 결과를 확인하지 못한 요청/);
  assert.equal(input(view, '수신자 이메일').props.value, recipient.address);
  assert.equal(posts(mock.calls, '/send').length, 0);
  pending.resolve({ recipient }); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false);
});


test('전화 기본 초안의 줄바꿈을 보존하고 지원하지 않는 제어문자와 과도한 TTS 길이는 차단한다', async t => {
  const { ContactPanel } = await components;
  const mock = memoryApi(); const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await view.settle(); press(view, '새 연락 초안 작성'); press(view, '전화 선택');
  assert.match(input(view, '읽을 전화 내용').props.value, /\n/);
  enter(view, '수신자 이름', '테스트 상대'); enter(view, '수신자 전화번호', '+12025550100');
  press(view, '입력한 수신자 이름과 전화번호 확인');
  enter(view, '읽을 전화 내용', '첫 줄\u0001둘째 줄');
  assert.equal(button(view, '연락 초안 저장').props.disabled, true);
  enter(view, '읽을 전화 내용', '&'.repeat(1000));
  assert.equal(button(view, '연락 초안 저장').props.disabled, true);
  enter(view, '읽을 전화 내용', `내용${'\r'.repeat(800)}`);
  assert.equal(button(view, '연락 초안 저장').props.disabled, true);
  enter(view, '읽을 전화 내용', '안녕하세요.\n약속 변경이 가능한지 확인 부탁드립니다.');
  press(view, '연락 초안 저장'); await view.settle();
  assert.equal(posts(mock.calls, '/contact-requests')[0].body.messageOrCallBrief, '안녕하세요.\n약속 변경이 가능한지 확인 부탁드립니다.');
  assert.equal(posts(mock.calls, '/call').length, 0);
});

test('전화 초안은 E.164 수신자 확인과 별도 승인 후에만 전화 요청을 보낸다', async t => {
  const { ContactPanel } = await components;
  const mock = memoryApi(); const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await view.settle(); press(view, '새 연락 초안 작성'); press(view, '전화 선택');
  enter(view, '수신자 이름', '상대'); enter(view, '수신자 전화번호', '01012345678');
  press(view, '입력한 수신자 이름과 전화번호 확인');
  assert.equal(button(view, '연락 초안 저장').props.disabled, true);
  enter(view, '수신자 전화번호', '+821012345678'); press(view, '입력한 수신자 이름과 전화번호 확인');
  press(view, '연락 초안 저장'); await view.settle();
  assert.equal(posts(mock.calls, '/call').length, 0);
  assert.equal(button(view, '전화 요청'), undefined);
  press(view, '연락 내용 승인'); await view.settle();
  assert.equal(posts(mock.calls, '/call').length, 0);
  press(view, '전화 요청'); await view.settle();
  const call = posts(mock.calls, '/call')[0];
  assert.equal(call.body.expectedSenderNumber, '+15550000001');
  assert.ok(call.body.requestId && call.options.idempotencyKey);
  assert.match(textOf(view.tree), /전화 요청 접수, 연결·응답 미확인/);
  assert.match(textOf(view.tree), /전화 요청 접수는 통화 연결이나 상대 수락의 증거가 아닙니다/);
  assert.doesNotMatch(textOf(view.tree), /상대 수락 확인/);
});

test('전화 연결 시 자격 증명 입력은 즉시 비우고 미결 요청 동안 세션을 보호한다', async t => {
  const { ContactPanel, operationGuard, ApiError } = await components;
  const phoneReady = { ...ready, channel: 'phone', recipientSnapshot: { ...ready.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phoneReady]); mock.api.phoneConnection = { status: 'not_configured', senderNumber: null };
  const pending = deferred<any>(); mock.api.postHook = (path: string) => path === '/v1/phone-connection' ? pending.promise : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view);
  press(view, 'Twilio 선택');
  assert.equal(input(view, '전화 계정 SID').props.secureTextEntry, true);
  assert.equal(input(view, '전화 인증 토큰').props.secureTextEntry, true);
  enter(view, '전화 계정 SID', 'test-sid'); enter(view, '전화 인증 토큰', 'test-token'); enter(view, '발신 전화번호', '+15550000001');
  press(view, '전화 연결 설정');
  assert.equal(input(view, '전화 계정 SID').props.value, ''); assert.equal(input(view, '전화 인증 토큰').props.value, '');
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '연락 목록').props.disabled, true);
  pending.reject(new ApiError('timeout', 'timeout', true)); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '전화 요청').props.disabled, true);
  mock.api.phoneConnection = { status: 'available', senderNumber: '+15550000001' };
  press(view, '발신 번호 다시 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true);
  mock.api.phoneConnection = { status: 'available', senderNumber: '+15550000001', lastRequestId: 'other-request' };
  press(view, '발신 번호 다시 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true);
  mock.api.phoneConnection = { status: 'available', senderNumber: '+15550000001', lastRequestId: posts(mock.calls, '/phone-connection')[0].body.requestId };
  press(view, '발신 번호 다시 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(button(view, '전화 요청').props.disabled, false);
  assert.equal(posts(mock.calls, '/call').length, 0);
});

test('연락 화면의 ClawOps 연결은 제공자까지 일치해야 미결 잠금을 해제한다', async t => {
  const { ContactPanel, operationGuard, ApiError } = await components;
  const phoneReady = { ...ready, channel: 'phone', recipientSnapshot: { ...ready.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phoneReady]); mock.api.phoneConnection = { status: 'not_configured', senderNumber: null };
  mock.api.postHook = (path: string) => { if (path === '/v1/phone-connection') throw new ApiError('timeout', 'timeout', true); };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view);
  enter(view, 'ClawOps 계정 ID', 'account'); enter(view, 'ClawOps API 키', 'key'); enter(view, 'ClawOps 서명 비밀', 'signing');
  enter(view, '발신 전화번호', '+15550000001'); press(view, '전화 연결 설정'); await view.settle();
  const call = posts(mock.calls, '/phone-connection')[0]; assert.equal(call.body.provider, 'clawops');
  assert.equal(operationGuard.hasUnresolved(), true);
  mock.api.phoneConnection = { status: 'available', provider: 'twilio', senderNumber: '+15550000001', lastRequestId: call.body.requestId };
  press(view, '발신 번호 다시 확인'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), true);
  mock.api.phoneConnection = { status: 'available', provider: 'clawops', senderNumber: '+15550000001', lastRequestId: call.body.requestId };
  press(view, '발신 번호 다시 확인'); await view.settle(); assert.equal(operationGuard.hasUnresolved(), false);
  assert.equal(posts(mock.calls, '/call').length, 0);
});

test('전화 결과 불명은 상태 조회 후 동일 발신 번호와 멱등 키로만 재시도한다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const phoneReady = { ...ready, channel: 'phone', recipientSnapshot: { ...ready.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phoneReady]);
  mock.api.postHook = (path: string) => { if (path.endsWith('/call')) throw new ApiError('timeout', 'timeout', true); };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '전화 요청'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
  press(view, '연락 상태 조회'); await view.settle(); press(view, '동일 발송 요청 재시도'); await view.settle();
  const calls = posts(mock.calls, '/call'); assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(operationGuard.hasUnresolved(), true);
});

test('전화 발신 번호 충돌은 재확인 전 새 요청을 막고 접수 목록도 연결 미확인으로 표시한다', async t => {
  const { ContactPanel, ApiError } = await components;
  const phoneReady = { ...ready, channel: 'phone', recipientSnapshot: { ...ready.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phoneReady]);
  mock.api.postHook = (path: string, body: any) => {
    if (path.endsWith('/call') && body.expectedSenderNumber !== mock.api.phoneConnection.senderNumber) throw new ApiError('conflict', 'changed', false, 409);
  };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); mock.api.phoneConnection = { status: 'available', senderNumber: '+15550000002' };
  press(view, '전화 요청'); await view.settle(); press(view, '발송 오류 닫기');
  assert.equal(button(view, '전화 요청').props.disabled, true);
  press(view, '발신 번호 다시 확인'); await view.settle(); press(view, '전화 요청'); await view.settle();
  const calls = posts(mock.calls, '/call'); assert.equal(calls[0].body.expectedSenderNumber, '+15550000001');
  assert.equal(calls[1].body.expectedSenderNumber, '+15550000002'); assert.notEqual(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
  press(view, '연락 목록'); await view.settle();
  assert.match(textOf(view.tree), /전화 요청 접수, 연결·응답 미확인/);
});

test('전화 설정 결과 불명 뒤 다른 발신 번호가 조회되어도 세션 잠금을 해제하지 않는다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const phoneReady = { ...ready, channel: 'phone', recipientSnapshot: { ...ready.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phoneReady]); mock.api.phoneConnection = { status: 'not_configured', senderNumber: null };
  mock.api.postHook = (path: string) => { if (path === '/v1/phone-connection') throw new ApiError('timeout', 'timeout', true); };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, 'Twilio 선택'); enter(view, '전화 계정 SID', 'sid'); enter(view, '전화 인증 토큰', 'token'); enter(view, '발신 전화번호', '+15550000001');
  press(view, '전화 연결 설정'); await view.settle();
  mock.api.phoneConnection = { status: 'available', senderNumber: '+15550000002', lastRequestId: posts(mock.calls, '/phone-connection')[0].body.requestId };
  press(view, '발신 번호 다시 확인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '연락 목록').props.disabled, true);
  assert.equal(button(view, '전화 요청').props.disabled, true); assert.equal(posts(mock.calls, '/call').length, 0);
});

test('회신 권한 미설정과 조회 실패를 응답 없음과 구분한다', async t => {
  const { ContactPanel, ApiError } = await components;
  const mock = memoryApi([sent]); mock.api.replyConnection = { status: 'not_configured', senderAddress: null };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view);
  assert.match(textOf(view.tree), /회신 읽기 권한이 설정되지 않았습니다/);
  assert.equal(button(view, '회신 확인').props.disabled, true);
  mock.api.replyConnection = { status: 'available', senderAddress: 'sender@example.test' };
  mock.api.postHook = (path: string) => { if (path.endsWith('/check-replies')) throw new ApiError('not_configured', 'no access', false, 503); };
  press(view, '회신 조회 설정 다시 확인'); await view.settle(); press(view, '회신 확인'); await view.settle();
  assert.match(textOf(view.tree), /회신 조회에 실패했습니다/);
  assert.doesNotMatch(textOf(view.tree), /저장된 응답이 없습니다/);
  assert.equal(posts(mock.calls, '/send').length, 0);
});

test('회신 확인은 저장된 본문과 허용 대안의 명시 선택 뒤 재승인하고 일정 갱신을 알린다', async t => {
  const { ContactPanel } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const applied = { ...sent, negotiationStatus: 'applied' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '제안하신 시간이 괜찮습니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([sent]); let refreshed = 0;
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/check-replies')) return { contactRequest: reviewed, responses: [response], checkedCount: 1, unmatchedCount: 1 };
    if (path.endsWith('/confirm')) return { contactRequest: applied, response, scheduleRevision: 4, changed: true };
  };
  const view = harness.renderer(ContactPanel, { ...directProps(mock.api), onScheduleChanged: () => { refreshed += 1; } }); t.after(() => view.unmount());
  await openContact(view); press(view, '회신 확인'); await view.settle();
  assert.match(textOf(view.tree), /사용자 확인 필요/); assert.match(textOf(view.tree), /신원은 확인되지 않습니다/);
  assert.match(textOf(view.tree), /상태: 사용자 확인 필요/);
  assert.match(textOf(view.tree), /판단할 수 없는 메일 1건/);
  assert.match(textOf(view.tree), /제안하신 시간이 괜찮습니다/); assert.equal(posts(mock.calls, '/confirm').length, 0);
  press(view, '선택: option-1 · 제안 proposal-1');
  assert.equal(posts(mock.calls, '/confirm').length, 0);
  press(view, '회신 확인 후 선택한 대안 재승인'); await view.settle();
  const confirm = posts(mock.calls, '/confirm')[0];
  assert.equal(confirm.path, '/v1/contact-requests/contact-1/responses/response-1/confirm');
  assert.equal(confirm.body.selectedOptionId, 'option-1'); assert.equal(confirm.body.contactRevision, sent.revision);
  assert.ok(confirm.body.requestId && confirm.options.idempotencyKey); assert.match(textOf(view.tree), /일정 반영됨/);
  assert.equal(refreshed, 2); assert.equal(posts(mock.calls, '/send').length, 0);
});

test('전화 결과 조회는 저장된 서버 응답만 읽고 확인 없이 수락을 만들지 않는다', async t => {
  const { ContactPanel } = await components;
  const phone = { ...sent, channel: 'phone', recipientSnapshot: { ...sent.recipientSnapshot, channel: 'phone', address: '+821012345678' } };
  const mock = memoryApi([phone]); let refreshed = 0;
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: phone, responses: [] } : undefined;
  const view = harness.renderer(ContactPanel, { ...directProps(mock.api), onScheduleChanged: () => { refreshed += 1; } }); t.after(() => view.unmount());
  await openContact(view); press(view, '통화 결과 조회'); await view.settle();
  assert.match(textOf(view.tree), /저장된 응답이 없습니다/); assert.match(textOf(view.tree), /상대 응답 대기/);
  assert.equal(posts(mock.calls).length, 0); assert.equal(refreshed, 1);
});

test('재승인 결과 불명 시 같은 응답과 옵션 및 멱등 키로만 재시도한다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '네, 가능합니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([reviewed]);
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: reviewed, responses: [response] } : undefined;
  mock.api.postHook = (path: string) => { if (path.endsWith('/confirm')) throw new ApiError('timeout', 'timeout', true); };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '저장된 응답 조회'); await view.settle();
  press(view, '선택: option-1 · 제안 proposal-1'); press(view, '회신 확인 후 선택한 대안 재승인'); await view.settle();
  assert.equal(operationGuard.hasUnresolved(), true); assert.equal(button(view, '연락 목록').props.disabled, true);
  press(view, '동일 재승인 요청 재시도'); await view.settle();
  assert.deepEqual(posts(mock.calls, '/confirm')[1], posts(mock.calls, '/confirm')[0]);
  assert.equal(operationGuard.hasUnresolved(), true);
});

test('본문이 없거나 자동 회신인 응답은 사용자 재승인을 제공하지 않는다', async t => {
  const { ContactPanel } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const common = { contactRequestId: sent.id, receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null, evidenceRef: 'evidence-1' };
  const responses = [{ ...common, id: 'r-1', providerEventId: 'e-1', displayText: null, reviewReason: 'sender_unverified' },
    { ...common, id: 'r-2', providerEventId: 'e-2', displayText: '부재중입니다.', reviewReason: 'automatic_message' }];
  const mock = memoryApi([reviewed]);
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: reviewed, responses } : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '저장된 응답 조회'); await view.settle();
  assert.equal(button(view, '선택: option-1 · 제안 proposal-1'), undefined);
  assert.equal(posts(mock.calls, '/confirm').length, 0);
});

test('공백뿐인 회신은 빈 본문으로 표시하고 재승인을 제공하지 않는다', async t => {
  const { ContactPanel } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: ' \n  ', reviewReason: 'sender_unverified' };
  const mock = memoryApi([reviewed]);
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: reviewed, responses: [response] } : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '저장된 응답 조회'); await view.settle();
  assert.match(textOf(view.tree), /확인할 수 있는 회신 본문이 없습니다/);
  assert.doesNotMatch(textOf(view.tree), /회신 원문의 일부입니다/);
  assert.equal(button(view, '선택: option-1 · 제안 proposal-1'), undefined);
  assert.equal(posts(mock.calls, '/confirm').length, 0);
});

test('재승인 후 최신성 재검증이 실패하면 일정 반영으로 표시하지 않는다', async t => {
  const { ContactPanel } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '네, 가능합니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([reviewed]);
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: reviewed, responses: [response] } : undefined;
  mock.api.postHook = (path: string) => path.endsWith('/confirm') ? { contactRequest: reviewed, response, scheduleRevision: 4, changed: false } : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '저장된 응답 조회'); await view.settle();
  press(view, '선택: option-1 · 제안 proposal-1'); press(view, '회신 확인 후 선택한 대안 재승인'); await view.settle();
  assert.match(textOf(view.tree), /현재 일정으로 새 제안을 요청해 주세요/); assert.doesNotMatch(textOf(view.tree), /일정 반영됨/);
  press(view, '저장된 회신 다시 조회'); await view.settle();
  assert.equal(button(view, '선택: option-1 · 제안 proposal-1'), undefined);
  assert.equal(posts(mock.calls, '/confirm').length, 1);
});

test('회신 반영 후 현재 제안 상태를 표시하고 나갔다 다시 들어와도 연락 이력을 읽는다', async t => {
  const { ProposalPanel } = await components;
  const awaiting = { ...proposal, status: 'awaiting_contact' };
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const applied = { ...sent, negotiationStatus: 'applied' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '제안하신 시간이 괜찮습니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([sent]); mock.proposals.set(proposal.id, awaiting);
  const updatedPreview = deferred<any>(); let holdPreview = false;
  mock.api.getHook = (path: string) => holdPreview && path === `/v1/proposals/${proposal.id}` ? updatedPreview.promise : undefined;
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/check-replies')) { mock.contacts.set(sent.id, reviewed); return { contactRequest: reviewed, responses: [response], checkedCount: 1, unmatchedCount: 0 }; }
    if (path.endsWith('/confirm')) {
      mock.contacts.set(sent.id, applied);
      mock.proposals.set(proposal.id, { ...awaiting, revision: proposal.revision + 1, status: 'applied' });
      holdPreview = true;
      return { contactRequest: applied, response, scheduleRevision: 8, changed: true };
    }
  };
  const view = harness.renderer(ProposalPanel, { api: mock.api, refreshVersion: 0, onScheduleChanged() {}, onBack() {}, onRequestRevision() {} });
  t.after(() => view.unmount());
  await view.settle(); press(view, '제안 시간 조정, 연락 대기, 상세 보기'); await view.settle();
  press(view, '연락 준비'); await openContact(view);
  assert.match(textOf(view.tree), /상태: 연락 대기/);
  press(view, '회신 확인'); await view.settle();
  press(view, '선택: option-1 · 제안 proposal-1');
  press(view, '회신 확인 후 선택한 대안 재승인'); await view.settle();
  assert.match(textOf(view.tree), /일정 반영됨/);
  assert.match(textOf(view.tree), /제안을 불러오는 중/);
  assert.doesNotMatch(textOf(view.tree), /상태: 연락 대기|원 일정은 유지됩니다/);
  holdPreview = false; updatedPreview.resolve({ proposal: mock.proposals.get(proposal.id) }); await view.settle();
  assert.match(textOf(view.tree), /상태: 적용됨/);
  assert.doesNotMatch(textOf(view.tree), /상태: 연락 대기|원 일정은 유지됩니다|같은 버전을 확인할 수 없어/);
  press(view, '연락 목록'); await view.settle();
  assert.equal(button(view, '새 연락 초안 작성').props.disabled, true);
  press(view, '제안으로'); await view.settle();
  assert.match(textOf(view.tree), /상태: 적용됨/);
  press(view, '연락 내역'); await openContact(view);
  assert.match(textOf(view.tree), /상태: 적용됨/);
  assert.match(textOf(view.tree), /승인된 연락 내용/);
  assert.doesNotMatch(textOf(view.tree), /상태: 연락 대기|원 일정은 유지됩니다|같은 버전을 확인할 수 없어/);
  assert.equal(button(view, 'Gmail 발송'), undefined);
  assert.equal(posts(mock.calls, '/send').length, 0);
});

test('완료된 여러 대안은 한 건 적용, 나머지 미반영으로 표시한다', async t => {
  const { ProposalPanel } = await components;
  const contact = { ...sent, negotiationStatus: 'applied', allowedOptions: [...sent.allowedOptions,
    { optionId: 'option-2', proposalId: alternative.id, proposalRevision: alternative.revision }] };
  const selected = { ...proposal, revision: proposal.revision + 1, status: 'applied' };
  const other = { ...alternative, revision: alternative.revision + 1, status: 'stale' };
  const mock = memoryApi([contact]); mock.proposals.set(selected.id, selected); mock.proposals.set(other.id, other);
  const view = harness.renderer(ProposalPanel, { api: mock.api, refreshVersion: 0, onScheduleChanged() {}, onBack() {}, onRequestRevision() {} });
  t.after(() => view.unmount());
  await view.settle(); press(view, '제안 시간 조정, 적용됨, 상세 보기'); await view.settle();
  press(view, '연락 내역'); await openContact(view);
  assert.match(textOf(view.tree), /상태: 적용됨/); assert.match(textOf(view.tree), /상태: 기준 변경됨/);
  assert.match(textOf(view.tree), /나머지 대안은 반영되지 않았습니다/);
  assert.doesNotMatch(textOf(view.tree), /처리된 제안 내역을 확인할 수 없습니다/);
});

for (const contact of [draft, ready]) {
  test(`${contact.deliveryStatus} 연락은 제안 버전이 변조되면 승인과 발송을 막는다`, async t => {
    const { ContactPanel } = await components;
    const mock = memoryApi([contact]); mock.proposals.set(proposal.id, { ...proposal, revision: proposal.revision + 1 });
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view);
    assert.match(textOf(view.tree), /같은 버전을 확인할 수 없어 승인할 수 없습니다/);
    assert.equal(button(view, contact.deliveryStatus === 'ready' ? 'Gmail 발송' : '연락 내용 승인').props.disabled, true);
    assert.equal(posts(mock.calls, '/decision').length, 0); assert.equal(posts(mock.calls, '/send').length, 0);
  });
}

test('반영 완료 연락의 원본 미확정 회신은 추가 확인이 필요한 상태로 표시하지 않는다', async t => {
  const { ContactPanel } = await components;
  const applied = { ...sent, negotiationStatus: 'applied' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '확인했습니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([applied]);
  mock.proposals.set(proposal.id, { ...proposal, revision: proposal.revision + 1, status: 'applied' });
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: applied, responses: [response] } : undefined;
  const view = harness.renderer(ContactPanel, directProps(mock.api, mock.proposals.get(proposal.id))); t.after(() => view.unmount());
  await openContact(view); press(view, '저장된 응답 조회'); await view.settle();
  assert.match(textOf(view.tree), /일정 반영됨/);
  assert.match(textOf(view.tree), /상태: 원문 판정 미확정/);
  assert.doesNotMatch(textOf(view.tree), /상태: 사용자 확인 필요/);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 0);
});

test('완료 이력에서 예상과 다른 제안 버전은 승인 내역으로 표시하지 않는다', async t => {
  const { ContactPanel } = await components;
  const contact = { ...sent, negotiationStatus: 'applied' };
  const mock = memoryApi([contact]); mock.proposals.set(proposal.id, { ...proposal, revision: proposal.revision + 2, status: 'applied' });
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view);
  assert.match(textOf(view.tree), /처리된 제안 내역을 확인할 수 없습니다/);
  assert.doesNotMatch(textOf(view.tree), /옮긴 회의/);
});

test('다른 대안이 적용되어 stale이 된 원래 제안에서도 연락 내역을 조회할 수 있다', async t => {
  const { ProposalPanel } = await components;
  const contact = { ...sent, negotiationStatus: 'applied', allowedOptions: [...sent.allowedOptions,
    { optionId: 'option-2', proposalId: alternative.id, proposalRevision: alternative.revision }] };
  const original = { ...proposal, revision: proposal.revision + 1, status: 'stale' };
  const selected = { ...alternative, revision: alternative.revision + 1, status: 'applied' };
  const mock = memoryApi([contact]); mock.proposals.set(original.id, original); mock.proposals.set(selected.id, selected);
  const view = harness.renderer(ProposalPanel, { api: mock.api, refreshVersion: 0, onScheduleChanged() {}, onBack() {}, onRequestRevision() {} });
  t.after(() => view.unmount());
  await view.settle(); press(view, '제안 시간 조정, 기준 변경됨, 상세 보기'); await view.settle();
  press(view, '연락 내역'); await view.settle();
  assert.equal(button(view, '새 연락 초안 작성').props.disabled, true);
  await openContact(view);
  assert.match(textOf(view.tree), /조회 전용/); assert.match(textOf(view.tree), /일정 반영됨/);
  assert.match(textOf(view.tree), /상태: 적용됨/); assert.match(textOf(view.tree), /상태: 기준 변경됨/);
  assert.ok(button(view, '저장된 응답 조회'));
  assert.equal(button(view, 'Gmail 발송'), undefined); assert.equal(button(view, '회신 확인'), undefined);
  assert.equal(posts(mock.calls, '/send').length, 0); assert.equal(posts(mock.calls, '/confirm').length, 0);
});

for (const item of [draft, ready, { ...sent, negotiationStatus: 'needs_user_review' }]) {
  test(`stale 제안의 ${item.deliveryStatus} 연락 이력에서는 변경 동작을 제공하지 않는다`, async t => {
    const { ContactPanel } = await components;
    const stale = { ...proposal, revision: proposal.revision + 1, status: 'stale' };
    const mock = memoryApi([item]); mock.proposals.set(stale.id, stale);
    const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
      evidenceRef: 'evidence-1', displayText: '확인했습니다.', reviewReason: 'sender_unverified' };
    mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: item, responses: [response] } : undefined;
    const view = harness.renderer(ContactPanel, directProps(mock.api, stale)); t.after(() => view.unmount());
    await view.settle(); assert.equal(button(view, '새 연락 초안 작성').props.disabled, true);
    await openContact(view); assert.match(textOf(view.tree), /조회 전용/);
    assert.equal(button(view, '연락 내용 승인'), undefined); assert.equal(button(view, '연락 거절'), undefined);
    assert.equal(button(view, 'Gmail 발송'), undefined); assert.equal(button(view, '회신 확인'), undefined);
    if (item.deliveryStatus === 'sent_or_connected') {
      press(view, '저장된 응답 조회'); await view.settle();
      assert.match(textOf(view.tree), /확인했습니다/);
      assert.equal(button(view, '선택: option-1 · 제안 proposal-1'), undefined);
    }
    assert.equal(mock.calls.filter(call => call.method === 'POST').length, 0);
  });
}

test('재승인 timeout 뒤 상태 조회에서 적용이 확인되면 재시도를 없애고 잠금을 해제한다', async t => {
  const { ContactPanel, ApiError, operationGuard } = await components;
  const reviewed = { ...sent, negotiationStatus: 'needs_user_review' };
  const applied = { ...sent, negotiationStatus: 'applied' };
  const response = { id: 'response-1', contactRequestId: sent.id, providerEventId: 'event-1', receivedAt: '2026-11-01T00:00:00Z', outcome: 'unclear', selectedOptionId: null,
    evidenceRef: 'evidence-1', displayText: '확인했습니다.', reviewReason: 'sender_unverified' };
  const mock = memoryApi([sent]);
  mock.api.postHook = (path: string) => {
    if (path.endsWith('/check-replies')) return { contactRequest: reviewed, responses: [response], checkedCount: 1, unmatchedCount: 0 };
    if (path.endsWith('/confirm')) throw new ApiError('timeout', 'timeout', true);
  };
  const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
  await openContact(view); press(view, '회신 확인'); await view.settle();
  press(view, '선택: option-1 · 제안 proposal-1'); press(view, '회신 확인 후 선택한 대안 재승인'); await view.settle();
  assert.ok(button(view, '동일 재승인 요청 재시도'));
  mock.contacts.set(sent.id, applied); mock.proposals.set(proposal.id, { ...proposal, revision: proposal.revision + 1, status: 'applied' });
  mock.api.getHook = (path: string) => path.endsWith('/responses') ? { contactRequest: applied, responses: [] } : undefined;
  press(view, '연락 상태 조회'); await view.settle();
  assert.match(textOf(view.tree), /일정 반영됨/); assert.match(textOf(view.tree), /조회 전용/);
  assert.equal(button(view, '동일 재승인 요청 재시도'), undefined);
  assert.notEqual(button(view, '연락 목록').props.disabled, true);
  assert.equal(operationGuard.hasUnresolved(), false);
  press(view, '저장된 응답 조회'); await view.settle();
  assert.match(textOf(view.tree), /저장된 응답이 없습니다/);
  assert.equal(posts(mock.calls, '/confirm').length, 1);
});

for (const action of ['decision', 'send'] as const) {
  test(`${action} timeout 뒤 적용된 연락 이력에서는 변경 재시도를 제공하지 않는다`, async t => {
    const { ContactPanel, ApiError, operationGuard } = await components;
    const start = action === 'decision' ? draft : ready;
    const applied = { ...sent, negotiationStatus: 'applied' };
    const mock = memoryApi([start]);
    mock.api.postHook = (path: string) => {
      if (path.endsWith(`/${action}`)) throw new ApiError('timeout', 'timeout', true);
    };
    const view = harness.renderer(ContactPanel, directProps(mock.api)); t.after(() => view.unmount());
    await openContact(view); press(view, action === 'decision' ? '연락 내용 승인' : 'Gmail 발송'); await view.settle();
    mock.contacts.set(sent.id, applied); mock.proposals.set(proposal.id, { ...proposal, revision: proposal.revision + 1, status: 'applied' });
    press(view, '연락 상태 조회'); await view.settle();
    assert.match(textOf(view.tree), /일정 반영됨/); assert.match(textOf(view.tree), /조회 전용/);
    assert.equal(button(view, '연락 결정 동일 요청 재시도'), undefined);
    assert.equal(button(view, '동일 발송 요청 재시도'), undefined);
    assert.notEqual(button(view, '연락 목록').props.disabled, true);
    assert.equal(operationGuard.hasUnresolved(), false);
    assert.equal(posts(mock.calls, `/${action}`).length, 1);
  });
}
