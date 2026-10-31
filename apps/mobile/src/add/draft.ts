import type { FormDraft } from '../chat/client';
import { isTimestamp } from '../schedule/client';

const choices: Record<string, string[]> = {
  kind: ['event', 'task'], flexibility: ['fixed', 'flexible'], involvement: ['personal', 'shared'],
  completion: ['pending', 'completed', 'incomplete', 'unknown'], category: ['', 'personal', 'work'],
};

export function reviewDraft(pending: FormDraft | undefined,
  kind: FormDraft['kind'], current: Record<string, string | string[]>): Record<string, string | string[]> | null {
  if (!pending || pending.kind !== kind) return null;
  const accepted = Object.fromEntries(Object.entries(pending.fields).filter(([field, value]) => {
    const previous = current[field];
    if (JSON.stringify(previous) === JSON.stringify(value)) return false;
    if (typeof previous === 'string') return typeof value === 'string' && value.length <= 2000 &&
      (!choices[field] || choices[field].includes(value)) && (!['startsAt', 'endsAt'].includes(field) || value === '' || isTimestamp(value));
    return Array.isArray(previous) && Array.isArray(value) && value.length <= 7 &&
      value.every(day => typeof day === 'string' && /^[1-7]$/.test(day)) && new Set(value).size === value.length;
  }));
  if ('startDate' in accepted || 'startTime' in accepted) delete accepted.startsAt;
  if ('endDate' in accepted || 'endTime' in accepted) delete accepted.endsAt;
  return accepted;
}
