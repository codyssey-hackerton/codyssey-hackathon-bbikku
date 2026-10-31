import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createPlacesClient, type Place } from './client';

type Status = { kind: 'idle' | 'loading' } | { kind: 'success'; places: Place[] } | { kind: 'error'; error: unknown };

export default function PlaceSearch({ api, label, disabled, canChange, onChange }: {
  api: ApiClient; label: string; disabled: boolean; canChange: () => boolean; onChange: (place: Place | null) => void;
}) {
  const client = useMemo(() => createPlacesClient(api), [api]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Place | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const version = useRef(0);
  useEffect(() => () => { version.current += 1; }, [client]);
  useEffect(() => {
    if (disabled && status.kind === 'loading') { version.current += 1; setStatus({ kind: 'idle' }); }
  }, [disabled, status.kind]);

  function edit(value: string) {
    if (!canChange()) return;
    version.current += 1; setQuery(value); setSelected(null); setStatus({ kind: 'idle' }); onChange(null);
  }
  async function search() {
    if (!canChange() || disabled || !query.trim() || query.trim().length > 100) return;
    const current = ++version.current;
    setSelected(null); onChange(null); setStatus({ kind: 'loading' });
    try {
      const places = await client.search(query);
      if (current === version.current && canChange()) setStatus({ kind: 'success', places });
    } catch (error) {
      if (current === version.current && canChange()) setStatus({ kind: 'error', error });
    }
  }
  const message = status.kind !== 'error' ? '' : status.error instanceof ApiError && status.error.code === 'not_configured'
    ? '장소 검색이 설정되지 않았습니다.' : status.error instanceof ApiError && ['unauthenticated', 'permission_denied'].includes(status.error.code)
      ? '장소 검색 권한이나 연결을 확인해 주세요.' : '장소를 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return <View style={styles.block}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={`${label} 검색어`} value={query} editable={!disabled} maxLength={100} onChangeText={edit} style={styles.input} />
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 검색`} accessibilityState={{ disabled: disabled || !query.trim() || status.kind === 'loading' }}
      disabled={disabled || !query.trim() || status.kind === 'loading'} onPress={search} style={styles.button}><Text>{label} 검색</Text></Pressable>
    {status.kind === 'loading' && <View accessibilityLiveRegion="polite"><ActivityIndicator /><Text>장소를 검색하는 중입니다.</Text></View>}
    {status.kind === 'error' && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
    {status.kind === 'success' && status.places.length === 0 && <Text>검색 결과가 없습니다. 다른 검색어를 입력해 주세요.</Text>}
    {status.kind === 'success' && status.places.map((place) => <Pressable key={place.id} accessibilityRole="button"
      accessibilityLabel={`${label} 장소 선택 ${place.name} ${place.roadAddress || place.address}`} disabled={disabled}
      onPress={() => { if (!canChange()) return; version.current += 1; setSelected(place); setQuery(place.name); setStatus({ kind: 'idle' }); onChange(place); }} style={styles.result}>
      <Text>{place.name}</Text><Text>{place.roadAddress || place.address}</Text>
    </Pressable>)}
    {selected && <Text>선택한 {label}: {selected.name} · {selected.roadAddress || selected.address}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 6 }, label: { color: colors.text, fontWeight: '700' },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft },
  result: { padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 10, gap: 3 },
  error: { color: '#a01818' },
});
