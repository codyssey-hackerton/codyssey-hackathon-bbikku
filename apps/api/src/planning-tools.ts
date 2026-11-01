import { z } from 'zod';
import { calculateTiming } from '@pikku/domain';
import type { ReadTool } from './agent.ts';
import { changeSet, compareInstants, identifier, timestamp, timezone } from './planning-schemas.ts';
import { findFreeSlots, freeSlotsInput } from './free-slots.ts';
import type { PlanningService } from './planning-service.ts';

export function createPlanningTools(service: PlanningService, baseline: Awaited<ReturnType<PlanningService['capture']>>): ReadTool[] {
  const scoped = (userId: string) => { if (userId !== baseline.userId) throw new Error('TOOL_SCOPE_MISMATCH'); };
  const scheduleInput = z.object({ from: timestamp, to: timestamp, timezone }).strict()
    .refine(value => timestamp.safeParse(value.from).success && timestamp.safeParse(value.to).success && compareInstants(value.from, value.to) < 0);
  const memoryInput = z.object({ keys: z.array(identifier).max(100), at: timestamp }).strict()
    .refine(value => Buffer.byteLength(JSON.stringify([...new Set(value.keys)]), 'utf8') <= 8192, '요청한 키가 너무 깁니다. 나누어 조회해 주세요.');
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
    { name: 'read_memory', description: '인증된 사용자의 유효한 맥락을 읽습니다. keys가 빈 배열이면 현재 스냅샷의 유효한 사실을 조회합니다. 결과는 최대 20개와 전체 JSON 16KiB이며 truncated, omittedCount, missingFields로 누락을 표시합니다. keys는 최대 100개, 중복 제거한 배열의 JSON은 UTF-8 8192바이트 이하여야 합니다.', input: memoryInput, async run(value, userId) {
      scoped(userId); const input = memoryInput.parse(value); const keys = new Set(input.keys);
      const matching = baseline.snapshot.facts.filter(fact => (!keys.size || keys.has(fact.key))
        && compareInstants(fact.recordedAt, input.at) <= 0 && (!fact.validUntil || compareInstants(input.at, fact.validUntil) < 0));
      const counts = new Map<string, number>();
      for (const fact of matching) counts.set(fact.key, (counts.get(fact.key) ?? 0) + 1);
      const result = (facts: typeof matching) => {
        const omittedCount = matching.length - facts.length;
        return { facts, contextRevision: baseline.snapshot.contextRevision,
          missingFields: keys.size ? [...keys].filter(key => facts.filter(fact => fact.key === key).length < (counts.get(key) ?? 0) ||
            !facts.some(fact => fact.key === key && fact.value !== null)) : omittedCount ? ['memory.truncated'] : [],
          truncated: omittedCount > 0, omittedCount };
      };
      const facts: typeof matching = [];
      for (const fact of matching) {
        if (facts.length < 20 && Buffer.byteLength(JSON.stringify(result([...facts, fact])), 'utf8') <= 16384) facts.push(fact);
      }
      return result(facts);
    } },
    { name: 'calculate_timing', description: '준비와 이동 시간을 계산합니다.', input: timingInput, async run(value, userId) {
      scoped(userId); const input = timingInput.parse(value);
      return calculateTiming({ appointmentStart: input.appointmentStart ?? undefined, preparationMinutes: input.preparationMinutes ?? undefined,
        travelMinutes: input.travelMinutes ?? undefined, bufferMinutes: input.bufferMinutes ?? undefined });
    } },
    { name: 'find_free_slots', description: 'asOf 시점의 스냅샷에서 시간 지정 항목을 제외한 연속 빈 구간을 계산합니다. 시작이 과거면 지금부터 남은 구간만 해석합니다. 미배치 작업이나 가져오지 않은 외부 일정, 준비·이동·여유는 보장하지 않으며 일정을 저장하지 않습니다.', input: freeSlotsInput, async run(value, userId) {
      scoped(userId); return findFreeSlots(baseline.snapshot, freeSlotsInput.parse(value));
    } },
    { name: 'validate_changes', description: '현재 일정 기준으로 변경안의 충돌, 마감, 소요시간, 고정·완료 일정 보호와 버전 및 명시된 timingConstraints의 시간 연결을 검증합니다. 명시하지 않은 관계와 실제 경로·이동시간은 검증하지 않습니다.', input: validateInput, async run(value, userId) {
      scoped(userId); return service.validateTool(baseline, validateInput.parse(value).changeSet);
    } },
  ];
}
