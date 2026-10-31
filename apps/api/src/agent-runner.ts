import type { AgentResult, ChatContext, CoordinationTarget, FormDraft } from '@pikku/domain';
import { AgentExecutionFailure, createPlanningAgent, type AgentDecision, type ModelPort, type ReadTool } from './agent.ts';
import { createPlanningTools } from './planning-tools.ts';
import { PlanningError, type PlanningService } from './planning-service.ts';
import type { TriggerEvent } from './scheduler.ts';
import { compareInstants, timestamp } from './planning-schemas.ts';

type AppFeature = { status: 'configured' | 'not_configured'; access: 'app' };
export type AgentCapabilities = {
  calendar: AppFeature; email: AppFeature; emailReplies: AppFeature; phone: AppFeature; places: AppFeature;
  travelTime: AppFeature & { modes: Array<'walk' | 'transit' | 'car'>; scheduledDeparture: 'unsupported' };
  scheduler: { status: 'configured' | 'not_configured' | 'degraded'; access: 'app' };
  weather?: { status: 'configured' | 'not_configured'; access: 'app' | 'model' };
  subway?: { status: 'configured' | 'not_configured'; access: 'app' | 'model' };
};
const unavailableCapabilities = (): AgentCapabilities => ({
  calendar: { status: 'not_configured', access: 'app' }, email: { status: 'not_configured', access: 'app' },
  emailReplies: { status: 'not_configured', access: 'app' }, phone: { status: 'not_configured', access: 'app' },
  places: { status: 'not_configured', access: 'app' }, travelTime: { status: 'not_configured', access: 'app',
    modes: ['walk', 'transit', 'car'], scheduledDeparture: 'unsupported' }, scheduler: { status: 'not_configured', access: 'app' },
});
type RunInput = { userId: string; requestId: string; conversationId: string | null; message: string; timezone: string;
  history: { role: 'user' | 'assistant'; content: string; externalExpiresAt?: string }[]; coordinationTarget?: CoordinationTarget; entryContext?: ChatContext; triggerEvent?: TriggerEvent };
type Prepared = { baseline: Awaited<ReturnType<PlanningService['capture']>>; decision: AgentDecision; inspected: boolean; failure: AgentResult | null; usedSnapshot: boolean; entryContext?: ChatContext };

