import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { createApiClient } from './src/api/http';
import { normalizeApiBaseUrl } from './src/api/connection';
import { operationGuard } from './src/api/operationGuard';
import type { ApiClient } from './src/api/http';
import ChatScreen from './src/chat/ChatScreen';
import { createChatClient } from './src/chat/client';
import type { CoordinationTarget } from './src/chat/client';
import ProposalPanel from './src/proposals/ProposalPanel';
import MemoryPanel from './src/memory/MemoryPanel';
import ReviewPanel from './src/review/ReviewPanel';
import CalendarScreen from './src/screens/CalendarScreen';
import DayScreen from './src/screens/DayScreen';
import { createScheduleClient } from './src/schedule/client';

type Tab = 'chat' | 'calendar' | 'day';
const tabs: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'AI 채팅' },
  { id: 'calendar', label: '월별' },
  { id: 'day', label: '하루' },
];

// Public Expo variables are embedded in the app. Never place credentials here.
const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || 'http://localhost:3001';
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
  const [panel, setPanel] = useState<'main' | 'proposals' | 'memory' | 'review'>('main');
  const [reviewOpened, setReviewOpened] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [coordinationTarget, setCoordinationTarget] = useState<(CoordinationTarget & { title: string }) | undefined>();
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
      <Scene visible={chatVisible}>
        <ChatScreen client={chatClient} timezone={timezone} scheduleClient={scheduleClient} selectedDate={selectedDate} refreshVersion={refreshVersion}
          onOpenProposals={() => setPanel('proposals')} onOpenMemory={() => setPanel('memory')} onOpenReviewSchedule={() => { setReviewOpened(true); setPanel('review'); }} onProposalCreated={refreshProposals}
          coordinationTarget={coordinationTarget} onClearCoordinationTarget={() => setCoordinationTarget(undefined)} />
      </Scene>
      <Scene visible={panel === 'main' && tab === 'calendar'}><CalendarScreen selectedDate={selectedDate} onSelectDate={setSelectedDate} client={scheduleClient} timezone={timezone} refreshVersion={refreshVersion} /></Scene>
      <Scene visible={panel === 'main' && tab === 'day'}><DayScreen selectedDate={selectedDate} onSelectDate={setSelectedDate} client={scheduleClient} timezone={timezone} refreshVersion={refreshVersion} onScheduleChanged={refresh}
        onCoordinate={(item) => { setCoordinationTarget({ id: item.id, expectedRevision: item.revision, title: item.title }); setTab('chat'); }} /></Scene>
      <Scene visible={panel === 'proposals'}><ProposalPanel api={api} refreshVersion={proposalRefreshVersion} onScheduleChanged={refresh} onBack={() => setPanel('main')} /></Scene>
      <Scene visible={panel === 'memory'}><MemoryPanel api={api} onMemoryChanged={refresh} onBack={() => setPanel('main')} /></Scene>
      {reviewOpened && <Scene visible={panel === 'review'}><ReviewPanel api={api} deviceTimezone={timezone} onBack={() => setPanel('main')} /></Scene>}
    </View>
    {panel === 'main' && <View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }} onPress={() => setTab(item.id)} style={[styles.tab, tab === item.id && styles.activeTab]}>
        <Text style={[styles.tabText, tab === item.id && styles.activeTabText]}>{item.label}</Text>
      </Pressable>)}
    </View>}
  </>;
}

function MobileApp() {
  const [baseUrl, setBaseUrl] = useState(defaultApiUrl);
  const [sessionToken, setSessionToken] = useState('');
  const [urlDraft, setUrlDraft] = useState(defaultApiUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const timezone = useMemo(deviceTimezone, []);
  const api = useMemo(() => createApiClient({ baseUrl, getSessionToken: () => sessionToken }), [baseUrl, sessionToken]);

  function toggleSettings() {
    if (!showSettings) {
      setUrlDraft(baseUrl);
      setTokenDraft(sessionToken);
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
    const nextToken = tokenDraft.trim();
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
      // Remount every screen and discard all previous-user UI state.
      setConnectionRevision((revision) => revision + 1);
    }
    setUrlDraft(nextUrl);
    setTokenEdited(false);
    setSettingsError(null);
    setShowSettings(false);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.topBar}>
        <Text style={styles.brand} accessibilityRole="header">PIKKU</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showSettings }} onPress={toggleSettings} style={styles.settingsToggle}>
          <Text style={styles.settingsToggleText}>개발 연결 설정</Text>
        </Pressable>
      </View>
      {showSettings && (
        <View style={styles.settings}>
          <Text style={styles.settingLabel}>API 서버 주소</Text>
          <TextInput accessibilityLabel="API 서버 주소" value={urlDraft} onChangeText={(value) => { setUrlDraft(value); setTokenEdited(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
          <Text style={styles.settingLabel}>개발 세션 Bearer 토큰</Text>
          <TextInput accessibilityLabel="개발 세션 토큰" value={tokenDraft} onChangeText={(value) => { setTokenDraft(value); setTokenEdited(true); }} secureTextEntry autoComplete="off" autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.hint}>토큰은 이 앱 실행 동안에만 사용합니다.</Text>
          {settingsError && <Text style={styles.error} accessibilityRole="alert">{settingsError}</Text>}
          <Pressable accessibilityRole="button" onPress={applySettings} style={styles.apply}><Text style={styles.applyText}>설정 적용</Text></Pressable>
        </View>
      )}
      <ConnectedWorkspace key={connectionRevision} api={api} timezone={timezone} />
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><MobileApp /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fff' },
  topBar: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#ddd' },
  brand: { color: '#172033', fontSize: 18, fontWeight: '700' },
  settingsToggle: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  settingsToggleText: { color: '#334155' },
  settings: { padding: 12, gap: 6, borderBottomWidth: 1, borderColor: '#ddd' },
  settingLabel: { color: '#334155', fontWeight: '600' },
  input: { minHeight: 44, paddingHorizontal: 10, borderWidth: 1, borderColor: '#aaa', borderRadius: 6, color: '#171717' },
  hint: { color: '#555', fontSize: 12 },
  error: { color: '#a01818' },
  apply: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: '#334155', borderRadius: 6 },
  applyText: { color: '#fff', fontWeight: '600' },
  screenContainer: { flex: 1 },
  screen: { flex: 1 },
  hidden: { display: 'none' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#ddd' },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  activeTab: { backgroundColor: '#e7eaf0' },
  tabText: { color: '#475569' },
  activeTabText: { color: '#172033', fontWeight: '700' },
});
