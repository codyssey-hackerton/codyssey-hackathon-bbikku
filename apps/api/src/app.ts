import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentExecutionFailure, type ModelPort } from './agent.ts';
import { PlanningAgentRunner } from './agent-runner.ts';
import type { SessionResolver } from './auth.ts';
import { MemoryIdempotency, RepositoryIdempotency, type HttpResult, type IdempotencyControl, type IdempotencyPort } from './idempotency.ts';
import { MODEL_ID, REASONING_EFFORT } from './model.ts';
import { PlanningError, PlanningService } from './planning-service.ts';
import { ContactService } from './contact-service.ts';
import { ContactDispatch, gmailAvailable, type GmailContactPort } from './contact-dispatch.ts';
import { recipientBody, contactBody, contactDecisionBody } from './contact-schemas.ts';
import { MemoryPlanningStore, type PlanningStore, type UserPlanningState } from './planning-store.ts';
import { buildReviewEvents, type ReviewSchedulerRuntime, type TriggerEvent } from './scheduler.ts';
import { checkinBody, commandBody, decisionBody, identifier, memoryBody, memoryQuery, proposalQuery, scheduleQuery, timezone } from './planning-schemas.ts';

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) { super(message); }
}
// This error is raised only before any proposal or other write has occurred.
class RetryableChatProviderError extends ApiError {
  constructor(message: string) { super(503, 'provider_unavailable', message, true); }
}

const nonblank = z.string().max(200).refine(value => value.trim().length > 0);
const requestBody = z.object({ requestId: nonblank }).passthrough();
const chatBody = z.object({
  requestId: nonblank,
  conversationId: nonblank.nullable(),
  message: z.string().max(8000).refine(value => value.trim().length > 0),
  timezone: nonblank.refine(value => {
    if (/^[+-]/.test(value)) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }),
  coordinationTarget: z.object({ id: nonblank, expectedRevision: z.number().int().min(1) }).strict().optional(),
}).strict();
const reviewTime = z.object({ enabled: z.boolean(), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable() }).strict()
  .refine(value => !value.enabled || value.localTime !== null);
const reviewBody = z.object({ requestId: nonblank, expectedRevision: z.number().int().min(0), timezone, evening: reviewTime, morning: reviewTime }).strict();
const contactSendBody = z.object({ requestId: identifier, contactRevision: z.number().int().min(1), expectedSenderAddress: z.email().max(254) }).strict();
const contactListQuery = z.object({ proposalId: identifier.optional() }).strict();

