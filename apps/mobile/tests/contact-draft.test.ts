import test from 'node:test';
import assert from 'node:assert/strict';
import type { Proposal } from '../src/proposals/client';
import { proposalDraft } from '../src/contacts/draft';

function proposal(operation: 'update' | 'delete'): Proposal {
  const target = { id: 'event-1', revision: 1, title: '공동 약속' };
  return {
    mode: 'coordination', coordinationTarget: { id: target.id, expectedRevision: 1 }, beforeItems: [target],
    reason: '외부에 공유하면 안 되는 맥락',
    changeSet: { changes: [{ changeId: 'change-1', operation, targetId: target.id, expectedRevision: 1,
      ...(operation === 'update' ? { after: { timeSlot: { startsAt: '2026-11-02T10:00:00+09:00', endsAt: '2026-11-02T11:00:00+09:00', timezone: 'Asia/Seoul' } } } : {}) }] },
  } as unknown as Proposal;
}

test('시간 대안으로 요청형 초안을 만들고 내부 이유는 포함하지 않는다', () => {
  const draft = proposalDraft(proposal('update'));
  assert.match(draft.purpose, /공동 약속/);
  assert.match(draft.messageOrCallBrief, /2026-11-02T10:00:00\+09:00/);
  assert.match(draft.messageOrCallBrief, /가능하신지 확인 부탁드립니다/);
  assert.match(draft.messageOrCallBrief, /원래 약속은 유지됩니다/);
  assert.doesNotMatch(JSON.stringify(draft), /외부에 공유하면 안 되는 맥락/);
});

test('삭제 대안은 이미 취소됐다고 주장하지 않는다', () => {
  const draft = proposalDraft(proposal('delete'));
  assert.match(draft.messageOrCallBrief, /취소하는 방안이 가능하신지/);
  assert.match(draft.messageOrCallBrief, /원래 약속은 유지됩니다/);
  assert.doesNotMatch(draft.messageOrCallBrief, /취소했습니다|취소되었습니다|수락했습니다/);
});
