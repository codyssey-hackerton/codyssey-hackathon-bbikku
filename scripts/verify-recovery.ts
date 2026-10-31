import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { PlanningAgentRunner } from '../apps/api/src/agent-runner.ts';
import type { ModelPort, Observation } from '../apps/api/src/agent.ts';
import { createResponsesModel, MODEL_ID, REASONING_EFFORT } from '../apps/api/src/model.ts';
import { PlanningService } from '../apps/api/src/planning-service.ts';
import { MemoryPlanningStore } from '../apps/api/src/planning-store.ts';
import type { AgentResult, ScheduleFields, ScheduleItem, TimeSlot } from '../packages/domain/src/contracts.ts';

const timezone = 'Asia/Seoul';
const userId = 'synthetic-recovery';
const slot = (startsAt: string, endsAt: string): TimeSlot => ({ startsAt, endsAt, timezone });
const task = (title: string, timeSlot: TimeSlot, deadline: string | null = null): ScheduleFields => ({
  kind: 'task', title, timeSlot, durationMinutes: 30, deadline, flexibility: 'flexible', involvement: 'personal', completion: 'pending',
});
const event = (timeSlot: TimeSlot): ScheduleFields => ({
  kind: 'event', title: '합성 고정 회의', timeSlot, durationMinutes: null, deadline: null,
  flexibility: 'fixed', involvement: 'personal', completion: 'pending',
});
type Scenario = {
  id: string; now: string; task: ScheduleFields; event: ScheduleFields; message: string;
  expected: 'answer' | 'proposal' | 'question'; incomplete?: boolean; expectedSlot?: TimeSlot;
};
const scenarios: Scenario[] = [
  { id: 'delay_no_impact', now: '2030-01-02T09:00:00+09:00',
    task: task('합성 서류 정리', slot('2030-01-02T10:00:00+09:00', '2030-01-02T10:30:00+09:00')),
    event: event(slot('2030-01-02T12:00:00+09:00', '2030-01-02T13:00:00+09:00')),
    message: '오늘 20분 늦게 일어나서 현재 9시예요. 10시 이전에 반드시 해야 하는 준비나 이동은 없어요. 오늘 일정에 영향이 있는지 확인해 주세요.', expected: 'answer' },
  { id: 'delay_one_conflict', now: '2030-01-02T14:15:00+09:00',
    task: task('합성 자료 정리', slot('2030-01-02T14:30:00+09:00', '2030-01-02T15:00:00+09:00')),
    event: event(slot('2030-01-02T15:00:00+09:00', '2030-01-02T16:00:00+09:00')),
    message: '오늘 합성 자료 정리를 원래 시작 시각보다 30분 늦게 시작하게 됐어요. 일정을 확인하고 고정 회의는 유지하면서 필요한 최소 변경을 제안해 주세요.',
    expected: 'proposal', expectedSlot: slot('2030-01-02T16:00:00+09:00', '2030-01-02T16:30:00+09:00') },
  { id: 'incomplete_still_needed', now: '2030-01-03T09:00:00+09:00',
    task: task('합성 운동', slot('2030-01-02T17:00:00+09:00', '2030-01-02T17:30:00+09:00')),
    event: event(slot('2030-01-03T10:00:00+09:00', '2030-01-03T11:00:00+09:00')),
    message: '어제 17시에 예정됐던 합성 운동을 못 했지만 여전히 해야 해요. 기한은 없어요. 기존 작업을 오늘 11시 30분부터 12시까지 하도록 제안해 주세요. 고정 일정은 유지해 주세요.',
    expected: 'proposal', incomplete: true, expectedSlot: slot('2030-01-03T11:30:00+09:00', '2030-01-03T12:00:00+09:00') },
  { id: 'incomplete_expired_unclear', now: '2030-01-03T09:00:00+09:00',
    task: task('합성 보고서', slot('2030-01-02T17:00:00+09:00', '2030-01-02T17:30:00+09:00'), '2030-01-02T23:59:00+09:00'),
    event: event(slot('2030-01-03T10:00:00+09:00', '2030-01-03T11:00:00+09:00')),
    message: '어제 못 한 합성 보고서를 처리해 주세요. 원래 마감은 어젯밤이었고 지금도 필요한지는 모르겠어요.', expected: 'question', incomplete: true },
];

