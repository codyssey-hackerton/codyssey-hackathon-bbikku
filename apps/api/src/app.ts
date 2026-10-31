import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { AgentExecutionFailure, type ModelPort } from './agent.ts';
import { PlanningAgentRunner } from './agent-runner.ts';
import { chatContext } from './chat-context.ts';
import { createExternalTools } from './external-tools.ts';
import { createExternalAccountTools } from './external-account-tools.ts';
import type { SessionResolver } from './auth.ts';
import type { MemberAuth } from './member-auth.ts';
import { registerMemberAuthRoutes } from './member-auth-routes.ts';
import type { RoutineService } from './routine-service.ts';
import { registerRoutineRoutes } from './routine-routes.ts';
import type { CalendarSyncService } from './calendar-sync.ts';
import { registerCalendarSyncRoutes } from './calendar-sync-routes.ts';
import type { createGoogleOAuth } from './google-oauth.ts';
import { MemoryIdempotency, RepositoryIdempotency, type HttpResult, type IdempotencyControl, type IdempotencyPort } from './idempotency.ts';
import { MODEL_ID, REASONING_EFFORT } from './model.ts';
import { PlanningError, PlanningService } from './planning-service.ts';
import { createPreparationProposal } from './preparation-service.ts';
import { getCalendarConnection } from './google-calendar.ts';
import { CalendarImportService } from './calendar-import.ts';
import type { createKakaoPlaces } from './kakao-places.ts';
import type { createKakaoTravel } from './kakao-travel.ts';
import type { createOpenMeteo } from './open-meteo.ts';
import type { createSeoulSubway } from './seoul-subway.ts';
import { PhoneConnections, validPhoneNumber } from './phone-connection.ts';
import { managedCallBindingKey, PhoneDispatch } from './phone-dispatch.ts';
import { createClawOpsReplies } from './clawops-replies.ts';
import { createManagedCallWatch } from './clawops-call-watch.ts';
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
import { attendanceBody, checkinBody, commandBody, decisionBody, identifier, memoryBody, memoryQuery, proposalQuery, scheduleQuery, timestamp, timezone, undoBody } from './planning-schemas.ts';

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
  entryContext: chatContext.optional(),
}).strict().refine(value => !(value.coordinationTarget && value.entryContext));
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
const travelPoint = z.object({ longitude: z.number().finite().min(-180).max(180), latitude: z.number().finite().min(-90).max(90) }).strict();
const travelBody = z.object({ origin: travelPoint, destination: travelPoint, mode: z.string().min(1).max(30), departureAt: z.string().max(100).optional() }).strict();
const weatherBody = z.object({ destination: travelPoint, appointmentAt: timestamp }).strict();
const subwayBody = z.object({ stationName: z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f/\\?#]/.test(value) && value !== '.' && value !== '..') }).strict();
const calendarImportBody = calendarQuery.extend({ requestId: identifier, selectedEvents: z.array(z.object({ id: identifier, etag: identifier }).strict()).min(1).max(100), expectedScheduleRevision: z.number().int().min(0) }).strict();
const phoneNumber = z.string().refine(validPhoneNumber);
const phoneConnectBody = z.union([
  z.object({ requestId: identifier, accountSid: identifier, authToken: identifier, fromNumber: phoneNumber }).strict(),
  z.object({ requestId: identifier, provider: z.literal('clawops'), accountId: identifier,
    mode: z.literal('voiceml').optional(), apiKey: z.string().min(1).max(1024), signingSecret: z.string().min(1).max(1024), fromNumber: phoneNumber }).strict(),
  z.object({ requestId: identifier, provider: z.literal('clawops'), mode: z.literal('agent'), accountId: identifier,
    apiKey: z.string().min(1).max(1024), agentId: identifier, fromNumber: phoneNumber }).strict(),
]);
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

export function buildApp(options: { memberAuth?: MemberAuth; memberAllowLocalInsecure?: boolean; routineService?: RoutineService; calendarSync?: CalendarSyncService; previewRateLimit?: boolean; webOrigins?: string[]; trustLoopbackProxy?: boolean; sessions?: SessionResolver; model?: ModelPort; store?: PlanningStore; clock?: () => Date; idempotency?: IdempotencyPort; gmailContact?: GmailContactPort; gmailReplyConnection?: Awaited<ReturnType<typeof getGmailReplyConnection>>; calendarConnection?: Awaited<ReturnType<typeof getCalendarConnection>>; googleOAuth?: ReturnType<typeof createGoogleOAuth>; places?: ReturnType<typeof createKakaoPlaces>; travel?: ReturnType<typeof createKakaoTravel>; weather?: ReturnType<typeof createOpenMeteo>; subway?: ReturnType<typeof createSeoulSubway>; subwayConfigured?: boolean; placesConfigured?: boolean; travelConfigured?: boolean; phoneConnections?: PhoneConnections; managedCallWatch?: Pick<ReturnType<typeof createManagedCallWatch>, 'start' | 'stop'>; voice?: { publicBaseUrl: string; sessionKey: string; model?: VoiceClassifier }; allowLocalPhoneConnect?: boolean; schedulerStatus?: () => 'not_configured' | 'available' | 'degraded'; onReviewScheduleChanged?: () => Promise<void> } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32_768, routerOptions: { maxParamLength: 2048 }, genReqId: () => randomUUID(), trustProxy: options.trustLoopbackProxy ? ['127.0.0.1', '::1'] : false });
  if (options.previewRateLimit) void app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  if (options.webOrigins?.length) void app.register(cors, {
    origin: options.webOrigins, methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], maxAge: 600,
  });
  const authenticated = new WeakMap<FastifyRequest, string>();
  const store = options.store ?? new MemoryPlanningStore();
  const idempotency = options.idempotency ?? (store.durable ? new RepositoryIdempotency(store, options.clock) : new MemoryIdempotency());
  const reviewIdempotency = store.durable ? idempotency : new RepositoryIdempotency(store, options.clock);
  const planning = new PlanningService(store, options.clock);
  const contacts = new ContactService(store, planning, options.clock);
  const contactResponses = new ContactResponseService(store, planning, options.clock);
  let voiceTokens: VoiceTokens | undefined; let voiceWebhook: VoiceWebhook | undefined;
  if (store.durable && options.phoneConnections && options.voice && (!options.voice.model || typeof options.voice.model.classify === 'function')) {
    try {
      voiceTokens = new VoiceTokens(options.voice.publicBaseUrl, options.voice.sessionKey);
      voiceWebhook = new VoiceWebhook({ store, planning, connections: options.phoneConnections, responseService: contactResponses,
        model: options.voice.model, publicBaseUrl: options.voice.publicBaseUrl, sessionKey: options.voice.sessionKey, clock: options.clock });
    } catch { voiceTokens = undefined; voiceWebhook = undefined; }
  }
  const phoneDispatch = options.phoneConnections ? new PhoneDispatch(store, planning, options.phoneConnections, options.clock, voiceTokens,
    typeof options.voice?.model?.classify === 'function') : undefined;
  const managedCallWatch = store.durable && options.phoneConnections
    ? options.managedCallWatch ?? createManagedCallWatch({ store, connections: options.phoneConnections }) : undefined;
  app.addHook('onClose', async () => { await managedCallWatch?.stop(); });
  const phoneProvider = async (userId: string): Promise<'twilio' | 'clawops' | 'clawops_agent' | null> => {
    if (!store.durable) return null;
    const connection = await options.phoneConnections?.status(userId);
    if (connection?.status !== 'available') return null;
    if (connection.provider === 'clawops' && connection.mode === 'agent') return 'clawops_agent';
    if (!voiceWebhook || !voiceTokens) return null;
    if (connection.provider === 'clawops') return 'clawops';
    return typeof options.voice?.model?.classify === 'function' ? 'twilio' : null;
  };
  const phoneReady = async (userId: string) => (await phoneProvider(userId)) !== null;
  const googleFor = async (userId: string) => {
    const current = await options.googleOAuth?.connections(userId) ?? {};
    return { gmailContact: current.gmailContact ?? (!current.blocked?.gmailContact && options.gmailContact?.userId === userId ? options.gmailContact : undefined),
      gmailReplyConnection: current.gmailReplyConnection ?? (!current.blocked?.gmailReplyConnection && !current.gmailContact && options.gmailReplyConnection?.userId === userId ? options.gmailReplyConnection : undefined),
      calendarConnection: current.calendarConnection ?? (!current.blocked?.calendarConnection && options.calendarConnection?.userId === userId ? options.calendarConnection : undefined) };
  };
  const gmailRepliesFor = async (userId: string) => {
    const connection = (await googleFor(userId)).gmailReplyConnection;
    return store.durable && connection?.userId === userId && typeof connection.checkReplies === 'function' &&
      z.email().max(254).safeParse(connection.senderAddress).success ? connection : undefined;
  };
  const feature = (configured: boolean) => ({ status: configured ? 'configured' as const : 'not_configured' as const, access: 'app' as const });
  const agentCapabilities = async (userId: string) => {
    const schedulerStatus = options.schedulerStatus?.();
    const google = await googleFor(userId);
    return {
    calendar: feature(google.calendarConnection?.userId === userId),
    email: feature(gmailAvailable(store, google.gmailContact, userId)),
    emailReplies: feature(!!await gmailRepliesFor(userId)),
    phone: feature(await phoneReady(userId)),
    places: feature(!!options.places && options.placesConfigured === true),
    weather: feature(!!options.weather), subway: feature(!!options.subway && options.subwayConfigured === true),
    travelTime: { ...feature(!!options.travel && options.travelConfigured === true), modes: ['walk', 'transit', 'car'] as Array<'walk' | 'transit' | 'car'>,
      scheduledDeparture: 'unsupported' as const },
    scheduler: { status: schedulerStatus === 'available' ? 'configured' as const : schedulerStatus === 'degraded' ? 'degraded' as const : 'not_configured' as const,
      access: 'app' as const },
    };
  };
  const runner = options.model ? new PlanningAgentRunner(planning, options.model, agentCapabilities, async userId => {
    const google = await googleFor(userId);
    return [
      ...createExternalTools(userId, { places: options.placesConfigured ? options.places : undefined,
        travel: options.travelConfigured ? options.travel : undefined, weather: options.weather,
        subway: options.subwayConfigured ? options.subway : undefined, clock: options.clock }),
      ...createExternalAccountTools(userId, { calendarConnection: google.calendarConnection,
        gmailReplyConnection: await gmailRepliesFor(userId), store, clock: options.clock }),
    ];
  }) : undefined;
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
            const retryable = agentResult.kind === 'failure' && ['stale_proposal', 'stale_snapshot', 'external_data_expired'].includes(agentResult.code);
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
    if (request.method === 'GET' && request.routeOptions.url === '/v1/google/oauth/callback') return;
    if (request.method === 'POST' && ['/v1/auth/google/start', '/v1/auth/google/complete'].includes(request.routeOptions.url ?? '')) return;
    // Only provider callbacks bypass session auth; each verifies its signature and bound call.
    if (request.method === 'POST' && ['/v1/voice/twilio/:token', '/v1/voice/clawops/:token'].includes(request.routeOptions.url ?? '')) return;
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    let memberUnavailable = false;
    let session: Awaited<ReturnType<SessionResolver['resolve']>> = null;
    if (match) {
      try { session = await options.memberAuth?.resolve(match[1]) ?? null; }
      catch { memberUnavailable = true; }
      if (!session) session = await options.sessions?.resolve(match[1]) ?? null;
    }
    if (!session && memberUnavailable) throw new ApiError(503, 'provider_unavailable', '회원 인증 저장소에 연결할 수 없습니다.', true);
    if (!session || !session.userId) throw new ApiError(401, 'unauthenticated', '인증이 필요합니다.');
    authenticated.set(request, session.userId);
  });

  const memberGuard = options.memberAuth ? registerMemberAuthRoutes(app, options.memberAuth,
    { allowLocalInsecure: options.memberAllowLocalInsecure }) : undefined;
  if (!options.memberAuth) {
    const unavailable = () => { throw new ApiError(503, 'not_configured', '회원 인증 저장소가 준비되지 않았습니다.'); };
    app.post('/v1/auth/google/start', unavailable);
    app.post('/v1/auth/google/complete', unavailable);
    app.get('/v1/auth/me', unavailable);
    app.post('/v1/auth/logout', unavailable);
  }
  registerRoutineRoutes(app, { service: options.routineService, resolveUser: request => authenticated.get(request) });
  if (options.calendarSync) registerCalendarSyncRoutes(app, { service: options.calendarSync, resolveUser: request => authenticated.get(request)!, idempotency });
  else {
    const unavailable = () => { throw new ApiError(503, 'not_configured', '캘린더 동기화 저장소가 준비되지 않았습니다.'); };
    app.get('/v1/calendar-sync', unavailable);
    app.get('/v1/calendar-sync/calendars', unavailable);
    app.get('/v1/calendar-sync/operations/:requestId', unavailable);
    for (const path of ['/v1/calendar-sync/connect', '/v1/calendar-sync/:id/run', '/v1/calendar-sync/:id/exports', '/v1/calendar-sync/:id/disconnect']) app.post(path, unavailable);
  }

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
    for (const voiceProvider of ['twilio', 'clawops'] as const) provider.post(`/v1/voice/${voiceProvider}/:token`, async (request, reply) => {
      if (!voiceWebhook) throw new ApiError(503, 'not_configured', '양방향 전화 연결이 설정되지 않았습니다.');
      const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/) }).strict(), request.params);
      const signature = request.headers[voiceProvider === 'twilio' ? 'x-twilio-signature' : 'x-signature'];
      const contentType = request.headers['content-type'];
      const rawUrl = request.raw.url ?? ''; const queryIndex = rawUrl.indexOf('?');
      const result = await voiceWebhook.handle({ provider: voiceProvider, token, rawQuery: queryIndex < 0 ? '' : rawUrl.slice(queryIndex),
        contentType: typeof contentType === 'string' ? contentType : '', signature: typeof signature === 'string' ? signature : '',
        params: request.body as Record<string, string | string[]> });
      return reply.code(result.status).type(voiceProvider === 'clawops' ? 'application/xml' : 'text/xml').send(result.twiml);
    });
  });
  app.get('/health', async request => ({ requestId: request.id, data: { status: 'ok' } }));
  app.get('/v1/capabilities', async request => ({
    requestId: request.id,
    data: {
      storage: { mode: planning.store.mode, durable: planning.store.durable },
      model: { id: MODEL_ID, reasoningEffort: REASONING_EFFORT, status: modelStatus },
      integrations: { calendar: (await googleFor(authenticated.get(request)!)).calendarConnection ? 'available' : 'not_configured', email: gmailAvailable(store, (await googleFor(authenticated.get(request)!)).gmailContact, authenticated.get(request)!) ? 'available' : 'not_configured', phone: await phoneReady(authenticated.get(request)!) ? 'available' : 'not_configured', travel: options.travel && options.travelConfigured === true ? 'available' : 'not_configured' },
      scheduler: { status: options.schedulerStatus?.() ?? 'not_configured' },
    },
  }));
  app.get('/v1/email-connection', async request => {
    const connection = (await googleFor(authenticated.get(request)!)).gmailContact;
    const available = gmailAvailable(store, connection, authenticated.get(request)!);
    return { requestId: request.id, data: { status: available ? 'available' : 'not_configured', senderAddress: available ? connection.senderAddress : null } };
  });
  app.get('/v1/email-reply-connection', async request => {
    const connection = await gmailRepliesFor(authenticated.get(request)!);
    return { requestId: request.id, data: { status: connection ? 'available' : 'not_configured', senderAddress: connection?.senderAddress ?? null } };
  });
  const calendarFor = async (userId: string) => {
    const connection = (await googleFor(userId)).calendarConnection;
    if (!connection || connection.userId !== userId) throw new ApiError(503, 'not_configured', '캘린더 연결이 설정되지 않았습니다.');
    return connection;
  };
  app.get('/v1/calendar-connection', async request => {
    const connection = (await googleFor(authenticated.get(request)!)).calendarConnection;
    return { requestId: request.id, data: { status: connection ? 'available' : 'not_configured', accountLabel: connection?.accountLabel ?? null } };
  });
  app.get('/v1/calendar/calendars', async request => ({ requestId: request.id, data: await (await calendarFor(authenticated.get(request)!)).listCalendars() }));
  app.get('/v1/calendar/events', async request => ({ requestId: request.id, data: await (await calendarFor(authenticated.get(request)!)).listEvents(parse(calendarQuery, request.query)) }));
  app.get('/v1/calendar-write-connection', async request => {
    const userId = authenticated.get(request)!;
    const connection = (await options.googleOAuth?.connections(userId))?.calendarWriteConnection;
    return { requestId: request.id, data: { status: connection?.userId === userId ? 'available' : 'not_configured',
      accountLabel: connection?.userId === userId ? connection.accountLabel : null } };
  });
  app.post('/v1/google/oauth/start', async (request, reply) => {
    const body = parse(z.object({ kind: z.enum(['calendar', 'calendar_write', 'gmail_send', 'gmail_read']) }).strict(), request.body);
    let result: Awaited<ReturnType<NonNullable<typeof options.googleOAuth>['start']>>;
    try { result = await options.googleOAuth?.start(authenticated.get(request)!, body.kind); }
    catch { throw new ApiError(503, 'not_configured', 'Google 연결이 설정되지 않았습니다.'); }
    if (!result) throw new ApiError(503, 'not_configured', 'Google 연결이 설정되지 않았습니다.');
    reply.header('Cache-Control', 'no-store');
    return { requestId: request.id, data: result };
  });
  app.get('/v1/google/oauth/callback', { onRequest: async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    if (options.memberAuth?.ownsState(query?.state)) return memberGuard?.(request, reply);
  } }, async (request, reply) => {
    const query = z.object({ state: z.string().regex(/^(?:member_)?[A-Za-z0-9_-]{43}$/), code: z.string().max(2048).optional() }).safeParse(request.query);
    const confirmationCode = !query.success ? undefined : options.memberAuth?.ownsState(query.data.state)
      ? await options.memberAuth.callback(query.data.state, query.data.code ?? '')
      : await options.googleOAuth?.callback(query.data.state, query.data.code ?? '');
    return reply.code(confirmationCode ? 200 : 400).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'").type('text/plain; charset=utf-8')
      .send(confirmationCode ? `앱으로 돌아가 아래 연결 확인 코드를 입력해 주세요.\n\n${confirmationCode}` : 'Google 연결을 완료하지 못했습니다. 앱에서 다시 시도해 주세요.');
  });
  app.post('/v1/google/oauth/complete', async (request, reply) => {
    const body = parse(z.object({ completionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), confirmationCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(), request.body);
    if (!await options.googleOAuth?.complete(authenticated.get(request)!, body.completionSecret, body.confirmationCode)) throw invalidRequest();
    reply.header('Cache-Control', 'no-store');
    return { requestId: request.id, data: { status: 'connected' } };
  });
  app.get('/v1/places/search', async request => {
    const { query } = parse(placesQuery, request.query);
    if (!options.places) throw new ApiError(503, 'not_configured', '장소 검색이 설정되지 않았습니다.');
    const result = await options.places.search(query);
    if (result.ok) return { requestId: request.id, data: { places: result.places } };
    if (result.error === 'invalid_query') throw invalidRequest();
    if (result.error === 'not_configured') throw new ApiError(503, 'not_configured', '장소 검색이 설정되지 않았습니다.');
    throw new ApiError(503, 'provider_unavailable', '장소 검색을 사용할 수 없습니다.', true);
  });
  app.post('/v1/travel/estimate', async request => {
    const body = parse(travelBody, request.body);
    if (!['walk', 'transit', 'car'].includes(body.mode) || body.departureAt !== undefined) {
      throw new ApiError(422, 'unsupported', '이 이동 수단 또는 출발 시각은 지원하지 않습니다.');
    }
    if (!options.travel) throw new ApiError(503, 'not_configured', '이동시간 조회가 설정되지 않았습니다.');
    const result = await options.travel.estimate(body);
    if (result.ok) return { requestId: request.id, data: { durationMinutes: result.durationMinutes, provider: result.provider,
      fetchedAt: result.fetchedAt, expiresAt: result.expiresAt, mode: body.mode } };
    if (result.error === 'invalid_request') throw invalidRequest();
    if (result.error === 'unsupported') throw new ApiError(422, 'unsupported', '이 이동 수단 또는 출발 시각은 지원하지 않습니다.');
    if (result.error === 'no_route') throw new ApiError(404, 'no_route', '이동 경로를 찾지 못했습니다.');
    if (result.error === 'not_configured') throw new ApiError(503, 'not_configured', '이동시간 조회가 설정되지 않았습니다.');
    throw new ApiError(503, 'provider_unavailable', '이동시간을 조회할 수 없습니다.', true);
  });
  app.post('/v1/weather/forecast', async request => {
    const body = parse(weatherBody, request.body);
    if (!options.weather) throw new ApiError(503, 'unavailable', '날씨 조회를 사용할 수 없습니다.', true);
    const result = await options.weather.forecast(body);
    if (result.ok) {
      const remainingTtlMs = Math.max(0, Math.min(300_000, Date.parse(result.forecast.expiresAt) - now().getTime()));
      return { requestId: request.id, data: { ...result.forecast, remainingTtlMs } };
    }
    if (result.error === 'invalid_request') throw invalidRequest();
    if (result.error === 'unsupported_range') throw new ApiError(422, 'unsupported_range', '해당 시각의 예보를 제공하지 않습니다.');
    if (result.error === 'timeout') throw new ApiError(504, 'timeout', '날씨 조회 시간이 초과되었습니다.', true);
    if (result.error === 'invalid_response') throw new ApiError(502, 'invalid_response', '날씨 응답을 확인할 수 없습니다.', true);
    throw new ApiError(503, 'unavailable', '날씨 조회를 사용할 수 없습니다.', true);
  });
  app.post('/v1/subway/arrivals', async request => {
    const body = parse(subwayBody, request.body);
    if (!options.subway) throw new ApiError(503, 'not_configured', '지하철 도착 조회가 설정되지 않았습니다.');
    const result = await options.subway.arrivals(body);
    if (result.ok) {
      const { ok: _ok, ...data } = result;
      return { requestId: request.id, data };
    }
    if (result.error === 'invalid_request') throw invalidRequest();
    if (result.error === 'not_configured') throw new ApiError(503, 'not_configured', '지하철 도착 조회가 설정되지 않았습니다.');
    if (result.error === 'timeout') throw new ApiError(504, 'timeout', '지하철 도착 조회 시간이 초과되었습니다.', true);
    if (result.error === 'invalid_response') throw new ApiError(502, 'invalid_response', '지하철 도착 응답을 확인할 수 없습니다.', true);
    if (result.error === 'rate_limited') throw new ApiError(429, 'rate_limited', '지하철 조회 한도에 도달했습니다.', true);
    throw new ApiError(503, 'unavailable', '지하철 도착 조회를 사용할 수 없습니다.', true);
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
      const service = new CalendarImportService(store, await calendarFor(userId));
      const prepared = await service.prepareSelected({ ...body, userId });
      return control.finalize(async () => ({ status: 200, body: { requestId: body.requestId, data: await service.commitPrepared(prepared) } }));
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/contact-requests/:id/call', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params); const body = parse(phoneCallBody, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !nonblank.safeParse(key).success) throw invalidRequest();
    const userId = authenticated.get(request)!;
    const currentProvider = await phoneProvider(userId);
    if (!phoneDispatch || !currentProvider) throw new ApiError(503, 'not_configured', '양방향 전화 연결이 설정되지 않았습니다.');
    const result = await phoneDispatch.call(userId, id, body, key, currentProvider);
    const contact = (result.body as { data?: { contactRequest?: { id?: string; deliveryStatus?: string; providerOperationId?: string | null } } })?.data?.contactRequest;
    if (currentProvider === 'clawops_agent' && result.status === 200 && contact?.id === id &&
        contact.deliveryStatus === 'sent_or_connected' && contact.providerOperationId) {
      try { managedCallWatch?.start(userId, id); } catch { /* The call was already sent; do not report a dispatch failure. */ }
    }
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
            timezone: body.timezone, history: reserved.turns, coordinationTarget: body.coordinationTarget, entryContext: body.entryContext });
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
            current.turns = [...current.turns, { role: 'user' as const, content: body.message }, { role: 'assistant' as const, content: agentResult.message,
              ...(prepared.baseline.externalExpiresAt ? { externalExpiresAt: prepared.baseline.externalExpiresAt } : {}) }].slice(-20);
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
  app.post('/v1/schedule/:id/attendance', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const result = await runIdempotent(request, 'schedule_attendance', async () => {
      const body = parse(attendanceBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.attendance(authenticated.get(request)!, id, body) } };
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/schedule/:id/undo', async (request, reply) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const result = await runIdempotent(request, 'schedule_undo', async () => {
      const body = parse(undoBody, request.body);
      return { status: 200, body: { requestId: body.requestId, data: await planning.undo(authenticated.get(request)!, id, body) } };
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
    const connection = await gmailRepliesFor(userId);
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
  app.post('/v1/contact-requests/:id/check-call', async (request, reply) => {
    if (!store.durable || !options.phoneConnections) throw new ApiError(503, 'not_configured', '전화 연결과 지속 저장소가 필요합니다.');
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const body = parse(checkRepliesBody, request.body); const userId = authenticated.get(request)!;
    const connections = options.phoneConnections;
    const result = await runIdempotent(request, 'contact_call_check', async (_requestBody, control) => {
      const state = await store.read(userId); const snapshot = state.contactRequests.get(id);
      if (!snapshot) throw new ApiError(404, 'not_found', '연락 요청을 찾을 수 없습니다.');
      if (snapshot.revision !== body.contactRevision || snapshot.channel !== 'phone' || snapshot.deliveryStatus !== 'sent_or_connected' || !snapshot.providerOperationId) {
        throw new ApiError(409, 'conflict', '발신한 전화와 연락 요청 버전을 확인해 주세요.');
      }
      const credential = await connections.read(userId).catch(() => undefined);
      if (!credential || credential.provider !== 'clawops' || credential.mode !== 'agent') throw new ApiError(503, 'not_configured', '관리형 전화 연결이 필요합니다.');
      const binding = { contactId: id, accountId: credential.accountId, agentId: credential.agentId, fromNumber: credential.fromNumber, mode: 'agent' };
      if (!isDeepStrictEqual(state.voiceSessions.get(managedCallBindingKey(snapshot.executionKey)), binding)) throw new ApiError(409, 'conflict', '발신 당시 전화 연결을 확인할 수 없습니다.');
      const lookup = await createClawOpsReplies({ accountId: credential.accountId, apiKey: credential.apiKey, fetch: connections.fetcher }).check({
        callId: snapshot.providerOperationId, fromNumber: credential.fromNumber, toNumber: snapshot.recipientSnapshot.address, createdAt: snapshot.createdAt,
      });
      if (!lookup.ok) {
        if (lookup.error === 'provider_unavailable') return { ...errorResult(new ApiError(503, 'provider_unavailable', '통화 내용을 확인할 수 없습니다.', true), body.requestId), retryableWithoutEffects: true };
        throw new ApiError(409, 'conflict', '발신한 통화와 연결을 확인할 수 없습니다.');
      }
      return control.finalize(async () => {
        const currentState = await store.read(userId);
        const latestCredential = await connections.read(userId).catch(() => undefined);
        if (!isDeepStrictEqual(currentState.contactRequests.get(id), snapshot) || !isDeepStrictEqual(latestCredential, credential) ||
            !isDeepStrictEqual(currentState.voiceSessions.get(managedCallBindingKey(snapshot.executionKey)), binding)) {
          throw new ApiError(409, 'conflict', '통화 조회 중 연락 요청 또는 연결이 변경되었습니다.');
        }
        const userEvents = lookup.events.filter(event => event.role === 'user');
        const text = lookup.events.map(event => `${event.role === 'user' ? '상대' : 'AI'}: ${event.text}`).join('\n');
        const clipped = text.slice(0, 2000).replace(/[\ud800-\udbff]$/, '');
        const truncated = lookup.truncated || clipped.length < text.length;
        const eventId = `clawops-${createHash('sha256').update(snapshot.providerOperationId!).digest('hex')}`;
        const prior = currentState.contactResponses.get(JSON.stringify(['phone', eventId]));
        if (lookup.complete && !truncated && userEvents.length && clipped.trim() && !prior && snapshot.negotiationStatus === 'awaiting_response') {
          await contactResponses.recordVerified(userId, id, { providerEventId: eventId, providerOperationId: snapshot.providerOperationId!,
            channel: 'phone', recipientAddress: snapshot.recipientSnapshot.address, receivedAt: userEvents[userEvents.length - 1]!.receivedAt,
            outcome: 'unclear', selectedOptionId: null, evidenceRef: eventId, displayText: clipped, reviewReason: 'voice_transcript_unverified' });
        }
        return { status: 200, body: { requestId: body.requestId, data: { ...await contactResponses.list(userId, id),
          checkedCount: lookup.events.length, unmatchedCount: 0, callStatus: lookup.callStatus, complete: lookup.complete && !truncated, truncated } } };
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
    const userId = authenticated.get(request)!;
    const contactDispatch = new ContactDispatch(store, planning, (await googleFor(userId)).gmailContact, options.clock);
    const result = await contactDispatch.send(userId, id, body, key);
    return reply.code(result.status).send(result.body);
  });
  });
  return Object.assign(app, { reviewRuntime });
}
