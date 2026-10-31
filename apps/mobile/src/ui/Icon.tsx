import { useContext } from 'react';
import { Text, View } from 'react-native';
import glyphs from '../../assets/icons/glyphs.json';
import { FontReadyContext } from './typography';
import { colors } from './theme';

export type IconName = keyof typeof glyphs;

// Controls supply their own labels; font glyphs are decorative and never read aloud.
export function Icon({ name, size = 20, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  const ready = useContext(FontReadyContext);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {ready && <Text allowFontScaling={false} style={{ fontFamily: 'Lucide', fontSize: size, lineHeight: size,
      color, includeFontPadding: false, textAlign: 'center' }}>{glyphs[name]}</Text>}
  </View>;
}