function sawItem(observations: Observation[], id: string): boolean {
  return observations.some(observation => observation.name === 'read_schedule' &&
    Array.isArray((observation.result as { items?: unknown[] })?.items) &&
    (observation.result as { items: ScheduleItem[] }).items.some(item => item.id === id));
}
function unchangedFields(item: ScheduleItem, after: ScheduleFields): boolean {
  return item.kind === after.kind && item.title === after.title && item.durationMinutes === after.durationMinutes &&
    item.deadline === after.deadline && item.flexibility === after.flexibility && item.involvement === after.involvement;
}

// These indicators catch known counterexamples; they do not establish Korean meaning.
function reviewAnswer(text: string) {
  const indicators = {
    maintenanceMentioned: /유지|그대로/.test(text),
    contextMentioned: /시간|지연|늦|영향|충돌|여유|가능/.test(text),
    noKnownOpposition: !/유지하지\s*마|그대로\s*두지\s*마|유지할\s*수\s*없/.test(text),
  };
  return { status: indicators.noKnownOpposition ? 'review_required' as const : 'rejected' as const, indicators };
}
function reviewQuestion(text: string, missingFields: string[]) {
  const clauses = text.split(/[.!?？！。\n]+/);
  const questionForm = /(?:가요|나요|까요|습니까|는가)\s*$|(?:알려|말씀해|확인해|정해)\s*주(?:세요|십시오)\s*$/;
  const asksNeed = clauses.some(clause => questionForm.test(clause.trim()) && /(?:필요|유효)\s*(?:한가요|하나요|할까요|합니까|한지|여부|성)/.test(clause));
  const asksDeadline = clauses.some(clause => questionForm.test(clause.trim()) && /(?:기한|마감)(?:일)?(?:은|는|이|을|를|도)?\s*(?:언제|어떻|몇|무엇|알려|정해|확인|새로|다시)/.test(clause));
  const fields = missingFields.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const words = fields.split(/[^a-z]+/);
  const needField = /필요|유효/.test(fields) || words.some(word => ['need', 'needed', 'necessary', 'necessity', 'validity'].includes(word));
  const deadlineField = /기한|마감/.test(fields) || words.some(word => ['deadline', 'due', 'expiry', 'expiration'].includes(word));
  const indicators = {
    relevantQuestion: asksNeed || asksDeadline,
    relevantMissingField: (asksNeed && needField) || (asksDeadline && deadlineField),
    noKnownUnsafeInstruction: !/확인\s*(?:을\s*)?없이.{0,30}(?:처리|진행|시작)/.test(text),
  };
  return { status: Object.values(indicators).every(Boolean) ? 'review_required' as const : 'rejected' as const, indicators };
}

