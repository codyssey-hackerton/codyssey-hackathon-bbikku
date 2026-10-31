import { isJsonValue, isOffsetTimestamp } from './client';
import type { MemoryFact, MemoryWriteInput, WritableMemoryKind } from './client';

export interface MemoryDraft {
  kind: WritableMemoryKind;
  key: string;
  value: string;
  valueMode: 'text' | 'json';
  validUntil: string;
}

export function parseMemoryDraft(draft: MemoryDraft, contextRevision: number, now: number):
  | { ok: true; input: MemoryWriteInput }
  | { ok: false; message: string } {
  const key = draft.key.trim();
  if (!key) return { ok: false, message: '항목 이름을 입력해 주세요.' };
  if (!draft.value.trim()) return { ok: false, message: '값을 입력해 주세요. 미설정은 JSON의 null로 입력할 수 있습니다.' };

  let value: unknown = draft.value;
  if (draft.valueMode === 'json') {
    try {
      value = JSON.parse(draft.value) as unknown;
    } catch {
      return { ok: false, message: '올바른 JSON 값을 입력해 주세요.' };
    }
  }
  if (!isJsonValue(value)) return { ok: false, message: 'JSON에 표현할 수 있는 값을 입력해 주세요.' };

  const validUntil = draft.validUntil.trim() || null;
  if (draft.kind === 'situation' && validUntil === null) {
    return { ok: false, message: '일시 상황에는 만료 시각이 필요합니다.' };
  }
  if (validUntil !== null && !isOffsetTimestamp(validUntil)) {
    return { ok: false, message: '만료 시각은 2026-11-01T18:00:00+09:00처럼 오프셋을 포함해 입력해 주세요.' };
  }
  if (validUntil !== null && Date.parse(validUntil) <= now) {
    return { ok: false, message: '만료 시각은 현재보다 나중이어야 합니다.' };
  }
  return { ok: true, input: { expectedContextRevision: contextRevision, kind: draft.kind, key, value, validUntil } };
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
