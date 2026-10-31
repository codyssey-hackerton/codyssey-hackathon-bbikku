import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon';
import { colors } from './theme';
import { sheetDragHandlers } from './sheetDrag';
import { Text } from './typography';

export function BottomSheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [reduceMotion, setReduceMotion] = useState(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const drag = useMemo(() => PanResponder.create(sheetDragHandlers(() => closeRef.current())), []);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  return <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View {...drag.panHandlers} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          aria-hidden={true} style={[styles.dragHandle, Platform.OS === 'web' && ({ touchAction: 'none' } as unknown as ViewStyle)]}>
          <View style={styles.grabBar} />
        </View>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <Icon name="close" size={18} color={colors.muted} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>{children}</ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay },
  sheet: { maxHeight: '92%', paddingHorizontal: 18, paddingTop: 12, backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  dragHandle: { height: 44, alignItems: 'center', justifyContent: 'center' },
  grabBar: { width: 36, height: 4, borderRadius: 4, backgroundColor: '#D4D9E5' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: 19, fontWeight: '700' },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: 8 },
  pressed: { opacity: 0.7 },
});