async function runScenario(scenario: Scenario, model: ModelPort) {
  const store = new MemoryPlanningStore();
  const service = new PlanningService(store, () => new Date(scenario.now));
  const seeded = await service.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [scenario.task, scenario.event].map((after, i) =>
    ({ changeId: `seed-${i}`, operation: 'create' as const, after })) } });
  const target = seeded.items.find(item => item.title === scenario.task.title)!;
  const fixed = seeded.items.find(item => item.title === scenario.event.title)!;
  if (scenario.incomplete) await service.checkin(userId, target.id, { expectedRevision: target.revision, completion: 'incomplete' });
  const before = await store.read(userId);
  const current = before.items.get(target.id)!;
  let turns = 0;
  let observations: Observation[] = [];
  const tools: string[] = [];
  const observedModel: ModelPort = { async decide(input) {
    if (++turns > 6) throw new Error('TURN_LIMIT');
    observations = input.observations;
    const decision = await model.decide(input) as { kind?: string; name?: string };
    if (decision.kind === 'tool_call' && decision.name) tools.push(decision.name);
    return decision;
  } };
  const runner = new PlanningAgentRunner(service, observedModel);
  let prepared: Awaited<ReturnType<PlanningAgentRunner['prepare']>> | undefined;
  let result: AgentResult | undefined;
  let failure: string | undefined;
  try {
    prepared = await runner.prepare({ userId, requestId: 'synthetic', conversationId: null, message: scenario.message, timezone, history: [] });
    result = await runner.finish(prepared);
  } catch (error) {
    failure = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'VERIFICATION_ERROR';
  }
  const after = await store.read(userId);
  const checks: Record<string, boolean> = {
    scheduleUnchanged: isDeepStrictEqual(after.items, before.items),
    scheduleRevisionUnchanged: after.scheduleRevision === before.scheduleRevision,
    itemRevisionsUnchanged: [...before.items].every(([id, item]) => after.items.get(id)?.revision === item.revision),
    contextRevisionUnchanged: after.contextRevision === before.contextRevision,
    noApprovals: isDeepStrictEqual(after.approvals, before.approvals),
    expectedDecision: prepared?.decision.kind === scenario.expected,
  };
  let contentReview: { status: 'review_required' | 'rejected' | 'not_applicable'; indicators: Record<string, boolean> } =
    { status: 'not_applicable', indicators: {} };
  if (scenario.expected === 'answer') {
    checks.reply = result?.kind === 'reply';
    checks.scheduleRead = sawItem(observations, current.id) && sawItem(observations, fixed.id);
    checks.noNewProposal = isDeepStrictEqual(after.proposals, before.proposals);
    if (result?.kind === 'reply') contentReview = reviewAnswer(result.message);
  } else if (scenario.expected === 'question') {
    const decision = prepared?.decision.kind === 'question' ? prepared.decision : undefined;
    checks.questionResult = result?.kind === 'question';
    checks.missingFieldsPresent = Boolean(decision?.missingFields.some(field => field.trim().length > 0));
    checks.missingFieldsPreserved = result?.kind === 'question' && isDeepStrictEqual(result.missingFields, decision?.missingFields);
    checks.noNewProposal = isDeepStrictEqual(after.proposals, before.proposals);
    if (result?.kind === 'question' && decision) contentReview = reviewQuestion(result.message, decision.missingFields);
  } else {
    const proposal = result?.kind === 'proposal' && result.proposalIds.length === 1 ? after.proposals.get(result.proposalIds[0]!) : undefined;
    const change = proposal?.changeSet.changes.length === 1 ? proposal.changeSet.changes[0] : undefined;
    checks.observedTaskAndFixed = sawItem(observations, current.id) && sawItem(observations, fixed.id);
    checks.oneValidatedPendingProposal = Boolean(proposal && after.proposals.size === before.proposals.size + 1 && proposal.status === 'pending' &&
      [...before.proposals].every(([id, value]) => isDeepStrictEqual(after.proposals.get(id), value)) &&
      proposal.mode === 'personal' && proposal.validation.valid && proposal.baseScheduleRevision === before.scheduleRevision &&
      proposal.baseContextRevision === before.contextRevision && proposal.validation.checkedScheduleRevision === before.scheduleRevision &&
      proposal.validation.checkedContextRevision === before.contextRevision && isDeepStrictEqual(proposal.beforeItems, [current]));
    checks.onlyTargetMoved = Boolean(change?.operation === 'update' && change.targetId === current.id && change.expectedRevision === current.revision &&
      unchangedFields(current, change.after) && (change.after.completion === current.completion || (scenario.incomplete && change.after.completion === 'pending')) &&
      !isDeepStrictEqual(change.after.timeSlot, current.timeSlot));
    checks.expectedTime = Boolean(change?.operation === 'update' && change.after.timeSlot && scenario.expectedSlot &&
      Date.parse(change.after.timeSlot.startsAt) === Date.parse(scenario.expectedSlot.startsAt) &&
      Date.parse(change.after.timeSlot.endsAt) === Date.parse(scenario.expectedSlot.endsAt));
  }
  const structuralStatus = Object.values(checks).every(Boolean) && !failure ? 'passed' : 'failed';
  const status = structuralStatus === 'failed' || contentReview.status === 'rejected' ? 'failed'
    : contentReview.status === 'review_required' ? 'review_required' : 'passed';
  return { scenario: scenario.id, status, structuralStatus, contentReview: { ...contentReview, method: 'heuristic' },
    modelDecision: prepared?.decision.kind ?? null, resultKind: result?.kind ?? null, message: result?.message ?? null,
    missingFields: prepared?.decision.kind === 'question' ? prepared.decision.missingFields : null,
    turns, tools, checks, ...(failure ? { failure } : {}) };
}

