import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ScheduleFields, ScheduleItem } from './client';
import { scheduleDraft, scheduleFields } from './form';
import type { ScheduleDraft } from './form';

type Props = {
  item: ScheduleItem | null;
  timezone: string;
  disabled: boolean;
  cancelDisabled: boolean;
  onCancel: () => void;
  onSave: (fields: ScheduleFields) => void;
};

function Choices<T extends string>({
  label, value, options, disabled, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
        {options.map((option) => {
          const unavailable = disabled || !!option.disabled;
          const selected = value === option.value;
          return (
            <Pressable key={option.value} accessibilityRole="radio"
              accessibilityLabel={`${label}: ${option.label}`}
              accessibilityState={{ checked: selected, disabled: unavailable }}
              disabled={unavailable} onPress={() => onChange(option.value)}
              style={[styles.choice, selected && styles.selectedChoice, unavailable && styles.disabled]}>
              <Text style={[styles.choiceText, selected && styles.selectedChoiceText]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function ScheduleForm({ item, timezone, disabled, cancelDisabled, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState(() => scheduleDraft(item, timezone));
  const [error, setError] = useState('');

  function update<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError('');
  }

  function field(label: string, key: 'title' | 'startsAt' | 'endsAt' | 'timezone' | 'durationMinutes' | 'deadline', placeholder?: string) {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput accessibilityLabel={label} value={draft[key]} editable={!disabled}
          accessibilityState={{ disabled }} onChangeText={(value) => update(key, value)}
          placeholder={placeholder} autoCapitalize="none" autoCorrect={false}
          keyboardType={key === 'durationMinutes' ? 'decimal-pad' : 'default'} style={styles.input} />
      </View>
    );
  }

  function save() {
    const result = scheduleFields(draft, item);
    if (!result.fields) {
      setError(result.error);
      return;
    }
    setError('');
    onSave(result.fields);
  }

  return (
    <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.heading}>{item ? '일정 수정' : '일정 또는 할 일 추가'}</Text>
      <Text style={styles.hint}>아래의 모든 필드가 저장됩니다. 비워 둔 선택 항목은 미설정으로 저장됩니다.</Text>
      <Choices label="종류" value={draft.kind} disabled={disabled} onChange={(value) => update('kind', value)}
        options={[{ value: 'event', label: '일정' }, { value: 'task', label: '할 일' }]} />
      {field('제목', 'title')}
      {field('시작 시각', 'startsAt', '2026-10-31T09:00:00+09:00')}
      {field('종료 시각', 'endsAt', '2026-10-31T10:00:00+09:00')}
      {field('시간대 (IANA)', 'timezone', 'Asia/Seoul')}
      <Text style={styles.hint}>시각에는 Z 또는 +09:00 같은 오프셋이 필요합니다. 할 일의 시작과 종료를 모두 비우면 미배치이며 시간대도 저장되지 않습니다.</Text>
      {field('소요시간 (분)', 'durationMinutes', '예: 30')}
      {field('마감 시각', 'deadline', '2026-10-31T18:00:00+09:00')}
      <Choices label="시간 유연성" value={draft.flexibility} disabled={disabled} onChange={(value) => update('flexibility', value)}
        options={[{ value: 'fixed', label: '고정' }, { value: 'flexible', label: '유동' }]} />
      <Choices label="참여" value={draft.involvement} disabled={disabled} onChange={(value) => update('involvement', value)}
        options={[{ value: 'personal', label: '개인', disabled: item?.involvement === 'shared' }, { value: 'shared', label: '공동' }]} />
      {item?.involvement === 'shared' && <Text style={styles.hint}>기존 공동 일정은 개인으로 바꿀 수 없습니다. 시간 변경은 상대방과의 조정이 필요할 수 있습니다.</Text>}
      <Choices label="완료 상태" value={draft.completion} disabled={disabled} onChange={(value) => update('completion', value)}
        options={[{ value: 'pending', label: '대기' }, { value: 'completed', label: '완료' },
          { value: 'incomplete', label: '미완료' }, { value: 'unknown', label: '미확인' }]} />
      {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={save}
          style={[styles.primary, disabled && styles.disabled]}><Text style={styles.primaryText}>저장</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: cancelDisabled }} disabled={cancelDisabled} onPress={onCancel}
          style={[styles.secondary, cancelDisabled && styles.disabled]}><Text style={styles.secondaryText}>편집 취소</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: 20, padding: 14, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, gap: 12 },
  heading: { color: '#172033', fontSize: 18, fontWeight: '700' },
  field: { gap: 5 },
  label: { color: '#172033', fontSize: 15, fontWeight: '600' },
  input: { minHeight: 44, borderWidth: 1, borderColor: '#94a3b8', borderRadius: 6, paddingHorizontal: 10, color: '#172033' },
  hint: { color: '#475569', fontSize: 14, lineHeight: 20 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: '#94a3b8' },
  selectedChoice: { backgroundColor: '#1d4ed8', borderColor: '#1d4ed8' },
  choiceText: { color: '#172033' },
  selectedChoiceText: { color: '#ffffff', fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 6, backgroundColor: '#1d4ed8' },
  primaryText: { color: '#ffffff', fontWeight: '700' },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 6, backgroundColor: '#e2e8f0' },
  secondaryText: { color: '#172033', fontWeight: '700' },
  disabled: { opacity: 0.5 },
  error: { color: '#a01818', fontSize: 14, lineHeight: 20 },
});
