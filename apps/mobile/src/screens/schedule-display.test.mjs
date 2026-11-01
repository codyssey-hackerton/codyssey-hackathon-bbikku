import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const result = await build({ stdin: { contents: "export { dailyProgress, scheduleLayout } from './schedule-display'; export { scheduleCardModel } from '../ui/scheduleCardModel';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { dailyProgress, scheduleLayout, scheduleCardModel } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const make = (id, kind, completion, start, end, sourceRefs = []) => ({ id, revision: 1, kind, completion, title: id,
  timeSlot: start ? { startsAt: start, endsAt: end, timezone: 'UTC' } : null, durationMinutes: kind === 'task' ? 30 : null,
  deadline: null, flexibility: 'flexible', involvement: 'personal', sourceRefs });
test('progress counts only timed tasks, including a routine occurrence once', () => {
  const rows = [make('a','task','completed','2026-11-01T09:00Z','2026-11-01T10:00Z'),
    make('b','task','pending','2026-11-01T10:00Z','2026-11-01T11:00Z',[{provider:'routine'}]),
    make('event','event','completed','2026-11-01T11:00Z','2026-11-01T12:00Z'), make('undated','task','completed',null,null)];
  assert.deepEqual(dailyProgress([...rows, rows[1]]), { done: 1, total: 2, percent: 50 });
  assert.deepEqual(dailyProgress([rows[2], rows[3]]), { done: 0, total: 0, percent: null });
});
test('the same saved completion feeds both home progress and day card state', () => {
  const pending = make('task','task','pending','2026-11-01T09:00Z','2026-11-01T10:00Z');
  const completed = { ...pending, revision: 2, completion: 'completed' };
  assert.equal(dailyProgress([completed]).done, 1);
  assert.equal(scheduleCardModel(completed, Date.parse('2026-11-01T12:00Z')).state, '완료됨');
  const restored = { ...completed, revision: 3, completion: 'pending' };
  assert.equal(dailyProgress([restored]).done, 0);
  assert.equal(scheduleCardModel(restored, Date.parse('2026-11-01T12:00Z')).state, '완료');
});
test('only today stacks ended items in reverse end order and reports overlaps', () => {
  const rows = [make('old','task','pending','2026-11-01T08:00Z','2026-11-01T09:00Z'),
    make('last','task','unknown','2026-11-01T09:00Z','2026-11-01T10:00Z'),
    make('active','event','pending','2026-11-01T10:00Z','2026-11-01T12:00Z'),
    make('overlap','task','pending','2026-11-01T10:30Z','2026-11-01T11:30Z')];
  const now = Date.parse('2026-11-01T11:00Z');
  const today = scheduleLayout(rows, now, new Date(now), 'UTC');
  assert.equal(today.front.id, 'active'); assert.deepEqual(today.past.map(item => item.id), ['last','old']);
  assert.equal(today.layout.get('active').overlap, true); assert.equal(today.layout.get('old').overlap, false);
  assert.deepEqual(scheduleLayout(rows, now, new Date('2026-10-31T12:00Z'), 'UTC').past, []);
});

test('non-blocking entries never create a conflict indication', () => {
  const first = make('a','event','pending','2026-11-01T09:00Z','2026-11-01T11:00Z');
  const second = make('b','event','pending','2026-11-01T10:00Z','2026-11-01T12:00Z');
  const free = { ...first, blocksTime: false };
  const layout = scheduleLayout([free, second], Date.parse('2026-11-01T08:00Z'), new Date('2026-11-01T12:00Z'), 'UTC').layout;
  assert.equal(layout.get('a').overlap, false); assert.equal(layout.get('b').overlap, false);
  assert.equal(scheduleLayout([first, second], Date.parse('2026-11-01T08:00Z'), new Date('2026-11-01T12:00Z'), 'UTC').layout.get('b').overlap, true);
});
