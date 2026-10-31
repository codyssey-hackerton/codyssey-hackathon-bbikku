import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineClient } from './client.ts';

test('routine categories accept legacy and personal/work values but reject malformed responses', async () => {
  const routine = { id: 'r1', revision: 1, title: '운동', weekdays: [1], timezone: 'Asia/Seoul', startDate: '2026-11-01', localTime: '09:00', durationMinutes: 30, active: true };
  let response;
  const client = createRoutineClient({ get: async () => response, post: async () => response });
  for (const category of [undefined, null, 'personal', 'work']) {
    response = { routines: [{ ...routine, ...(category === undefined ? {} : { category }) }] };
    assert.equal((await client.list())[0].category, category);
  }
  response = { routines: [{ ...routine, category: 'other' }] };
  await assert.rejects(client.list(), error => error.code === 'invalid_response');
});
