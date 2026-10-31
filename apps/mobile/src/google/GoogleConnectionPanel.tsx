import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { ActionButton } from '../ui/ActionButton';
import { createGoogleClient, type ConnectionStatus, type GoogleConnectionKind } from './client';

const connections: { kind: GoogleConnectionKind; title: string; description: string }[] = [
  { kind: 'calendar', title: 'Google 캘린더 읽기', description: '캘린더를 조회하고 선택한 일정을 가져올 수 있습니다.' },
  { kind: 'calendar_write', title: 'Google 캘린더 동기화', description: '양방향 동기화에 필요한 별도 읽기·쓰기 권한입니다. 연결만으로 동기화하지 않습니다.' },
  { kind: 'gmail_send', title: 'Gmail 발송', description: '승인한 연락을 발송할 수 있습니다. 계정 연결만으로 메일을 보내지 않습니다.' },
  { kind: 'gmail_read', title: 'Gmail 회신 읽기', description: '처음 개인 계정을 연결할 때는 Gmail 발송을 먼저 연결한 뒤 회신 읽기를 연결해 주세요. 같은 Google 계정을 사용해야 합니다.' },
  { kind: 'contacts', title: 'Google 연락처', description: '이름으로 연락처를 검색하고 선택한 전화번호를 확인합니다. 선택만으로 전화를 걸지 않습니다.' },
];
type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'success'; data: ConnectionStatus };
type Start = { status: 'idle' | 'pending' | 'completing' | 'complete' } | { status: 'ready'; kind: GoogleConnectionKind } | { status: 'error'; error: unknown } | { status: 'completion_unknown' };

function message(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  return code === 'not_configured' ? 'Google 연결이 아직 설정되지 않았습니다. 관리자에게 설정을 요청해 주세요.' :
    code === 'expired' ? 'Google 연결 준비 시간이 지났습니다. 연결을 다시 시작해 주세요.' :
    code === 'unauthenticated' ? '삐꾸 로그인 세션을 확인한 뒤 다시 시도해 주세요.' :
    code === 'permission_denied' ? '현재 삐꾸 계정에서 이 연결을 확인할 권한이 없습니다.' :
    code === 'invalid_response' ? 'Google 연결 상태 응답을 확인할 수 없습니다.' : '연결 상태를 불러오지 못했습니다. 서버 연결을 확인한 뒤 다시 시도해 주세요.';
}

function Button({ label, onPress, disabled = false, primary = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <ActionButton label={label} onPress={onPress} disabled={disabled} secondary={!primary} />;
}

export default function GoogleConnectionPanel({ api, onBack, onOpenCalendarImport }: { api: ApiClient; onBack: () => void; onOpenCalendarImport?: () => void }) {
  const client = useMemo(() => createGoogleClient(api), [api]);
  const [statuses, setStatuses] = useState<Record<GoogleConnectionKind, Load>>({ calendar: { status: 'loading' }, calendar_write: { status: 'loading' }, gmail_send: { status: 'loading' }, gmail_read: { status: 'loading' }, contacts: { status: 'loading' } });
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
    setStatuses({ calendar: { status: 'loading' }, calendar_write: { status: 'loading' }, gmail_send: { status: 'loading' }, gmail_read: { status: 'loading' }, contacts: { status: 'loading' } });
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
    <Text style={styles.eyebrow}>GOOGLE 연결 관리</Text>
    <Text accessibilityRole="header" style={styles.title}>Google 서비스 연결</Text>
    <Text style={styles.intro}>삐꾸 로그인과 Google 서비스 연결은 별도입니다. 현재 삐꾸 사용자에게 필요한 권한만 Google 동의 화면에서 직접 확인해 주세요.</Text>
    <View style={styles.notice}><Text style={styles.noticeTitle}>동의 없이 연결하지 않아요</Text>
      <Text style={styles.detail}>캘린더·Gmail·연락처 권한은 각각 연결합니다. 연결만으로 일정 변경이나 메일 발송이 이루어지지 않습니다.</Text></View>
    <Text accessibilityRole="header" style={styles.section}>Google Calendar</Text>
    {connections.map(({ kind, title, description }) => {
      const status = statuses[kind];
      return <View key={kind}>
      {kind === 'contacts' && <Text accessibilityRole="header" style={styles.section}>연락처</Text>}
      {kind === 'gmail_send' && <Text accessibilityRole="header" style={styles.section}>Gmail</Text>}
      <View style={styles.card}>
      <View style={styles.cardHeader}><Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        {status.status === 'success' && <Text style={[styles.status, status.data.status === 'available' ? styles.connected : styles.unconnected]}>{status.data.status === 'available' ? '연결됨' : '미연결'}</Text>}</View>
      <Text style={styles.detail}>{description}</Text>
      {status.status === 'loading' && <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator size="small" /><Text style={styles.detail}>연결 상태를 확인하는 중입니다.</Text></View>}
      {status.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{message(status.error)}</Text>}
      {status.status === 'success' && status.data.status === 'available' && status.data.account && <Text style={styles.detail}>연결 계정: {status.data.account}</Text>}
      {status.status === 'success' && status.data.status === 'not_configured' && <Text style={styles.detail}>이 권한은 아직 연결되지 않았습니다.</Text>}
      {kind === 'calendar' && status.status === 'success' && status.data.status === 'available' && onOpenCalendarImport &&
        <Button label="캘린더 일정 가져오기" primary onPress={onOpenCalendarImport} disabled={start.status === 'pending' || start.status === 'completing'} />}
      <Button label={`${title} 연결 시작`} disabled={start.status === 'pending' || start.status === 'completing'} onPress={() => { void prepare(kind); }} />
    </View></View>; })}
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
    <Button label="뒤로" primary onPress={onBack} disabled={start.status === 'pending' || start.status === 'completing'} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, paddingBottom: 40 }, eyebrow: { color: colors.primaryPressed, fontSize: 11, fontWeight: '700' },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' }, intro: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  section: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 12, marginBottom: 8 },
  heading: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 }, text: { color: colors.text, lineHeight: 21 },
  detail: { color: colors.muted, fontSize: 13, lineHeight: 19 }, notice: { backgroundColor: colors.surfaceSecondary, borderRadius: 18, padding: 16, gap: 6 },
  noticeTitle: { color: colors.text, fontSize: 15, fontWeight: '700' }, error: { color: colors.error, lineHeight: 21 },
  card: { gap: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 17, padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  status: { overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 12, fontWeight: '700' },
  connected: { backgroundColor: '#E3F7EA', color: '#17633D' }, unconnected: { backgroundColor: colors.surfaceSecondary, color: colors.muted },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { minHeight: 44, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, color: colors.text },
});
