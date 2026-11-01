import type { AgentResult, ChatContext, CoordinationTarget, DeviceContext, FormDraft, ReminderCandidate } from '@pikku/domain';
import { AgentExecutionFailure, createPlanningAgent, type AgentDecision, type AgentMetrics, type ModelPort, type ReadTool } from './agent.ts';
import { createPlanningTools } from './planning-tools.ts';
import { PlanningError, type PlanningService } from './planning-service.ts';
import type { TriggerEvent } from './scheduler.ts';
import { changeSet, compareInstants, timestamp } from './planning-schemas.ts';
import type { Conversation } from './planning-store.ts';
import { locationAvailable } from './device-context.ts';
import { findFreeSlots, freeSlotsInput } from './free-slots.ts';
import { z } from 'zod';

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
  history: Conversation['turns']; coordinationTarget?: CoordinationTarget; entryContext?: ChatContext; triggerEvent?: TriggerEvent; deviceContext?: DeviceContext };
type FreeSlotRead = { input: z.infer<typeof freeSlotsInput>; slots: { startsAt: string; endsAt: string }[] };
type Prepared = { baseline: Awaited<ReturnType<PlanningService['capture']>>; decision: AgentDecision; inspected: boolean; failure: AgentResult | null; usedSnapshot: boolean; freeSlotReads: FreeSlotRead[]; entryContext?: ChatContext; phoneEvidence: boolean; phoneConfigured: boolean;
  reminder?: { itemId: string; expectedRevision: number; travel?: NonNullable<ReminderCandidate['travel']> } };