function overallStatus(reports: { status: string }[]) {
  if (reports.length !== scenarios.length || reports.some(report => !['passed', 'review_required'].includes(report.status))) return 'failed';
  return reports.some(report => report.status === 'review_required') ? 'review_required' : 'passed';
}

function selfTestModel(scenario: Scenario, unchangedProposal = false): ModelPort {
  return { async decide(input) {
    if (!input.observations.length) return { kind: 'tool_call', name: 'read_schedule', input: {
      from: '2030-01-02T00:00:00+09:00', to: '2030-01-04T00:00:00+09:00', timezone,
    } };
    if (scenario.expected === 'answer' && !unchangedProposal) return { kind: 'answer', text: '지연에도 시간 여유가 있어 기존 일정을 그대로 유지해요.' };
    if (scenario.expected === 'question') return { kind: 'question', text: '마감이 지난 이 작업이 여전히 필요한가요?', missingFields: ['necessity'] };
    const items = (input.observations[0]!.result as { items: ScheduleItem[] }).items;
    const item = items.find(value => value.title === scenario.task.title)!;
    const { id, revision, sourceRefs: _sourceRefs, ...fields } = item;
    return { kind: 'proposal', reason: '합성 검증', evidenceRefs: [], changeSet: { changes: [{
      changeId: 'update', operation: 'update', targetId: id, expectedRevision: revision,
      after: { ...fields, timeSlot: unchangedProposal ? fields.timeSlot : scenario.expectedSlot },
    }] } };
  } };
}

