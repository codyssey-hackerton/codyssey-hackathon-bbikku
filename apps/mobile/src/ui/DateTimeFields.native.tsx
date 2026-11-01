import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Text } from './typography';
import { colors } from './theme';
import type { DateTimeFieldsProps } from './DateTimeFields';
export type { DateTimeFieldsProps } from './DateTimeFields';

function pickerDate(mode: 'date' | 'time', value: string): Date {
  const date = new Date();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(value);
  if (mode === 'date' && dateMatch) date.setFullYear(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  if (mode === 'time' && timeMatch) date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
  return date;
}
function pickerValue(mode: 'date' | 'time', date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return mode === 'date' ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function DateTimeFields({ label, mode, value, onChange, disabled = false }: DateTimeFieldsProps) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(() => pickerDate(mode, value));
  const gate = useRef({ disabled, generation: 0, mounted: true });
  gate.current.disabled = disabled;
  useEffect(() => { gate.current.mounted = true; return () => { gate.current.mounted = false; gate.current.generation++; }; }, []);
  useEffect(() => { if (disabled) { gate.current.generation++; setOpen(false); } }, [disabled]);
  const generation = gate.current.generation;
  const active = () => gate.current.mounted && !gate.current.disabled && gate.current.generation === generation;
  function close() { gate.current.generation++; setOpen(false); }
  const title = value ? mode === 'date' ? value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1년 $2월 $3일') : value : mode === 'date' ? '날짜 선택' : '시간 선택';
  return <View style={styles.field}><Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, expanded: open }} disabled={disabled}
      onPress={() => { gate.current.generation++; setSelected(pickerDate(mode, value)); setOpen(true); }} style={styles.button}><Text>{title}</Text></Pressable>
    {open && !disabled && <><DateTimePicker value={selected} mode={mode} display={mode === 'date' ? Platform.OS === 'ios' ? 'inline' : 'default' : 'spinner'}
      onChange={(event, next) => { if (!active()) return; if (Platform.OS === 'android') { close(); if (event.type === 'set' && next) onChange(pickerValue(mode, next)); }
        else if (next) setSelected(next); }} />
      {Platform.OS === 'ios' && <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel={`${label} 선택 취소`} onPress={close} style={styles.button}><Text>취소</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} 선택 완료`} onPress={() => { if (active()) { close(); onChange(pickerValue(mode, selected)); } }} style={styles.button}><Text>완료</Text></Pressable></View>}
    </>}
  </View>;
}
const styles = StyleSheet.create({ field: { gap: 5 }, label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  button: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, justifyContent: 'center' }, actions: { flexDirection: 'row', gap: 8 } });