function explicitPhoneRequest(message: string): boolean {
  // shortcut: 보수적인 한국어 표현만 허용하며 구조화된 전화 요청 입력이 생기면 교체한다.
  if (/["'“”‘’「」『』]/.test(message) || /(?:라고|달래|달라고|하지\s*마|하지\s*말|하지\s*않|안\s*(?:해|걸|하)|걸지\s*마|전화하지|통화하지|전화\s*말고|통화\s*말고|전화\s*금지|통화\s*금지)/.test(message)) return false;
  return /(?:전화|통화)\s*(?:를|로|좀|한\s*번|해서|하여|해|걸|부탁)/.test(message) &&
    /(?:해\s*줘|해\s*주|해주세요|해줘|걸어\s*줘|걸어\s*주|걸어주세요|걸어봐|해봐|부탁|물어봐|확인해\s*줘|확인해\s*주|확인해주세요)/.test(message);
}

function explicitReminderRequest(message: string): boolean {
  // shortcut: 일부 한국어 표현은 인식하지 못하며 구조화된 알림 요청이 생기면 교체한다.
  return /알람|알림|알려/.test(message) && !/["'“”‘’「」『』]/.test(message) &&
    !/(?:안|못)\s*(?:알람|알림|알려)|(?:알람|알림|알려)[\s\S]{0,60}(?:지\s*(?:마|말)|(?:안|못)\s*(?:해|오|울|알려|주)|않|끄|꺼|취소|없|아니|원치|싫|금지)|(?:알람|알림)(?:을|은|도|이|\s)*\s*(?:안|말고)/.test(message);
}

function subtractMinutes(value: string, minutes: number): string | null {
  if (!timestamp.safeParse(value).success || !Number.isSafeInteger(minutes)) return null;
  const shifted = new Date(Date.parse(value) - minutes * 60_000);
  if (!Number.isFinite(shifted.getTime()) || shifted.getUTCFullYear() < 0 || shifted.getUTCFullYear() > 9999) return null;
  const extra = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1]?.slice(3) ?? '';
  return shifted.toISOString().replace(/Z$/, extra + 'Z');
}

// The graph is read-only. A caller must finish inside its own atomic result/ledger transaction.
export class PlanningAgentRunner {
  constructor(private readonly planning: PlanningService, private readonly model: ModelPort,
    private readonly capabilities: (userId: string) => Promise<AgentCapabilities> = async () => unavailableCapabilities(),
    private readonly toolFactory: (userId: string, deviceContext?: DeviceContext) => Promise<ReadTool[]> = async () => []) {}
  async prepare(input: RunInput, options: { signal?: AbortSignal; metrics?: AgentMetrics } = {}): Promise<Prepared> {
    options.signal?.throwIfAborted();
    const baseline = await this.planning.capture(input.userId, input.timezone, input.coordinationTarget);
    options.signal?.throwIfAborted();
    let previousProposals: { status: 'unavailable'; reason: string } | { status: 'available'; proposals: unknown[] } =
      { status: 'unavailable', reason: 'no_reference' };
    if (input.conversationId) {
      const stored = await this.planning.store.read(input.userId);
      const turn = stored.conversations.get(input.conversationId)?.turns.slice(-20).reverse()
        .find(value => value.role === 'assistant' && value.proposalIds !== undefined);
      if (turn) {
        const ids = turn.proposalIds;
        if (turn.externalExpiresAt !== undefined && (!timestamp.safeParse(turn.externalExpiresAt).success ||
            compareInstants(turn.externalExpiresAt, baseline.snapshot.now) <= 0)) {
          previousProposals = { status: 'unavailable', reason: 'external_data_expired' };
        } else if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) {
          previousProposals = { status: 'unavailable', reason: 'invalid_reference' };
        } else {
          if (turn.externalExpiresAt && (!baseline.externalExpiresAt || compareInstants(turn.externalExpiresAt, baseline.externalExpiresAt) < 0)) {
            baseline.externalExpiresAt = turn.externalExpiresAt;
          }
          const proposals = ids.map(id => stored.proposals.get(id));
          if (proposals.some(proposal => !proposal || !changeSet.safeParse(proposal.changeSet).success)) {
            previousProposals = { status: 'unavailable', reason: 'not_found' };
          } else if (proposals.some(proposal => proposal!.expiresAt !== null &&
              (!timestamp.safeParse(proposal!.expiresAt).success || compareInstants(proposal!.expiresAt, baseline.snapshot.now) <= 0))) {
            previousProposals = { status: 'unavailable', reason: 'expired' };
          } else {
            const safe = proposals.map(proposal => ({ id: proposal!.id, mode: proposal!.mode, status: proposal!.status,
              expiresAt: proposal!.expiresAt, changeSet: changeSet.parse(proposal!.changeSet),
              beforeItems: proposal!.beforeItems.map(({ id, revision, kind, title, timeSlot, durationMinutes, deadline, flexibility,
                involvement, completion, category, attendance, location, allDay, blocksTime, notes }) => ({ id, revision, kind, title,
                timeSlot: timeSlot && { startsAt: timeSlot.startsAt, endsAt: timeSlot.endsAt, timezone: timeSlot.timezone }, durationMinutes,
                deadline, flexibility, involvement, completion, category, attendance, location, allDay, blocksTime, notes })) }));
            if (Buffer.byteLength(JSON.stringify({ status: 'available', proposals: safe }), 'utf8') > 16_000) {
              previousProposals = { status: 'unavailable', reason: 'too_large' };
            } else previousProposals = { status: 'available', proposals: safe };
          }
        }
      }
    }
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    const externalTools = (await this.toolFactory(input.userId, input.deviceContext)).map(tool => ({ ...tool,
      run: async (value: unknown, userId: string) => {
        const result = await tool.run(value, userId);
        options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    const validation: { inspected: boolean; failure: AgentResult | null } = { inspected: false, failure: null };
    const agent = createPlanningAgent({
      model: this.model, tools: [...createPlanningTools(this.planning, baseline), ...externalTools], signal: options.signal, metrics: options.metrics,
      validateProposal: async (decision, actor) => {
        if (actor !== input.userId) throw new Error('AGENT_SCOPE_MISMATCH');
        validation.failure = await this.planning.inspectProposal(baseline, decision);
        validation.inspected = true;
        return validation.failure ? [validation.failure.kind] : [];
      },
    });
    const state = await agent.invoke({ userId: input.userId, message: input.message,
      context: { requestId: input.requestId, conversationId: input.conversationId, now: baseline.snapshot.now, timezone: input.timezone,
        history, previousProposals, memoryIndex: baseline.memoryIndex, ...(!input.triggerEvent && baseline.recentReviews?.length ? { recentReviews: baseline.recentReviews } : {}), capabilities, device: { location: locationAvailable(input.deviceContext?.currentLocation, baseline.snapshot.now) ? 'available' : 'not_shared',
          ...(input.deviceContext?.travelMode ? { travelMode: input.deviceContext.travelMode } : {}),
          notificationSupport: input.deviceContext?.notificationSupport ?? 'unknown' },
        ...(baseline.coordinationTarget ? { coordinationTarget: baseline.coordinationTarget } : {}),
        ...(input.entryContext ? { entryContext: input.entryContext.kind === 'item' ? { kind: 'item', item: selectedItem } : input.entryContext } : {}),
        ...(input.triggerEvent ? { triggerEvent: { reason: input.triggerEvent.reason, scheduledFor: input.triggerEvent.scheduledFor,
          timezone: input.triggerEvent.timezone, targetDate: input.triggerEvent.targetDate, sourceRevision: input.triggerEvent.sourceRevision } } : {}) } });
    options.signal?.throwIfAborted();
    if (!state.decision) throw new AgentExecutionFailure('AGENT_OUTPUT_INVALID');
    const freeSlotReads = state.observations.filter(observation => observation.name === 'find_free_slots').map(observation => ({
      input: freeSlotsInput.parse(observation.input),
      slots: z.object({ slots: z.array(z.object({ startsAt: timestamp, endsAt: timestamp })) }).parse(observation.result).slots,
    }));
    const phone = state.decision.kind === 'phone_request' ? state.decision : null;
    const observed = phone && state.observations.some(observation => observation.name === 'read_schedule' &&
      z.object({ items: z.array(z.object({ id: z.string(), revision: z.number() })) }).safeParse(observation.result).data?.items
        .some(item => item.id === phone.itemId && item.revision === phone.expectedRevision));
    const item = phone && baseline.snapshot.items.find(value => value.id === phone.itemId && value.revision === phone.expectedRevision);
    const selected = phone && input.entryContext?.kind === 'item' && input.entryContext.id === phone.itemId && input.entryContext.expectedRevision === phone.expectedRevision;
    const phoneEvidence = Boolean(phone && !input.triggerEvent && explicitPhoneRequest(input.message) && item && (selected || observed));
    const request = state.decision.kind === 'reminder_request' ? state.decision : null;
    const reminderItem = request && baseline.snapshot.items.find(value => value.id === request.itemId && value.revision === request.expectedRevision && value.timeSlot);
    const reminderObserved = request && state.observations.some(observation => observation.name === 'read_schedule' &&
      z.object({ items: z.array(z.object({ id: z.string(), revision: z.number() })) }).safeParse(observation.result).data?.items
        .some(value => value.id === request.itemId && value.revision === request.expectedRevision));
    const reminderSelected = request && input.entryContext?.kind === 'item' && input.entryContext.id === request.itemId && input.entryContext.expectedRevision === request.expectedRevision;
    let reminder: Prepared['reminder'];
    if (request && reminderItem && !input.triggerEvent && input.entryContext?.kind !== 'form' &&
        explicitReminderRequest(input.message) && (reminderSelected || reminderObserved)) {
      if (request.basis === 'event_start') reminder = { itemId: request.itemId, expectedRevision: request.expectedRevision };
      else if (request.destinationPlaceId && input.deviceContext?.travelMode && locationAvailable(input.deviceContext.currentLocation, baseline.snapshot.now)) {
        const gps = state.observations.filter(observation => observation.name === 'get_current_location').map(observation =>
          z.object({ ok: z.literal(true), expiresAt: timestamp, data: z.object({ placeId: z.string().min(1) }) }).safeParse(observation.result))
          .filter(result => result.success).map(result => result.data.data.placeId);
        const travel = state.observations.filter(observation => observation.name === 'estimate_travel').map(observation => {
          const args = z.object({ originPlaceId: z.string(), destinationPlaceId: z.string(), mode: z.enum(['walk', 'transit', 'car']) }).safeParse(observation.input);
          const result = z.object({ ok: z.literal(true), provider: z.literal('kakao'), fetchedAt: timestamp, expiresAt: timestamp,
            data: z.object({ originPlaceId: z.string(), destinationPlaceId: z.string(), mode: z.enum(['walk', 'transit', 'car']),
              durationMinutes: z.number().int().nonnegative().safe(), basis: z.literal('current_time'),
              destinationName: z.string().max(200).refine(value => !!value.trim()),
              destinationAddress: z.string().max(300).refine(value => !!value.trim()) }) }).safeParse(observation.result);
          return args.success && result.success && gps.includes(args.data.originPlaceId) &&
            args.data.originPlaceId === result.data.data.originPlaceId && args.data.destinationPlaceId === request.destinationPlaceId &&
            args.data.destinationPlaceId === result.data.data.destinationPlaceId && args.data.mode === input.deviceContext?.travelMode &&
            args.data.mode === result.data.data.mode ? result.data : null;
        }).filter(value => value !== null).at(-1);
        if (travel) reminder = { itemId: request.itemId, expectedRevision: request.expectedRevision,
          travel: { mode: travel.data.mode, durationMinutes: travel.data.durationMinutes, provider: 'kakao', basis: 'current_time',
            destinationName: travel.data.destinationName, destinationAddress: travel.data.destinationAddress } };
      }
    }
    return { baseline, decision: state.decision, inspected: validation.inspected, failure: validation.failure,
      entryContext: input.entryContext, freeSlotReads, phoneEvidence, phoneConfigured: capabilities.phone.status === 'configured', reminder,
      usedSnapshot: !!request || input.entryContext?.kind === 'item' || state.observations.some(observation => ['read_schedule', 'read_memory', 'validate_changes', 'find_free_slots'].includes(observation.name)) };
  }
  async finish(prepared: Prepared): Promise<AgentResult | { kind: 'reply'; message: string; draft: FormDraft }> {
    const decision = prepared.decision;
    const current = prepared.baseline.externalExpiresAt || prepared.freeSlotReads.length || (decision.kind !== 'proposal' && prepared.usedSnapshot)
      ? await this.planning.latest(prepared.baseline) : null;
    if (prepared.baseline.externalExpiresAt && current && compareInstants(current.now, prepared.baseline.externalExpiresAt) >= 0) {
      return { kind: 'failure', message: '조회한 정보가 만료되었습니다. 다시 요청해 주세요.', code: 'external_data_expired', retryable: true };
    }
    if (decision.kind !== 'proposal' && prepared.usedSnapshot &&
      current && !this.planning.baselineCurrent(prepared.baseline, current)) {
      return { kind: 'failure', message: '조회 중 일정 또는 맥락이 변경되었습니다. 다시 요청해 주세요.', code: 'stale_snapshot', retryable: true };
    }
    if (current && prepared.freeSlotReads.some(read => {
      const refreshed = findFreeSlots({ ...prepared.baseline.snapshot, now: current.now }, read.input);
      return read.slots.some(original => !refreshed.slots.some(slot =>
        compareInstants(slot.endsAt, original.endsAt) === 0 && compareInstants(slot.startsAt, original.startsAt) >= 0));
    })) {
      return { kind: 'failure', message: '조회한 빈 시간이 달라졌습니다. 다시 요청해 주세요.', code: 'stale_snapshot', retryable: true };
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
    if (decision.kind === 'answer') return { kind: 'reply', message: decision.text, ...(decision.suggestions ? { suggestions: decision.suggestions } : {}) };
    if (decision.kind === 'question') return { kind: 'question', message: decision.text, missingFields: decision.missingFields,
      ...(decision.suggestions ? { suggestions: decision.suggestions } : {}) };
    if (decision.kind === 'reminder_request') {
      const evidence = prepared.reminder;
      const item = evidence && current?.items.find(value => value.id === evidence.itemId && value.revision === evidence.expectedRevision);
      if (!evidence || !item?.timeSlot || !current || (decision.basis === 'departure' && !evidence.travel)) {
        return { kind: 'failure', message: '알림할 일정과 이동 정보를 확인해 주세요.', code: 'invalid_request', retryable: false };
      }
      const departureAt = evidence.travel ? subtractMinutes(item.timeSlot.startsAt, evidence.travel.durationMinutes) : undefined;
      const reminderAt = subtractMinutes(departureAt ?? item.timeSlot.startsAt, decision.minutesBefore);
      const expiresAt = new Date(Date.parse(current.now) + 300_000).toISOString();
      const expiry = prepared.baseline.externalExpiresAt && compareInstants(prepared.baseline.externalExpiresAt, expiresAt) < 0
        ? prepared.baseline.externalExpiresAt : expiresAt;
      if (departureAt === null || !reminderAt || compareInstants(reminderAt, current.now) <= 0 || compareInstants(expiry, current.now) <= 0) {
        return { kind: 'failure', message: '알림 시각이 지났거나 확인한 정보가 만료되었습니다.', code: 'invalid_request', retryable: false };
      }
      return { kind: 'reminder_request', message: '알림 내용을 확인해 주세요.', reminder: {
        itemId: item.id, expectedRevision: item.revision, title: item.title, appointmentAt: item.timeSlot.startsAt,
        appointmentEndsAt: item.timeSlot.endsAt, timezone: item.timeSlot.timezone, basis: decision.basis,
        minutesBefore: decision.minutesBefore, reminderAt, expiresAt: expiry,
        ...(item.location ? { appointmentLocation: item.location } : {}),
        ...(departureAt && evidence.travel ? { departureAt, travel: evidence.travel } : {}),
      } };
    }
    if (decision.kind === 'phone_request') {
      if (!prepared.phoneEvidence) return { kind: 'failure', message: '전화할 일정과 요청을 확인해 주세요.', code: 'invalid_request', retryable: false };
      return { kind: 'phone_request', message: prepared.phoneConfigured ? '전화 요청을 확인해 주세요. 승인 전에는 전화하지 않습니다.' : '전화 연결이 설정되지 않았습니다. 연결과 요청을 확인해 주세요.',
        itemId: decision.itemId, expectedRevision: decision.expectedRevision };
    }
    if (decision.kind === 'call_review') return { kind: 'failure', message: '통화 검토를 확인할 수 없습니다.', code: 'invalid_request', retryable: false };
    if (decision.kind === 'proposal') {
      if (!prepared.inspected) throw new Error('Proposal validation did not run');
      return prepared.failure ?? await this.planning.saveProposal(prepared.baseline, decision);
    }
    throw new AgentExecutionFailure('AGENT_OUTPUT_INVALID');
  }
}