// The graph is read-only. A caller must finish inside its own atomic result/ledger transaction.
export class PlanningAgentRunner {
  constructor(private readonly planning: PlanningService, private readonly model: ModelPort,
    private readonly capabilities: (userId: string) => Promise<AgentCapabilities> = async () => unavailableCapabilities(),
    private readonly toolFactory: (userId: string) => Promise<ReadTool[]> = async () => []) {}
  async prepare(input: RunInput): Promise<Prepared> {
    const baseline = await this.planning.capture(input.userId, input.timezone, input.coordinationTarget);
    let selectedItem;
    if (input.entryContext?.kind === 'item') {
      const { id, expectedRevision } = input.entryContext;
      const item = baseline.snapshot.items.find(value => value.id === id);
      if (!item) throw new PlanningError(404, 'not_found', '선택한 일정을 찾을 수 없습니다.');
      if (item.revision !== expectedRevision) throw new PlanningError(409, 'conflict', '선택한 일정의 버전이 변경되었습니다.');
      const { sourceRefs: _sourceRefs, ...safeItem } = item;
      selectedItem = safeItem;
    }
    const history = input.history.slice(-20).map(turn => {
      if (turn.role === 'assistant' && turn.externalExpiresAt !== undefined) {
        if (!timestamp.safeParse(turn.externalExpiresAt).success || compareInstants(turn.externalExpiresAt, baseline.snapshot.now) <= 0) {
          return { role: turn.role, content: '[이전 외부 조회 결과는 만료되었습니다. 필요한 정보는 도구로 다시 조회하세요.]' };
        }
        if (!baseline.externalExpiresAt || compareInstants(turn.externalExpiresAt, baseline.externalExpiresAt) < 0) {
          baseline.externalExpiresAt = turn.externalExpiresAt;
        }
      }
      return { role: turn.role, content: turn.content };
    });
    const capabilities = await this.capabilities(input.userId);
    const externalTools = (await this.toolFactory(input.userId)).map(tool => ({ ...tool,
      run: async (value: unknown, userId: string) => {
        const result = await tool.run(value, userId);
        if (!result || typeof result !== 'object' || !('ok' in result) || typeof result.ok !== 'boolean') {
          throw new Error('INVALID_EXTERNAL_RESULT');
        }
        if (!result.ok && (!('error' in result) || typeof result.error !== 'string' || !result.error)) {
          throw new Error('INVALID_EXTERNAL_RESULT');
        }
        if (result.ok) {
          if (!('expiresAt' in result) || typeof result.expiresAt !== 'string' ||
            !timestamp.safeParse(result.expiresAt).success) throw new Error('INVALID_EXTERNAL_EXPIRY');
          if (!baseline.externalExpiresAt || compareInstants(result.expiresAt, baseline.externalExpiresAt) < 0) {
            baseline.externalExpiresAt = result.expiresAt;
          }
        }
        return result;
      },
    }));
    const validation: { inspected: boolean; failure: AgentResult | null } = { inspected: false, failure: null };
    const agent = createPlanningAgent({
      model: this.model, tools: [...createPlanningTools(this.planning, baseline), ...externalTools],
      validateProposal: async (decision, actor) => {
        if (actor !== input.userId) throw new Error('AGENT_SCOPE_MISMATCH');
        validation.failure = await this.planning.inspectProposal(baseline, decision);
        validation.inspected = true;
        return validation.failure ? [validation.failure.kind] : [];
      },
    });
    const state = await agent.invoke({ userId: input.userId, message: input.message,
      context: { requestId: input.requestId, conversationId: input.conversationId, now: baseline.snapshot.now, timezone: input.timezone,
        history, capabilities, ...(baseline.coordinationTarget ? { coordinationTarget: baseline.coordinationTarget } : {}),
        ...(input.entryContext ? { entryContext: input.entryContext.kind === 'item' ? { kind: 'item', item: selectedItem } : input.entryContext } : {}),
        ...(input.triggerEvent ? { triggerEvent: { reason: input.triggerEvent.reason, scheduledFor: input.triggerEvent.scheduledFor,
          timezone: input.triggerEvent.timezone, targetDate: input.triggerEvent.targetDate, sourceRevision: input.triggerEvent.sourceRevision } } : {}) } });
    if (!state.decision) throw new AgentExecutionFailure('AGENT_OUTPUT_INVALID');
    return { baseline, decision: state.decision, inspected: validation.inspected, failure: validation.failure,
      entryContext: input.entryContext,
      usedSnapshot: input.entryContext?.kind === 'item' || state.observations.some(observation => ['read_schedule', 'read_memory', 'validate_changes'].includes(observation.name)) };
  }
  async finish(prepared: Prepared): Promise<AgentResult | { kind: 'reply'; message: string; draft: FormDraft }> {
    const decision = prepared.decision;
    const current = prepared.baseline.externalExpiresAt || (decision.kind !== 'proposal' && prepared.usedSnapshot)
      ? await this.planning.latest(prepared.baseline) : null;
    if (prepared.baseline.externalExpiresAt && current && compareInstants(current.now, prepared.baseline.externalExpiresAt) >= 0) {
      return { kind: 'failure', message: '조회한 정보가 만료되었습니다. 다시 요청해 주세요.', code: 'external_data_expired', retryable: true };
    }
    if (decision.kind !== 'proposal' && prepared.usedSnapshot &&
      current && !this.planning.baselineCurrent(prepared.baseline, current)) {
      return { kind: 'failure', message: '조회 중 일정 또는 맥락이 변경되었습니다. 다시 요청해 주세요.', code: 'stale_snapshot', retryable: true };
    }
    if (prepared.entryContext?.kind === 'form' && decision.kind === 'proposal') {
      return { kind: 'failure', message: '입력 초안에서는 일정을 저장하지 않습니다. 입력값을 확인해 주세요.', code: 'invalid_request', retryable: false };
    }
    if (decision.kind === 'draft') {
      const context = prepared.entryContext;
      if ((context?.kind !== 'form' && context?.kind !== 'create') || (context.kind === 'form' &&
          (context.draft.kind !== decision.draft.kind || Object.entries(decision.draft.fields).some(([key, value]) => !(key in context.draft.fields) ||
            Array.isArray(value) !== Array.isArray(context.draft.fields[key]) || (key === 'kind' && value !== context.draft.fields[key]))))) {
        return { kind: 'failure', message: '입력 초안을 확인할 수 없습니다. 다시 요청해 주세요.', code: 'invalid_request', retryable: false };
      }
      return { kind: 'reply', message: decision.text, draft: decision.draft };
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
