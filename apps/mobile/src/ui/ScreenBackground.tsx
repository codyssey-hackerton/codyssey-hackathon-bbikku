import type { ReactNode } from 'react';
import { Image, StyleSheet, View } from 'react-native';

const backgrounds = {
  home: require('./assets/home-background.png'),
  ai: require('./assets/ai-background.png'),
} as const;
export function ScreenBackground({ variant = 'home', children }: { variant?: 'home' | 'ai'; children: ReactNode }) {
  return <View style={styles.container}>
    <Image source={backgrounds[variant]} pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" resizeMode="stretch" style={styles.image} />
    {children}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  image: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
});
