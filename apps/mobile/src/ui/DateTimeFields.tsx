import { StyleSheet, View } from 'react-native';
import { Text } from './typography';
import { colors } from './theme';

export type DateTimeFieldsProps = { label: string; mode: 'date' | 'time'; value: string; onChange: (value: string) => void; disabled?: boolean };

export function DateTimeFields({ label, mode, value, onChange, disabled = false }: DateTimeFieldsProps) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text>
    <input aria-label={label} type={mode} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}
      style={{ minHeight: 44, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0 10px', fontSize: 16, color: colors.text }} />
  </View>;
}
const styles = StyleSheet.create({ field: { gap: 5 }, label: { color: colors.text, fontSize: 15, fontWeight: '600' } });
