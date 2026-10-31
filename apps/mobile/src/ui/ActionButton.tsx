import { Pressable, StyleSheet } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Text } from './typography';
import { colors } from './theme';

export function ActionButton({ label, onPress, icon, secondary = false, disabled = false }: {
  label: string; onPress: () => void; icon?: IconName; secondary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, disabled && styles.disabled, pressed && styles.pressed]}>
    {icon && <Icon name={icon} size={18} color={secondary ? colors.primary : colors.surface} />}
    <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minHeight: 48, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.primary, flexShrink: 1 },
  secondary: { backgroundColor: colors.primarySoft },
  label: { color: colors.surface, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  secondaryLabel: { color: colors.primary },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
