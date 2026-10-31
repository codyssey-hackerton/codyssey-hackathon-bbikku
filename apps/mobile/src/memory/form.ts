import { parsePreferences } from '../profile/preferences';
import { addDays, civilDate, startOfDay } from '../schedule/dates';
import type { MemoryFact, MemoryWriteInput, WritableMemoryKind } from './client';

export interface MemoryDraft {
  kind: WritableMemoryKind;
  key: string;
  value: string;
  expiry: 'today' | 'week' | 'keep' | null;
}

const timeLabels: Record<string, string> = {
  preparationMinutes: '준비시간', travelMinutes: '이동시간', bufferMinutes: '도착 여유시간',
  preparation_minutes: '준비시간', travel_minutes: '이동시간', buffer_minutes: '도착 여유시간',
};

export function editableMemory(fact: MemoryFact): boolean {
  return fact.key !== 'planning_preferences' && !Object.hasOwn(timeLabels, fact.key) && typeof fact.value === 'string';
}

export function parseMemoryDraft(draft: MemoryDraft, contextRevision: number, now: number, timezone: string, existingUntil: string | null = null):
  | { ok: true; input: MemoryWriteInput }
  | { ok: false; message: string } {
  const key = draft.key.trim();
  if (!key) return { ok: false, message: '항목 이름을 입력해 주세요.' };
  if (key === 'planning_preferences' || Object.hasOwn(timeLabels, key)) {
    return { ok: false, message: '이 이름은 프로필에서 사용하는 항목이에요. 다른 이름을 입력해 주세요.' };
  }
  if (!draft.value.trim()) return { ok: false, message: '내용을 입력해 주세요.' };
  let validUntil: string | null = draft.kind === 'preference' ? existingUntil : null;
  if (draft.kind === 'situation') {
    if (draft.expiry === 'keep' && existingUntil !== null) validUntil = existingUntil;
    else if (draft.expiry === 'today' || draft.expiry === 'week') {
      try {
        validUntil = startOfDay(addDays(civilDate(new Date(now), timezone), draft.expiry === 'today' ? 1 : 7), timezone).toISOString();
      } catch {
        return { ok: false, message: '기기 시간대를 확인할 수 없어 기간을 정할 수 없습니다.' };
      }
    } else {
      return { ok: false, message: '상황이 유지되는 기간을 선택해 주세요.' };
    }
  }
  if (validUntil !== null && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= now)) {
    return { ok: false, message: '기존 기간이 끝났어요. 최신 목록을 확인해 주세요.' };
  }
  return { ok: true, input: { expectedContextRevision: contextRevision, kind: draft.kind, key, value: draft.value, validUntil } };
}

export function memoryDisplay(fact: MemoryFact): { title: string; lines: string[] } {
  if (fact.key === 'planning_preferences') {
    const value = fact.kind === 'preference' && fact.validUntil === null && fact.source.type === 'user' ? parsePreferences(fact.value) : null;
    if (!value) return { title: '목표와 생활 선호', lines: ['이 저장된 내용은 여기에서 표시할 수 없어요.'] };
    const goals = { work: '일·학업', health: '건강', life: '일상' };
    const period = { morning: '오전', afternoon: '오후', unknown: '아직 모름' };
    const minutes = (n: number | null) => n === null ? '설정하지 않음' : `${n}분`;
    return { title: '목표와 생활 선호', lines: [
      `목표: ${value.goals.map(goal => goals[goal]).join(', ') || '설정하지 않음'}`,
      `준비시간: ${minutes(value.timing.preparationMinutes)}`,
      `이동시간 참고값: ${minutes(value.timing.travelEstimateMinutes)}`,
      `도착 여유시간: ${minutes(value.timing.bufferMinutes)}`,
      `편한 시간대: ${value.preferredPeriod === null ? '설정하지 않음' : period[value.preferredPeriod]}`,
    ] };
  }
  const label = Object.hasOwn(timeLabels, fact.key) ? timeLabels[fact.key] : fact.key;
  if (Object.hasOwn(timeLabels, fact.key) && typeof fact.value === 'number') return { title: label, lines: [`${fact.value}분`] };
  if (typeof fact.value === 'string') return { title: label, lines: [fact.value || '(빈 내용)'] };
  if (typeof fact.value === 'number' || typeof fact.value === 'boolean') return { title: label, lines: [String(fact.value)] };
  return { title: label, lines: ['이 저장된 내용은 여기에서 표시할 수 없어요.'] };
}

/** Only user-provided preference/situation entries are presented as explicit inputs. */
export function userMemory(facts: MemoryFact[]) {
  const explicit = facts.filter((fact) => fact.source.type === 'user' &&
    (fact.kind === 'preference' || fact.kind === 'situation'));
  return {
    set: explicit.filter((fact) => fact.value !== null),
    unset: explicit.filter((fact) => fact.value === null),
  };
}
