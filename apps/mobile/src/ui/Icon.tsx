import { useContext } from 'react';
import { Text, View } from 'react-native';
import glyphs from '../../assets/icons/glyphs.json';
import { FontReadyContext } from './typography';
import { colors } from './theme';
import { StreamlineIcon, type StreamlineIconName } from './StreamlineIcon';

export type IconName = keyof typeof glyphs | StreamlineIconName;
const streamline: Partial<Record<IconName, StreamlineIconName>> = {
  home: 'home', calendar: 'calendar', add: 'add', plus: 'add', routine: 'routine', repeat: 'routine',
  search: 'search', check: 'check', clock: 'clock', send: 'send', spark: 'spark', sparkles: 'spark',
  more: 'more', close: 'close', profile: 'profile', help: 'help', wifi: 'wifi', alert: 'alert',
  trash: 'trash', settings: 'settings', bell: 'bell',
};

// Controls supply their own labels; both icon sets are decorative.
export function Icon({ name, size = 20, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  const ready = useContext(FontReadyContext);
  const mapped = streamline[name];
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {mapped ? <StreamlineIcon name={mapped} size={size} color={color} /> : ready && <Text allowFontScaling={false} style={{ fontFamily: 'Lucide', fontSize: size, lineHeight: size,
      color, includeFontPadding: false, textAlign: 'center' }}>{glyphs[name as keyof typeof glyphs]}</Text>}
  </View>;
}
