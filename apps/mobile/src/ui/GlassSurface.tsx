import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { colors } from './theme';

// A translucent fallback works in the current Expo runtime without additional native views.
export function GlassSurface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const [opaque, setOpaque] = useState(true);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', value => {
      changed = true;
      if (active) setOpaque(value);
    });
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value => {
      if (active && !changed) setOpaque(value);
    }).catch(() => {});
    return () => { active = false; subscription.remove(); };
  }, []);
  return <View style={[styles.surface, style]}>
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, {
      backgroundColor: Platform.OS === 'ios' && opaque ? colors.surface : 'rgba(255,255,255,0.88)',
    }]} />
    {children}
  </View>;
}

const styles = StyleSheet.create({
  surface: { overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: 26 },
});
