import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import PlaceSearch from '../places/PlaceSearch';
import type { Place } from '../places/client';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';
import { createTravelClient, isTravelFresh, travelRemainingMs, type TravelEstimate, type TravelMode } from '../travel/client';
import WeatherPanel from '../weather/WeatherPanel';

const modes = [{ key: 'walk', label: '도보' }, { key: 'transit', label: '대중교통' }, { key: 'car', label: '자동차' }] as const;
type Status = { kind: 'idle' | 'loading' | 'expired' } | { kind: 'success'; result: TravelEstimate } | { kind: 'error'; error: unknown };

export default function RoutePlanner({ api, disabled, canChange, onInvalidate, onUse, appointmentAt }: {
  api: ApiClient; disabled: boolean; canChange: () => boolean; onInvalidate: () => void; onUse: (result: TravelEstimate) => void; appointmentAt: string | null;
}) {
  const client = useMemo(() => createTravelClient(api), [api]);
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [mode, setMode] = useState<TravelMode | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [weatherOpen, setWeatherOpen] = useState(false);
  const version = useRef(0);
  const invalidateRef = useRef(onInvalidate); invalidateRef.current = onInvalidate;
  useEffect(() => () => { version.current += 1; }, [client]);
  useEffect(() => {
    const subscription = AppState?.addEventListener('change', (next) => {
      if (next !== 'active') { version.current += 1; setStatus({ kind: 'expired' }); }
    });
    return () => subscription?.remove();
  }, []);
  useEffect(() => {
    if (status.kind !== 'success') return;
    const delay = Math.max(1, travelRemainingMs(status.result.freshness) + 1);
    const timer = setTimeout(() => { version.current += 1; setStatus({ kind: 'expired' }); invalidateRef.current(); }, delay);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    if (disabled && status.kind === 'loading') { version.current += 1; setStatus({ kind: 'idle' }); }
  }, [disabled, status.kind]);
  function invalidate() { version.current += 1; setStatus({ kind: 'idle' }); onInvalidate(); }
  async function estimate() {
    if (!canChange() || disabled || !origin || !destination || !mode) return;
    const current = ++version.current;
    onInvalidate(); setStatus({ kind: 'loading' });
    try {
      const result = await client.estimate(origin, destination, mode);
      if (version.current === current && canChange()) setStatus({ kind: 'success', result });
    } catch (error) {
      if (version.current === current && canChange()) setStatus({ kind: 'error', error });
    }
  }
  const errorCode = status.kind === 'error' && status.error instanceof ApiError ? status.error.code : '';
  const errorMessage = errorCode === 'not_configured' ? '경로 조회가 설정되지 않았습니다.' :
    errorCode === 'unsupported' ? '선택한 이동 수단의 조회를 지원하지 않습니다.' :
    errorCode === 'no_route' ? '선택한 장소 사이의 경로를 찾지 못했습니다.' :
    errorCode === 'unauthenticated' || errorCode === 'permission_denied' ? '경로 조회 권한이나 연결을 확인해 주세요.' :
    errorCode === 'expired' ? '경로 조회 결과가 만료되었습니다.' : '경로를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return <View style={styles.block}>
    <Text accessibilityRole="header" style={styles.title}>이동 경로 확인</Text>
    <Text style={styles.text}>검색어는 Kakao에 전달됩니다. 선택한 장소의 좌표는 경로 조회 시 Kakao에 전달되며 일정의 장소로 저장되지 않습니다.</Text>
    <PlaceSearch api={api} label="출발 장소" disabled={disabled} canChange={canChange} onChange={(place) => { setOrigin(place); invalidate(); }} />
    <PlaceSearch api={api} label="도착 장소" disabled={disabled} canChange={canChange} onChange={(place) => { setDestination(place); invalidate(); }} />
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: weatherOpen, disabled }} disabled={disabled}
      onPress={() => { if (canChange()) setWeatherOpen((open) => !open); }} style={styles.button}><Text>{weatherOpen ? '날씨 정보 닫기' : '날씨 정보 열기'}</Text></Pressable>
    {weatherOpen && <WeatherPanel api={api} destination={destination} appointmentAt={appointmentAt} disabled={disabled} canChange={canChange} />}
    <Text style={styles.text}>이동 수단을 직접 선택해 주세요.</Text>
    <View style={styles.modes}>{modes.map((item) => <Pressable key={item.key} accessibilityRole="button"
      accessibilityState={{ selected: mode === item.key, disabled }} disabled={disabled}
      onPress={() => { if (!canChange() || mode === item.key) return; setMode(item.key); invalidate(); }} style={styles.button}>
      <Text>{mode === item.key ? `${item.label} 선택됨` : item.label}</Text>
    </Pressable>)}</View>
    <Text style={styles.text}>현재 시각 기준 조회이며 미래 약속 시각의 이동 시간을 보장하지 않습니다. 조회가 불가능하면 이동 시간을 직접 입력해 주세요.</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || !origin || !destination || !mode || status.kind === 'loading' }}
      disabled={disabled || !origin || !destination || !mode || status.kind === 'loading'} onPress={estimate} style={styles.button}><Text>이동 시간 조회</Text></Pressable>
    {status.kind === 'loading' && <View accessibilityLiveRegion="polite"><ActivityIndicator /><Text>이동 시간을 조회하는 중입니다.</Text></View>}
    {status.kind === 'error' && <Text accessibilityRole="alert" style={styles.text}>{errorMessage} 이동 시간을 직접 입력할 수 있습니다.</Text>}
    {status.kind === 'expired' && <Text style={styles.text}>조회 결과가 만료되었습니다. 다시 조회하거나 이동 시간을 직접 입력해 주세요.</Text>}
    {status.kind === 'success' && <>
      <Text style={styles.text}>현재 시각 기준 Kakao 조회: {status.result.durationMinutes}분 · 조회 시각 {status.result.fetchedAt} · 최대 5분 동안 확인할 수 있습니다.</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => {
        if (!canChange()) return;
        if (!isTravelFresh(status.result.freshness)) { setStatus({ kind: 'expired' }); onInvalidate(); return; }
        onUse(status.result);
      }} style={styles.button}><Text>이동시간에 사용</Text></Pressable>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 10 }, title: { fontSize: 18, fontWeight: '700', color: colors.text },
  text: { color: colors.muted, lineHeight: 21 }, modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft },
});
