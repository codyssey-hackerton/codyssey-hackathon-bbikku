import React, { useMemo, useState } from 'react';
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
import { DateTimeFields } from '../ui/DateTimeFields';
import { addDays } from './dates';
import { compareTimestamps, isTimestamp } from './client';

const regions = [
  { value: 'Asia/Seoul', label: '한국' }, { value: 'Asia/Tokyo', label: '일본' },
  { value: 'America/New_York', label: '미국 동부' }, { value: 'America/Chicago', label: '미국 중부' },
  { value: 'America/Denver', label: '미국 산악' }, { value: 'America/Los_Angeles', label: '미국 서부' },
  { value: 'Europe/London', label: '영국 런던' },
];
function shiftDate(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const check = new Date(0); check.setUTCFullYear(year, month - 1, day);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return '';
  const next = addDays({ year, month, day }, days);
  return `${String(next.year).padStart(4, '0')}-${String(next.month).padStart(2, '0')}-${String(next.day).padStart(2, '0')}`;
}

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
    endDate: (() => { const date = localParts(item?.timeSlot?.endsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.date ?? defaultDate;
      return item?.allDay ? shiftDate(date, -1) : date; })(),
    endTime: localParts(item?.timeSlot?.endsAt ?? '', item?.timeSlot?.timezone ?? timezone)?.time ?? '',
  }));

  function update<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError('');
  }

  function field(label: string, key: 'title' | 'notes') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput accessibilityLabel={label} value={draft[key]} editable={!disabled}
          accessibilityState={{ disabled }} onChangeText={(value) => update(key, value)}
          multiline={key === 'notes'} maxLength={key === 'notes' ? 20_000 : undefined} style={styles.input} />
      </View>
    );
  }

  function updateLocal(next: typeof local, allDay = draft.allDay, zone = draft.timezone, side: 'start' | 'end' | 'both' = 'both') {
    setLocal(next);
    const endDate = allDay ? shiftDate(next.endDate, 1) : next.endDate;
    const startTime = allDay ? '00:00' : next.startTime, endTime = allDay ? '00:00' : next.endTime;
    setDraft(previous => ({ ...previous, allDay, timezone: zone,
      startsAt: side === 'end' ? previous.startsAt : startTime ? localInstant(next.startDate, startTime, zone) ?? 'invalid' : '',
      endsAt: side === 'start' ? previous.endsAt : endTime ? localInstant(endDate, endTime, zone) ?? 'invalid' : '' }));
    setError('');
  }

  function changeZone(zone: string) {
    if (draft.allDay) { updateLocal(local, true, zone); return; }
    setDraft(previous => ({ ...previous, timezone: zone,
      startsAt: !isTimestamp(previous.startsAt) && local.startTime ? localInstant(local.startDate, local.startTime, zone) ?? 'invalid' : previous.startsAt,
      endsAt: !isTimestamp(previous.endsAt) && local.endTime ? localInstant(local.endDate, local.endTime, zone) ?? 'invalid' : previous.endsAt }));
    setLocal(previous => {
      const start = localParts(draft.startsAt, zone), end = localParts(draft.endsAt, zone);
      return { ...previous, ...(start ? { startDate: start.date, startTime: start.time } : {}), ...(end ? { endDate: end.date, endTime: end.time } : {}) };
    });
    setError('');
  }

  function save() {
    if (operationGuard.hasUnresolved()) {
      setError('처리 중이거나 결과를 확인하지 못한 요청을 시작한 화면에서 확인한 뒤 저장해 주세요.');
      return;
    }
    if (draft.kind === 'task' && !item && draft.startsAt === '' && draft.endsAt === '') {
      setError('할 일의 시작과 종료를 선택해 주세요.');
      return;
    }
    let next = draft;
    if (draft.kind === 'task' && isTimestamp(draft.startsAt) && isTimestamp(draft.endsAt) &&
        (item?.kind !== 'task' || !item.timeSlot || item.durationMinutes === null || compareTimestamps(draft.startsAt, item.timeSlot.startsAt) !== 0 || compareTimestamps(draft.endsAt, item.timeSlot.endsAt) !== 0)) {
      next = { ...draft, durationMinutes: String((Date.parse(draft.endsAt) - Date.parse(draft.startsAt)) / 60_000) };
    }
    const result = scheduleFields(next, item);
    if (!result.fields) {
      setError(result.error);
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
      if (typeof fields.startDate === 'string' || typeof fields.startTime === 'string') {
        const time = previous.allDay ? '00:00' : nextLocal.startTime;
        next.startsAt = time ? localInstant(nextLocal.startDate, time, previous.timezone) ?? 'invalid' : '';
      }
      if (typeof fields.endDate === 'string' || typeof fields.endTime === 'string') {
        const time = previous.allDay ? '00:00' : nextLocal.endTime;
        const date = previous.allDay ? shiftDate(nextLocal.endDate, 1) : nextLocal.endDate;
        next.endsAt = time ? localInstant(date, time, previous.timezone) ?? 'invalid' : '';
      }
      if (!initialKind && (fields.kind === 'event' || fields.kind === 'task')) next.kind = fields.kind;
      if (fields.flexibility === 'fixed' || fields.flexibility === 'flexible') next.flexibility = fields.flexibility;
      if (fields.involvement === 'personal' || fields.involvement === 'shared') next.involvement = fields.involvement;
      if (next.kind === 'task' && (fields.completion === 'pending' || fields.completion === 'completed' || fields.completion === 'incomplete' || fields.completion === 'unknown')) next.completion = fields.completion;
      if (fields.category === '' || fields.category === 'personal' || fields.category === 'work') next.category = fields.category;
      return next;
    });
    setError('');
  }

  const visibleDraft = { title: draft.title, category: draft.category, startDate: local.startDate, endDate: local.endDate,
    ...(!draft.allDay ? { startTime: local.startTime, endTime: local.endTime } : {}) };
  const visibleProposal = useMemo(() => {
    if (!pendingDraft) return undefined;
    const fields = { ...pendingDraft.fields };
    const start = typeof fields.startsAt === 'string' ? localParts(fields.startsAt, draft.timezone) : null;
    const end = typeof fields.endsAt === 'string' ? localParts(fields.endsAt, draft.timezone) : null;
    if (start) { fields.startDate ??= start.date; if (!draft.allDay) fields.startTime ??= start.time; }
    if (end) { fields.endDate ??= end.date; if (!draft.allDay) fields.endTime ??= end.time; }
    return { ...pendingDraft, fields };
  }, [pendingDraft, draft.timezone, draft.allDay]);
  const zoneOptions = [...regions];
  if (!zoneOptions.some(option => option.value === timezone)) zoneOptions.unshift({ value: timezone, label: '기기 설정' });
  if (!zoneOptions.some(option => option.value === draft.timezone)) zoneOptions.unshift({ value: draft.timezone, label: '현재 지역' });

  return (
    <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.heading}>{draft.kind === 'task' ? (item ? '할 일 수정' : '할 일 추가') : (item ? '일정 수정' : '일정 추가')}</Text>
      <DraftReview pending={visibleProposal} identity={pendingDraft} kind={item?.kind ?? initialKind ?? 'event'} current={visibleDraft} disabled={disabled} onApply={applyDraft} onHandled={onDraftHandled} />
      {onAskDraft && <Pressable accessibilityRole="button" accessibilityLabel="AI로 작성하기" disabled={disabled} onPress={() => onAskDraft(visibleDraft)} style={[styles.secondary, disabled && styles.disabled]}><Text style={styles.secondaryText}>AI로 작성하기</Text></Pressable>}
      {!initialKind && <Choices label="종류" value={draft.kind} disabled={disabled} onChange={(value) => update('kind', value)}
        options={[{ value: 'event', label: '일정' }, { value: 'task', label: '할 일' }]} />}
      <Choices label="분류" value={draft.category} disabled={disabled} onChange={(value) => update('category', value)}
        options={[{ value: '', label: '미분류' }, { value: 'personal', label: '개인' }, { value: 'work', label: '업무' }]} />
      {field('제목', 'title')}
      <Pressable accessibilityRole="switch" accessibilityLabel="종일" accessibilityState={{ checked: draft.allDay, disabled }} disabled={disabled}
        onPress={() => updateLocal(local, !draft.allDay)} style={styles.secondary}><Text style={styles.secondaryText}>{draft.allDay ? '종일 선택됨' : '종일'}</Text></Pressable>
      <DateTimeFields label="시작 날짜" mode="date" value={local.startDate} disabled={disabled} onChange={value => updateLocal({ ...local, startDate: value }, draft.allDay, draft.timezone, 'start')} />
      {!draft.allDay && <DateTimeFields label="시작 시간" mode="time" value={local.startTime} disabled={disabled} onChange={value => updateLocal({ ...local, startTime: value }, false, draft.timezone, 'start')} />}
      <DateTimeFields label="종료 날짜" mode="date" value={local.endDate} disabled={disabled} onChange={value => updateLocal({ ...local, endDate: value }, draft.allDay, draft.timezone, 'end')} />
      {!draft.allDay && <DateTimeFields label="종료 시간" mode="time" value={local.endTime} disabled={disabled} onChange={value => updateLocal({ ...local, endTime: value }, false, draft.timezone, 'end')} />}
      {draft.kind === 'task' && item && <Pressable accessibilityRole="button" accessibilityLabel="시간 미정으로 변경" disabled={disabled} onPress={() => {
        setLocal(previous => ({ ...previous, startTime: '', endTime: '' }));
        setDraft(previous => ({ ...previous, allDay: false, startsAt: '', endsAt: '' })); setError('');
      }} style={styles.secondary}><Text style={styles.secondaryText}>시간 미정으로 변경</Text></Pressable>}
      <Choices label="국가·지역" value={draft.timezone} disabled={disabled} onChange={changeZone} options={zoneOptions} />
      {field('메모', 'notes')}
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
