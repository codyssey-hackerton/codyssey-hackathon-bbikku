import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../ui/typography';
import { colors } from '../ui/theme';
import type { ScheduleFields, ScheduleItem } from './client';
import { scheduleDraft, scheduleFields } from './form';
import type { ScheduleDraft } from './form';
import { DraftReview } from '../add/DraftReview';
import type { FormDraft } from '../chat/client';
import { localInstant, localParts } from '../add/local-time';
import { operationGuard } from '../api/operationGuard';

type Props = {
  item: ScheduleItem | null;
  timezone: string;
  disabled: boolean;
  cancelDisabled: boolean;
  onCancel: () => void;
  onSave: (fields: ScheduleFields) => void;
  initialKind?: 'event' | 'task';
  defaultDate?: string;
  onAskDraft?: (fields: Record<string, string | string[]>) => void;
  pendingDraft?: FormDraft; onDraftHandled?: () => void;
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
              aria-checked={selected}
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

export function ScheduleForm({ item, timezone, disabled, cancelDisabled, onCancel, onSave, initialKind, defaultDate = '', onAskDraft, pendingDraft, onDraftHandled }: Props) {
  const [draft, setDraft] = useState(() => ({ ...scheduleDraft(item, timezone), kind: item?.kind ?? initialKind ?? 'event' }));
  const [error, setError] = useState('');
  const [local, setLocal] = useState(() => ({
    startDate: localParts(item?.timeSlot?.startsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.date ?? defaultDate,
    startTime: localParts(item?.timeSlot?.startsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.time ?? '',
    endDate: localParts(item?.timeSlot?.endsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.date ?? defaultDate,
    endTime: localParts(item?.timeSlot?.endsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.time ?? '',
  }));

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

  function localField(label: string, key: keyof typeof local, placeholder: string) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={local[key]} editable={!disabled} accessibilityState={{ disabled }}
        placeholder={placeholder} autoCapitalize="none" autoCorrect={false} style={styles.input}
        onChangeText={value => {
          const next = { ...local, [key]: value };
          setLocal(next);
          const start = key === 'startDate' || key === 'startTime';
          const date = start ? next.startDate : next.endDate;
          const time = start ? next.startTime : next.endTime;
          update(start ? 'startsAt' : 'endsAt', time ? localInstant(date, time, draft.timezone) ?? `${date} ${time}` : '');
        }} /></View>;
  }

  function save() {
    if (operationGuard.hasUnresolved()) {
      setError('처리 중이거나 결과를 확인하지 못한 요청을 시작한 화면에서 확인한 뒤 저장해 주세요.');
      return;
    }
    const result = scheduleFields(draft, item);
    if (!result.fields) {
      setError(initialKind && result.error.includes('ISO 8601') ? '시작과 종료 날짜·시간을 확인해 주세요. 해당 시간대에서 존재하지 않거나 중복된 시각은 사용할 수 없습니다.' : result.error);
      return;
    }
    setError('');
    onSave(result.fields);
  }

  function applyDraft(fields: Record<string, string | string[]>) {
    const start = typeof fields.startsAt === 'string' ? localParts(fields.startsAt, draft.timezone) : null;
    const end = typeof fields.endsAt === 'string' ? localParts(fields.endsAt, draft.timezone) : null;
    const nextLocal = { ...local,
      ...(start ? { startDate: start.date, startTime: start.time } : fields.startsAt === '' ? { startTime: '' } : {}),
      ...(end ? { endDate: end.date, endTime: end.time } : fields.endsAt === '' ? { endTime: '' } : {}) };
    for (const key of ['startDate', 'startTime', 'endDate', 'endTime'] as const) if (typeof fields[key] === 'string') nextLocal[key] = fields[key];
    setLocal(nextLocal);
    setDraft(previous => {
      const next = { ...previous };
      for (const key of ['title', 'startsAt', 'endsAt', 'timezone', 'durationMinutes', 'deadline'] as const) if (typeof fields[key] === 'string') next[key] = fields[key];
      if (typeof fields.startDate === 'string' || typeof fields.startTime === 'string') next.startsAt = nextLocal.startTime ? localInstant(nextLocal.startDate, nextLocal.startTime, previous.timezone) ?? `${nextLocal.startDate} ${nextLocal.startTime}` : '';
      if (typeof fields.endDate === 'string' || typeof fields.endTime === 'string') next.endsAt = nextLocal.endTime ? localInstant(nextLocal.endDate, nextLocal.endTime, previous.timezone) ?? `${nextLocal.endDate} ${nextLocal.endTime}` : '';
      if (!initialKind && (fields.kind === 'event' || fields.kind === 'task')) next.kind = fields.kind;
      if (fields.flexibility === 'fixed' || fields.flexibility === 'flexible') next.flexibility = fields.flexibility;
      if (fields.involvement === 'personal' || fields.involvement === 'shared') next.involvement = fields.involvement;
      if (next.kind === 'task' && (fields.completion === 'pending' || fields.completion === 'completed' || fields.completion === 'incomplete' || fields.completion === 'unknown')) next.completion = fields.completion;
      if (fields.category === '' || fields.category === 'personal' || fields.category === 'work') next.category = fields.category;
      return next;
    });
    setError('');
  }

  return (
    <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.heading}>{draft.kind === 'task' ? (item ? '할 일 수정' : '할 일 추가') : (item ? '일정 수정' : '일정 추가')}</Text>
      <Text style={styles.hint}>아래의 모든 필드가 저장됩니다. 비워 둔 선택 항목은 미설정으로 저장됩니다.</Text>
      <DraftReview pending={pendingDraft} kind={item?.kind ?? initialKind ?? 'event'} current={{ ...Object.fromEntries(Object.entries(draft).filter(([key]) =>
        !(initialKind && (key === 'kind' || key === 'timezone')) && !(draft.kind === 'event' && key === 'completion'))), ...(initialKind ? local : {}) }} disabled={disabled} onApply={applyDraft} onHandled={onDraftHandled} />
      {onAskDraft && <Pressable accessibilityRole="button" accessibilityLabel="AI로 작성하기" disabled={disabled} onPress={() => onAskDraft({ ...Object.fromEntries(Object.entries(draft).filter(([key]) => draft.kind !== 'event' || key !== 'completion')), ...(initialKind ? local : {}) })} style={[styles.secondary, disabled && styles.disabled]}><Text style={styles.secondaryText}>AI로 작성하기</Text></Pressable>}
      {!initialKind && <Choices label="종류" value={draft.kind} disabled={disabled} onChange={(value) => update('kind', value)}
        options={[{ value: 'event', label: '일정' }, { value: 'task', label: '할 일' }]} />}
      <Choices label="분류" value={draft.category} disabled={disabled} onChange={(value) => update('category', value)}
        options={[{ value: '', label: '미분류' }, { value: 'personal', label: '개인' }, { value: 'work', label: '업무' }]} />
      {field('제목', 'title')}
      {initialKind ? <>
        {localField('시작 날짜', 'startDate', 'YYYY-MM-DD')}
        {localField('시작 시간', 'startTime', 'HH:mm')}
        {localField('종료 날짜', 'endDate', 'YYYY-MM-DD')}
        {localField('종료 시간', 'endTime', 'HH:mm')}
        <Text style={styles.hint}>시간대: {draft.timezone}. 시간대 변경으로 존재하지 않거나 두 번 나타나는 시각은 사용할 수 없습니다.</Text>
      </> : <>
      {field('시작 시각', 'startsAt', '2026-10-31T09:00:00+09:00')}
      {field('종료 시각', 'endsAt', '2026-10-31T10:00:00+09:00')}
      {field('시간대 (IANA)', 'timezone', 'Asia/Seoul')}
      <Text style={styles.hint}>시각에는 Z 또는 +09:00 같은 오프셋이 필요합니다. 할 일의 시작과 종료를 모두 비우면 미배치이며 시간대도 저장되지 않습니다.</Text>
      </>}
      {field('소요시간 (분)', 'durationMinutes', '예: 30')}
      {field('마감 시각', 'deadline', '2026-10-31T18:00:00+09:00')}
      <Choices label="시간 유연성" value={draft.flexibility} disabled={disabled} onChange={(value) => update('flexibility', value)}
        options={[{ value: 'fixed', label: '고정' }, { value: 'flexible', label: '유동' }]} />
      <Choices label="참여" value={draft.involvement} disabled={disabled} onChange={(value) => update('involvement', value)}
        options={[{ value: 'personal', label: '개인', disabled: item?.involvement === 'shared' }, { value: 'shared', label: '공동' }]} />
      {item?.involvement === 'shared' && <Text style={styles.hint}>기존 공동 일정은 개인으로 바꿀 수 없습니다. 시간 변경은 상대방과의 조정이 필요할 수 있습니다.</Text>}
      {draft.kind === 'task' && <Choices label="완료 상태" value={draft.completion} disabled={disabled} onChange={(value) => update('completion', value)}
        options={[{ value: 'pending', label: '대기' }, { value: 'completed', label: '완료' },
          { value: 'incomplete', label: '미완료' }, { value: 'unknown', label: '미확인' }]} />}
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
  form: { marginTop: 20, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 14, gap: 12 },
  heading: { color: colors.text, fontSize: 18, fontWeight: '700' },
  field: { gap: 5 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  input: { minHeight: 44, borderWidth: 1, borderColor: '#94a3b8', borderRadius: 12, paddingHorizontal: 10, color: colors.text },
  hint: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: '#94a3b8' },
  selectedChoice: { backgroundColor: colors.primaryPressed, borderColor: '#1d4ed8' },
  choiceText: { color: colors.text },
  selectedChoiceText: { color: '#ffffff', fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.primaryPressed },
  primaryText: { color: '#ffffff', fontWeight: '700' },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.primarySoft },
  secondaryText: { color: colors.text, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  error: { color: '#a01818', fontSize: 14, lineHeight: 20 },
});
