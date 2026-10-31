import type { ScheduleItem } from '@pikku/domain';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { ScheduleStatusButton } from './ScheduleStatusButton';
import { scheduleCardModel, scheduleTimeLabel } from './scheduleCardModel';
import { colors } from './theme';
import { Text } from './typography';

export function ScheduleCard({ item, timezone, now = Date.now(), variant = 'list', disabled = false, onPress, onStatus, onMore }: {
  item: ScheduleItem; timezone: string; now?: number; variant?: 'list' | 'timeline'; disabled?: boolean;
  onPress?: () => void; onStatus?: () => void; onMore?: () => void;
}) {
  const state = scheduleCardModel(item, now);
  const inRange = variant === 'timeline' && state.active;
  const recordedActive = inRange && !state.event && item.completion === 'completed';
  const active = inRange && !recordedActive;
  const stripe = state.routine ? colors.routine : state.event ? colors.schedule : colors.primary;
  const time = scheduleTimeLabel(item, timezone);
  const phase = state.active && !state.event && item.completion === 'incomplete' ? '진행 중 · 미완료' : state.phase;
  return <View style={[styles.card, active && styles.active, recordedActive && styles.recordedActive]}>
    {active && <Image source={require('./assets/timeline-active.png')} pointerEvents="none" accessible={false} resizeMode="stretch" style={styles.gradient} />}
    <View style={[styles.stripe, { backgroundColor: active ? 'rgba(255,255,255,0.75)' : recordedActive ? '#8CA0EC' : stripe }]} />
    <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${item.title} · ${time}${item.location ? ` · 장소 ${item.location}` : ''} · ${state.type} · ${state.state}`}
      accessibilityState={onPress ? { disabled } : undefined} disabled={disabled || !onPress} onPress={onPress}
      style={({ pressed }) => [styles.body, pressed && styles.pressed]}>
      <Text numberOfLines={2} style={[styles.title, active && styles.activeText]}>{item.title}</Text>
      {!!item.location && <Text numberOfLines={2} style={[styles.time, active && styles.activeText]}>장소: {item.location}</Text>}
      {variant === 'list' && <Text numberOfLines={2} style={[styles.time, active && styles.activeText]}>{time}</Text>}
      <Text numberOfLines={2} style={[styles.meta, active && styles.activeText]}>
        {state.type}{item.category === 'work' ? ' · 업무' : item.category === 'personal' ? ' · 개인' : ''}{state.recorded && !state.active ? '' : ` · ${phase}`}
      </Text>
    </Pressable>
    <View style={styles.actions}>
      <ScheduleStatusButton label={state.state} accessibilityLabel={`${item.title} ${state.state}`}
        selected={state.selected} absent={state.absent} disabled={disabled || !onStatus} onPress={onStatus ?? (() => {})} />
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 더보기`} accessibilityState={{ disabled: disabled || !onMore }}
        disabled={disabled || !onMore} onPress={onMore} style={({ pressed }) => [styles.more, pressed && styles.pressed, (disabled || !onMore) && styles.disabled]}>
        <Icon name="more" size={20} color={active ? '#FFFFFF' : '#8390A3'} />
      </Pressable>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { minHeight: 62, paddingVertical: 5, paddingLeft: 10, paddingRight: 7, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.surface, borderRadius: 13, shadowColor: '#71829B', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  active: { backgroundColor: colors.primaryPressed },
  recordedActive: { backgroundColor: '#E9EDFF' },
  gradient: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%', borderRadius: 13 },
  stripe: { width: 5, height: 34, borderRadius: 8 },
  body: { flex: 1, minWidth: 0, justifyContent: 'center', minHeight: 44 },
  title: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  time: { marginTop: 2, color: colors.muted, fontSize: 12, lineHeight: 16 },
  meta: { marginTop: 3, color: colors.muted, fontSize: 10, lineHeight: 14 },
  activeText: { color: '#FFFFFF' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});
