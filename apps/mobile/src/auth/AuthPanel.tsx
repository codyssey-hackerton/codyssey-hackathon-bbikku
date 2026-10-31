import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { operationGuard } from '../api/operationGuard';
import { ActionButton } from '../ui/ActionButton';
import { PikkuCharacter } from '../ui/PikkuCharacter';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createAuthClient, type LoginResult } from './client';

type State = 'idle' | 'starting' | 'ready' | 'completing' | 'error' | 'completion_unknown';
export default function AuthPanel({ baseUrl, onBack, onSignedIn, mode, onFlowActiveChange }: {
  baseUrl: string; onBack: () => void; onSignedIn: (result: LoginResult) => boolean;
  mode?: 'signup' | 'login'; onFlowActiveChange?: (active: boolean) => void;
}) {
  const client = useMemo(() => createAuthClient(baseUrl), [baseUrl]);
  const [state, setState] = useState<State>('idle');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [opened, setOpened] = useState(false);
  const flow = useRef<{ url: string; secret: string; startedAt: number } | null>(null);
  const generation = useRef(0); const owner = useRef<object>({}); const locked = useRef(false);
  const active = useRef(false); const activeCallback = useRef(onFlowActiveChange);
  activeCallback.current = onFlowActiveChange;
  function setFlowActive(value: boolean) {
    if (active.current === value) return;
    active.current = value; activeCallback.current?.(value);
  }
  useEffect(() => () => { generation.current += 1; flow.current = null; operationGuard.clear(owner.current); setFlowActive(false); }, [client]);
  function back() {
    generation.current += 1; flow.current = null; setCode(''); setFlowActive(false); onBack();
  }
  async function start() {
    if (locked.current || operationGuard.hasUnresolved()) { setNotice('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    locked.current = true; flow.current = null; setCode(''); setOpened(false); setNotice(''); setState('starting'); setFlowActive(true);
    const current = ++generation.current;
    try {
      const startedAt = globalThis.performance?.now();
      if (!Number.isFinite(startedAt)) throw new Error('TIME_UNAVAILABLE');
      const value = await client.start();
      const elapsed = globalThis.performance.now() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) throw new Error('EXPIRED');
      if (current === generation.current) { flow.current = { url: value.authorizationUrl, secret: value.completionSecret, startedAt }; setState('ready'); }
    } catch { if (current === generation.current) { setFlowActive(false); setNotice('로그인을 준비하지 못했습니다. 연결 상태를 확인하고 다시 시작해 주세요.'); setState('error'); } }
    finally { locked.current = false; }
  }
  async function open() {
    const current = generation.current, value = flow.current;
    if (!value || state !== 'ready') return;
    const elapsed = globalThis.performance?.now() - value.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) { flow.current = null; setFlowActive(false); setState('error'); setNotice('로그인 준비 시간이 지났습니다. 다시 시작해 주세요.'); return; }
    try { await Linking.openURL(value.url); if (current === generation.current) setOpened(true); }
    catch { if (current === generation.current) setNotice('Google 화면을 열지 못했습니다. 다시 시도해 주세요.'); }
  }
  async function complete() {
    const value = flow.current, confirmationCode = code.trim();
    if (!value || state !== 'ready' || locked.current || !/^[A-Za-z0-9_-]{43}$/.test(confirmationCode)) return;
    if (operationGuard.hasUnresolved()) { setNotice('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    const elapsed = globalThis.performance?.now() - value.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 600_000) { flow.current = null; setCode(''); setFlowActive(false); setState('error'); setNotice('로그인 준비 시간이 지났습니다. 다시 시작해 주세요.'); return; }
    const current = generation.current; locked.current = true; flow.current = null; setCode(''); setNotice(''); setState('completing');
    operationGuard.update(owner.current, { status: 'pending' });
    try {
      const result = await client.complete(value.secret, confirmationCode);
      operationGuard.clear(owner.current);
      if (current === generation.current) {
        setFlowActive(false);
        if (!onSignedIn(result)) { setState('error'); setNotice('처리 중인 요청이 있어 계정을 바꾸지 못했습니다. 요청을 확인하고 로그인을 다시 시작해 주세요.'); }
      }
    } catch {
      if (current === generation.current) { setFlowActive(false); setState('completion_unknown'); setNotice('로그인 결과를 확인하지 못했습니다. 자동 재시도하지 않으며 로그인을 다시 시작해야 합니다.'); }
    } finally { locked.current = false; operationGuard.clear(owner.current); }
  }
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
  <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.container}>
    <View style={styles.back}><ActionButton label="뒤로" disabled={state === 'starting' || state === 'completing'} onPress={back} secondary /></View>
    <Text style={styles.eyebrow}>PIKKU · ACCOUNT</Text>
    <Text accessibilityRole="header" style={styles.title}>{mode === 'signup' ? '새로운 시작' : mode === 'login' ? '다시 만나 반가워요' : 'Google로 로그인 또는 가입'}</Text>
    <Text style={styles.description}>{mode === 'signup' ? 'Google 계정으로 삐꾸를 시작해요.' : 'Google 계정으로 삐꾸에 로그인해요.'}</Text>
    <View style={styles.hero} accessible={false}><View style={styles.mascot}><PikkuCharacter size={68} /></View></View>
    <View style={styles.card}>
    <Text style={styles.cardTitle}>Google 계정으로 계속하기</Text>
    <Text style={styles.description}>이 로그인은 앱 계정용입니다. 캘린더와 Gmail 연결은 로그인 후 별도로 동의합니다.</Text>
    <ActionButton label="Google 로그인 시작" disabled={state === 'starting' || state === 'completing'} onPress={() => void start()} />
    {state === 'starting' && <Text accessibilityLiveRegion="polite">로그인 화면을 준비하고 있습니다.</Text>}
    {state === 'ready' && <><ActionButton label="Google 로그인 화면 열기" onPress={() => void open()} secondary />
      {opened && <Text>Google 화면 열기를 요청했습니다. 동의 후 브라우저에 표시된 확인 코드를 입력하세요.</Text>}
      <TextInput accessibilityLabel="Google 로그인 확인 코드" value={code} onChangeText={setCode} secureTextEntry autoComplete="off" autoCapitalize="none" autoCorrect={false} maxLength={43} style={styles.input} />
      <ActionButton label="Google 로그인 확인" disabled={!/^[A-Za-z0-9_-]{43}$/.test(code.trim())} onPress={() => void complete()} /></>}
    {state === 'completing' && <Text accessibilityLiveRegion="polite">로그인 결과를 확인하고 있습니다.</Text>}
    {!!notice && <Text accessibilityRole="alert">{notice}</Text>}
    </View>
  </ScrollView></KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32, gap: 12 },
  back: { alignSelf: 'flex-start', minWidth: 72 },
  eyebrow: { color: colors.primaryPressed, fontSize: 12, fontWeight: '700', marginTop: 8 },
  title: { color: colors.text, fontSize: 26, lineHeight: 36, fontWeight: '700' },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  hero: { alignItems: 'center', justifyContent: 'center', minHeight: 180 },
  mascot: { width: 128, height: 128, borderRadius: 64, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 12, borderColor: 'rgba(255,255,255,0.55)' },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 18, gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text },
});
