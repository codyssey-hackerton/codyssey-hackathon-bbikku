import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import { FontReadyContext, Text, TextInput } from './src/ui/typography';
import { colors } from './src/ui/theme';
import { TabIcon } from './src/ui/TabIcon';
import { Icon } from './src/ui/Icon';
import { GlassSurface } from './src/ui/GlassSurface';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { createApiClient } from './src/api/http';
import { normalizeApiBaseUrl } from './src/api/connection';
import { operationGuard } from './src/api/operationGuard';
import type { ApiClient } from './src/api/http';
import ChatScreen, { type RecoveryRequest, type RevisionRequest } from './src/chat/ChatScreen';
import { createChatClient } from './src/chat/client';
import type { CoordinationTarget } from './src/chat/client';
import ProposalPanel from './src/proposals/ProposalPanel';
import MemoryPanel from './src/memory/MemoryPanel';
import ReviewPanel from './src/review/ReviewPanel';
import CalendarScreen from './src/screens/CalendarScreen';
import CalendarImportPanel from './src/calendar/CalendarImportPanel';
import PhoneConnectionPanel from './src/contacts/PhoneConnectionPanel';
import GoogleConnectionPanel from './src/google/GoogleConnectionPanel';
import HealthPanel from './src/health/HealthPanel';
import DayScreen from './src/screens/DayScreen';
import { createScheduleClient } from './src/schedule/client';
import { civilDate, formatCivilDate, startOfDay } from './src/schedule/dates';
import AuthPanel from './src/auth/AuthPanel';
import { createAuthClient, type LoginResult, type Member } from './src/auth/client';
import RoutinesPanel from './src/routines/RoutinesPanel';
import CalendarSyncPanel from './src/calendar-sync/CalendarSyncPanel';

type Tab = 'chat' | 'calendar' | 'day';
const tabs: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'AI 채팅' },
  { id: 'calendar', label: '캘린더' },
  { id: 'day', label: '하루 일정' },
];

// Public Expo variables are embedded in the app. Never place credentials here.
const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || (Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001');
const defaultApiUrl = normalizeApiBaseUrl(configuredApiUrl) ?? configuredApiUrl;

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
}

