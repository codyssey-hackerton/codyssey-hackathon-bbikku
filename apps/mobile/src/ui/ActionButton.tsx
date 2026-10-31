import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Text } from './typography';
import { colors } from './theme';

export function ActionButton({ label, onPress, icon, secondary = false, disabled = false, loading = false, variant, size = 'md' }: {
  label: string; onPress: () => void; icon?: IconName; secondary?: boolean; disabled?: boolean; loading?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg';
}) {
  const kind = variant ?? (secondary ? 'secondary' : 'primary');
  const inactive = disabled || loading;
  const foreground = kind === 'primary' || kind === 'danger' ? colors.surface : colors.primaryPressed;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive, busy: loading }}
    disabled={inactive} onPress={onPress} style={({ pressed }) => [styles.touch, inactive && styles.disabled, pressed && styles.pressed]}>
    <View pointerEvents="none" style={[styles.button, styles[kind], size === 'sm' && styles.small, size === 'lg' && styles.large]}>
      {loading ? <ActivityIndicator color={foreground} size="small" /> : icon && <Icon name={icon} size={18} color={foreground} />}
      <Text numberOfLines={1} style={[styles.label, { color: foreground }]}>{label}</Text>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  touch: { minHeight: 44, justifyContent: 'center', flexShrink: 1 },
  button: { minHeight: 44, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12 },
  primary: { backgroundColor: colors.primaryPressed },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.error },
  small: { minHeight: 36 },
  large: { minHeight: 52 },
  label: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
