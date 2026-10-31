import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { isUncertainMutationError } from '../api/mutation';
import { operationGuard } from '../api/operationGuard';
import { ActionButton } from '../ui/ActionButton';
import { colors } from '../ui/theme';
import { Text, TextInput } from '../ui/typography';
import { createContactClient, matchesPhoneProvider, type PhoneConnection, type PhoneConnectionInput, type PhoneProvider } from './client';

type Props = { api: ApiClient; onBack: () => void };
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; data: PhoneConnection };
type Setup = 'idle' | 'pending' | 'uncertain';
type PhoneReceipt = PhoneConnection & { lastRequestId?: string | null };

export function PhoneConnectionForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (input: PhoneConnectionInput) => void }) {
  const [provider, setProvider] = useState<PhoneProvider>('clawops');
  const [account, setAccount] = useState('');
  const [secret, setSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const clear = () => { setAccount(''); setSecret(''); setSigningSecret(''); setFromNumber(''); };
  const valid = !!account.trim() && !!secret.trim() && (provider !== 'clawops' || !!signingSecret.trim()) && /^\+[1-9]\d{1,14}$/.test(fromNumber.trim());
  return <>
    <Text style={styles.label}>전화 제공자</Text>
    {(['clawops', 'twilio'] as const).map(item => <Pressable key={item} accessibilityRole="radio" accessibilityLabel={item === 'clawops' ? 'ClawOps 선택' : 'Twilio 선택'}
      accessibilityState={{ checked: provider === item, disabled }} aria-checked={provider === item} disabled={disabled}
      onPress={() => { clear(); setProvider(item); }} style={styles.choice}>
      <Text style={styles.text}>{provider === item ? '●' : '○'} {item === 'clawops' ? 'ClawOps' : 'Twilio'}</Text>
    </Pressable>)}
    {provider === 'clawops' && <Text style={styles.text}>ClawOps 계정 ID, API 키, 서명 비밀과 발신 번호가 모두 필요합니다. 전화에서는 안내 후 키패드 선택과 재확인으로 응답을 받습니다.</Text>}
    <Text style={styles.label}>{provider === 'clawops' ? 'ClawOps 계정 ID' : '계정 SID'}</Text>
    <TextInput accessibilityLabel={provider === 'clawops' ? 'ClawOps 계정 ID' : '전화 계정 SID'} value={account} onChangeText={setAccount} editable={!disabled} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
    <Text style={styles.label}>{provider === 'clawops' ? 'ClawOps API 키' : '인증 토큰'}</Text>
    <TextInput accessibilityLabel={provider === 'clawops' ? 'ClawOps API 키' : '전화 인증 토큰'} value={secret} onChangeText={setSecret} editable={!disabled} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
    {provider === 'clawops' && <><Text style={styles.label}>ClawOps 서명 비밀</Text>
      <TextInput accessibilityLabel="ClawOps 서명 비밀" value={signingSecret} onChangeText={setSigningSecret} editable={!disabled} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} /></>}
    <Text style={styles.label}>발신 번호 (E.164)</Text>
    <TextInput accessibilityLabel="발신 전화번호" value={fromNumber} onChangeText={setFromNumber} editable={!disabled} keyboardType="phone-pad" style={styles.input} />
    <ActionButton label="전화 연결 설정" disabled={disabled || !valid} onPress={() => {
      if (!valid || disabled) return;
      const input: PhoneConnectionInput = provider === 'clawops'
        ? { provider, accountId: account.trim(), apiKey: secret.trim(), signingSecret: signingSecret.trim(), fromNumber: fromNumber.trim() }
        : { accountSid: account.trim(), authToken: secret.trim(), fromNumber: fromNumber.trim() };
      clear(); onSubmit(input);
    }} />
  </>;
}

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
  const owner = useRef<object>({});
  const active = useRef(true);
  const busy = useRef(false);
  const reading = useRef(false);
  const expected = useRef<{ number: string; requestId: string; provider: PhoneProvider } | null>(null);

  async function refresh() {
    if (reading.current || (busy.current && setup !== 'uncertain')) return;
    reading.current = true;
    if (active.current) setConnection({ status: 'loading' });
    try {
      const data: PhoneReceipt = await client.phoneConnection();
      if (!active.current) return;
      setConnection({ status: 'success', data });
      if (expected.current && data.status === 'available' && data.senderNumber === expected.current.number && data.lastRequestId === expected.current.requestId && matchesPhoneProvider(data, expected.current.provider)) {
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

  async function connect(input: PhoneConnectionInput) {
    if (busy.current || reading.current || connection.status !== 'success') return;
    busy.current = true;
    setMessage(''); setSetup('pending');
    operationGuard.update(owner.current, { status: 'pending' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requestId = `request-${id}`;
    const provider = 'provider' in input ? input.provider : 'twilio';
    expected.current = { number: input.fromNumber, requestId, provider };
    try {
      const result: PhoneReceipt = await client.connectPhone({ input, requestId, idempotencyKey: `operation-${id}` });
      if (result.status !== 'available' || result.senderNumber !== input.fromNumber || !matchesPhoneProvider(result, provider) ||
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
  return <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>전화 외부 연결</Text>
      <ActionButton label="뒤로" onPress={() => { if (!busy.current) onBack(); }} disabled={locked} secondary />
    </View>
    <Text style={styles.text}>발신 계정을 설정합니다. 이 화면에서는 전화가 발신되지 않습니다.</Text>
    {connection.status === 'loading' && <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" /><Text style={styles.text}>연결 상태를 확인하는 중입니다.</Text></View>}
    {connection.status === 'error' && <Text accessibilityRole="alert" style={styles.error}>{connection.message}</Text>}
    {connection.status === 'success' && <Text style={styles.text}>{expected.current ? '전화 연결 결과를 다시 확인해 주세요.' : connection.data.status === 'available'
      ? `연결됨 · 발신 번호: ${connection.data.senderNumber} · 제공자: ${connection.data.provider === 'clawops' ? 'ClawOps' : 'Twilio'}` : '전화 연결이 설정되지 않았습니다.'}</Text>}
    <ActionButton label="전화 연결 상태 확인" onPress={() => void refresh()} disabled={setup === 'pending' || connection.status === 'loading'} secondary />
    <PhoneConnectionForm disabled={locked || connection.status !== 'success'} onSubmit={(input) => void connect(input)} />
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
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  error: { color: colors.error },
});