function Scene({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <View style={[styles.screen, !visible && styles.hidden]} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>{children}</View>;
}

function ConnectedWorkspace({ api, timezone }: { api: ApiClient; timezone: string }) {
  const [tab, setTab] = useState<Tab>('chat');
  const [panel, setPanel] = useState<'main' | 'proposals' | 'memory' | 'review' | 'calendarImport' | 'phoneConnection' | 'googleConnection' | 'routines' | 'calendarSync'>('main');
  const [routinesOpened, setRoutinesOpened] = useState(false);
  const [calendarSyncOpened, setCalendarSyncOpened] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [coordinationTarget, setCoordinationTarget] = useState<(CoordinationTarget & { title: string }) | undefined>();
  const [recoveryRequest, setRecoveryRequest] = useState<RecoveryRequest | undefined>();
  const [revisionRequest, setRevisionRequest] = useState<RevisionRequest | undefined>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [proposalRefreshVersion, setProposalRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
    setProposalRefreshVersion((version) => version + 1);
  }, []);
  const refreshProposals = useCallback(() => setProposalRefreshVersion((version) => version + 1), []);
  const chatClient = useMemo(() => createChatClient(api), [api]);
  const scheduleClient = useMemo(() => createScheduleClient(api), [api]);
  const chatVisible = tab === 'chat' && panel === 'main';

  return <>
    <View style={styles.screenContainer}>
      {panel === 'main' && <Pressable accessibilityRole="button" accessibilityLabel="Google 연결" onPress={() => setPanel('googleConnection')} style={styles.importButton}>
        <Text style={styles.settingsToggleText}>Google 연결</Text>
      </Pressable>}
      {panel === 'main' && <Pressable accessibilityRole="button" accessibilityLabel="전화 외부 연결" onPress={() => setPanel('phoneConnection')} style={styles.importButton}>
        <Text style={styles.settingsToggleText}>전화 외부 연결</Text>
      </Pressable>}
      {panel === 'main' && <Pressable accessibilityRole="button" accessibilityLabel="루틴" onPress={() => { setRoutinesOpened(true); setPanel('routines'); }} style={styles.importButton}>
        <Text style={styles.settingsToggleText}>루틴</Text>
      </Pressable>}
      {panel === 'main' && (tab === 'calendar' || tab === 'day') && <Pressable accessibilityRole="button" accessibilityLabel="캘린더 일정 가져오기" onPress={() => setPanel('calendarImport')} style={styles.importButton}>
        <Text style={styles.settingsToggleText}>캘린더 일정 가져오기</Text>
      </Pressable>}
      {panel === 'main' && (tab === 'calendar' || tab === 'day') && <Pressable accessibilityRole="button" accessibilityLabel="Google 캘린더 동기화" onPress={() => { setCalendarSyncOpened(true); setPanel('calendarSync'); }} style={styles.importButton}>
        <Text style={styles.settingsToggleText}>Google 캘린더 동기화</Text>
      </Pressable>}
      <Scene visible={chatVisible}>
        <ChatScreen client={chatClient} timezone={timezone} scheduleClient={scheduleClient} selectedDate={selectedDate} refreshVersion={refreshVersion}
          onOpenProposals={() => setPanel('proposals')} onOpenMemory={() => setPanel('memory')} onOpenReviewSchedule={() => { setReviewOpened(true); setPanel('review'); }} onProposalCreated={refreshProposals}
          coordinationTarget={coordinationTarget} onClearCoordinationTarget={() => setCoordinationTarget(undefined)} recoveryRequest={recoveryRequest} revisionRequest={revisionRequest} />
      </Scene>
      <Scene visible={panel === 'main' && tab === 'calendar'}><CalendarScreen selectedDate={selectedDate} onSelectDate={setSelectedDate} client={scheduleClient} timezone={timezone} refreshVersion={refreshVersion} /></Scene>
      <Scene visible={panel === 'main' && tab === 'day'}><DayScreen selectedDate={selectedDate} onSelectDate={setSelectedDate} client={scheduleClient} api={api} onOpenPreparationProposals={() => { refreshProposals(); setPanel('proposals'); }} timezone={timezone} refreshVersion={refreshVersion} onScheduleChanged={refresh} visible={panel === 'main' && tab === 'day'}
        onCoordinate={(item) => { setCoordinationTarget({ id: item.id, expectedRevision: item.revision, title: item.title }); setTab('chat'); }}
        onRecovery={(item) => {
          const dateLabel = formatCivilDate(civilDate(selectedDate, timezone));
          setRecoveryRequest({ key: JSON.stringify([item.id, dateLabel]), title: item.title, dateLabel,
            text: `${dateLabel}에 확인한 미완료 할 일 “${item.title}”이 아직 필요한지와 기한을 먼저 확인하고 싶어요. 필요하다면 가능한 복구 방법을 함께 살펴봐 주세요. 일정 변경은 제안을 보고 결정할게요.` });
          setTab('chat');
        }} /></Scene>
      <Scene visible={panel === 'proposals'}><ProposalPanel api={api} refreshVersion={proposalRefreshVersion} onScheduleChanged={refresh} onBack={() => setPanel('main')} onRequestRevision={(proposal) => {
        const target = proposal.coordinationTarget;
        setRevisionRequest({ key: JSON.stringify([proposal.id, proposal.revision]), proposalId: proposal.id,
          text: `다음 제안을 바탕으로 수정한 새 제안을 만들어 주세요. 기존 제안을 변경하거나 승인하지 말고, 새 제안은 별도 검토와 승인을 받도록 해 주세요.\n\n제안 ID: ${proposal.id} · 버전: ${proposal.revision}\n제안 전체 변경과 변경 전 정보:\n${JSON.stringify({ mode: proposal.mode, coordinationTarget: target, reason: proposal.reason, changes: proposal.changeSet.changes, timingConstraints: proposal.changeSet.timingConstraints, beforeItems: proposal.beforeItems.map(({ sourceRefs: _sourceRefs, ...item }) => item) }, null, 2)}\n\n원하는 수정: `,
          coordinationTarget: target ? { ...target, title: proposal.beforeItems.find((item) => item.id === target.id)?.title ?? target.id } : undefined });
        setTab('chat'); setPanel('main');
      }} /></Scene>
      {panel === 'calendarImport' && <CalendarImportPanel api={api} timezone={timezone} scheduleClient={scheduleClient} onBack={() => setPanel('main')} onScheduleChanged={refresh} />}
      {panel === 'phoneConnection' && <PhoneConnectionPanel api={api} onBack={() => setPanel('main')} />}
      {panel === 'googleConnection' && <GoogleConnectionPanel api={api} onBack={() => setPanel('main')} />}
      {calendarSyncOpened && <Scene visible={panel === 'calendarSync'}><CalendarSyncPanel api={api} timezone={timezone} selectedDate={selectedDate} visible={panel === 'calendarSync'} refreshVersion={refreshVersion} onBack={() => setPanel('main')} onScheduleChanged={refresh} /></Scene>}
      {routinesOpened && <Scene visible={panel === 'routines'}><RoutinesPanel api={api} timezone={timezone} selectedDate={(() => { const date = civilDate(selectedDate, timezone); return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`; })()}
        onBack={() => setPanel('main')} onDay={value => { const [year, month, day] = value.split('-').map(Number); setSelectedDate(startOfDay({ year: year!, month: month!, day: day! }, timezone)); setPanel('main'); setTab('day'); }} onScheduleChanged={refresh} /></Scene>}
      <Scene visible={panel === 'memory'}><MemoryPanel api={api} onMemoryChanged={refresh} onBack={() => setPanel('main')} /></Scene>
      {reviewOpened && <Scene visible={panel === 'review'}><ReviewPanel api={api} deviceTimezone={timezone} onBack={() => setPanel('main')} /></Scene>}
    </View>
    {panel === 'main' && <View style={styles.tabBar}><GlassSurface><View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }} onPress={() => setTab(item.id)} style={[styles.tab, tab === item.id && styles.activeTab]}>
        <TabIcon name={item.id} color={tab === item.id ? colors.primary : colors.muted} />
        <Text style={[styles.tabText, tab === item.id && styles.activeTabText]}>{item.label}</Text>
      </Pressable>)}
    </View></GlassSurface></View>}
  </>;
}

function MobileApp({ fontUnavailable = false }: { fontUnavailable?: boolean }) {
  const [baseUrl, setBaseUrl] = useState(defaultApiUrl);
  const [sessionToken, setSessionToken] = useState('');
  const [member, setMember] = useState<Member | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<'idle' | 'pending' | 'unknown'>('idle');
  const logoutOwner = useRef<object>({});
  const logoutLock = useRef(false);
  const [urlDraft, setUrlDraft] = useState(defaultApiUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showSettings, setShowSettings] = useState(Platform.OS === 'web' && process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true');
  const [showConnections, setShowConnections] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [healthMounted, setHealthMounted] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const timezone = useMemo(deviceTimezone, []);
  const api = useMemo(() => createApiClient({ baseUrl, getSessionToken: () => sessionToken }), [baseUrl, sessionToken]);

  function toggleSettings() {
    if (!showSettings) {
      setUrlDraft(baseUrl);
      setTokenDraft(member ? '' : sessionToken);
      setTokenEdited(false);
      setSettingsError(null);
    }
    setShowSettings((open) => !open);
  }

  function applySettings() {
    const nextUrl = normalizeApiBaseUrl(urlDraft);
    if (nextUrl === null) {
      setSettingsError('올바른 http:// 또는 https:// API 서버 주소를 입력하세요.');
      return;
    }
    const serverChanged = nextUrl !== normalizeApiBaseUrl(baseUrl);
    const nextToken = member && !tokenEdited ? sessionToken : tokenDraft.trim();
    const connectionChanged = serverChanged || nextToken !== sessionToken;
    if (connectionChanged && operationGuard.hasUnresolved()) {
      setSettingsError('처리 중이거나 결과를 확인하지 못한 요청이 있습니다. 해당 화면에서 같은 요청의 결과를 먼저 확인해 주세요. 앱을 종료하면 이 재시도 정보는 사라집니다.');
      return;
    }
    if (serverChanged && sessionToken && !tokenEdited) {
      setTokenDraft('');
      setTokenEdited(true);
      setSettingsError('서버 주소가 변경되었습니다. 해당 서버의 세션 토큰을 다시 입력해 주세요.');
      return;
    }
    if (connectionChanged) {
      setBaseUrl(nextUrl);
      setSessionToken(nextToken);
      setMember(null); setHealthMounted(false); setHealthOpen(false); setLogoutState('idle');
      // Remount every screen and discard all previous-user UI state.
      setConnectionRevision((revision) => revision + 1);
    }
    setUrlDraft(nextUrl);
    setTokenEdited(false);
    setSettingsError(null);
    setShowSettings(false);
  }

  function signedIn(result: LoginResult) {
    if (operationGuard.hasUnresolved()) return false;
    setSessionToken(result.sessionToken); setMember(result.member); setTokenDraft(''); setTokenEdited(false);
    setConnectionRevision(revision => revision + 1); setHealthMounted(false); setHealthOpen(false);
    setShowSettings(false); setAuthOpen(false); setLogoutState('idle'); return true;
  }

  function clearLocalSession() {
    if (operationGuard.hasUnresolved()) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    setSessionToken(''); setMember(null); setTokenDraft(''); setTokenEdited(false);
    setConnectionRevision(revision => revision + 1); setHealthMounted(false); setHealthOpen(false); setLogoutState('idle');
  }

  async function logout() {
    if (logoutLock.current || operationGuard.hasUnresolved()) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    logoutLock.current = true; setSettingsError(null); setLogoutState('pending');
    operationGuard.update(logoutOwner.current, { status: 'pending' });
    try {
      await createAuthClient(baseUrl).logout(api);
      operationGuard.clear(logoutOwner.current);
      setSessionToken(''); setMember(null); setTokenDraft(''); setTokenEdited(false);
      setConnectionRevision(revision => revision + 1); setHealthMounted(false); setHealthOpen(false); setLogoutState('idle');
    } catch { setLogoutState('unknown'); }
    finally { logoutLock.current = false; operationGuard.clear(logoutOwner.current); }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {Platform.OS === 'web' && process.env.EXPO_PUBLIC_PREVIEW_ONLY === 'true' && <View style={styles.settings}><Text style={styles.settingLabel}>팀 공유 · 화면 미리보기</Text><Text style={styles.hint}>공유 API와 로그인 연결을 준비 중입니다. 실제 AI 대화와 일정 저장은 연결 완료 후 사용할 수 있습니다.</Text></View>}
      {Platform.OS === 'web' && process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true' && <View style={styles.settings}><Text style={styles.settingLabel}>팀 공유 · 기능 테스트</Text><Text style={styles.hint}>참여 코드를 입력해 기능을 테스트할 수 있습니다.</Text></View>}
      {fontUnavailable && <Text accessibilityRole="alert" style={styles.fontNotice}>글꼴을 불러오지 못해 기본 글꼴로 표시합니다.</Text>}
      <View style={styles.topBar}>
        <View style={styles.brandGroup}>
          <View style={styles.brandMark} accessible={false}><Text style={styles.brandMarkText}>p</Text></View>
          <Text style={styles.brand} accessibilityRole="header">pikku</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="개발 연결 설정" accessibilityState={{ expanded: showSettings }} onPress={toggleSettings} style={styles.settingsToggle}>
          <Icon name="settings" size={18} />
          <Text style={styles.settingsToggleText}>설정</Text>
        </Pressable>
      </View>
      {showSettings && (
        <View style={styles.settings}>
          {member ? <><Text style={styles.settingLabel}>로그인: {member.displayName || member.email}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="로그아웃" disabled={logoutState === 'pending'} onPress={() => void logout()} style={styles.settingsToggle}><Text style={styles.settingsToggleText}>로그아웃</Text></Pressable>
            {logoutState === 'unknown' && <><Text accessibilityRole="alert" style={styles.error}>로그아웃 결과를 확인하지 못했습니다. 서버 세션 폐기 여부는 확인되지 않았습니다.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="로컬 세션 지우기" onPress={clearLocalSession} style={styles.settingsToggle}><Text style={styles.settingsToggleText}>이 기기의 세션만 지우기</Text></Pressable></>}</> :
            <><Pressable accessibilityRole="button" accessibilityLabel="Google 로그인 또는 가입" onPress={() => { if (operationGuard.hasUnresolved()) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; } setShowSettings(false); setAuthOpen(true); }} style={styles.settingsToggle}><Text style={styles.settingsToggleText}>Google 로그인 또는 가입</Text></Pressable>
              <Text style={styles.hint}>로그인하면 기존 미리보기 계정의 데이터가 자동으로 이전되지 않습니다.</Text></>}
          <Pressable accessibilityRole="button" accessibilityLabel="연결" accessibilityState={{ expanded: showConnections }}
            onPress={() => setShowConnections((value) => !value)} style={styles.settingsToggle}><Text style={styles.settingsToggleText}>연결</Text></Pressable>
          {showConnections && <Pressable accessibilityRole="button" accessibilityLabel="건강 데이터" onPress={() => {
            setHealthMounted(true); setHealthOpen(true); setShowSettings(false);
          }} style={styles.settingsToggle}><Text style={styles.settingsToggleText}>건강 데이터</Text></Pressable>}
          <Text style={styles.settingLabel}>API 서버 주소</Text>
          <TextInput accessibilityLabel="API 서버 주소" value={urlDraft} onChangeText={(value) => { setUrlDraft(value); setTokenEdited(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
          <Text style={styles.settingLabel}>{Platform.OS === 'web' && process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true' ? '팀 참여 코드' : '개발 세션 Bearer 토큰'}</Text>
          <TextInput accessibilityLabel={Platform.OS === 'web' && process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true' ? '팀 참여 코드' : '개발 세션 토큰'} value={tokenDraft} onChangeText={(value) => { setTokenDraft(value); setTokenEdited(true); }} secureTextEntry autoComplete="off" autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.hint}>토큰은 이 앱 실행 동안에만 사용합니다.</Text>
          {settingsError && <Text style={styles.error} accessibilityRole="alert">{settingsError}</Text>}
          <Pressable accessibilityRole="button" onPress={applySettings} style={styles.apply}><Text style={styles.applyText}>설정 적용</Text></Pressable>
        </View>
      )}
      <Scene visible={!healthOpen && !authOpen}><ConnectedWorkspace key={connectionRevision} api={api} timezone={timezone} /></Scene>
      {healthMounted && <Scene visible={healthOpen && !authOpen}><HealthPanel key={connectionRevision} timezone={timezone} visible={healthOpen && !authOpen} onBack={() => setHealthOpen(false)} /></Scene>}
      {authOpen && <AuthPanel baseUrl={baseUrl} onBack={() => setAuthOpen(false)} onSignedIn={signedIn} />}
    </SafeAreaView>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Lucide: require('./assets/icons/lucide.ttf'),
    'Pretendard-Regular': require('./assets/fonts/Pretendard-Regular.otf'),
    'Pretendard-Medium': require('./assets/fonts/Pretendard-Medium.otf'),
    'Pretendard-SemiBold': require('./assets/fonts/Pretendard-SemiBold.otf'),
    'Pretendard-Bold': require('./assets/fonts/Pretendard-Bold.otf'),
  });
  return <SafeAreaProvider><FontReadyContext.Provider value={fontsLoaded}>
    {!fontsLoaded && !fontError
      ? <SafeAreaView style={styles.loading}><ActivityIndicator color={colors.primary} /><Text>하루를 준비하고 있어요</Text></SafeAreaView>
      : <MobileApp fontUnavailable={!!fontError} />}
  </FontReadyContext.Provider></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: colors.background },
  importButton: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-end', paddingHorizontal: 20 },
  topBar: { minHeight: 58, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandGroup: { flexDirection: 'row', gap: 9, alignItems: 'center' },
  brandMark: { width: 30, height: 30, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: colors.surface, fontSize: 24, fontWeight: '700', lineHeight: 28 },
  brand: { color: colors.text, fontSize: 23, fontWeight: '700', letterSpacing: -0.7 },
  settingsToggle: { minHeight: 44, minWidth: 56, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, backgroundColor: colors.surface, borderRadius: 22 },
  settingsToggleText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  settings: { margin: 16, marginTop: 4, padding: 16, gap: 8, backgroundColor: colors.surface, borderRadius: 20 },
  settingLabel: { color: colors.text, fontWeight: '600' },
  input: { minHeight: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, color: colors.text },
  hint: { color: colors.muted, fontSize: 12 },
  error: { color: colors.error },
  apply: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.primary, borderRadius: 14 },
  applyText: { color: colors.surface, fontWeight: '600' },
  screenContainer: { flex: 1 },
  screen: { flex: 1 },
  hidden: { display: 'none' },
  tabBar: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, backgroundColor: colors.background },
  tabs: { flexDirection: 'row', padding: 5 },
  tab: { flex: 1, minHeight: 58, paddingVertical: 7, gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  activeTab: { backgroundColor: colors.primarySoft },
  tabText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  activeTabText: { color: colors.primary, fontWeight: '700' },
  loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 14 },
  fontNotice: { padding: 12, color: colors.error, backgroundColor: colors.surface },
});
