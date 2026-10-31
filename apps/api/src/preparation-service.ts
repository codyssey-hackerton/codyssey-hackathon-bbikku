import { calculateTiming, type AgentResult, type Change } from '@pikku/domain';
import { z } from 'zod';
import { identifier, timezone } from './planning-schemas.ts';
import { PlanningError, PlanningService } from './planning-service.ts';

const minutes = z.number().finite().nonnegative().refine(value => Number.isSafeInteger(value * 60_000));
const preparationInput = z.object({ targetId: identifier, expectedTargetRevision: z.number().int().min(1),
  expectedScheduleRevision: z.number().int().min(0), timezone, preparationMinutes: minutes, travelMinutes: minutes, bufferMinutes: minutes });
export type PreparationInput = z.infer<typeof preparationInput>;

export async function createPreparationProposal(planning: PlanningService, userId: string, input: PreparationInput): Promise<AgentResult> {
  const parsed = preparationInput.safeParse(input);
  if (!parsed.success) throw new PlanningError(400, 'invalid_request', '준비계획 입력을 확인해 주세요.');
  const value = parsed.data;
  if (value.preparationMinutes === 0 && value.travelMinutes === 0 && value.bufferMinutes === 0) {
    throw new PlanningError(400, 'no_effective_change', '준비·이동·여유 시간 중 하나 이상이 필요합니다.');
  }
  const baseline = await planning.capture(userId, value.timezone);
  if (baseline.snapshot.scheduleRevision !== value.expectedScheduleRevision) {
    throw new PlanningError(409, 'stale_proposal', '일정이 변경되어 다시 확인해야 합니다.');
  }
  const target = baseline.snapshot.items.find(item => item.id === value.targetId);
  if (!target) throw new PlanningError(404, 'not_found', '대상 일정을 찾을 수 없습니다.');
  if (target.revision !== value.expectedTargetRevision) throw new PlanningError(409, 'stale_proposal', '대상 일정이 변경되었습니다.');
  if (target.kind !== 'event' || !target.timeSlot || target.completion === 'completed') {
    throw new PlanningError(409, 'conflict', '완료되지 않은 시간 지정 일정이 필요합니다.');
  }
  const appointmentStart = target.timeSlot.startsAt;
  const timing = calculateTiming({ appointmentStart, preparationMinutes: value.preparationMinutes,
    travelMinutes: value.travelMinutes, bufferMinutes: value.bufferMinutes });
  const arrival = calculateTiming({ appointmentStart, preparationMinutes: 0, travelMinutes: 0, bufferMinutes: value.bufferMinutes });
  if (!timing.ready || !arrival.ready) throw new PlanningError(400, 'invalid_request', '시간을 계산할 수 없습니다.');
  const segments = [
    { id: 'preparation', title: '준비', duration: value.preparationMinutes, startsAt: timing.preparationStartAt, endsAt: timing.departureAt },
    { id: 'travel', title: '이동', duration: value.travelMinutes, startsAt: timing.departureAt, endsAt: arrival.departureAt },
    { id: 'buffer', title: '도착 여유', duration: value.bufferMinutes, startsAt: arrival.departureAt, endsAt: appointmentStart },
  ];
  const changes: Change[] = segments.filter(segment => segment.duration > 0).map(segment => ({
    changeId: segment.id, operation: 'create', after: { kind: 'task', title: segment.title,
      timeSlot: { startsAt: segment.startsAt, endsAt: segment.endsAt, timezone: value.timezone }, durationMinutes: segment.duration,
      deadline: appointmentStart, flexibility: 'flexible', involvement: 'personal', completion: 'pending' },
  }));
  return planning.saveProposal(baseline, { kind: 'proposal', changeSet: { changes, timingConstraints: [{
    appointment: { kind: 'existing', id: target.id, expectedRevision: target.revision },
    preparationMinutes: value.preparationMinutes, travelMinutes: value.travelMinutes, bufferMinutes: value.bufferMinutes,
    segments: { preparation: value.preparationMinutes > 0 ? 'preparation' : null, travel: value.travelMinutes > 0 ? 'travel' : null, buffer: value.bufferMinutes > 0 ? 'buffer' : null },
  }] }, evidenceRefs: [target.id],
    reason: `사용자 입력: 준비 ${value.preparationMinutes}분, 이동 ${value.travelMinutes}분, 도착 여유 ${value.bufferMinutes}분. 계산: 준비 ${timing.preparationStartAt}, 출발 ${timing.departureAt}, 도착 ${arrival.departureAt}, 일정 시작 ${appointmentStart}.` });
}
