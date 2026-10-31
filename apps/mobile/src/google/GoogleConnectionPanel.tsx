import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createGoogleClient, type ConnectionStatus, type GoogleConnectionKind } from './client';

const connections: { kind: GoogleConnectionKind; title: string; description: string }[] = [
  { kind: 'calendar', title: 'Google 캘린더 읽기', description: '캘린더를 조회하고 선택한 일정을 가져올 수 있습니다.' },
  { kind: 'calendar_write', title: 'Google 캘린더 동기화', description: '양방향 동기화에 필요한 별도 읽기·쓰기 권한입니다. 연결만으로 동기화하지 않습니다.' },
  { kind: 'gmail_send', title: 'Gmail 발송', description: '승인한 연락을 발송할 수 있습니다. 계정 연결만으로 메일을 보내지 않습니다.' },
  { kind: 'gmail_read', title: 'Gmail 회신 읽기', description: '처음 개인 계정을 연결할 때는 Gmail 발송을 먼저 연결한 뒤 회신 읽기를 연결해 주세요. 같은 Google 계정을 사용해야 합니다.' },
];
type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'success'; data: ConnectionStatus };
type Start = { status: 'idle' | 'pending' | 'completing' | 'complete' } | { status: 'ready'; kind: GoogleConnectionKind } | { status: 'error'; error: unknown } | { status: 'completion_unknown' };

function message(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  return code === 'not_configured' ? 'Google 연결이 아직 설정되지 않았습니다. 관리자에게 설정을 요청해 주세요.' :
    code === 'expired' ? 'Google 연결 준비 시간이 지났습니다. 연결을 다시 시작해 주세요.' :
    code === 'unauthenticated' || code === 'permission_denied' ? '현재 삐꾸 사용자 세션을 확인해 주세요.' :
    code === 'invalid_response' ? 'Google 연결 응답을 확인할 수 없습니다.' : 'Google 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text>{label}</Text></Pressable>;
}

