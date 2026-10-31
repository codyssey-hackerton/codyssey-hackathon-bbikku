import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet } from 'react-native';
import { operationGuard } from '../api/operationGuard';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createAuthClient, type LoginResult } from './client';

type State = 'idle' | 'starting' | 'ready' | 'completing' | 'error' | 'completion_unknown';
export default function AuthPanel({ baseUrl, onBack, onSignedIn }: { baseUrl: string; onBack: () => void; onSignedIn: (result: LoginResult) => boolean }) {
  const client = useMemo(() => createAuthClient(baseUrl), [baseUrl]);
  const [state, setState] = useState<State>('idle');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [opened, setOpened] = useState(false);
  const flow = useRef<{ url: string; secret: string; startedAt: number } | null>(null);
  const generation = useRef(0); const owner = useRef<object>({}); const locked = useRef(false);
  useEffect(() => () => { generation.current += 1; flow.current = null; operationGuard.clear(owner.current); }, [client]);
  async function start() {
    if (locked.current || operationGuard.hasUnresolved()) { setNotice('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    locked.current = true; flow.current = null; setCode(''); setOpened(false); setNotice(''); setState('starting');
    const current = ++generation.current;
    try {
      const startedAt = globalThis.performance?.now();
      if (!Number.isFinite(startedAt)) throw new Error('TIME_UNAVAILABLE');
      const value = await client.start();
      const elapsed = globalThis.performance.now() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) throw new Error('EXPIRED');
      if (current === generation.current) { flow.current = { url: value.authorizationUrl, secret: value.completionSecret, startedAt }; setState('ready'); }
    } catch { if (current === generation.current) { setNotice('로그인을 준비하지 못했습니다. 연결 상태를 확인하고 다시 시작해 주세요.'); setState('error'); } }
    finally { locked.current = false; }
  }
  async function open() {
    const current = generation.current, value = flow.current;
    if (!value || state !== 'ready') return;
    const elapsed = globalThis.performance?.now() - value.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) { flow.current = null; setState('error'); setNotice('로그인 준비 시간이 지났습니다. 다시 시작해 주세요.'); return; }
    try { await Linking.openURL(value.url); if (current === generation.current) setOpened(true); }
    catch { if (current === generation.current) setNotice('Google 화면을 열지 못했습니다. 다시 시도해 주세요.'); }
  }
  async function complete() {
    const value = flow.current, confirmationCode = code.trim();
    if (!value || state !== 'ready' || locked.current || !/^[A-Za-z0-9_-]{43}$/.test(confirmationCode)) return;
    if (operationGuard.hasUnresolved()) { setNotice('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    const elapsed = globalThis.performance?.now() - value.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) { flow.current = null; setCode(''); setState('error'); setNotice('로그인 준비 시간이 지났습니다. 다시 시작해 주세요.'); return; }
    const current = generation.current; locked.current = true; flow.current = null; setCode(''); setNotice(''); setState('completing');
    operationGuard.update(owner.current, { status: 'pending' });
    try {
      const result = await client.complete(value.secret, confirmationCode);
      operationGuard.clear(owner.current);
      if (current === generation.current && !onSignedIn(result)) { setState('error'); setNotice('처리 중인 요청이 있어 계정을 바꾸지 못했습니다. 요청을 확인하고 로그인을 다시 시작해 주세요.'); }
    } catch {
      if (current === generation.current) { setState('completion_unknown'); setNotice('로그인 결과를 확인하지 못했습니다. 자동 재시도하지 않으며 로그인을 다시 시작해야 합니다.'); }
    } finally { locked.current = false; operationGuard.clear(owner.current); }
  }
  return <ScrollView contentContainerStyle={styles.container}>
    <ActionButton label="뒤로" disabled={state === 'starting' || state === 'completing'} onPress={onBack} secondary />
    <Text accessibilityRole="header" style={styles.title}>Google로 로그인 또는 가입</Text>
    <Text>이 로그인은 앱 계정용입니다. 캘린더와 Gmail 연결은 로그인 후 별도로 동의합니다.</Text>
    <ActionButton label="Google 로그인 시작" disabled={state === 'starting' || state === 'completing'} onPress={() => void start()} />
    {state === 'starting' && <Text accessibilityLiveRegion="polite">로그인 화면을 준비하고 있습니다.</Text>}
    {state === 'ready' && <><ActionButton label="Google 로그인 화면 열기" onPress={() => void open()} secondary />
      {opened && <Text>Google 화면 열기를 요청했습니다. 동의 후 브라우저에 표시된 확인 코드를 입력하세요.</Text>}
      <TextInput accessibilityLabel="Google 로그인 확인 코드" value={code} onChangeText={setCode} secureTextEntry autoComplete="off" autoCapitalize="none" autoCorrect={false} maxLength={43} style={styles.input} />
      <ActionButton label="Google 로그인 확인" disabled={!/^[A-Za-z0-9_-]{43}$/.test(code.trim())} onPress={() => void complete()} /></>}
    {state === 'completing' && <Text accessibilityLiveRegion="polite">로그인 결과를 확인하고 있습니다.</Text>}
    {!!notice && <Text accessibilityRole="alert">{notice}</Text>}
  </ScrollView>;
}
const styles = StyleSheet.create({ container: { padding: 20, gap: 12, paddingBottom: 32 }, title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text } });
