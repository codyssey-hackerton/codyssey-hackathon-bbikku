import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { ApiError, type ApiClient } from '../api/http';
import { ActionButton } from '../ui/ActionButton';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import { searchDeviceContacts, type ContactChoice } from './device-contacts';
import { normalizeScheduleCallNumber } from './schedule-call-client';

export function normalizeContactNumber(value: string): string | null {
  if (!/^[+\d\s()./-]+$/.test(value)) return null;
  const number = normalizeScheduleCallNumber(value.replace(/[\s()./-]/g, ''));
  return number?.startsWith('+820') ? null : number;
}
function googleContacts(value: unknown): { contacts: ContactChoice[]; truncated: boolean } {
  if (!value || typeof value !== 'object') throw new ApiError('invalid_response', '연락처 응답을 확인할 수 없습니다.');
  const result = value as { contacts?: unknown; truncated?: unknown };
  if (!Array.isArray(result.contacts) || result.contacts.length > 30 || typeof result.truncated !== 'boolean' || !result.contacts.every(contact =>
    contact && typeof contact.id === 'string' && !!contact.id.trim() && contact.id.length <= 300 &&
    typeof contact.displayName === 'string' && !!contact.displayName.trim() && contact.displayName.length <= 200 &&
    Array.isArray(contact.phoneNumbers) && contact.phoneNumbers.length <= 100 && contact.phoneNumbers.every((phone: unknown) => {
      if (!phone || typeof phone !== 'object') return false;
      const row = phone as { number?: unknown; label?: unknown };
      return typeof row.number === 'string' && row.number.length <= 100 && (row.label === undefined || typeof row.label === 'string' && row.label.length <= 200);
    }))) throw new ApiError('invalid_response', '연락처 응답을 확인할 수 없습니다.');
  return { contacts: result.contacts as ContactChoice[], truncated: result.truncated };
}
type Result = { status: 'idle' | 'loading' | 'denied' | 'unavailable' | 'not_configured' | 'error' } |
  { status: 'success'; contacts: ContactChoice[]; truncated: boolean; limited: boolean };
export function ContactPicker({ api, disabled, onSelect, onOpenGoogleContacts }: {
  api: ApiClient; disabled: boolean; onSelect: (value: { name: string; number: string }) => void; onOpenGoogleContacts?: () => void;
}) {
  const [open, setOpen] = useState(false), [source, setSource] = useState<'device' | 'google'>(Platform.OS === 'web' ? 'google' : 'device');
  const [query, setQuery] = useState(''), [result, setResult] = useState<Result>({ status: 'idle' });
  const generation = useRef(0);
  useEffect(() => {
    setOpen(false); setQuery(''); setResult({ status: 'idle' });
    return () => { generation.current++; };
  }, [api]);
  function reset() { generation.current++; setResult({ status: 'idle' }); }
  async function search() {
    const term = query.trim(); if (disabled || !term || term.length > 100) return;
    const token = ++generation.current; setResult({ status: 'loading' });
    try {
      const data = source === 'device' ? await searchDeviceContacts(term) : { status: 'ok' as const, limited: false,
        ...googleContacts(await api.get<unknown>(`/v1/contacts/google/search?q=${encodeURIComponent(term)}`)) };
      if (generation.current !== token) return;
      setResult(data.status === 'ok' ? { status: 'success', contacts: data.contacts, limited: data.limited, truncated: data.truncated } : { status: data.status });
    } catch (error) { if (generation.current === token) setResult({ status: error instanceof ApiError && error.code === 'not_configured' && source === 'google' ? 'not_configured' : 'error' }); }
  }
  if (!open) return <ActionButton label="연락처에서 선택" secondary disabled={disabled} onPress={() => setOpen(true)} />;
  return <View style={styles.box}>
    <Text accessibilityRole="header" style={styles.title}>연락처 검색</Text>
    <View style={styles.row}>
      <ActionButton label={source === 'device' ? '휴대폰 연락처 선택됨' : '휴대폰 연락처'} secondary disabled={disabled} onPress={() => { reset(); setSource('device'); }} />
      <ActionButton label={source === 'google' ? 'Google 연락처 선택됨' : 'Google 연락처'} secondary disabled={disabled} onPress={() => { reset(); setSource('google'); }} />
    </View>
    <Text style={styles.hint}>{source === 'device' ? '휴대폰에서 이름과 전화번호만 검색합니다. 웹에서는 휴대폰 주소록을 사용할 수 없습니다.' : '연결한 Google 연락처에서 이름의 시작 부분으로 검색합니다.'}</Text>
    <TextInput accessibilityLabel="연락처 이름 검색" value={query} editable={!disabled} maxLength={100} onChangeText={value => { reset(); setQuery(value); }} placeholder="이름 입력" style={styles.input} />
    <ActionButton label="이름 검색" disabled={disabled || result.status === 'loading' || !query.trim()} onPress={() => void search()} />
    {result.status === 'loading' && <Text accessibilityLiveRegion="polite">연락처를 검색하고 있습니다.</Text>}
    {result.status === 'denied' && <Text accessibilityRole="alert">연락처 접근이 거부되었습니다. 기기 설정에서 허용하거나 번호를 직접 입력해 주세요.</Text>}
    {result.status === 'unavailable' && <Text>이 기기에서는 휴대폰 연락처를 사용할 수 없습니다. Google 검색 또는 직접 입력을 이용해 주세요.</Text>}
    {result.status === 'not_configured' && <><Text accessibilityRole="alert">Google 연락처 연결이 필요합니다.</Text>{onOpenGoogleContacts && <ActionButton label="Google 연락처 연결 열기" secondary disabled={disabled} onPress={onOpenGoogleContacts} />}</>}
    {result.status === 'error' && <Text accessibilityRole="alert">연락처를 검색하지 못했습니다. 연결을 확인하거나 직접 입력해 주세요.</Text>}
    {result.status === 'success' && <>
      {result.limited && <Text style={styles.hint}>허용된 연락처만 검색했습니다.</Text>}
      {result.truncated && <Text style={styles.hint}>일부 결과만 표시합니다. 이름을 더 자세히 입력해 주세요.</Text>}
      {!result.contacts.length && <Text>검색 결과가 없습니다.</Text>}
      {result.contacts.map((contact, index) => <View key={`${contact.id}-${index}`} style={styles.contact}>
        <Text style={styles.title}>{contact.displayName}</Text>
        {!contact.phoneNumbers.length && <Text>전화번호가 없습니다.</Text>}
        {contact.phoneNumbers.map((phone, phoneIndex) => {
          const number = normalizeContactNumber(phone.number);
          return <View key={phoneIndex}><ActionButton label={`${contact.displayName} · ${phone.label || '전화'} · ${phone.number}`} secondary disabled={disabled || !number}
            onPress={() => { if (number) { reset(); setOpen(false); onSelect({ name: contact.displayName, number }); } }} />
            {!number && <Text style={styles.hint}>이 번호는 형식을 확인할 수 없습니다. 직접 입력해 주세요.</Text>}</View>;
        })}
      </View>)}
    </>}
    <ActionButton label="연락처 선택 취소" secondary disabled={disabled} onPress={() => { reset(); setOpen(false); }} />
  </View>;
}
const styles = StyleSheet.create({ box: { gap: 10, paddingVertical: 10 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { fontWeight: '700', color: colors.text }, hint: { color: colors.muted, lineHeight: 20 }, contact: { gap: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12 } });
