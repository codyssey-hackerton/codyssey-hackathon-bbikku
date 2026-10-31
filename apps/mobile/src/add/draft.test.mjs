import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDraft } from './draft.ts';

test('AI draft is restricted to its form kind and valid fields', () => {
  const current = { title: '기존', category: 'personal', weekdays: ['1'] };
  const pending = { kind: 'routine', fields: { title: '제안', category: 'work', weekdays: ['2', '4'], surprise: 'x' } };
  assert.equal(reviewDraft(pending, 'event', current), null);
  assert.deepEqual(reviewDraft(pending, 'routine', current), { title: '제안', category: 'work', weekdays: ['2', '4'] });
  const invalid = { ...pending, fields: { category: 'other', weekdays: ['2', '2'], title: 'x'.repeat(2001) } };
  assert.deepEqual(reviewDraft(invalid, 'routine', current), {});
});

test('partial date and time proposals retain only known fields and valid ISO instants', () => {
  const current = { startDate: '2026-11-01', startTime: '09:00', startsAt: '2026-11-01T00:00:00Z' };
  const draft = { kind: 'event', fields: { startDate: '2026-11-02', startsAt: 'not a timestamp', unexpected: 'ignored' } };
  assert.deepEqual(reviewDraft(draft, 'event', current), { startDate: '2026-11-02' });
});

test('unchanged local fields do not suppress a changed ISO time', () => {
  const current = { startDate: '2026-11-01', startTime: '09:00', startsAt: '2026-11-01T00:00:00.000Z' };
  const draft = { kind: 'event', fields: { ...current, startsAt: '2026-11-01T01:30:00.000Z' } };
  assert.deepEqual(reviewDraft(draft, 'event', current), { startsAt: '2026-11-01T01:30:00.000Z' });
  draft.fields.startTime = '11:00';
  assert.deepEqual(reviewDraft(draft, 'event', current), { startTime: '11:00' });
});
