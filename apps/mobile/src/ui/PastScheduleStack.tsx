import { Children, cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { AccessibilityInfo, LayoutAnimation, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './typography';

export function PastScheduleStack({ children, front, count, expanded, onToggle, disabled = false, insetLeft = 0 }: {
  children: ReactNode; front?: ReactNode; count: number; expanded: boolean; onToggle: () => void; disabled?: boolean; insetLeft?: number;
}) {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  const toggle = () => {
    if (!reduceMotion && Platform.OS === 'ios') LayoutAnimation.configureNext({ duration: 300, update: { type: LayoutAnimation.Types.easeInEaseOut },
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity }, delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity } });
    onToggle();
  };
  if (count <= 0) return <>{front}</>;
  if (expanded) return <View>
    <View style={styles.history}>{children}</View>
    <Pressable accessibilityRole="button" accessibilityLabel="이전 일정 접기" accessibilityState={{ disabled, expanded: true }} disabled={disabled}
      onPress={toggle} style={({ pressed }) => [styles.close, pressed && styles.pressed]}><Text style={styles.closeText}>접기</Text></Pressable>
    {front}
  </View>;
  const inset = Number.isFinite(insetLeft) ? Math.max(0, insetLeft) : 0;
  const previews = Children.toArray(children).slice(0, Math.min(3, count)).reverse();
  return <View style={styles.stack}>
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      aria-hidden={true} {...(Platform.OS === 'web' ? { inert: true } : {})} style={[styles.layers, { left: inset }]}>
      {previews.map((child, index) => {
        const slot = 3 - previews.length + index;
        const row = isValidElement(child) && child.type === View
          ? cloneElement(child as ReactElement<{ style?: StyleProp<ViewStyle> }>, { style: [(child.props as { style?: StyleProp<ViewStyle> }).style, { marginTop: 0 }] })
          : child;
        return <View key={index} style={[styles.layer, { top: 5 + slot * 9, left: 15 - slot * 5, right: 15 - slot * 5,
          backgroundColor: ['#F2F5FF', '#F7F9FF', '#FAFBFF'][slot] }]}>
          <View style={styles.clip}><View style={{ marginLeft: -inset }}>{row}</View></View>
        </View>;
      })}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="이전 일정 카드 펼치기" accessibilityState={{ disabled, expanded: false }}
      disabled={disabled} onPress={toggle} style={({ pressed }) => [styles.peek, { left: inset }, pressed && styles.pressed]} />
    {front ? <View style={styles.front}>{front}</View> : null}
  </View>;
}
const styles = StyleSheet.create({
  stack: { paddingTop: 32, overflow: 'visible' },
  history: { gap: 6 },
  layers: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, overflow: 'visible' },
  layer: { position: 'absolute', height: 62, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF',
    shadowColor: '#7586B0', shadowOpacity: 0.14, shadowRadius: 8, shadowOffset: { width: 0, height: -2 }, elevation: 1 },
  clip: { height: '100%', borderRadius: 12, overflow: 'hidden' },
  peek: { position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 3 },
  front: { zIndex: 4 },
  close: { minHeight: 44, alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 10 },
  closeText: { color: '#5369CA', fontSize: 11, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
