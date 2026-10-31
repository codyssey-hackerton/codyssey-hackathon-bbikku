import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelPort } from '../src/agent.ts';
import { buildApp } from '../src/app.ts';

const sessions = { async resolve(token: string) { return token === 'test' ? { userId: 'user' } : null; } };
const headers = (key: string) => ({ authorization: 'Bearer test', 'idempotency-key': key });
const task = { kind: 'task', title: '공부', timeSlot: null, durationMinutes: 30, deadline: null, flexibility: 'flexible', involvement: 'personal', completion: 'pending' };

for (const readSnapshot of [true, false]) {
  test(readSnapshot ? 'a reply based on an outdated read is rejected' : 'a reply without reads is not blocked by an unrelated update', async t => {
    let start!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const model: ModelPort = { async decide(input) {
      if (readSnapshot && !input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: {
        from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', timezone: 'UTC',
      } };
      start(); await gate; return { kind: 'answer', text: readSnapshot ? '일정이 없습니다.' : '천만에요.' };
    } };
    const app = buildApp({ sessions, model, clock: () => new Date('2026-10-31T12:00:00Z') });
    t.after(() => { release(); return app.close(); });
    const pending = app.inject({ method: 'POST', url: '/v1/chat', headers: headers('chat'), payload: {
      requestId: 'chat', conversationId: null, message: '확인', timezone: 'UTC',
    } }).then(response => response);
    await started;
    const write = await app.inject({ method: 'POST', url: '/v1/schedule/commands', headers: headers('write'), payload: {
      requestId: 'write', expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'new', operation: 'create', after: task }] },
    } });
    assert.equal(write.statusCode, 200, write.body);
    release();
    const response = await pending;
    assert.equal(response.statusCode, 200, response.body);
    if (readSnapshot) {
      assert.equal(response.json().data.result.kind, 'failure');
      assert.equal(response.json().data.result.code, 'stale_snapshot');
      assert.equal(response.json().data.result.retryable, true);
    } else assert.deepEqual(response.json().data.result, { kind: 'reply', message: '천만에요.' });
  });
}