export default function GoogleConnectionPanel({ api, onBack }: { api: ApiClient; onBack: () => void }) {
  const client = useMemo(() => createGoogleClient(api), [api]);
  const [statuses, setStatuses] = useState<Record<GoogleConnectionKind, Load>>({ calendar: { status: 'loading' }, calendar_write: { status: 'loading' }, gmail_send: { status: 'loading' }, gmail_read: { status: 'loading' } });
  const [attempt, setAttempt] = useState(0);
  const [start, setStart] = useState<Start>({ status: 'idle' });
  const [opened, setOpened] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState('');
  const activeFlow = useRef<{ url: string; completionSecret: string; startedAt: number } | null>(null);
  const completionLock = useRef(false);
  const completionOwner = useRef<object>({});
  const generation = useRef(0);
  const startGeneration = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatuses({ calendar: { status: 'loading' }, calendar_write: { status: 'loading' }, gmail_send: { status: 'loading' }, gmail_read: { status: 'loading' } });
    for (const { kind } of connections) client.status(kind).then((data) => {
      if (generation.current === current) setStatuses((previous) => ({ ...previous, [kind]: { status: 'success', data } }));
    }, (error: unknown) => {
      if (generation.current === current) setStatuses((previous) => ({ ...previous, [kind]: { status: 'error', error } }));
    });
    return () => { generation.current += 1; };
  }, [client, attempt]);
  useEffect(() => () => { startGeneration.current += 1; activeFlow.current = null; operationGuard.clear(completionOwner.current); }, [client]);

  async function prepare(kind: GoogleConnectionKind) {
    if (start.status === 'pending' || start.status === 'completing' || completionLock.current) return;
    const current = ++startGeneration.current; activeFlow.current = null; setConfirmationCode(''); setOpened(false); setStart({ status: 'pending' });
    try {
      const startedAt = globalThis.performance?.now();
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw new ApiError('not_configured', '연결 유효기간을 확인할 수 없습니다.');
      const { authorizationUrl, completionSecret } = await client.start(kind);
      const elapsed = globalThis.performance.now() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 10 * 60_000) throw new ApiError('expired', '연결 준비 시간이 지났습니다.');
      if (startGeneration.current === current) { activeFlow.current = { url: authorizationUrl, completionSecret, startedAt }; setStart({ status: 'ready', kind }); }
    } catch (error) {
      if (startGeneration.current === current) setStart({ status: 'error', error });
    }
  }
  async function openConsent() {
    const flow = activeFlow.current;
    if (start.status !== 'ready' || !flow) return;
    const current = startGeneration.current;
    try {
      const elapsed = globalThis.performance?.now() - flow.startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 10 * 60_000) throw new ApiError('expired', '연결 준비 시간이 지났습니다.');
      await Linking.openURL(flow.url);
      if (current === startGeneration.current) setOpened(true);
    } catch (error) {
      if (current === startGeneration.current) { activeFlow.current = null; setConfirmationCode(''); setStart({ status: 'error', error }); }
    }
  }
  async function complete() {
    const flow = activeFlow.current, code = confirmationCode.trim();
    if (start.status !== 'ready' || !flow || !/^[A-Za-z0-9_-]{43}$/.test(code) || completionLock.current) return;
    const elapsed = globalThis.performance?.now() - flow.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 10 * 60_000) {
      activeFlow.current = null; setConfirmationCode(''); setStart({ status: 'error', error: new ApiError('expired', '연결 준비 시간이 지났습니다.') }); return;
    }
    const current = startGeneration.current;
    completionLock.current = true; activeFlow.current = null; setConfirmationCode(''); setStart({ status: 'completing' });
    operationGuard.update(completionOwner.current, { status: 'pending' });
    try {
      await client.complete(flow.completionSecret, code);
      if (current === startGeneration.current) { setStart({ status: 'complete' }); setAttempt((value) => value + 1); }
    } catch {
      if (current === startGeneration.current) setStart({ status: 'completion_unknown' });
    } finally {
      completionLock.current = false; operationGuard.clear(completionOwner.current);
    }
  }
  return <ScrollView contentContainerStyle={styles.container}>
    <Button label="뒤로" onPress={onBack} disabled={start.status === 'pending' || start.status === 'completing'} />
    <Text accessibilityRole="header" style={styles.title}>내 Google 연결</Text>
    <Text style={styles.text}>현재 삐꾸 사용자에 Google 계정을 연결합니다. 각 권한은 Google 동의 화면에서 별도로 확인합니다.</Text>
    {connections.map(({ kind, title, description }) => {
      const status = statuses[kind];
      return <View style={styles.card} key={kind}>
      <Text accessibilityRole="header" style={styles.heading}>{title}</Text><Text style={styles.text}>{description}</Text>
      {status.status === 'loading' && <View accessibilityLiveRegion="polite"><ActivityIndicator /><Text>연결 상태를 확인하는 중입니다.</Text></View>}
      {status.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{message(status.error)}</Text>}
      {status.status === 'success' && <Text style={styles.text}>{status.data.status === 'available'
        ? `연결됨${status.data.account ? ` · ${status.data.account}` : ''}` : '연결되지 않음'}</Text>}
      <Button label={`${title} 연결 시작`} disabled={start.status === 'pending' || start.status === 'completing'} onPress={() => { void prepare(kind); }} />
    </View>; })}
    {start.status === 'pending' && <Text accessibilityLiveRegion="polite" style={styles.text}>Google 동의 화면을 준비하고 있습니다.</Text>}
    {start.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{message(start.error)}</Text>}
    {start.status === 'ready' && <>
      <Text style={styles.text}>{connections.find((item) => item.kind === start.kind)?.title} 권한을 Google에서 직접 확인해 주세요.</Text>
      <Button label="Google 동의 화면 열기" onPress={() => { void openConsent(); }} />
      {opened && <Text style={styles.text}>동의 화면 열기를 요청했습니다. 화면이 보이지 않으면 팝업 설정을 확인해 주세요.</Text>}
      <Text style={styles.text}>Google 동의가 끝나면 브라우저에 표시된 연결 확인 코드를 복사해 아래에 입력해 주세요. 이 코드를 다른 사람에게 전달하지 마세요.</Text>
      <TextInput accessibilityLabel="Google 연결 확인 코드" value={confirmationCode} onChangeText={setConfirmationCode}
        secureTextEntry autoComplete="off" autoCapitalize="none" autoCorrect={false} maxLength={43} style={styles.input} />
      <Button label="Google 연결 확인" disabled={!/^[A-Za-z0-9_-]{43}$/.test(confirmationCode.trim())} onPress={() => { void complete(); }} />
    </>}
    {start.status === 'completing' && <Text accessibilityLiveRegion="polite" style={styles.text}>Google 연결을 확인하는 중입니다.</Text>}
    {start.status === 'complete' && <Text accessibilityLiveRegion="polite" style={styles.text}>연결을 확인했습니다. 권한별 상태를 다시 조회합니다.</Text>}
    {start.status === 'completion_unknown' && <Text accessibilityRole="alert" style={styles.error}>연결 결과를 확인하지 못했습니다. 연결 상태를 다시 확인해 주세요. 기존 계정이 이미 연결되어 있었다면 상태만으로 이번 변경 여부를 알 수 없으므로 필요하면 처음부터 다시 시작해 주세요.</Text>}
    <Button label="연결 상태 다시 확인" disabled={start.status === 'pending' || start.status === 'completing'} onPress={() => { setAttempt((value) => value + 1); }} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12, paddingBottom: 32 }, title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  heading: { color: colors.text, fontSize: 17, fontWeight: '700' }, text: { color: colors.text, lineHeight: 21 },
  error: { color: colors.error, lineHeight: 21 }, card: { gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft }, disabled: { opacity: 0.5 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text },
});
