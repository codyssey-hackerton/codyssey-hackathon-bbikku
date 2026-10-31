import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { PlanningAgentRunner } from '../apps/api/src/agent-runner.ts';
import type { AgentInput, ModelPort, Observation } from '../apps/api/src/agent.ts';
import { createResponsesModel, MODEL_ID, REASONING_EFFORT } from '../apps/api/src/model.ts';
import { PlanningService } from '../apps/api/src/planning-service.ts';
import { MemoryPlanningStore } from '../apps/api/src/planning-store.ts';

const timezone = 'Asia/Seoul';
const now = '2030-01-02T09:00:00+09:00';
const tomorrow = '2030-01-03';
const later = '2030-01-04';
const scheduleInput = (day: string) => ({ from: `${day}T00:00:00+09:00`, to: `${day === tomorrow ? later : '2030-01-05'}T00:00:00+09:00`, timezone });
const timeSlot = { startsAt: `${tomorrow}T10:00:00+09:00`, endsAt: `${tomorrow}T10:30:00+09:00`, timezone };
const task = { kind: 'task' as const, title: '청소', timeSlot, durationMinutes: 30, deadline: null,
  flexibility: 'flexible' as const, involvement: 'personal' as const, completion: 'pending' as const };
const meeting = { kind: 'event' as const, title: '합성 회의', timeSlot: { ...timeSlot, startsAt: `${tomorrow}T15:00:00+09:00`, endsAt: `${tomorrow}T16:00:00+09:00` },
  durationMinutes: null, deadline: null, flexibility: 'fixed' as const, involvement: 'personal' as const, completion: 'pending' as const };
type Scenario = { id: string; prompts: string[] };
const scenarios: Scenario[] = [
  { id: 'cleaning_duration', prompts: ['청소를 계획하고 싶어요. 필요한 소요 시간을 모르면 물어봐 주세요.', '30분이에요. 내일 오전 10시 청소를 제안해 주세요.'] },
  { id: 'preparation', prompts: ['내일 15시 약속, 이동 30분, 도착 여유 10분, 준비 15분이에요. 출발과 준비 시작 시각을 계산해 주세요.', '다른 조건은 그대로 두고 준비시간만 45분이면 언제인가요?'] },
  { id: 'schedule_lookup', prompts: ['내일 일정을 알려 주세요.', '모레 일정도 알려 주세요.'] },
  { id: 'ambiguous_date', prompts: ['그날 일정 알려 주세요. 어느 날인지 모르겠어요.'] },
];

async function runScenario(scenario: Scenario, model: ModelPort) {
  const store = new MemoryPlanningStore();
  const service = new PlanningService(store, () => new Date(now));
  const seeded = await service.command('synthetic', { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'meeting', operation: 'create', after: meeting }] } });
  const before = await store.read('synthetic');
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  let calls = 0;
  const turns = [];
  for (let index = 0; index < scenario.prompts.length; index++) {
    let observations: Observation[] = [];
    const runner = new PlanningAgentRunner(service, { async decide(input) {
      if (++calls > 6) throw new Error('MODEL_BUDGET');
      observations = input.observations;
      return model.decide(input);
    } });
    const prompt = scenario.prompts[index]!;
    const prepared = await runner.prepare({ userId: 'synthetic', requestId: `turn-${index}`, conversationId: null, message: prompt, timezone, history });
    const result = await runner.finish(prepared);
    const checks: Record<string, boolean> = {};
    if (scenario.id === 'cleaning_duration' && index === 0) {
      checks.question = result.kind === 'question' && result.missingFields.some(field => /duration|소요|시간/i.test(field));
    } else if (scenario.id === 'cleaning_duration') {
      const state = await store.read('synthetic');
      const proposal = result.kind === 'proposal' && result.proposalIds.length === 1 ? state.proposals.get(result.proposalIds[0]!) : undefined;
      const change = proposal?.changeSet.changes.length === 1 ? proposal.changeSet.changes[0] : undefined;
      checks.pendingValidCleaning = Boolean(proposal?.status === 'pending' && proposal.validation.valid && change?.operation === 'create' &&
        change.after.kind === 'task' && change.after.title === '청소' && change.after.durationMinutes === 30 &&
        Date.parse(change.after.timeSlot?.startsAt ?? '') === Date.parse(timeSlot.startsAt) && Date.parse(change.after.timeSlot?.endsAt ?? '') === Date.parse(timeSlot.endsAt));
    } else if (scenario.id === 'preparation') {
      const observation = observations.find(value => value.name === 'calculate_timing');
      const output = observation?.result as { ready?: boolean; departureAt?: string; preparationStartAt?: string } | undefined;
      const input = observation?.input as { preparationMinutes?: number; travelMinutes?: number; bufferMinutes?: number } | undefined;
      checks.calculated = result.kind === 'reply' && input?.preparationMinutes === (index === 0 ? 15 : 45) && input?.travelMinutes === 30 && input?.bufferMinutes === 10 &&
        output?.ready === true && Date.parse(output.departureAt ?? '') === Date.parse(`${tomorrow}T14:20:00+09:00`) &&
        Date.parse(output.preparationStartAt ?? '') === Date.parse(`${tomorrow}T${index === 0 ? '14:05' : '13:35'}:00+09:00`);
    } else if (scenario.id === 'schedule_lookup') {
      const observed = observations.find(value => value.name === 'read_schedule' && isDeepStrictEqual(value.input, scheduleInput(index === 0 ? tomorrow : later)));
      const items = (observed?.result as { items?: { id: string }[] } | undefined)?.items;
      checks.correctRange = result.kind === 'reply' && Array.isArray(items) && (index === 0 ? items.length === 1 && items[0]?.id === seeded.items[0]?.id : items.length === 0);
    } else {
      checks.question = result.kind === 'question' && result.missingFields.some(field => field.trim().length > 0);
    }
    turns.push({ index, kind: result.kind, message: result.message, missingFields: result.kind === 'question' ? result.missingFields : null, tools: observations.map(value => value.name), checks });
    history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.message });
  }
  const after = await store.read('synthetic');
  const structural = turns.every(turn => Object.values(turn.checks).every(Boolean)) && isDeepStrictEqual(before.items, after.items) &&
    before.scheduleRevision === after.scheduleRevision && isDeepStrictEqual(before.approvals, after.approvals) &&
    (scenario.id === 'cleaning_duration' ? after.proposals.size === 1 : after.proposals.size === 0);
  return { scenario: scenario.id, structuralStatus: structural ? 'passed' : 'failed', contentReview: 'review_required', calls, turns };
}

