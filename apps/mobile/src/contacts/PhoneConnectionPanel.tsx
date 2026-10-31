import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { isUncertainMutationError } from '../api/mutation';
import { operationGuard } from '../api/operationGuard';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createContactClient, type PhoneConnection } from './client';

type Props = { api: ApiClient; onBack: () => void };
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; data: PhoneConnection };
type Setup = 'idle' | 'pending' | 'uncertain';
type PhoneReceipt = PhoneConnection & { lastRequestId?: string | null };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'unauthenticated') return '연결된 세션을 확인해 주세요.';
  if (error instanceof ApiError && error.code === 'invalid_configuration') return '전화 연결 설정에는 HTTPS 또는 로컬 서버가 필요합니다.';
  return '전화 연결을 확인하지 못했습니다. 설정과 연결을 확인해 주세요.';
}

export default function PhoneConnectionPanel({ api, onBack }: Props) {
  const client = useMemo(() => createContactClient(api), [api]);
  const [connection, setConnection] = useState<Load>({ status: 'loading' });
  const [setup, setSetup] = useState<Setup>('idle');
  const [message, setMessage] = useState('');
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const owner = useRef<object>({});
  const active = useRef(true);
  const busy = useRef(false);
  const reading = useRef(false);
  const expected = useRef<{ number: string; requestId: string } | null>(null);

  async function refresh() {
    if (reading.current || (busy.current && setup !== 'uncertain')) return;
    reading.current = true;
    if (active.current) setConnection({ status: 'loading' });
    try {
      const data: PhoneReceipt = await client.phoneConnection();
      if (!active.current) return;
      setConnection({ status: 'success', data });
      if (expected.current && data.status === 'available' && data.senderNumber === expected.current.number && data.lastRequestId === expected.current.requestId) {
        expected.current = null; busy.current = false; operationGuard.clear(owner.current);
        setSetup('idle'); setMessage('전화 연결을 확인했습니다.');
      }
    } catch (error) {
      if (active.current) setConnection({ status: 'error', message: errorMessage(error) });
    } finally { reading.current = false; }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; };
  }, [client]);

  async function connect() {
    if (busy.current || reading.current || connection.status !== 'success' || !accountSid.trim() || !authToken.trim() || !/^\+[1-9]\d{1,14}$/.test(fromNumber.trim())) return;
    const input = { accountSid: accountSid.trim(), authToken: authToken.trim(), fromNumber: fromNumber.trim() };
    busy.current = true;
    setAccountSid(''); setAuthToken(''); setFromNumber(''); setMessage(''); setSetup('pending');
    operationGuard.update(owner.current, { status: 'pending' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requestId = `request-${id}`;
    expected.current = { number: input.fromNumber, requestId };
    try {
      const result: PhoneReceipt = await client.connectPhone({ input, requestId, idempotencyKey: `operation-${id}` });
      if (result.status !== 'available' || result.senderNumber !== input.fromNumber ||
          (result.lastRequestId !== undefined && result.lastRequestId !== requestId)) throw new ApiError('invalid_response', '');
      expected.current = null; busy.current = false; operationGuard.clear(owner.current);
      if (active.current) { setConnection({ status: 'success', data: result }); setSetup('idle'); setMessage('전화 연결을 확인했습니다.'); }
    } catch (error) {
      if (isUncertainMutationError(error)) {
        operationGuard.update(owner.current, { status: 'error', error: undefined, uncertain: true });
        if (active.current) setSetup('uncertain');
      } else {
        expected.current = null; busy.current = false; operationGuard.clear(owner.current);
        if (active.current) { setSetup('idle'); setMessage(errorMessage(error)); }
      }
    }
  }

  const locked = setup !== 'idle';
  const valid = accountSid.trim() && authToken.trim() && /^\+[1-9]\d{1,14}$/.test(fromNumber.trim());
  return <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>전화 외부 연결</Text>
      <ActionButton label="뒤로" onPress={() => { if (!busy.current) { setAccountSid(''); setAuthToken(''); setFromNumber(''); onBack(); } }} disabled={locked} secondary />
    </View>
    <Text style={styles.text}>발신 계정을 설정합니다. 이 화면에서는 전화가 발신되지 않습니다.</Text>
    {connection.status === 'loading' && <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" /><Text style={styles.text}>연결 상태를 확인하는 중입니다.</Text></View>}
    {connection.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{connection.message}</Text>}
    {connection.status === 'success' && <Text style={styles.text}>{connection.data.status === 'available' ? `연결됨 · 발신 번호: ${connection.data.senderNumber}` : '전화 연결이 설정되지 않았습니다.'}</Text>}
    <ActionButton label="전화 연결 상태 확인" onPress={() => void refresh()} disabled={setup === 'pending' || connection.status === 'loading'} secondary />
    <Text style={styles.label}>계정 SID</Text>
    <TextInput accessibilityLabel="전화 계정 SID" value={accountSid} onChangeText={setAccountSid} editable={!locked} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
    <Text style={styles.label}>인증 토큰</Text>
    <TextInput accessibilityLabel="전화 인증 토큰" value={authToken} onChangeText={setAuthToken} editable={!locked} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
    <Text style={styles.label}>발신 번호 (E.164)</Text>
    <TextInput accessibilityLabel="발신 전화번호" value={fromNumber} onChangeText={setFromNumber} editable={!locked} keyboardType="phone-pad" style={styles.input} />
    <ActionButton label="전화 연결 설정" onPress={() => void connect()} disabled={locked || connection.status !== 'success' || !valid} />
    {setup === 'pending' && <Text accessibilityLiveRegion="polite" style={styles.text}>전화 연결을 설정하는 중입니다.</Text>}
    {setup === 'uncertain' && <Text accessibilityRole="alert" style={styles.error}>설정 결과를 확인하지 못했습니다. 전화 연결 상태를 다시 확인해 주세요.</Text>}
    {!!message && <Text accessibilityLiveRegion="polite" style={styles.text}>{message}</Text>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { color: colors.text, fontSize: 25, fontWeight: '700', flexShrink: 1 },
  text: { color: colors.text },
  label: { color: colors.text, fontWeight: '600', marginTop: 6 },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  error: { color: colors.error },
});
