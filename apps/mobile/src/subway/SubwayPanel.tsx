import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { isTravelFresh, travelRemainingMs } from '../travel/client';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createSubwayClient, type SubwayResult } from './client';

type Status = { kind: 'idle' | 'loading' | 'expired' } | { kind: 'success'; data: SubwayResult } | { kind: 'error'; error: unknown };

export default function SubwayPanel({ api, disabled, canChange }: { api: ApiClient; disabled: boolean; canChange: () => boolean }) {
  const client = useMemo(() => createSubwayClient(api), [api]);
  const [station, setStation] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [clockTick, setClockTick] = useState(0);
  const version = useRef(0);
  const canChangeRef = useRef(canChange); canChangeRef.current = canChange;
  useEffect(() => () => { version.current += 1; }, [client]);
  useEffect(() => {
    const subscription = AppState?.addEventListener('change', (next) => { if (next !== 'active') { version.current += 1; setStatus({ kind: 'expired' }); } });
    return () => subscription?.remove();
  }, []);
  useEffect(() => {
    if (disabled && status.kind === 'loading') { version.current += 1; setStatus({ kind: 'idle' }); }
  }, [disabled, status.kind]);
  useEffect(() => {
    if (status.kind !== 'success') return;
    const remaining = travelRemainingMs(status.data.freshness);
    if (remaining <= 0) { version.current += 1; setStatus({ kind: 'expired' }); return; }
    const untilStale = status.data.arrivals.filter((row) => !row.stale).map((row) => travelRemainingMs({
      startedAt: status.data.freshness.startedAt, validForMs: Math.min(row.staleInMs, 120_000),
    })).filter((time) => time > 0);
    const timer = setTimeout(() => setClockTick((value) => value + 1), Math.max(1, Math.min(remaining, ...untilStale) + 1));
    return () => clearTimeout(timer);
  }, [status, clockTick]);
  async function lookup() {
    if (disabled || !canChangeRef.current() || !station.trim()) return;
    const current = ++version.current; setStatus({ kind: 'loading' });
    try {
      const data = await client.arrivals(station);
      if (current === version.current && canChangeRef.current()) setStatus({ kind: 'success', data });
    } catch (error) {
      if (current === version.current && canChangeRef.current()) setStatus({ kind: 'error', error });
    }
  }
  const code = status.kind === 'error' && status.error instanceof ApiError ? status.error.code : '';
  const message = code === 'not_configured' ? '서울 지하철 조회가 설정되지 않았습니다.' :
    code === 'rate_limited' ? '조회가 많아 잠시 후 다시 시도해 주세요.' :
    code === 'invalid_request' ? '역 이름을 확인해 주세요.' :
    code === 'unauthenticated' || code === 'permission_denied' ? '지하철 조회 권한이나 연결을 확인해 주세요.' :
    code === 'timeout' ? '지하철 조회 시간이 초과되었습니다.' :
    code === 'expired' ? '지하철 도착 정보가 만료되었습니다.' : '지하철 도착 정보를 불러오지 못했습니다.';
  return <View style={styles.block}>
    <Text accessibilityRole="header" style={styles.title}>서울 지하철 도착 정보</Text>
    <Text style={styles.text}>입력한 역 이름은 조회를 위해 서울 열린데이터광장에 전달됩니다. 현재 역 도착 정보이며 전체 경로 이동시간이나 미래 예측이 아니고 이동시간에 자동으로 더하지 않습니다.</Text>
    <TextInput accessibilityLabel="서울 지하철 역 이름" value={station} maxLength={80} editable={!disabled} onChangeText={(value) => {
      if (!canChangeRef.current()) return; version.current += 1; setStation(value); setStatus({ kind: 'idle' });
    }} style={styles.input} />
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || !station.trim() || status.kind === 'loading' }}
      disabled={disabled || !station.trim() || status.kind === 'loading'} onPress={lookup} style={styles.button}><Text>지하철 도착 조회</Text></Pressable>
    {status.kind === 'loading' && <View accessibilityLiveRegion="polite"><ActivityIndicator /><Text>도착 정보를 조회하는 중입니다.</Text></View>}
    {status.kind === 'error' && <Text accessibilityRole="alert" style={styles.text}>{message}</Text>}
    {status.kind === 'expired' && <Text style={styles.text}>도착 정보가 오래되었거나 앱 상태가 바뀌었습니다. 다시 조회해 주세요.</Text>}
    {status.kind === 'success' && <>
      <Text style={styles.text}>{status.data.stationName} · 제공자 응답 수신 시각 {status.data.fetchedAt}</Text>
      <Text style={styles.text}>남은 시간은 조회 응답 시점 기준이며 자동 갱신되지 않습니다. 원문 문구는 각 정보 생성 시각 기준입니다.</Text>
      {status.data.arrivals.length === 0 && <Text style={styles.text}>현재 제공된 도착 정보가 없습니다.</Text>}
      {status.data.arrivals.map((row, index) => <View key={`${row.lineId}-${row.observedAt}-${index}`} style={styles.item}>
        <Text style={styles.text}>{row.lineId} · {row.direction} · {row.destination}</Text>
        <Text style={styles.text}>{row.stale || !isTravelFresh({ startedAt: status.data.freshness.startedAt, validForMs: Math.min(row.staleInMs, 120_000) })
          ? '오래된 정보 · 현재 도착 시각으로 사용하지 마세요' : `조회 응답 시 남은 시간 ${row.arrivalSeconds}초`}</Text>
        <Text style={styles.text}>정보 생성: {row.observedAt}</Text>
        {!!row.message && <Text style={styles.text}>원문: {row.message}</Text>}
        {!!row.detailMessage && <Text style={styles.text}>원문 상세: {row.detailMessage}</Text>}
      </View>)}
      <Text accessibilityRole="link" onPress={() => { void Linking.openURL('https://data.seoul.go.kr/dataList/OA-12764/A/1/datasetView.do'); }} style={styles.link}>출처: 서울 열린데이터광장</Text>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 8 }, title: { color: colors.text, fontSize: 18, fontWeight: '700' }, text: { color: colors.text, lineHeight: 21 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft },
  item: { padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 10, gap: 3 },
  link: { color: colors.primary, textDecorationLine: 'underline' },
});