async function main() {
  const argument = process.argv[2];
  if (process.argv.length !== 3 || !['--self-test', '--live'].includes(argument ?? '')) {
    console.log('Usage: node --import tsx scripts/verify-recovery.ts --self-test|--live');
    console.log('Live exit codes: 0 passed, 1 failed, 2 requires human content review.');
    return;
  }
  if (argument === '--self-test') {
    const reports = [];
    for (const scenario of scenarios) {
      const report = await runScenario(scenario, selfTestModel(scenario));
      assert.equal(report.structuralStatus, 'passed', JSON.stringify(report));
      assert.equal(report.status, scenario.expected === 'proposal' ? 'passed' : 'review_required', JSON.stringify(report));
      reports.push(report);
    }
    assert.equal(overallStatus(reports), 'review_required');
    assert.equal(reports[0]!.contentReview.indicators.maintenanceMentioned, true);
    assert.equal(reports[0]!.contentReview.indicators.contextMentioned, true);
    const negative = await runScenario(scenarios[0]!, selfTestModel(scenarios[0]!, true));
    assert.equal(negative.status, 'failed');
    assert.equal(negative.checks.noNewProposal, false);
    const base = selfTestModel(scenarios[0]!);
    const opposition = await runScenario(scenarios[0]!, { async decide(input) {
      return input.observations.length ? { kind: 'answer', text: '지연됐으므로 기존 일정을 그대로 유지하지 마세요.' } : base.decide(input);
    } });
    assert.equal(opposition.structuralStatus, 'passed');
    assert.equal(opposition.status, 'failed');
    assert.equal(opposition.contentReview.indicators.noKnownOpposition, false);
    const questionScenario = scenarios[3]!;
    const question = async (text: string, missingFields: string[]) => runScenario(questionScenario, {
      async decide() { return { kind: 'question', text, missingFields }; },
    });
    const command = await question('마감이 지났지만 확인 없이 오늘 바로 처리하세요.', []);
    assert.equal(command.status, 'failed');
    assert.equal(command.checks.missingFieldsPresent, false);
    assert.equal(command.contentReview.indicators.relevantQuestion, false);
    const punctuation = await question('마감이 지났지만 확인 없이 오늘 바로 처리하세요?', ['deadline']);
    assert.equal(punctuation.structuralStatus, 'passed');
    assert.equal(punctuation.status, 'failed');
    assert.equal(punctuation.contentReview.indicators.relevantQuestion, false);
    const questionMarkOnly = await question('합성 보고서의 마감이 지났습니다?', ['deadline']);
    assert.equal(questionMarkOnly.status, 'failed');
    assert.equal(questionMarkOnly.contentReview.indicators.relevantQuestion, false);
    const validText = '합성 보고서가 지금도 필요한가요? 필요하다면 새 마감일도 알려 주세요.';
    const validQuestion = await question(validText, ['necessity', 'deadline']);
    assert.equal(validQuestion.structuralStatus, 'passed');
    assert.equal(validQuestion.status, 'review_required');
    assert.equal(validQuestion.contentReview.indicators.relevantQuestion, true);
    assert.equal(validQuestion.contentReview.indicators.relevantMissingField, true);
    const politeQuestion = await question('이 작업이 여전히 필요한지 알려 주세요.', ['필요 여부']);
    assert.equal(politeQuestion.status, 'review_required');
    const noMissingFields = await question(validText, []);
    assert.equal(noMissingFields.status, 'failed');
    assert.equal(noMissingFields.checks.missingFieldsPresent, false);
    const unrelatedField = await question(validText, ['unknown']);
    assert.equal(unrelatedField.structuralStatus, 'passed');
    assert.equal(unrelatedField.status, 'failed');
    assert.equal(unrelatedField.contentReview.indicators.relevantMissingField, false);
    console.log(JSON.stringify({ status: 'passed', deterministicScenarios: scenarios.length, knownOppositionRejected: true,
      unsafeQuestionRejected: true, missingFieldsChecked: true, naturalLanguageReview: 'required', liveModel: false }));
    return;
  }
  const key = process.env.PIKKU_OPENAI_API_KEY?.trim();
  if (!key) { console.error('PIKKU_OPENAI_API_KEY is not configured.'); process.exitCode = 1; return; }
  const reports = [];
  for (const scenario of scenarios) {
    let requests = 0;
    let providerFailure: string | undefined;
    const model = createResponsesModel(key, async (url, init) => {
      if (url !== 'https://api.openai.com/v1/responses' || requests >= 6) throw new Error('PROVIDER_BUDGET');
      requests++;
      try {
        const response = await fetch(url, init);
        if (!response.ok) providerFailure = `HTTP_${response.status}`;
        return response;
      } catch (error) { providerFailure = 'NETWORK_ERROR'; throw error; }
    });
    const report = { ...await runScenario(scenario, model), requests, ...(providerFailure ? { providerFailure } : {}) };
    reports.push(report);
    console.log(JSON.stringify(report));
    if (providerFailure) break;
  }
  const status = overallStatus(reports);
  const structuralStatus = reports.length === scenarios.length && reports.every(report => report.structuralStatus === 'passed') ? 'passed' : 'failed';
  console.log(JSON.stringify({ status, structuralStatus, contentReviewMethod: 'heuristic', model: MODEL_ID, reasoningEffort: REASONING_EFFORT,
    completedScenarios: reports.length, requestedScenarios: scenarios.length, storage: 'isolated_memory', durable: false }));
  if (status === 'failed') process.exitCode = 1;
  if (status === 'review_required') process.exitCode = 2;
}
void main().catch(() => { console.error('Recovery verification setup failed.'); process.exitCode = 1; });
