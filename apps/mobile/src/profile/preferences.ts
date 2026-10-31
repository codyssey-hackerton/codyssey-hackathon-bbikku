import type { MemoryFact } from '../memory/client';

export type Goal = 'work' | 'health' | 'life';
export type Period = 'morning' | 'afternoon' | 'unknown' | null;
export type PlanningPreferences = {
  version: 1;
  goals: Goal[];
  timing: { preparationMinutes: number | null; travelEstimateMinutes: number | null; bufferMinutes: number | null };
  preferredPeriod: Period;
  onboardingStatus: 'completed' | 'skipped';
};
export const emptyPreferences = (): PlanningPreferences => ({ version: 1, goals: [],
  timing: { preparationMinutes: null, travelEstimateMinutes: null, bufferMinutes: null }, preferredPeriod: null, onboardingStatus: 'skipped' });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
const minutes = (value: unknown) => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440);
export function parsePreferences(value: unknown): PlanningPreferences | null {
  if (!object(value) || !keys(value, ['version', 'goals', 'timing', 'preferredPeriod', 'onboardingStatus']) || value.version !== 1 ||
      !Array.isArray(value.goals) || !value.goals.every(goal => goal === 'work' || goal === 'health' || goal === 'life') ||
      new Set(value.goals).size !== value.goals.length || !object(value.timing) ||
      !keys(value.timing, ['preparationMinutes', 'travelEstimateMinutes', 'bufferMinutes']) ||
      !minutes(value.timing.preparationMinutes) || !minutes(value.timing.travelEstimateMinutes) || !minutes(value.timing.bufferMinutes) ||
      ![null, 'morning', 'afternoon', 'unknown'].includes(value.preferredPeriod as Period) ||
      (value.onboardingStatus !== 'completed' && value.onboardingStatus !== 'skipped')) return null;
  return value as PlanningPreferences;
}
export function findPreferences(facts: MemoryFact[]): PlanningPreferences | null {
  const found = facts.filter(fact => fact.kind === 'preference' && fact.key === 'planning_preferences');
  if (!found.length) return null;
  if (found.length !== 1 || found[0].source.type !== 'user' || found[0].validUntil !== null) throw new Error('invalid_profile');
  const value = parsePreferences(found[0].value);
  if (!value) throw new Error('invalid_profile');
  return value;
}
export function parseMinutes(value: string): number | null | undefined {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n <= 1440 ? n : undefined;
}
