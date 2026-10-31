import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import type { Place } from '../places/client';
import { travelRemainingMs } from '../travel/client';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';
import { createWeatherClient, type WeatherForecast } from './client';

type Status = { kind: 'idle' | 'loading' | 'expired' } | { kind: 'success'; forecast: WeatherForecast; identity: string } | { kind: 'error'; error: unknown };

export default function WeatherPanel({ api, destination, appointmentAt, disabled, canChange }: {
  api: ApiClient; destination: Place | null; appointmentAt: string | null; disabled: boolean; canChange: () => boolean;
}) {
  const client = useMemo(() => createWeatherClient(api), [api]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const version = useRef(0);
  const identity = JSON.stringify([destination?.id, destination?.latitude, destination?.longitude, appointmentAt]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const canChangeRef = useRef(canChange); canChangeRef.current = canChange;
  useEffect(() => { version.current += 1; setStatus({ kind: 'idle' }); return () => { version.current += 1; }; }, [client, identity]);
  useEffect(() => {
    const subscription = AppState?.addEventListener('change', (next) => { if (next !== 'active') { version.current += 1; setStatus({ kind: 'expired' }); } });
    return () => subscription?.remove();
  }, []);
  useEffect(() => {
    if (disabled && status.kind === 'loading') { version.current += 1; setStatus({ kind: 'idle' }); }
  }, [disabled, status.kind]);
  useEffect(() => {
    if (status.kind !== 'success') return;
    const timer = setTimeout(() => { version.current += 1; setStatus({ kind: 'expired' }); }, Math.max(1, travelRemainingMs(status.forecast.freshness) + 1));
    return () => clearTimeout(timer);
  }, [status]);
  async function lookup() {
    if (disabled || !canChangeRef.current() || !destination || !appointmentAt) return;
    const current = ++version.current; const requested = identity;
    setStatus({ kind: 'loading' });
    try {
      const forecast = await client.forecast(destination, appointmentAt);
      if (current === version.current && requested === identityRef.current && canChangeRef.current()) setStatus({ kind: 'success', forecast, identity: requested });
    } catch (error) {
      if (current === version.current && requested === identityRef.current && canChangeRef.current()) setStatus({ kind: 'error', error });
    }
  }
  const code = status.kind === 'error' && status.error instanceof ApiError ? status.error.code : '';
  const message = code === 'unsupported_range' ? '선택한 약속 시각의 예보를 제공하지 않습니다.' :
    code === 'not_configured' ? '날씨 조회가 설정되지 않았습니다.' :
    code === 'unauthenticated' || code === 'permission_denied' ? '날씨 조회 권한이나 연결을 확인해 주세요.' :
    code === 'timeout' ? '날씨 조회 시간이 초과되었습니다.' :
    code === 'expired' ? '날씨 예보가 만료되었습니다.' : '날씨 예보를 불러오지 못했습니다.';
  const format = (value: number | null, unit: string) => value === null ? '미제공' : `${value}${unit}`;
  return <View style={styles.block}>
    <Text accessibilityRole="header" style={styles.title}>도착 장소 날씨</Text>
    <Text style={styles.text}>도착 장소 좌표와 약속 날짜가 Open-Meteo에 전달되며, 약속 시각에 해당하는 예보를 표시합니다. 예보는 달라질 수 있습니다.</Text>
    {!destination && <Text style={styles.text}>도착 장소를 먼저 선택해 주세요.</Text>}
    {!appointmentAt && <Text style={styles.text}>약속 시각을 확인할 수 없습니다.</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || !destination || !appointmentAt || status.kind === 'loading' }}
      disabled={disabled || !destination || !appointmentAt || status.kind === 'loading'} onPress={lookup} style={styles.button}><Text>날씨 조회</Text></Pressable>
    {status.kind === 'loading' && <View accessibilityLiveRegion="polite"><ActivityIndicator /><Text>날씨 예보를 조회하는 중입니다.</Text></View>}
    {status.kind === 'error' && <Text accessibilityRole="alert" style={styles.text}>{message}</Text>}
    {status.kind === 'expired' && <Text style={styles.text}>날씨 예보가 만료되었거나 앱 상태가 바뀌었습니다. 다시 조회해 주세요.</Text>}
    {status.kind === 'success' && status.identity === identity && <>
      <Text style={styles.text}>예보 시각: {status.forecast.forecastTime} · 조회: {status.forecast.fetchedAt}</Text>
      <Text style={styles.text}>해당 정각 기온 {format(status.forecast.temperatureC, '°C')} · 체감 {format(status.forecast.apparentTemperatureC, '°C')} · 바람 {format(status.forecast.windSpeedKmh, 'km/h')}</Text>
      <Text style={styles.text}>해당 정각 직전 1시간 강수량 {format(status.forecast.precipitationMm, 'mm')} · 강수확률 {format(status.forecast.precipitationProbabilityPercent, '%')}</Text>
      <Text accessibilityRole="link" onPress={() => { void Linking.openURL('https://open-meteo.com/'); }} style={styles.link}>출처: Open-Meteo</Text>
      <Text accessibilityRole="link" onPress={() => { void Linking.openURL('https://open-meteo.com/en/licence'); }} style={styles.link}>Open-Meteo 라이선스 (CC BY 4.0)</Text>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 8 }, title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  text: { color: colors.text, lineHeight: 21 }, link: { color: colors.primary, textDecorationLine: 'underline' },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft },
});
