import type { Proposal } from '../proposals/client';

export function proposalDraft(proposal: Proposal): { purpose: string; messageOrCallBrief: string } {
  const targetId = proposal.coordinationTarget?.id;
  const original = proposal.beforeItems.find((item) => item.id === targetId);
  const title = original?.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || '공동 일정';
  const change = proposal.changeSet.changes.find((item) => item.operation !== 'create' && item.targetId === targetId);
  const alternative = change?.operation === 'delete' ? '기존 약속을 취소하는 방안' :
    change?.operation === 'update' && change.after.timeSlot
      ? `${change.after.timeSlot.startsAt} ~ ${change.after.timeSlot.endsAt} (${change.after.timeSlot.timezone})로 변경하는 방안`
      : '제안된 일정 조정 방안';
  return {
    purpose: `${title} 일정 조정 가능 여부`,
    messageOrCallBrief: `안녕하세요.\n\n“${title}”과 관련하여 ${alternative}이 가능하신지 확인 부탁드립니다.\n답변을 확인하기 전까지 원래 약속은 유지됩니다.\n\n감사합니다.`,
  };
}
