import test from 'node:test';
import assert from 'node:assert/strict';
import { editableMemory, memoryDisplay, parseMemoryDraft, userMemory } from './form.ts';
import { findPreferences } from '../profile/preferences.ts';

const now = Date.parse('2026-10-31T15:00:00+09:00');
const draft = { kind: 'preference', key: ' 공부 ', value: '오전', expiry: null };
const fact = (key, value) => ({ id: key, revision: 1, kind: 'preference', key, value, source: { type: 'user', ref: 'u' }, recordedAt: '2026-10-31T00:00:00Z', validUntil: null });

test('natural language preserves revision, reserves profile keys, and rejects blank input', () => {
  assert.deepEqual(parseMemoryDraft(draft, 7, now, 'Asia/Seoul'), {
    ok: true, input: { kind: 'preference', key: '공부', value: '오전', expectedContextRevision: 7, validUntil: null },
  });
  for (const key of ['planning_preferences', 'preparationMinutes', 'travelMinutes', 'bufferMinutes', 'preparation_minutes']) {
    for (const kind of ['preference', 'situation']) assert.equal(parseMemoryDraft({ ...draft, key, kind }, 7, now, 'Asia/Seoul').ok, false);
  }
  for (const change of [{ key: ' ' }, { value: ' ' }]) assert.equal(parseMemoryDraft({ ...draft, ...change }, 2, now, 'Asia/Seoul').ok, false);
  assert.equal(parseMemoryDraft({ ...draft, value: '{"a":1}' }, 2, now, 'Asia/Seoul').input.value, '{"a":1}');
});

test('situation expiration requires a choice and uses local calendar days, including DST', () => {
  const situation = { ...draft, kind: 'situation' };
  assert.equal(parseMemoryDraft(situation, 0, now, 'Asia/Seoul').ok, false);
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'today' }, 0, now, 'Asia/Seoul').input.validUntil, '2026-10-31T15:00:00.000Z');
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'week' }, 0, now, 'Asia/Seoul').input.validUntil, '2026-11-06T15:00:00.000Z');
  const dst = Date.parse('2026-03-07T12:00:00-05:00');
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'week' }, 0, dst, 'America/New_York').input.validUntil, '2026-03-14T04:00:00.000Z');
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'today' }, 0, now, 'invalid/timezone').ok, false);
  const existing = '2026-11-03T09:00:00Z';
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'keep' }, 0, now, 'Asia/Seoul', existing).input.validUntil, existing);
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'keep' }, 0, now, 'Asia/Seoul').ok, false);
  assert.equal(parseMemoryDraft({ ...situation, expiry: 'keep' }, 0, now, 'Asia/Seoul', '2026-01-01T00:00:00Z').ok, false);
  assert.equal(parseMemoryDraft(draft, 0, now, 'Asia/Seoul', existing).input.validUntil, existing);
});

test('known profile and legacy values display without raw structured data or inferred values', () => {
  const value = { version: 1, goals: ['work', 'health'], timing: { preparationMinutes: 0, travelEstimateMinutes: null, bufferMinutes: 10 }, preferredPeriod: 'unknown', onboardingStatus: 'completed' };
  assert.deepEqual(memoryDisplay(fact('planning_preferences', value)).lines, ['목표: 일·학업, 건강', '준비시간: 0분', '이동시간 참고값: 설정하지 않음', '도착 여유시간: 10분', '편한 시간대: 아직 모름']);
  assert.deepEqual(memoryDisplay(fact('travelMinutes', 30)).lines, ['30분']);
  for (const entry of [fact('planning_preferences', { secret: 'hidden' }), fact('other', { secret: 'hidden' }), fact('other', ['hidden'])]) {
    assert.doesNotMatch(memoryDisplay(entry).lines.join(' '), /hidden|secret/);
    assert.equal(editableMemory(entry), false);
  }
  assert.equal(editableMemory(fact('planning_preferences', 'text')), false);
  assert.equal(editableMemory(fact('travelMinutes', 'text')), false);
  assert.equal(editableMemory(fact('other', 'text')), true);
});

test('profile summary rejects expiring or non-user structured preferences', () => {
  const value = { version: 1, goals: ['work'], timing: { preparationMinutes: 0, travelEstimateMinutes: null, bufferMinutes: 10 }, preferredPeriod: 'morning', onboardingStatus: 'completed' };
  const valid = fact('planning_preferences', value);
  assert.deepEqual(findPreferences([valid]), value);
  assert.match(memoryDisplay(valid).lines.join(' '), /목표: 일·학업/);
  for (const invalid of [
    { ...valid, validUntil: '2099-01-01T00:00:00Z' },
    { ...valid, source: { type: 'provider', ref: 'external' } },
    { ...valid, value: { ...value, version: 2 } },
  ]) {
    assert.throws(() => findPreferences([invalid]), /invalid_profile/);
    assert.deepEqual(memoryDisplay(invalid).lines, ['이 저장된 내용은 여기에서 표시할 수 없어요.']);
  }
});

test('only user-provided preference and situation values appear as explicit; null is unset', () => {
  const base = fact('first', '오전');
  const values = [base, { ...base, id: '2', kind: 'situation' }, { ...base, id: '3', value: null },
    { ...base, id: '4', kind: 'observation' }, { ...base, id: '5', kind: 'inference' },
    { ...base, id: '6', source: { type: 'derived', ref: 'd' } }, { ...base, id: '7', source: { type: 'provider', ref: 'p' } }];
  const result = userMemory(values);
  assert.deepEqual(result.set.map((item) => item.id), ['first', '2']);
  assert.deepEqual(result.unset.map((item) => item.id), ['3']);
});
