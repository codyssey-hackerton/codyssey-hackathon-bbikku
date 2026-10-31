import type { AgentResult, CoordinationTarget } from '@pikku/domain';
import { AgentExecutionFailure, createPlanningAgent, type AgentDecision, type ModelPort } from './agent.ts';
import { createPlanningTools } from './planning-tools.ts';
import type { PlanningService } from './planning-service.ts';
import type { TriggerEvent } from './scheduler.ts';

type AppFeature = { status: 'configured' | 'not_configured'; access: 'app' };
export type AgentCapabilities = {
  calendar: AppFeature; email: AppFeature; emailReplies: AppFeature; phone: AppFeature; places: AppFeature;
  travelTime: AppFeature & { modes: Array<'walk' | 'transit' | 'car'>; scheduledDeparture: 'unsupported' };
  scheduler: { status: 'configured' | 'not_configured' | 'degraded'; access: 'app' };
};
const unavailableCapabilities = (): AgentCapabilities => ({
  calendar: { status: 'not_configured', access: 'app' }, email: { status: 'not_configured', access: 'app' },
  emailReplies: { status: 'not_configured', access: 'app' }, phone: { status: 'not_configured', access: 'app' },
  places: { status: 'not_configured', access: 'app' }, travelTime: { status: 'not_configured', access: 'app',
    modes: ['walk', 'transit', 'car'], scheduledDeparture: 'unsupported' }, scheduler: { status: 'not_configured', access: 'app' },
});
type RunInput = { userId: string; requestId: string; conversationId: string | null; message: string; timezone: string;
  history: { role: 'user' | 'assistant'; content: string }[]; coordinationTarget?: CoordinationTarget; triggerEvent?: TriggerEvent };
type Prepared = { baseline: Awaited<ReturnType<PlanningService['capture']>>; decision: AgentDecision; inspected: boolean; failure: AgentResult | null; usedSnapshot: boolean };

// The graph is read-only. A caller must finish inside its own atomic result/ledger transaction.
export class PlanningAgentRunner {
  constructor(private readonly planning: PlanningService, private readonly model: ModelPort,
    private readonly capabilities: (userId: string) => Promise<AgentCapabilities> = async () => unavailableCapabilities()) {}
  async prepare(input: RunInput): Promise<Prepared> {
    const baseline = await this.planning.capture(input.userId, input.timezone, input.coordinationTarget);
    const capabilities = await this.capabilities(input.userId);
    const validation: { inspected: boolean; failure: AgentResult | null } = { inspected: false, failure: null };
    const agent = createPlanningAgent({
      model: this.model, tools: createPlanningTools(this.planning, baseline),
      validateProposal: async (decision, actor) => {
        if (actor !== input.userId) throw new Error('AGENT_SCOPE_MISMATCH');
        validation.failure = await this.planning.inspectProposal(baseline, decision);
        validation.inspected = true;
        return validation.failure ? [validation.failure.kind] : [];
      },
    });
    const state = await agent.invoke({ userId: input.userId, message: input.message,
      context: { requestId: input.requestId, conversationId: input.conversationId, now: baseline.snapshot.now, timezone: input.timezone,
        history: input.history.slice(-20), capabilities, ...(baseline.coordinationTarget ? { coordinationTarget: baseline.coordinationTarget } : {}),
        ...(input.triggerEvent ? { triggerEvent: { reason: input.triggerEvent.reason, scheduledFor: input.triggerEvent.scheduledFor,
          timezone: input.triggerEvent.timezone, targetDate: input.triggerEvent.targetDate, sourceRevision: input.triggerEvent.sourceRevision } } : {}) } });
    if (!state.decision) throw new AgentExecutionFailure('AGENT_OUTPUT_INVALID');
    return { baseline, decision: state.decision, inspected: validation.inspected, failure: validation.failure,
      usedSnapshot: state.observations.some(observation => ['read_schedule', 'read_memory', 'validate_changes'].includes(observation.name)) };
  }
  async finish(prepared: Prepared): Promise<AgentResult> {
    const decision = prepared.decision;
    if (decision.kind !== 'proposal' && prepared.usedSnapshot &&
      !this.planning.baselineCurrent(prepared.baseline, await this.planning.latest(prepared.baseline))) {
      return { kind: 'failure', message: '조회 중 일정 또는 맥락이 변경되었습니다. 다시 요청해 주세요.', code: 'stale_snapshot', retryable: true };
    }
    if (decision.kind === 'answer') return { kind: 'reply', message: decision.text };
    if (decision.kind === 'question') return { kind: 'question', message: decision.text, missingFields: decision.missingFields };
    if (decision.kind === 'proposal') {
      if (!prepared.inspected) throw new Error('Proposal validation did not run');
      return prepared.failure ?? await this.planning.saveProposal(prepared.baseline, decision);
    }
    throw new AgentExecutionFailure('AGENT_OUTPUT_INVALID');
  }
}
