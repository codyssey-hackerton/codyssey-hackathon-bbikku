import { Image } from 'react-native';
import { colors } from './theme';

const icons = {
  home: require('../../assets/streamline-core/home.png'),
  calendar: require('../../assets/streamline-core/calendar.png'),
  add: require('../../assets/streamline-core/add.png'),
  routine: require('../../assets/streamline-core/routine.png'),
  search: require('../../assets/streamline-core/search.png'),
  check: require('../../assets/streamline-core/check.png'),
  clock: require('../../assets/streamline-core/clock.png'),
  send: require('../../assets/streamline-core/send.png'),
  spark: require('../../assets/streamline-core/spark.png'),
  more: require('../../assets/streamline-core/more.png'),
  close: require('../../assets/streamline-core/close.png'),
  profile: require('../../assets/streamline-core/profile.png'),
  help: require('../../assets/streamline-core/help.png'),
  wifi: require('../../assets/streamline-core/wifi.png'),
  alert: require('../../assets/streamline-core/alert.png'),
  trash: require('../../assets/streamline-core/trash.png'),
  settings: require('../../assets/streamline-core/settings.png'),
  bell: require('../../assets/streamline-core/bell.png'),
} as const;
export type StreamlineIconName = keyof typeof icons;
export function StreamlineIcon({ name, size = 20, color = colors.muted }: { name: StreamlineIconName; size?: number; color?: string }) {
  return <Image source={icons[name]} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    resizeMode="contain" style={{ width: size, height: size, tintColor: color, ...(name === 'more' ? { transform: [{ rotate: '90deg' }] } : {}) }} />;
}
