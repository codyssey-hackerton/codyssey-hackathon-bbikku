import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import { FontReadyContext, Text, TextInput } from './src/ui/typography';
import { colors } from './src/ui/theme';
import { Icon } from './src/ui/Icon';
import { GlassSurface } from './src/ui/GlassSurface';
import { BottomSheet } from './src/ui/BottomSheet';
import { PikkuCharacter } from './src/ui/PikkuCharacter';
import { ScreenBackground } from './src/ui/ScreenBackground';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { createApiClient } from './src/api/http';
import { normalizeApiBaseUrl } from './src/api/connection';
import { operationGuard } from './src/api/operationGuard';
import type { ApiClient } from './src/api/http';
import ChatScreen, { type RecoveryRequest, type RevisionRequest } from './src/chat/ChatScreen';
import { createChatClient } from './src/chat/client';
import type { ChatEntryContext, CoordinationTarget, FormDraft } from './src/chat/client';
import ProposalPanel from './src/proposals/ProposalPanel';
import MemoryPanel from './src/memory/MemoryPanel';
import ScheduleCallPanel from './src/contacts/ScheduleCallPanel';
import ReviewPanel from './src/review/ReviewPanel';
import CalendarScreen from './src/screens/CalendarScreen';
import CalendarImportPanel from './src/calendar/CalendarImportPanel';
import PhoneConnectionPanel from './src/contacts/PhoneConnectionPanel';
import GoogleConnectionPanel from './src/google/GoogleConnectionPanel';
import HealthPanel from './src/health/HealthPanel';
import DayScreen from './src/screens/DayScreen';
import HomeScreen from './src/screens/HomeScreen';
import AddItemPanel from './src/add/AddItemPanel';
import { createScheduleClient } from './src/schedule/client';
import type { ScheduleItem } from './src/schedule/client';
import { civilDate, formatCivilDate, startOfDay } from './src/schedule/dates';
import AuthPanel from './src/auth/AuthPanel';
import { WelcomeScreen } from './src/auth/WelcomeScreen';
import { OnboardingPanel, ProfilePanel, usePlanningProfile } from './src/profile';
import { createAuthClient, type LoginResult, type Member } from './src/auth/client';
import RoutinesPanel from './src/routines/RoutinesPanel';
import CalendarSyncPanel from './src/calendar-sync/CalendarSyncPanel';

type Tab = 'home' | 'calendar' | 'chat' | 'routines';
type AddSession = { key: string; kind: FormDraft['kind']; date: Date; item?: ScheduleItem };

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

