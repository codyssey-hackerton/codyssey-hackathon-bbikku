import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { AgentExecutionFailure, type ModelPort } from './agent.ts';
import { PlanningAgentRunner } from './agent-runner.ts';
import type { SessionResolver } from './auth.ts';
import { MemoryIdempotency, RepositoryIdempotency, type HttpResult, type IdempotencyControl, type IdempotencyPort } from './idempotency.ts';
import { MODEL_ID, REASONING_EFFORT } from './model.ts';
import { PlanningError, PlanningService } from './planning-service.ts';
import { createPreparationProposal } from './preparation-service.ts';
import { getCalendarConnection } from './google-calendar.ts';
import { CalendarImportService } from './calendar-import.ts';
import type { createKakaoPlaces } from './kakao-places.ts';
import { PhoneConnections, validPhoneNumber } from './phone-connection.ts';
import { PhoneDispatch } from './phone-dispatch.ts';
import { VoiceTokens } from './voice-token.ts';
import { VoiceWebhook } from './voice-webhook.ts';
import type { VoiceClassifier } from './voice-model.ts';
import { ContactService } from './contact-service.ts';
import { ContactResponseService } from './contact-response.ts';
import type { getGmailReplyConnection } from './gmail-reply-connection.ts';
import { ContactDispatch, gmailAvailable, type GmailContactPort } from './contact-dispatch.ts';
import { recipientBody, contactBody, contactDecisionBody } from './contact-schemas.ts';
import { MemoryPlanningStore, type PlanningStore, type UserPlanningState } from './planning-store.ts';
import { buildReviewEvents, type ReviewSchedulerRuntime, type TriggerEvent } from './scheduler.ts';
import { checkinBody, commandBody, decisionBody, identifier, memoryBody, memoryQuery, proposalQuery, scheduleQuery, timestamp, timezone } from './planning-schemas.ts';

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
const checkRepliesBody = z.object({ requestId: identifier, contactRevision: z.number().int().min(1) }).strict();
const confirmResponseBody = checkRepliesBody.extend({ selectedOptionId: identifier }).strict();
const preparationMinutes = z.number().finite().nonnegative().refine(value => Number.isSafeInteger(value * 60_000));
const preparationBody = z.object({ requestId: identifier, targetId: identifier, expectedTargetRevision: z.number().int().min(1), expectedScheduleRevision: z.number().int().min(0), timezone, preparationMinutes, travelMinutes: preparationMinutes, bufferMinutes: preparationMinutes }).strict();
const calendarQuery = z.object({ calendarId: identifier, from: timestamp, to: timestamp }).strict();
const placesQuery = z.object({ query: z.string().trim().min(1).max(100) }).strict();
const calendarImportBody = calendarQuery.extend({ requestId: identifier, selectedEvents: z.array(z.object({ id: identifier, etag: identifier }).strict()).min(1).max(100), expectedScheduleRevision: z.number().int().min(0) }).strict();
const phoneNumber = z.string().refine(validPhoneNumber);
const phoneConnectBody = z.object({ requestId: identifier, accountSid: identifier, authToken: identifier, fromNumber: phoneNumber }).strict();
const phoneCallBody = z.object({ requestId: identifier, contactRevision: z.number().int().min(1), expectedSenderNumber: phoneNumber }).strict();

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

