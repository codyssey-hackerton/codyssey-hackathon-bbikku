import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryDraft, userMemory } from './form.ts';

const now = Date.parse('2026-10-31T15:00:00+09:00');
const draft = { kind: 'preference', key: ' 공부 ', value: '오전', valueMode: 'text', validUntil: '' };

test('explicit text and structured JSON keep the server revision and null has a distinct meaning', () => {
  assert.deepEqual(parseMemoryDraft(draft, 7, now), {
    ok: true, input: { kind: 'preference', key: '공부', value: '오전', expectedContextRevision: 7, validUntil: null },
  });
  const structured = parseMemoryDraft({ ...draft, valueMode: 'json', value: '{"a":[1,true,null]}' }, 8, now);
  assert.deepEqual(structured.input.value, { a: [1, true, null] });
  assert.equal(parseMemoryDraft({ ...draft, valueMode: 'json', value: 'null' }, 8, now).input.value, null);
  assert.equal(parseMemoryDraft({ ...draft, value: 'null' }, 8, now).input.value, 'null');
});

test('situation requires a valid future timestamp with offset; preference may omit it', () => {
  for (const validUntil of ['', '2026-11-01T18:00:00', '2026-02-31T18:00:00+09:00', '2026-10-31T15:00:00+09:00']) {
    assert.equal(parseMemoryDraft({ ...draft, kind: 'situation', validUntil }, 0, now).ok, false, validUntil);
  }
  const result = parseMemoryDraft({ ...draft, kind: 'situation', validUntil: '2026-11-01T18:00:00+09:00' }, 0, now);
  assert.equal(result.ok, true);
  assert.equal(result.input.validUntil, '2026-11-01T18:00:00+09:00');
  assert.equal(parseMemoryDraft(draft, 0, now).input.validUntil, null);
});

test('blank values, malformed JSON and non-finite JSON numbers are rejected', () => {
  for (const change of [{ key: ' ' }, { value: ' ' }, { valueMode: 'json', value: '{' }, { valueMode: 'json', value: '1e999' }]) {
    assert.equal(parseMemoryDraft({ ...draft, ...change }, 2, now).ok, false);
  }
});

test('only user-provided preference and situation values appear as explicit; null is unset', () => {
  const base = { id: '1', kind: 'preference', value: '오전', source: { type: 'user', ref: 'u' } };
  const values = [
    base,
    { ...base, id: '2', kind: 'situation' },
    { ...base, id: '3', value: null },
    { ...base, id: '4', kind: 'observation' },
    { ...base, id: '5', kind: 'inference' },
    { ...base, id: '6', source: { type: 'derived', ref: 'd' } },
    { ...base, id: '7', source: { type: 'provider', ref: 'p' } },
  ];
  const result = userMemory(values);
  assert.deepEqual(result.set.map((item) => item.id), ['1', '2']);
  assert.deepEqual(result.unset.map((item) => item.id), ['3']);
});
