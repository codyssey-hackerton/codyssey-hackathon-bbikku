import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';
import { createContactClient, type PhoneConnection } from './client';

type Props = { api: ApiClient; onBack: () => void };
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; data: PhoneConnection };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'unauthenticated') return '연결된 세션을 확인해 주세요.';
  if (error instanceof ApiError && error.code === 'invalid_configuration') return '전화 연결 상태를 확인하려면 서버 연결을 확인해 주세요.';
  return '전화 연결 상태를 확인하지 못했습니다. 다시 시도해 주세요.';
}

export default function PhoneConnectionPanel({ api, onBack }: Props) {
  const client = useMemo(() => createContactClient(api), [api]);
  const [connection, setConnection] = useState<Load>({ status: 'loading' });
  const generation = useRef(0);
  const reading = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const current = ++generation.current;
    setConnection({ status: 'loading' });
    try {
      const data = await client.phoneConnection();
      if (current === generation.current) setConnection({ status: 'success', data });
    } catch (error) {
      if (current === generation.current) setConnection({ status: 'error', message: errorMessage(error) });
    } finally {
      if (current === generation.current) reading.current = false;
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; reading.current = false; };
  }, [refresh]);

  return <ScrollView contentContainerStyle={styles.container}>
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>전화 외부 연결</Text>
      <ActionButton label="뒤로" onPress={onBack} secondary />
    </View>
    {connection.status === 'loading' && <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" /><Text style={styles.text}>연결 상태를 확인하는 중입니다.</Text></View>}
    {connection.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{connection.message}</Text>}
    {connection.status === 'success' && <Text accessibilityLiveRegion="polite" style={styles.text}>{connection.data.status === 'available'
      ? `연결됨 · 발신 번호: ${connection.data.senderNumber}` : '전화 연결이 설정되지 않았습니다. 운영자에게 문의해 주세요.'}</Text>}
    <ActionButton label={connection.status === 'error' ? '다시 시도' : '전화 연결 상태 확인'} onPress={() => void refresh()} disabled={connection.status === 'loading'} secondary />
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { color: colors.text, fontSize: 25, fontWeight: '700', flexShrink: 1 },
  text: { color: colors.text },
  error: { color: colors.error },
});