function requestId(request: FastifyRequest): string {
  const parsed = requestBody.safeParse(request.body);
  return parsed.success ? parsed.data.requestId : request.id;
}
function errorResult(error: unknown, id: string): HttpResult {
  if (error instanceof ApiError || error instanceof PlanningError) return {
    status: error.status, body: { requestId: id, error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) } },
  };
  return { status: 500, body: { requestId: id, error: { code: 'internal_error', message: '요청을 처리하지 못했습니다.', retryable: false } } };
}
function invalidRequest(): ApiError { return new ApiError(400, 'invalid_request', '요청 본문 또는 헤더를 확인해 주세요.'); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

export function buildApp(options: { sessions?: SessionResolver; model?: ModelPort; store?: PlanningStore; clock?: () => Date; idempotency?: IdempotencyPort; gmailContact?: GmailContactPort; schedulerStatus?: () => 'not_configured' | 'available' | 'degraded'; onReviewScheduleChanged?: () => Promise<void> } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32_768, genReqId: () => randomUUID() });
  const authenticated = new WeakMap<FastifyRequest, string>();
  const store = options.store ?? new MemoryPlanningStore();
  const idempotency = options.idempotency ?? (store.durable ? new RepositoryIdempotency(store, options.clock) : new MemoryIdempotency());
  const reviewIdempotency = store.durable ? idempotency : new RepositoryIdempotency(store, options.clock);
  const planning = new PlanningService(store, options.clock);
  const contacts = new ContactService(store, planning, options.clock);
  const contactDispatch = new ContactDispatch(store, planning, options.gmailContact, options.clock);
  const runner = options.model ? new PlanningAgentRunner(planning, options.model) : undefined;
  const now = () => options.clock?.() ?? new Date();
  let modelStatus: 'not_configured' | 'available' | 'degraded' = options.model ? 'available' : 'not_configured';

  function reviewConfigMatches(state: UserPlanningState, event: TriggerEvent): boolean {
    const due = Date.parse(event.scheduledFor); const setting = state.reviewSchedule;
    if (!Number.isFinite(due) || !setting || !['evening_plan', 'morning_review'].includes(event.reason)) return false;
    if (state.reviewScheduleUpdatedAt && Date.parse(state.reviewScheduleUpdatedAt) > due) return false;
    try {
      const expected = buildReviewEvents({ userId: event.userId, reviewSchedule: setting }, new Date(due)).find(value => value.reason === event.reason);
      if (!expected || expected.id !== event.id || expected.scheduledFor !== event.scheduledFor || expected.timezone !== event.timezone ||
        expected.targetDate !== event.targetDate || expected.idempotencyKey !== event.idempotencyKey || expected.sourceRevision !== event.sourceRevision) return false;
    } catch { return false; }
    return true;
  }
  function reviewVerdict(state: UserPlanningState, event: TriggerEvent): 'ready' | 'stale' | 'late' | 'early' {
    if (!reviewConfigMatches(state, event)) return 'stale';
    const due = Date.parse(event.scheduledFor); const current = now().getTime();
    if (current < due) return 'early';
    return current - due > 60 * 60_000 ? 'late' : 'ready';
  }
  function recordReviewSkip(state: UserPlanningState, event: TriggerEvent, reason: 'late' | 'stale'): void {
    const key = JSON.stringify(['skip', event.idempotencyKey, event.sourceRevision ?? null, reason]);
    if (!state.reviewLedger.has(key)) state.reviewLedger.set(key, { eventId: event.id, status: 'skipped', reason, sourceRevision: event.sourceRevision ?? null, at: now().toISOString() });
  }
  const reviewRuntime: ReviewSchedulerRuntime & { recordSkipped(event: TriggerEvent, reason: 'late' | 'stale'): Promise<void> } = {
    listReviewSchedules: () => planning.listReviewSchedules(),
    async recordSkipped(event, reason) {
      await store.transaction(event.userId, state => recordReviewSkip(state, event, reason));
    },
    async runScheduledReview(event) {
      const failed = (): HttpResult => ({ status: 503, body: { status: 'failed' }, retryableWithoutEffects: true });
      const skip = (state: UserPlanningState, reason: 'late' | 'stale'): HttpResult => {
        recordReviewSkip(state, event, reason);
        return { status: 200, body: { status: 'skipped' }, ...(reason === 'stale' ? { retryableWithoutEffects: true as const } : {}) };
      };
      // Even a replay must use a currently valid setting revision and occurrence.
      if (!reviewConfigMatches(await store.read(event.userId), event)) {
        const stillStale = await store.transaction(event.userId, state => {
          if (reviewConfigMatches(state, event)) return false;
          skip(state, 'stale'); return true;
        });
        if (stillStale) return { status: 'skipped' };
      }
      const result = await reviewIdempotency.execute({
        userId: event.userId, operation: 'scheduled_review', key: event.idempotencyKey, requestId: event.id,
        payload: { reason: event.reason, scheduledFor: event.scheduledFor },
        guard: state => { const verdict = reviewVerdict(state, event); return verdict === 'stale' || verdict === 'late' ? skip(state, verdict) : undefined; },
        guardExisting: state => !reviewConfigMatches(state, event) ? skip(state, 'stale') : undefined,
        run: async control => {
          const first = reviewVerdict(await store.read(event.userId), event);
          if (first === 'early') return failed();
          if (first === 'stale' || first === 'late') return control.finalize(() => store.atomic(event.userId, () => store.transaction(event.userId, state => skip(state, first))));
          if (!runner) return failed();
          let prepared;
          try {
            const message = event.reason === 'evening_plan'
              ? `${event.targetDate} 일정을 검토하고 필요한 경우 제안해 주세요.`
              : `${event.targetDate} 오늘의 일정을 검토하고 필요한 경우 제안해 주세요.`;
            prepared = await runner.prepare({ userId: event.userId, requestId: event.id, conversationId: null, message,
              timezone: event.timezone, history: [], triggerEvent: event });
            modelStatus = 'available';
          } catch (error) {
            if (error instanceof AgentExecutionFailure) modelStatus = 'degraded';
            return failed();
          }
          return control.finalize(() => store.atomic(event.userId, async () => {
            const current = await store.read(event.userId);
            const verdict = reviewVerdict(current, event);
            if (verdict === 'early') return failed();
            if (verdict === 'stale' || verdict === 'late') return store.transaction(event.userId, state => skip(state, verdict));
            const agentResult = await runner.finish(prepared);
            const retryable = agentResult.kind === 'failure' && ['stale_proposal', 'stale_snapshot'].includes(agentResult.code);
            const outcome = retryable ? { status: 'failed' as const, result: agentResult } : { status: 'completed' as const, result: agentResult };
            await store.transaction(event.userId, state => { state.reviewLedger.set(event.idempotencyKey, { eventId: event.id, ...outcome, at: now().toISOString() }); });
            return { status: retryable ? 503 : 200, body: outcome, ...(retryable ? { retryableWithoutEffects: true as const } : {}) };
          }));
        },
      });
      const outcome = result.body as { status?: string; result?: import('@pikku/domain').AgentResult } | undefined;
      return outcome?.status === 'completed' || outcome?.status === 'skipped' || outcome?.status === 'failed'
        ? { status: outcome.status, ...(outcome.result ? { result: outcome.result } : {}) } : { status: 'failed' };
    },
  };

  app.setErrorHandler((error, request, reply) => {
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const result = error instanceof ApiError || error instanceof PlanningError ? errorResult(error, requestId(request))
      : status >= 400 && status < 500 ? errorResult(invalidRequest(), requestId(request))
        : errorResult(error, requestId(request));
    void reply.code(result.status).send(result.body);
  });
  app.setNotFoundHandler((request, reply) => {
    const result = errorResult(new ApiError(404, 'not_found', '요청한 경로를 찾을 수 없습니다.'), requestId(request));
    void reply.code(result.status).send(result.body);
  });
  app.addHook('preHandler', async request => {
    if (request.routeOptions.url === '/health') return;
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    const session = match && options.sessions ? await options.sessions.resolve(match[1]) : null;
    if (!session || !session.userId) throw new ApiError(401, 'unauthenticated', '인증이 필요합니다.');
    authenticated.set(request, session.userId);
  });

  app.get('/health', async request => ({ requestId: request.id, data: { status: 'ok' } }));
  app.get('/v1/capabilities', async request => ({
    requestId: request.id,
    data: {
      storage: { mode: planning.store.mode, durable: planning.store.durable },
      model: { id: MODEL_ID, reasoningEffort: REASONING_EFFORT, status: modelStatus },
      integrations: { calendar: 'not_configured', email: gmailAvailable(store, options.gmailContact, authenticated.get(request)!) ? 'available' : 'not_configured', phone: 'not_configured', travel: 'not_configured' },
      scheduler: { status: options.schedulerStatus?.() ?? 'not_configured' },
    },
  }));
  app.get('/v1/email-connection', async request => {
    const available = gmailAvailable(store, options.gmailContact, authenticated.get(request)!);
    return { requestId: request.id, data: { status: available ? 'available' : 'not_configured', senderAddress: available ? options.gmailContact!.senderAddress : null } };
  });

  async function runIdempotent(request: FastifyRequest, operation: string, run: (body: z.infer<typeof requestBody>, control: IdempotencyControl) => Promise<HttpResult>): Promise<HttpResult> {
    const body = requestBody.safeParse(request.body);
    const key = request.headers['idempotency-key'];
    if (!body.success || typeof key !== 'string' || !nonblank.safeParse(key).success) throw invalidRequest();
    const { requestId: id, ...payload } = body.data;
    return idempotency.execute({
      userId: authenticated.get(request)!, operation, key, requestId: id,
      payload: { body: payload, params: request.params },
      run: async control => {
        try { return await run(body.data, control); } catch (error) {
          const result = errorResult(error, id);
          return operation === 'chat' && error instanceof RetryableChatProviderError ? { ...result, retryableWithoutEffects: true } : result;
        }
      },
    });
  }

  app.post('/v1/chat', async (request, reply) => {
    const result = await runIdempotent(request, 'chat', async (_requestBody, control) => {
      const body = parse(chatBody, request.body);
      if (!runner) throw new ApiError(503, 'not_configured', 'AI 연결이 설정되지 않았습니다.');
      const userId = authenticated.get(request)!;
      const conversationId = body.conversationId ?? randomUUID();
      const conversationToken = randomUUID();
      const reserved = await store.transaction(userId, state => {
        const existing = state.conversations.get(conversationId);
        if (body.conversationId && !existing) throw new ApiError(404, 'not_found', '대화를 찾을 수 없습니다.');
        if (existing?.lock && Date.parse(existing.lock.until) > now().getTime()) throw new ApiError(409, 'operation_in_progress', '이 대화의 이전 요청을 처리 중입니다.', true, { conversationId });
        const turns = existing?.turns ?? [];
        state.conversations.set(conversationId, { turns, lock: { token: conversationToken, until: new Date(now().getTime() + 15 * 60_000).toISOString() } });
        return { turns, created: !existing };
      });
      let completed = false;
      try {
        let prepared;
        try {
          prepared = await runner.prepare({ userId, message: body.message, requestId: body.requestId, conversationId,
            timezone: body.timezone, history: reserved.turns, coordinationTarget: body.coordinationTarget });
          modelStatus = 'available';
        } catch (error) {
          if (!(error instanceof AgentExecutionFailure)) throw error;
          modelStatus = 'degraded';
          throw new RetryableChatProviderError('AI 요청을 처리하지 못했습니다.');
        }
        const result = await control.finalize(() => store.atomic(userId, async () => {
          const conversation = (await store.read(userId)).conversations.get(conversationId);
          if (conversation?.lock?.token !== conversationToken || Date.parse(conversation.lock.until) <= now().getTime()) {
            throw new ApiError(409, 'operation_in_progress', '이 대화의 실행 권한이 만료되었습니다.', true, { conversationId });
          }
          const agentResult = await runner.finish(prepared);
          await store.transaction(userId, state => {
            const current = state.conversations.get(conversationId)!;
            current.turns = [...current.turns, { role: 'user' as const, content: body.message }, { role: 'assistant' as const, content: agentResult.message }].slice(-20);
            delete current.lock;
          });
          return { status: 200, body: { requestId: body.requestId, data: { conversationId, result: agentResult } } };
        }));
        completed = true;
        return result;
      } finally {
        if (!completed) await store.transaction(userId, state => {
          const current = state.conversations.get(conversationId);
          if (current?.lock?.token !== conversationToken) return;
          if (reserved.created && !current.turns.length) state.conversations.delete(conversationId);
          else delete current.lock;
        });
      }
    });
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/schedule', async request => {
    const query = parse(scheduleQuery, request.query);
    return { requestId: request.id, data: await planning.listSchedule(authenticated.get(request)!, query) };
  });
  app.get('/v1/memory', async request => {
    const query = parse(memoryQuery, request.query);
    return { requestId: request.id, data: await planning.listMemory(authenticated.get(request)!, query.at) };
  });
  app.get('/v1/review-schedule', async request => ({ requestId: request.id, data: await planning.getReviewSchedule(authenticated.get(request)!) }));
  app.get('/v1/proposals', async request => ({ requestId: request.id, data: await planning.listProposals(authenticated.get(request)!, parse(proposalQuery, request.query)) }));
  app.get('/v1/proposals/:id', async request => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    return { requestId: request.id, data: await planning.getProposal(authenticated.get(request)!, id) };
  });
  app.post('/v1/schedule/commands', async (request, reply) => {
    const result = await runIdempotent(request, 'schedule_command', async () => {
      const body = parse(commandBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.command(authenticated.get(request)!, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/schedule/:id/checkin', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const result = await runIdempotent(request, 'schedule_checkin', async () => {
      const body = parse(checkinBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.checkin(authenticated.get(request)!, id, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/memory', async (request, reply) => {
    const result = await runIdempotent(request, 'memory_write', async () => {
      const body = parse(memoryBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.saveMemory(authenticated.get(request)!, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/review-schedule', async (request, reply) => {
    const result = await runIdempotent(request, 'review_schedule_write', async () => {
      const body = parse(reviewBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.saveReviewSchedule(authenticated.get(request)!, body) } };
    });
    if (result.status === 200 && options.onReviewScheduleChanged) {
      try { await options.onReviewScheduleChanged(); } catch { /* saved setting remains authoritative; capability reports scheduler state */ }
    }
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/proposals/:id/decision', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const result = await runIdempotent(request, 'proposal_decision', async () => {
      const body = parse(decisionBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.decideProposal(authenticated.get(request)!, id, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/recipients', async (request, reply) => {
    const result = await runIdempotent(request, 'recipient_create', async () => {
      const body = parse(recipientBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await contacts.createRecipient(authenticated.get(request)!, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/contact-requests', async (request, reply) => {
    const result = await runIdempotent(request, 'contact_request_create', async () => {
      const body = parse(contactBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await contacts.create(authenticated.get(request)!, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  // Newest 100 requests; this bounded endpoint intentionally has no cursor.
  app.get('/v1/contact-requests', async request => {
    const { proposalId } = parse(contactListQuery, request.query);
    return { requestId: request.id, data: await contacts.list(authenticated.get(request)!, proposalId) };
  });
  app.get('/v1/contact-requests/:id', async request => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    return { requestId: request.id, data: await contacts.get(authenticated.get(request)!, id) };
  });
  app.post('/v1/contact-requests/:id/decision', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const result = await runIdempotent(request, 'contact_decision', async () => {
      const body = parse(contactDecisionBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await contacts.decide(authenticated.get(request)!, id, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/contact-requests/:id/send', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const body = parse(contactSendBody, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !nonblank.safeParse(key).success) throw invalidRequest();
    const result = await contactDispatch.send(authenticated.get(request)!, id, body, key);
    return reply.code(result.status).send(result.body);
  });
  return Object.assign(app, { reviewRuntime });
}
