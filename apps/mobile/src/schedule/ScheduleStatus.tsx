import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { scheduleErrorMessage } from './useSchedule';

export function ScheduleLoading() {
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" />
      <Text style={styles.text}>일정을 불러오는 중입니다.</Text>
    </View>
  );
}

export function ScheduleError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <View style={styles.errorBox}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
        {scheduleErrorMessage(error)}
      </Text>
      <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}>
        <Text style={styles.retryText}>다시 시도</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 20 },
  text: { color: colors.muted, fontSize: 15 },
  errorBox: { alignItems: 'flex-start', gap: 8, paddingVertical: 20 },
  error: { color: '#a01818', fontSize: 15, lineHeight: 22 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.primarySoft },
  retryText: { color: colors.text, fontWeight: '700' },
});