function mock(scenario: Scenario): ModelPort {
  return { async decide(input: AgentInput & { observations: Observation[] }) {
    const index = (input.context.history as unknown[]).length / 2;
    if (scenario.id === 'cleaning_duration') {
      if (!index) return { kind: 'question', text: '청소에 얼마나 걸리나요?', missingFields: ['durationMinutes'] };
      return { kind: 'proposal', reason: '합성 청소', evidenceRefs: [], changeSet: { changes: [{ changeId: 'clean', operation: 'create', after: task }] } };
    }
    if (scenario.id === 'ambiguous_date') return { kind: 'question', text: '어느 날짜인가요?', missingFields: ['date'] };
    if (!input.observations.length) return scenario.id === 'preparation'
      ? { kind: 'tool_call', name: 'calculate_timing', input: { appointmentStart: `${tomorrow}T15:00:00+09:00`, preparationMinutes: index ? 45 : 15, travelMinutes: 30, bufferMinutes: 10 } }
      : { kind: 'tool_call', name: 'read_schedule', input: scheduleInput(index ? later : tomorrow) };
    return { kind: 'answer', text: '합성 결과입니다. 내용은 사람이 확인합니다.' };
  } };
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--self-test', '--live'].includes(mode ?? '')) throw new Error('Use --self-test or --live');
  if (mode === '--self-test') {
    for (const scenario of scenarios) assert.equal((await runScenario(scenario, mock(scenario))).structuralStatus, 'passed', scenario.id);
    const bad = await runScenario(scenarios[3]!, { async decide() { return { kind: 'answer', text: '임의 날짜' }; } });
    assert.equal(bad.structuralStatus, 'failed');
    const missingDuration = await runScenario(scenarios[0]!, { async decide(input) {
      if (!(input.context.history as unknown[]).length) return { kind: 'question', text: '언제인가요?', missingFields: ['date'] };
      return { kind: 'proposal', reason: '합성', evidenceRefs: [], changeSet: { changes: [{ changeId: 'clean', operation: 'create', after: task }] } };
    } });
    assert.equal(missingDuration.structuralStatus, 'failed');
    console.log(JSON.stringify({ status: 'passed', scenarios: scenarios.length, naturalLanguageReview: 'required', liveModel: false }));
    return;
  }
  const key = process.env.PIKKU_OPENAI_API_KEY?.trim();
  if (!key) { console.error('PIKKU_OPENAI_API_KEY is not configured.'); process.exitCode = 1; return; }
  let failed = false;
  for (const scenario of scenarios) {
    try {
      const report = await runScenario(scenario, createResponsesModel(key));
      console.log(JSON.stringify(report));
      if (report.structuralStatus !== 'passed') failed = true;
    } catch { console.log(JSON.stringify({ scenario: scenario.id, structuralStatus: 'failed', error: 'MODEL_OR_VALIDATION_FAILURE' })); failed = true; }
  }
  console.log(JSON.stringify({ status: failed ? 'failed' : 'review_required', model: MODEL_ID, reasoningEffort: REASONING_EFFORT, storage: 'isolated_memory', durable: false }));
  process.exitCode = failed ? 1 : 2;
}
void main().catch(() => { console.error('Core flow verification failed.'); process.exitCode = 1; });
