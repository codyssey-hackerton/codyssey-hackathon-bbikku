import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { ActionButton } from '../ui/ActionButton';
import { PikkuCharacter } from '../ui/PikkuCharacter';
import { colors } from '../ui/theme';
import { Text } from '../ui/typography';

export function WelcomeScreen({ onStart, onLogin, onDeveloperSettings }: {
  onStart: () => void; onLogin: () => void; onDeveloperSettings?: () => void;
}) {
  const preview = Platform.OS === 'web' && (process.env.EXPO_PUBLIC_TEAM_PREVIEW === 'true' || process.env.EXPO_PUBLIC_PREVIEW_ONLY === 'true');
  const showDeveloperSettings = !!onDeveloperSettings && ((typeof __DEV__ !== 'undefined' && __DEV__) || preview);
  return <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
    <View style={styles.badge}><Text style={styles.badgeText}>PLAN · ACT · RECOVER</Text></View>
    <View style={styles.hero} accessible={false}>
      <View style={styles.halo}><View style={styles.mascot}><PikkuCharacter size={78} /></View></View>
    </View>
    <View style={styles.introCard}>
      <Text accessibilityRole="header" style={styles.title}>당신의 하루를,{ '\n' }더 가볍게.</Text>
      <Text style={styles.description}>일정을 이해하고, 실행 가능한 계획을 추천해요.{ '\n' }놓친 계획도 다시 이어갈 수 있도록.</Text>
    </View>
    <View style={styles.actions}>
      <ActionButton label="시작하기" size="lg" onPress={onStart} />
      <ActionButton label="로그인" size="lg" secondary onPress={onLogin} />
      {showDeveloperSettings && <ActionButton label="개발 연결 설정" variant="ghost" onPress={onDeveloperSettings} />}
    </View>
  </ScrollView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28 },
  badge: { alignSelf: 'flex-start', backgroundColor: 'rgba(105,134,252,0.12)', borderRadius: 99, paddingHorizontal: 14, paddingVertical: 8 },
  badgeText: { color: colors.primaryPressed, fontSize: 11, fontWeight: '700' },
  hero: { minHeight: 240, flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
  halo: { width: 190, height: 190, borderRadius: 95, backgroundColor: 'rgba(105,134,252,0.16)', alignItems: 'center', justifyContent: 'center' },
  mascot: { width: 128, height: 128, borderRadius: 64, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  introCard: { backgroundColor: 'rgba(255,255,255,0.88)', borderColor: colors.border, borderWidth: 1, borderRadius: 24, padding: 20 },
  title: { color: colors.text, fontSize: 32, lineHeight: 44, fontWeight: '700' },
  description: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: 20 },
  actions: { gap: 10, marginTop: 40 },
});
