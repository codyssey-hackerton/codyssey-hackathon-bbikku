import { z } from 'zod';
import { calculateTiming } from '@pikku/domain';
import type { ReadTool } from './agent.ts';
import { changeSet, compareInstants, identifier, timestamp, timezone } from './planning-schemas.ts';
import type { PlanningService } from './planning-service.ts';

export function createPlanningTools(service: PlanningService, baseline: Awaited<ReturnType<PlanningService['capture']>>): ReadTool[] {
  const scoped = (userId: string) => { if (userId !== baseline.userId) throw new Error('TOOL_SCOPE_MISMATCH'); };
  const scheduleInput = z.object({ from: timestamp, to: timestamp, timezone }).strict()
    .refine(value => timestamp.safeParse(value.from).success && timestamp.safeParse(value.to).success && compareInstants(value.from, value.to) < 0);
  const memoryInput = z.object({ keys: z.array(identifier).max(100), at: timestamp }).strict();
  const timingInput = z.object({
    appointmentStart: timestamp.nullable().optional(), preparationMinutes: z.number().finite().nonnegative().nullable().optional(),
    travelMinutes: z.number().finite().nonnegative().nullable().optional(), bufferMinutes: z.number().finite().nonnegative().nullable().optional(),
  }).strict();
  const validateInput = z.object({ changeSet }).strict();
  return [
    { name: 'read_schedule', description: '인증된 사용자의 지정 구간 일정과 미배치 작업을 읽습니다.', input: scheduleInput, async run(value, userId) {
      scoped(userId); const input = scheduleInput.parse(value);
      return { items: baseline.snapshot.items.filter(item => item.timeSlot
        ? compareInstants(item.timeSlot.startsAt, input.to) < 0 && compareInstants(input.from, item.timeSlot.endsAt) < 0
        : item.kind === 'task'), scheduleRevision: baseline.snapshot.scheduleRevision };
    } },
    { name: 'read_memory', description: '인증된 사용자의 유효한 맥락을 읽습니다. keys가 빈 배열이면 현재 스냅샷의 유효한 사실 전체를 조회합니다.', input: memoryInput, async run(value, userId) {
      scoped(userId); const input = memoryInput.parse(value); const keys = new Set(input.keys);
      const facts = baseline.snapshot.facts.filter(fact => (!keys.size || keys.has(fact.key))
        && compareInstants(fact.recordedAt, input.at) <= 0 && (!fact.validUntil || compareInstants(input.at, fact.validUntil) < 0));
      return { facts, contextRevision: baseline.snapshot.contextRevision, missingFields: [...keys].filter(key => !facts.some(fact => fact.key === key && fact.value !== null)) };
    } },
    { name: 'calculate_timing', description: '준비와 이동 시간을 계산합니다.', input: timingInput, async run(value, userId) {
      scoped(userId); const input = timingInput.parse(value);
      return calculateTiming({ appointmentStart: input.appointmentStart ?? undefined, preparationMinutes: input.preparationMinutes ?? undefined,
        travelMinutes: input.travelMinutes ?? undefined, bufferMinutes: input.bufferMinutes ?? undefined });
    } },
    { name: 'validate_changes', description: '현재 서버 일정과 맥락으로 변경안을 검증합니다.', input: validateInput, async run(value, userId) {
      scoped(userId); return service.validateTool(baseline, validateInput.parse(value).changeSet);
    } },
  ];
}