export function buildApp(options: { previewRateLimit?: boolean; webOrigins?: string[]; trustLoopbackProxy?: boolean; sessions?: SessionResolver; model?: ModelPort; store?: PlanningStore; clock?: () => Date; idempotency?: IdempotencyPort; gmailContact?: GmailContactPort; gmailReplyConnection?: Awaited<ReturnType<typeof getGmailReplyConnection>>; calendarConnection?: Awaited<ReturnType<typeof getCalendarConnection>>; places?: ReturnType<typeof createKakaoPlaces>; phoneConnections?: PhoneConnections; voice?: { publicBaseUrl: string; sessionKey: string; model: VoiceClassifier }; allowLocalPhoneConnect?: boolean; schedulerStatus?: () => 'not_configured' | 'available' | 'degraded'; onReviewScheduleChanged?: () => Promise<void> } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32_768, routerOptions: { maxParamLength: 2048 }, genReqId: () => randomUUID(), trustProxy: options.trustLoopbackProxy ? ['127.0.0.1', '::1'] : false });
  if (options.previewRateLimit) void app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  if (options.webOrigins?.length) void app.register(cors, {
    origin: options.webOrigins, methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], maxAge: 600,
  });
  const authenticated = new WeakMap<FastifyRequest, string>();
  const store = options.store ?? new MemoryPlanningStore();
  const idempotency = options.idempotency ?? (store.durable ? new RepositoryIdempotency(store, options.clock) : new MemoryIdempotency());
  const reviewIdempotency = store.durable ? idempotency : new RepositoryIdempotency(store, options.clock);
  const planning = new PlanningService(store, options.clock);
  const contacts = new ContactService(store, planning, options.clock);
  const contactResponses = new ContactResponseService(store, planning, options.clock);
  const contactDispatch = new ContactDispatch(store, planning, options.gmailContact, options.clock);
  let voiceTokens: VoiceTokens | undefined; let voiceWebhook: VoiceWebhook | undefined;
  if (store.durable && options.phoneConnections && options.voice && typeof options.voice.model?.classify === 'function') {
    try {
      voiceTokens = new VoiceTokens(options.voice.publicBaseUrl, options.voice.sessionKey);
      voiceWebhook = new VoiceWebhook({ store, planning, connections: options.phoneConnections, responseService: contactResponses,
        model: options.voice.model, publicBaseUrl: options.voice.publicBaseUrl, sessionKey: options.voice.sessionKey, clock: options.clock });
    } catch { voiceTokens = undefined; voiceWebhook = undefined; }
  }
  const phoneDispatch = options.phoneConnections ? new PhoneDispatch(store, planning, options.phoneConnections, options.clock, voiceTokens) : undefined;
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
    const result = status === 429 ? errorResult(new ApiError(429, 'rate_limited', '요청이 많습니다. 잠시 후 다시 시도해 주세요.', true), requestId(request))
      : error instanceof ApiError || error instanceof PlanningError ? errorResult(error, requestId(request))
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
    // This single provider route authenticates with Twilio's signature and bound call SID.
    if (request.method === 'POST' && request.routeOptions.url === '/v1/voice/twilio/:token') return;
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    const session = match && options.sessions ? await options.sessions.resolve(match[1]) : null;
    if (!session || !session.userId) throw new ApiError(401, 'unauthenticated', '인증이 필요합니다.');
    authenticated.set(request, session.userId);
  });

  app.after(() => {
  void app.register(async provider => {
    provider.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, async (_request: FastifyRequest, body: string | Buffer) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (/%(?![0-9a-f]{2})/i.test(text)) throw invalidRequest();
      const params: Record<string, string | string[]> = Object.create(null);
      for (const [key, value] of new URLSearchParams(text)) {
        const previous = params[key];
        params[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
      }
      return params;
    });
    provider.post('/v1/voice/twilio/:token', async (request, reply) => {
      if (!voiceWebhook) throw new ApiError(503, 'not_configured', '양방향 전화 연결이 설정되지 않았습니다.');
      const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/) }).strict(), request.params);
      const signature = request.headers['x-twilio-signature'];
      const contentType = request.headers['content-type'];
      const rawUrl = request.raw.url ?? ''; const queryIndex = rawUrl.indexOf('?');
      const result = await voiceWebhook.handle({ token, rawQuery: queryIndex < 0 ? '' : rawUrl.slice(queryIndex),
        contentType: typeof contentType === 'string' ? contentType : '', signature: typeof signature === 'string' ? signature : '',
        params: request.body as Record<string, string | string[]> });
      return reply.code(result.status).type('text/xml').send(result.twiml);
    });
  });
  app.get('/health', async request => ({ requestId: request.id, data: { status: 'ok' } }));
  app.get('/v1/capabilities', async request => ({
    requestId: request.id,
    data: {
      storage: { mode: planning.store.mode, durable: planning.store.durable },
      model: { id: MODEL_ID, reasoningEffort: REASONING_EFFORT, status: modelStatus },
      integrations: { calendar: options.calendarConnection?.userId === authenticated.get(request) ? 'available' : 'not_configured', email: gmailAvailable(store, options.gmailContact, authenticated.get(request)!) ? 'available' : 'not_configured', phone: voiceWebhook && voiceTokens && (await options.phoneConnections?.status(authenticated.get(request)!))?.status === 'available' ? 'available' : 'not_configured', travel: 'not_configured' },
      scheduler: { status: options.schedulerStatus?.() ?? 'not_configured' },
    },
  }));
  app.get('/v1/email-connection', async request => {
    const available = gmailAvailable(store, options.gmailContact, authenticated.get(request)!);
    return { requestId: request.id, data: { status: available ? 'available' : 'not_configured', senderAddress: available ? options.gmailContact!.senderAddress : null } };
  });
  const gmailRepliesFor = (userId: string) => {
    const connection = options.gmailReplyConnection;
    return store.durable && connection?.userId === userId && typeof connection.checkReplies === 'function' &&
      z.email().max(254).safeParse(connection.senderAddress).success ? connection : undefined;
  };
  app.get('/v1/email-reply-connection', async request => {
    const connection = gmailRepliesFor(authenticated.get(request)!);
    return { requestId: request.id, data: { status: connection ? 'available' : 'not_configured', senderAddress: connection?.senderAddress ?? null } };
  });
  const calendarFor = (userId: string) => {
    if (!options.calendarConnection || options.calendarConnection.userId !== userId) throw new ApiError(503, 'not_configured', '캘린더 연결이 설정되지 않았습니다.');
    return options.calendarConnection;
  };
  app.get('/v1/calendar-connection', async request => {
    const connection = options.calendarConnection?.userId === authenticated.get(request) ? options.calendarConnection : undefined;
    return { requestId: request.id, data: { status: connection ? 'available' : 'not_configured', accountLabel: connection?.accountLabel ?? null } };
  });
  app.get('/v1/calendar/calendars', async request => ({ requestId: request.id, data: await calendarFor(authenticated.get(request)!).listCalendars() }));
  app.get('/v1/calendar/events', async request => ({ requestId: request.id, data: await calendarFor(authenticated.get(request)!).listEvents(parse(calendarQuery, request.query)) }));
  app.get('/v1/places/search', async request => {
    const { query } = parse(placesQuery, request.query);
    if (!options.places) throw new ApiError(503, 'not_configured', '장소 검색이 설정되지 않았습니다.');
    const result = await options.places.search(query);
    if (result.ok) return { requestId: request.id, data: { places: result.places } };
    if (result.error === 'invalid_query') throw invalidRequest();
    if (result.error === 'not_configured') throw new ApiError(503, 'not_configured', '장소 검색이 설정되지 않았습니다.');
    throw new ApiError(503, 'provider_unavailable', '장소 검색을 사용할 수 없습니다.', true);
  });
  app.get('/v1/phone-connection', async request => ({ requestId: request.id, data: await options.phoneConnections?.status(authenticated.get(request)!) ?? { status: 'not_configured', senderNumber: null, lastRequestId: null } }));
  app.post('/v1/phone-connection', async request => {
    if (request.protocol !== 'https' && !options.allowLocalPhoneConnect) throw new ApiError(403, 'permission_denied', '안전한 연결이 필요합니다.');
    if (!options.phoneConnections) throw new ApiError(503, 'not_configured', '전화 연결이 설정되지 않았습니다.');
    if (!store.durable) throw new ApiError(503, 'not_configured', '전화 연결에는 지속 저장소가 필요합니다.');
    const body = parse(phoneConnectBody, request.body);
    const userId = authenticated.get(request)!;
    return { requestId: body.requestId, data: await store.atomic(userId, () => options.phoneConnections!.connect(userId, body, body.requestId)) };
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

  app.post('/v1/calendar/import', async (request, reply) => {
    const result = await runIdempotent(request, 'calendar_import', async (_requestBody, control) => {
      const body = parse(calendarImportBody, request.body); const userId = authenticated.get(request)!;
      const service = new CalendarImportService(store, calendarFor(userId));
      const prepared = await service.prepareSelected({ ...body, userId });
      return control.finalize(async () => ({ status: 200, body: { requestId: body.requestId, data: await service.commitPrepared(prepared) } }));
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/contact-requests/:id/call', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params); const body = parse(phoneCallBody, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !nonblank.safeParse(key).success) throw invalidRequest();
    if (!phoneDispatch || !voiceWebhook || !voiceTokens) throw new ApiError(503, 'not_configured', '양방향 전화 연결이 설정되지 않았습니다.');
    const result = await phoneDispatch.call(authenticated.get(request)!, id, body, key);
    return reply.code(result.status).send(result.body);
  });

  app.post('/v1/chat', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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
  app.post('/v1/preparation-proposals', async (request, reply) => {
    const result = await runIdempotent(request, 'preparation_proposal', async () => {
      const body = parse(preparationBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: { result: await createPreparationProposal(planning, authenticated.get(request)!, body) } } };
    });
    return reply.code(result.status).send(result.body);
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
  app.get('/v1/contact-requests/:id/responses', async request => {
    if (!store.durable) throw new ApiError(503, 'not_configured', '지속 저장소가 필요합니다.');
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    return { requestId: request.id, data: await contactResponses.list(authenticated.get(request)!, id) };
  });
  app.post('/v1/contact-requests/:id/check-replies', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const body = parse(checkRepliesBody, request.body); const userId = authenticated.get(request)!;
    const connection = gmailRepliesFor(userId);
    if (!connection) throw new ApiError(503, 'not_configured', '이메일 회신 연결이 필요합니다.');
    const result = await runIdempotent(request, 'contact_reply_check', async (_requestBody, control) => {
      const snapshot = (await store.read(userId)).contactRequests.get(id);
      if (!snapshot) throw new ApiError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
      if (snapshot.revision !== body.contactRevision || snapshot.channel !== 'email' ||
          snapshot.deliveryStatus !== 'sent_or_connected' || !snapshot.providerOperationId) {
        throw new ApiError(409, 'conflict', '발송한 이메일과 연락 요청 버전을 확인해 주세요.');
      }
      let lookup: Awaited<ReturnType<typeof connection.checkReplies>>;
      try {
        lookup = await connection.checkReplies({ providerOperationId: snapshot.providerOperationId,
          recipientAddress: snapshot.recipientSnapshot.address, expectedSenderAddress: connection.senderAddress });
        if (!Array.isArray(lookup.events) || lookup.events.length > 100 || !Number.isSafeInteger(lookup.unmatchedCount) || lookup.unmatchedCount < 0) throw new Error('Invalid reply lookup');
      } catch {
        return { ...errorResult(new ApiError(503, 'provider_unavailable', '이메일 회신을 확인할 수 없습니다.', true), body.requestId), retryableWithoutEffects: true };
      }
      return control.finalize(async () => {
        const current = (await store.read(userId)).contactRequests.get(id);
        if (!isDeepStrictEqual(current, snapshot)) throw new ApiError(409, 'conflict', '회신 조회 중 연락 요청이 변경되었습니다.');
        for (const event of lookup.events) await contactResponses.recordVerified(userId, id, event);
        return { status: 200, body: { requestId: body.requestId, data: { ...await contactResponses.list(userId, id),
          checkedCount: lookup.events.length, unmatchedCount: lookup.unmatchedCount } } };
      });
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/contact-requests/:id/responses/:responseId/confirm', async (request, reply) => {
    if (!store.durable) throw new ApiError(503, 'not_configured', '지속 저장소가 필요합니다.');
    const { id, responseId } = parse(z.object({ id: identifier, responseId: identifier }).strict(), request.params);
    const body = parse(confirmResponseBody, request.body);
    const result = await runIdempotent(request, 'contact_response_confirm', async () => ({ status: 200,
      body: { requestId: body.requestId, data: await contactResponses.confirm(authenticated.get(request)!, id,
        { responseId, contactRevision: body.contactRevision, selectedOptionId: body.selectedOptionId }) } }));
    return reply.code(result.status).send(result.body);
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
  });
  return Object.assign(app, { reviewRuntime });
}
