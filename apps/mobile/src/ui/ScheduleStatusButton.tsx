import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './typography';

export function ScheduleStatusButton({ label, accessibilityLabel, selected = false, disabled = false, onPress, absent = false }: {
  label: string; accessibilityLabel?: string; selected?: boolean; disabled?: boolean; onPress: () => void; absent?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.touch, pressed && styles.pressed]}>
    <View style={[styles.visual, selected && styles.selected, absent && styles.absent, disabled && styles.disabled]}>
      <Text numberOfLines={1} style={[styles.label, selected && styles.selectedText, absent && styles.absentText, disabled && styles.disabledText]}>{label}</Text>
    </View>
  </Pressable>;
}
const styles = StyleSheet.create({
  touch: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  visual: { minHeight: 30, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8, borderWidth: 1, borderColor: '#CBD4EA', borderRadius: 10, backgroundColor: '#FFFFFF' },
  label: { color: '#626B80', fontSize: 11, fontWeight: '700' },
  selected: { backgroundColor: '#EDF2FF', borderColor: '#AEBEFF' },
  selectedText: { color: '#4358A4' },
  absent: { backgroundColor: '#FFF5F1', borderColor: '#F2CBC0' },
  absentText: { color: '#A54D3C' },
  disabled: { backgroundColor: '#F8F9FC', borderColor: '#E3E7EE' },
  disabledText: { color: '#A5ADBA' },
  pressed: { opacity: 0.7 },
});