function ConnectedWorkspace({ api, timezone, onOpenSettings, member }: { api: ApiClient; timezone: string; onOpenSettings: () => void; member: Member | null }) {
  const [tab, setTab] = useState<Tab>('home');
  const [panel, setPanel] = useState<'main' | 'profile' | 'connections' | 'proposals' | 'memory' | 'review' | 'calendarImport' | 'phoneConnection' | 'googleConnection' | 'calendarSync' | 'addItem' | 'scheduleCall'>('main');
  const [scheduleCallTarget, setScheduleCallTarget] = useState<{ itemId: string; expectedRevision: number } | null>(null);
  const [phoneReturnToCall, setPhoneReturnToCall] = useState(false);
  const [memoryReturn, setMemoryReturn] = useState<'profile' | 'connections'>('profile');
  const profile = usePlanningProfile(api);
  const [onboarding, setOnboarding] = useState<'check' | 'show' | 'hidden'>(member ? 'check' : 'hidden');
  const [calendarMode, setCalendarMode] = useState<'month' | 'day'>('month');
  const [routinesOpened, setRoutinesOpened] = useState(false);
  const [calendarSyncOpened, setCalendarSyncOpened] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [coordinationTarget, setCoordinationTarget] = useState<(CoordinationTarget & { title: string }) | undefined>();
  const [recoveryRequest, setRecoveryRequest] = useState<RecoveryRequest | undefined>();
  const [revisionRequest, setRevisionRequest] = useState<RevisionRequest | undefined>();
  const [entryContext, setEntryContext] = useState<ChatEntryContext | undefined>();
  const [addVisible, setAddVisible] = useState(false);
  const [addSession, setAddSession] = useState<AddSession | null>(null);
  const [formRequest, setFormRequest] = useState<{ sessionKey: string; key: string } | null>(null);
  const [pendingDraft, setPendingDraft] = useState<FormDraft | undefined>();
  const [navigationError, setNavigationError] = useState('');
  const [showRequestReview, setShowRequestReview] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [proposalRefreshVersion, setProposalRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setRefreshVersion(version => version + 1);
    setProposalRefreshVersion(version => version + 1);
  }, []);
  const refreshProposals = useCallback(() => setProposalRefreshVersion(version => version + 1), []);
  useEffect(() => {
    if (onboarding === 'check' && profile.load.status === 'success') setOnboarding(profile.load.value ? 'hidden' : 'show');
  }, [onboarding, profile.load]);
  useEffect(() => { if (profile.mutation.state.status === 'success') refresh(); }, [profile.mutation.state.status, refresh]);
  const chatClient = useMemo(() => createChatClient(api), [api]);
  const scheduleClient = useMemo(() => createScheduleClient(api), [api]);
  const chatVisible = tab === 'chat' && panel === 'main';
  const nextKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const selectedCivil = civilDate(selectedDate, timezone);
  const selectedDateKey = `${selectedCivil.year}-${String(selectedCivil.month).padStart(2, '0')}-${String(selectedCivil.day).padStart(2, '0')}`;

  function selectDay(value: string) {
    const [year, month, day] = value.split('-').map(Number);
    setSelectedDate(startOfDay({ year: year!, month: month!, day: day! }, timezone));
  }

  function openAdd(kind: FormDraft['kind'], item?: ScheduleItem) {
    setAddVisible(false);
    const unresolved = operationGuard.hasUnresolved();
    setShowRequestReview(unresolved);
    if (addSession) {
      setNavigationError(unresolved
        ? '작성 중인 초안을 열었습니다. 처리 중이거나 결과를 확인하지 못한 요청은 시작한 화면에서 확인해 주세요. 확인 전에는 저장할 수 없습니다.'
        : '작성 중인 내용을 먼저 저장하거나 닫아 주세요.');
      setPanel('addItem');
      return;
    }
    setNavigationError(unresolved ? '초안은 작성할 수 있습니다. 저장하기 전에 처리 중이거나 결과를 확인하지 못한 요청을 시작한 화면에서 확인해 주세요.' : '');
    setPendingDraft(undefined);
    setAddSession({ key: nextKey(), kind, date: new Date(selectedDate), item });
    setPanel('addItem');
  }

  function ask(item?: ScheduleItem) {
    setAddVisible(false);
    if (operationGuard.hasUnresolved()) {
      setNavigationError('기존 요청과 대화 맥락을 유지했습니다. 처리 중이거나 결과를 확인하지 못한 요청을 시작한 화면에서 확인해 주세요.');
      setShowRequestReview(false); setTab('chat'); setPanel('main');
      return;
    }
    setCoordinationTarget(undefined); setRecoveryRequest(undefined); setRevisionRequest(undefined);
    setEntryContext(item
      ? { key: nextKey(), kind: 'item', id: item.id, expectedRevision: item.revision, title: item.title }
      : { key: nextKey(), kind: 'create' });
    setTab('chat'); setPanel('main');
  }

  function recover(item: ScheduleItem) {
    const dateLabel = formatCivilDate(civilDate(item.timeSlot ? new Date(item.timeSlot.startsAt) : selectedDate, timezone));
    const key = JSON.stringify([item.id, dateLabel]);
    setCoordinationTarget(undefined); setRevisionRequest(undefined);
    setEntryContext({ key, kind: 'item', id: item.id, expectedRevision: item.revision, title: item.title });
    setRecoveryRequest({ key, title: item.title, dateLabel,
      text: `${dateLabel}에 확인한 미완료 할 일 “${item.title}”이 아직 필요한지와 기한을 먼저 확인하고 싶어요. 필요하다면 가능한 복구 방법을 함께 살펴봐 주세요. 일정 변경은 제안을 보고 결정할게요.` });
    setTab('chat'); setPanel('main');
  }

  function applyDraft(draft: FormDraft) {
    if (entryContext?.kind === 'form') {
      if (!addSession || formRequest?.sessionKey !== addSession.key || formRequest.key !== entryContext.key || draft.kind !== addSession.kind) {
        setNavigationError('작성하던 폼이 바뀌어 초안을 적용할 수 없습니다.');
        return;
      }
    } else if (entryContext?.kind === 'create') {
      if (addSession) {
        setNavigationError('작성 중인 폼이 있습니다. 기존 내용을 먼저 저장하거나 닫아 주세요.');
        return;
      }
      setAddSession({ key: nextKey(), kind: draft.kind, date: new Date(selectedDate) });
    } else return;
    setPendingDraft(draft); setPanel('addItem');
  }

  const dayProps = {
    selectedDate, onSelectDate: setSelectedDate, client: scheduleClient, api, timezone, refreshVersion,
    onScheduleChanged: refresh,
    onOpenPreparationProposals: () => { refreshProposals(); setPanel('proposals'); },
    onCoordinate: (item: ScheduleItem) => {
      setEntryContext(undefined); setRecoveryRequest(undefined); setRevisionRequest(undefined);
      setCoordinationTarget({ id: item.id, expectedRevision: item.revision, title: item.title });
      setTab('chat'); setPanel('main');
    },
    onRecovery: recover, onAsk: (item: ScheduleItem) => ask(item),
    createRequest: () => setAddVisible(true), editRequest: (item: ScheduleItem) => openAdd(item.kind, item),
  };
  const connections = [
    { label: '내 프로필', run: () => setPanel('profile') },
    { label: 'Google 연결', run: () => setPanel('googleConnection') },
    { label: '캘린더 일정 가져오기', run: () => setPanel('calendarImport') },
    { label: 'Google 캘린더 동기화', run: () => { setCalendarSyncOpened(true); setPanel('calendarSync'); } },
    { label: '전화 외부 연결', run: () => { setPhoneReturnToCall(false); setPanel('phoneConnection'); } },
    { label: '내 정보·선호', run: () => { setMemoryReturn('connections'); setPanel('memory'); } },
    { label: '자동 검토 설정', run: () => { setReviewOpened(true); setPanel('review'); } },
    { label: '계정·앱 설정', run: onOpenSettings },
  ];

  if (onboarding === 'check') return <View style={styles.connectionMenu}>
    <Text accessibilityRole="header" style={styles.menuTitle}>나의 삐꾸를 준비하고 있어요</Text>
    {profile.load.status === 'loading' ? <ActivityIndicator color={colors.primary} /> : <>
      <Text accessibilityRole="alert" style={styles.error}>개인화 설정을 불러오지 못했습니다. 기존 설정은 변경하지 않았어요.</Text>
      <Pressable accessibilityRole="button" onPress={profile.refresh} style={styles.connectionRow}><Text>개인화 설정 다시 조회</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setOnboarding('hidden')} style={styles.connectionRow}><Text>지금은 홈으로</Text></Pressable>
    </>}
  </View>;
  if (onboarding === 'show') return <OnboardingPanel profile={profile} onComplete={() => setOnboarding('hidden')} onBack={() => setOnboarding('hidden')} />;

  return <>
    {navigationError !== '' && <View style={styles.navigationNotice}><Text accessibilityRole="alert" style={[styles.error, styles.noticeText]}>{navigationError}</Text>
      {showRequestReview && <Pressable accessibilityRole="button" accessibilityLabel="AI 비서 열기" onPress={() => { setTab('chat'); setPanel('main'); setNavigationError(''); setShowRequestReview(false); }} style={styles.noticeClose}><Text>AI 비서 열기</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="안내 닫기" onPress={() => { setNavigationError(''); setShowRequestReview(false); }} style={styles.noticeClose}><Icon name="close" /></Pressable></View>}
    <View style={styles.screenContainer}>
      <Scene visible={panel === 'main' && tab === 'home'}><HomeScreen {...dayProps} selectedDate={new Date()} visible={panel === 'main' && tab === 'home'}
        onCalendar={() => { setSelectedDate(new Date()); setTab('calendar'); setCalendarMode('day'); }} onOpenProposals={() => setPanel('proposals')} onOpenSettings={() => setPanel('profile')} /></Scene>
      <Scene visible={chatVisible}>
        <ChatScreen client={chatClient} timezone={timezone} scheduleClient={scheduleClient} selectedDate={selectedDate} refreshVersion={refreshVersion}
          onOpenProposals={() => setPanel('proposals')} onOpenReviewSchedule={() => { setReviewOpened(true); setPanel('review'); }} onProposalCreated={refreshProposals}
          coordinationTarget={coordinationTarget} onClearCoordinationTarget={() => setCoordinationTarget(undefined)} recoveryRequest={recoveryRequest} revisionRequest={revisionRequest}
          entryContext={entryContext} onClearEntryContext={() => setEntryContext(undefined)} onApplyDraft={applyDraft} onOpenScheduleCall={target => {
            if (scheduleCallTarget && (scheduleCallTarget.itemId !== target.itemId || scheduleCallTarget.expectedRevision !== target.expectedRevision)) {
              setNavigationError('진행 중인 전화 요청을 먼저 확인해 주세요.');
            } else if (!scheduleCallTarget) setScheduleCallTarget(target);
            setPanel('scheduleCall');
          }} />
      </Scene>
      <Scene visible={panel === 'main' && tab === 'calendar' && calendarMode === 'month'}><CalendarScreen selectedDate={selectedDate}
        onSelectDate={date => { setSelectedDate(date); setCalendarMode('day'); }} client={scheduleClient} timezone={timezone} refreshVersion={refreshVersion} /></Scene>
      <Scene visible={panel === 'main' && tab === 'calendar' && calendarMode === 'day'}>
        <Pressable accessibilityRole="button" accessibilityLabel="월간 캘린더로" onPress={() => setCalendarMode('month')} style={styles.backButton}><Icon name="chevronLeft" /><Text style={styles.settingsToggleText}>월간 캘린더</Text></Pressable>
        <DayScreen {...dayProps} visible={panel === 'main' && tab === 'calendar' && calendarMode === 'day'} />
      </Scene>
      {routinesOpened && <Scene visible={panel === 'main' && tab === 'routines'}><RoutinesPanel api={api} timezone={timezone}
        visible={panel === 'main' && tab === 'routines'} selectedDate={selectedDateKey}
        onSelectDate={selectDay} onRecovery={recover} onBack={() => setTab('home')}
        onDay={value => { selectDay(value); setPanel('main'); setTab('calendar'); setCalendarMode('day'); }} onScheduleChanged={refresh} /></Scene>}
      <Scene visible={panel === 'connections'}><ScrollView contentContainerStyle={styles.connectionMenu}>
        <Pressable accessibilityRole="button" accessibilityLabel="연결 및 설정 닫기" onPress={() => setPanel('main')} style={styles.backButton}><Icon name="chevronLeft" /><Text style={styles.settingsToggleText}>돌아가기</Text></Pressable>
        <Text accessibilityRole="header" style={styles.menuTitle}>연결 및 설정</Text>
        {connections.map(item => <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={item.run} style={styles.connectionRow}><Text style={styles.connectionText}>{item.label}</Text><Icon name="chevronRight" /></Pressable>)}
        <Text style={styles.attribution}>아이콘: Streamline Core · CC BY 4.0. 크기·색상 변경, 더보기 90도 회전 및 PNG 변환.</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Streamline 아이콘 원본" onPress={() => { void Linking.openURL('https://github.com/webalys-hq/streamline-vectors/tree/main/core').catch(() => setNavigationError('아이콘 출처 링크를 열지 못했습니다.')); }} style={styles.backButton}><Text style={styles.settingsToggleText}>Streamline 원본</Text></Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel="CC BY 4.0 라이선스" onPress={() => { void Linking.openURL('https://creativecommons.org/licenses/by/4.0/').catch(() => setNavigationError('라이선스 링크를 열지 못했습니다.')); }} style={styles.backButton}><Text style={styles.settingsToggleText}>CC BY 4.0 라이선스</Text></Pressable>
      </ScrollView></Scene>
      <Scene visible={panel === 'proposals'}><ProposalPanel api={api} refreshVersion={proposalRefreshVersion} onScheduleChanged={refresh} onBack={() => setPanel('main')} onRequestRevision={proposal => {
        const target = proposal.coordinationTarget;
        setEntryContext(undefined); setRecoveryRequest(undefined);
        setRevisionRequest({ key: JSON.stringify([proposal.id, proposal.revision]), proposalId: proposal.id,
          text: `다음 제안을 바탕으로 수정한 새 제안을 만들어 주세요. 기존 제안을 변경하거나 승인하지 말고, 새 제안은 별도 검토와 승인을 받도록 해 주세요.\n\n제안 ID: ${proposal.id} · 버전: ${proposal.revision}\n제안 전체 변경과 변경 전 정보:\n${JSON.stringify({ mode: proposal.mode, coordinationTarget: target, reason: proposal.reason, changes: proposal.changeSet.changes, timingConstraints: proposal.changeSet.timingConstraints, beforeItems: proposal.beforeItems.map(({ sourceRefs: _sourceRefs, ...item }) => item) }, null, 2)}\n\n원하는 수정: `,
          coordinationTarget: target ? { ...target, title: proposal.beforeItems.find(item => item.id === target.id)?.title ?? target.id } : undefined });
        setTab('chat'); setPanel('main');
      }} /></Scene>
      {panel === 'calendarImport' && <CalendarImportPanel api={api} timezone={timezone} scheduleClient={scheduleClient} onBack={() => setPanel('main')} onScheduleChanged={refresh} />}
      {panel === 'phoneConnection' && <PhoneConnectionPanel api={api} onBack={() => setPanel(phoneReturnToCall && scheduleCallTarget ? 'scheduleCall' : 'main')} />}
      {panel === 'googleConnection' && <GoogleConnectionPanel api={api} onBack={() => setPanel('main')} />}
      {calendarSyncOpened && <Scene visible={panel === 'calendarSync'}><CalendarSyncPanel api={api} timezone={timezone} selectedDate={selectedDate} visible={panel === 'calendarSync'} refreshVersion={refreshVersion} onBack={() => setPanel('main')} onScheduleChanged={refresh} /></Scene>}
      <Scene visible={panel === 'profile'}><ProfilePanel profile={profile} member={member} onBack={() => setPanel('main')}
        onOpenGoogle={() => setPanel('googleConnection')} onOpenReview={() => { setReviewOpened(true); setPanel('review'); }}
        onOpenAccount={() => setPanel('connections')} onOpenMemory={() => { setMemoryReturn('profile'); setPanel('memory'); }} /></Scene>
      <Scene visible={panel === 'memory'}><MemoryPanel api={api} onMemoryChanged={() => { refresh(); profile.refresh(); }} onBack={() => setPanel(memoryReturn)} /></Scene>
      {scheduleCallTarget && <Scene visible={panel === 'scheduleCall'}><ScheduleCallPanel api={api} {...scheduleCallTarget}
        onClose={() => { setTab('chat'); setPanel('main'); }} onFinish={() => { setScheduleCallTarget(null); setTab('chat'); setPanel('main'); }} onScheduleChanged={refresh} onOpenPhoneSettings={() => { setPhoneReturnToCall(true); setPanel('phoneConnection'); }} /></Scene>}
      {reviewOpened && <Scene visible={panel === 'review'}><ReviewPanel api={api} deviceTimezone={timezone} onBack={() => setPanel('main')} /></Scene>}
      {addSession && <Scene visible={panel === 'addItem'}><AddItemPanel key={addSession.key} api={api} client={scheduleClient} timezone={timezone}
        selectedDate={addSession.date} kind={addSession.kind} item={addSession.item} pendingDraft={pendingDraft} onDraftHandled={() => setPendingDraft(undefined)}
        onClose={() => { setAddSession(null); setPendingDraft(undefined); if (entryContext?.key === formRequest?.key) setEntryContext(undefined); setFormRequest(null); setPanel('main'); }} onScheduleChanged={refresh}
        onAskDraft={draft => {
          if (operationGuard.hasUnresolved()) {
            setNavigationError('작성 중인 초안은 유지됩니다. 처리 중이거나 결과를 확인하지 못한 요청을 시작한 화면에서 먼저 확인해 주세요.');
            setShowRequestReview(true);
            return;
          }
          setCoordinationTarget(undefined); setRecoveryRequest(undefined); setRevisionRequest(undefined);
          const key = nextKey();
          setFormRequest({ sessionKey: addSession.key, key });
          setEntryContext({ key, kind: 'form', draft }); setTab('chat'); setPanel('main');
        }} /></Scene>}
    </View>
    {panel === 'main' && <View style={styles.tabBar}><GlassSurface><View style={styles.tabs} accessibilityRole="tablist">
      {(['home', 'calendar', 'chat', 'add', 'routines'] as const).map(id => {
        const label = { home: '홈', calendar: '캘린더', chat: 'AI 비서', add: '추가', routines: '루틴' }[id];
        const selected = id !== 'add' && tab === id;
        return <Pressable key={id} accessibilityRole={id === 'add' ? 'button' : 'tab'} accessibilityLabel={label} accessibilityState={{ selected }}
          onPress={() => { if (id === 'add') setAddVisible(true); else { setTab(id); if (id === 'routines') setRoutinesOpened(true); } }} style={[styles.tab, selected && styles.activeTab]}>
          {id === 'chat' ? <View style={styles.aiTab}><PikkuCharacter size={42} /></View> : <Icon name={id === 'routines' ? 'repeat' : id === 'add' ? 'plus' : id} size={22} color={selected ? colors.primary : colors.muted} />}
          <Text style={[styles.tabText, selected && styles.activeTabText]}>{label}</Text>
        </Pressable>;
      })}
    </View></GlassSurface></View>}
    <BottomSheet visible={addVisible} title="무엇을 추가할까요?" onClose={() => setAddVisible(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel="삐꾸에게 부탁하기" onPress={() => ask()} style={styles.askButton}><PikkuCharacter size={42} /><View style={styles.askText}><Text style={styles.askTitle}>삐꾸에게 부탁하기</Text><Text style={styles.hint}>새 일정·할 일·루틴을 함께 만들어요</Text></View><Icon name="arrowRight" color={colors.primary} /></Pressable>
      {(['event', 'task', 'routine'] as const).map(kind => <Pressable key={kind} accessibilityRole="button" accessibilityLabel={{ event: '일정 추가', task: '할 일 추가', routine: '루틴 추가' }[kind]} onPress={() => openAdd(kind)} style={styles.connectionRow}><Icon name={kind === 'event' ? 'calendar' : kind === 'routine' ? 'repeat' : 'day'} /><Text style={styles.connectionText}>{{ event: '일정 추가', task: '할 일 추가', routine: '루틴 추가' }[kind]}</Text><Icon name="plus" /></Pressable>)}
    </BottomSheet>
  </>;
}

function MobileApp({ fontUnavailable = false }: { fontUnavailable?: boolean }) {
  const [baseUrl, setBaseUrl] = useState(defaultApiUrl);
  const [sessionToken, setSessionToken] = useState('');
  const [member, setMember] = useState<Member | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('login');
  const [authFlowActive, setAuthFlowActive] = useState(false);
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
    if (authFlowActive) { setSettingsError('로그인을 완료하거나 이전 화면으로 돌아가 취소해 주세요.'); return; }
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
    if (connectionChanged && (operationGuard.hasUnresolved() || authFlowActive)) {
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
    setShowSettings(false); setAuthOpen(false); setAuthFlowActive(false); setLogoutState('idle'); return true;
  }

  function clearLocalSession() {
    if (operationGuard.hasUnresolved() || authFlowActive) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
    setSessionToken(''); setMember(null); setTokenDraft(''); setTokenEdited(false);
    setConnectionRevision(revision => revision + 1); setHealthMounted(false); setHealthOpen(false); setLogoutState('idle');
  }

  async function logout() {
    if (logoutLock.current || operationGuard.hasUnresolved() || authFlowActive) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
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
      <ScreenBackground>
      <StatusBar style="dark" />
      {Platform.OS === 'web' && process.env.EXPO_PUBLIC_PREVIEW_ONLY === 'true' && <View style={styles.settings}><Text style={styles.settingLabel}>팀 공유 · 화면 미리보기</Text><Text style={styles.hint}>공유 API와 로그인 연결을 준비 중입니다. 실제 AI 대화와 일정 저장은 연결 완료 후 사용할 수 있습니다.</Text></View>}
      {Platform.OS === 'web' && process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true' && <View style={styles.settings}><Text style={styles.settingLabel}>팀 공유 · 기능 테스트</Text><Text style={styles.hint}>참여 코드를 입력해 기능을 테스트할 수 있습니다.</Text></View>}
      {fontUnavailable && <Text accessibilityRole="alert" style={styles.fontNotice}>글꼴을 불러오지 못해 기본 글꼴로 표시합니다.</Text>}
      {(showSettings || healthOpen) && <View style={styles.topBar}>
        <View style={styles.brandGroup}>
          <View style={styles.brandMark} accessible={false}><Text style={styles.brandMarkText}>p</Text></View>
          <Text style={styles.brand} accessibilityRole="header">pikku</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="개발 연결 설정" accessibilityState={{ expanded: showSettings }} onPress={toggleSettings} style={styles.settingsToggle}>
          <Icon name="settings" size={18} />
          <Text style={styles.settingsToggleText}>설정</Text>
        </Pressable>
      </View>}
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
            if (authOpen && (operationGuard.hasUnresolved() || authFlowActive)) { setSettingsError('처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.'); return; }
            setAuthOpen(false); setHealthMounted(true); setHealthOpen(true); setShowSettings(false);
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
      {!sessionToken && !authOpen && !showSettings && !healthOpen && <WelcomeScreen onStart={() => { setAuthMode('signup'); setAuthOpen(true); }}
        onLogin={() => { setAuthMode('login'); setAuthOpen(true); }} onDeveloperSettings={toggleSettings} />}
      {sessionToken !== '' && <Scene visible={!healthOpen && !authOpen && !showSettings}><ConnectedWorkspace key={connectionRevision} api={api} timezone={timezone} onOpenSettings={toggleSettings} member={member} /></Scene>}
      {healthMounted && <Scene visible={healthOpen && !authOpen}><HealthPanel key={connectionRevision} timezone={timezone} visible={healthOpen && !authOpen} onBack={() => setHealthOpen(false)} /></Scene>}
      {authOpen && <AuthPanel key={baseUrl} baseUrl={baseUrl} mode={authMode} onFlowActiveChange={setAuthFlowActive}
        onBack={() => { setAuthOpen(false); setAuthFlowActive(false); }} onSignedIn={signedIn} />}
      </ScreenBackground>
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
  navigationNotice: { padding: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, backgroundColor: colors.surface },
  noticeText: { flex: 1, minWidth: 180 },
  noticeClose: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  connectionMenu: { padding: 16, gap: 12, paddingBottom: 36 },
  menuTitle: { fontSize: 24, fontWeight: '700', color: colors.text, marginVertical: 8 },
  backButton: { minHeight: 44, flexDirection: 'row', gap: 6, alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 12 },
  connectionRow: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 16, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 12 },
  connectionText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  attribution: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 16 },
  askButton: { minHeight: 84, borderRadius: 20, padding: 16, backgroundColor: '#E9E9FF', flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  askText: { flex: 1, gap: 6 },
  askTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  aiTab: { width: 48, height: 48, marginTop: -20, borderRadius: 24, backgroundColor: '#E9E6FF', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: colors.surface },
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
  apply: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.primaryPressed, borderRadius: 14 },
  applyText: { color: colors.surface, fontWeight: '600' },
  screenContainer: { flex: 1 },
  screen: { flex: 1 },
  hidden: { display: 'none' },
  tabBar: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  tabs: { flexDirection: 'row', padding: 5 },
  tab: { flex: 1, minHeight: 62, paddingVertical: 8, gap: 5, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  activeTab: { backgroundColor: colors.primarySoft },
  tabText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  activeTabText: { color: colors.primary, fontWeight: '700' },
  loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 14 },
  fontNotice: { padding: 12, color: colors.error, backgroundColor: colors.surface },
});
