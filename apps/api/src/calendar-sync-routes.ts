import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CalendarSyncService } from './calendar-sync.ts';
import type { HttpResult, IdempotencyPort } from './idempotency.ts';
import { PlanningError } from './planning-service.ts';

const identifier = z.string().min(1).max(1024).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value));
const requestId = identifier.max(200);
const params = z.object({ id: identifier }).strict();
const operationParams = z.object({ requestId }).strict();
const connect = z.object({ requestId, calendarId: identifier, allowDeletes: z.boolean().optional(), exportItemIds: z.array(identifier).max(100).optional() }).strict();
const change = z.object({ requestId, expectedRevision: z.number().int().min(1).safe() }).strict();
const exportsBody = change.extend({ exportItemIds: z.array(identifier).min(1).max(100) }).strict();
const invalid = () => new PlanningError(400, 'invalid_request', '동기화 요청을 확인해 주세요.');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function failure(error: unknown, id: string): HttpResult {
  if (error instanceof PlanningError) return { status: error.status, body: { requestId: id, error: { code: error.code, message: error.message, retryable: error.retryable } } };
  return { status: 503, body: { requestId: id, error: { code: 'provider_unavailable', message: '캘린더 동기화를 처리하지 못했습니다.', retryable: false } } };
}
export function registerCalendarSyncRoutes(app: FastifyInstance, options: {
  service: CalendarSyncService;
  resolveUser: (request: FastifyRequest) => string;
  idempotency: IdempotencyPort;
}) {
  app.get('/v1/calendar-sync', async request => ({ requestId: request.id, data: await options.service.list(options.resolveUser(request)) }));
  app.get('/v1/calendar-sync/calendars', async request => ({ requestId: request.id, data: await options.service.listCalendars(options.resolveUser(request)) }));
  app.get('/v1/calendar-sync/operations/:requestId', async request => {
    const { requestId } = parse(operationParams, request.params);
    return { requestId: request.id, data: await options.service.getOperation(options.resolveUser(request), requestId) };
  });
  async function execute(request: FastifyRequest, operation: string, body: { requestId: string }, run: () => Promise<unknown>) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !requestId.safeParse(key).success) throw invalid();
    const { requestId: id, ...payload } = body;
    return options.idempotency.execute({ userId: options.resolveUser(request), operation, key, requestId: id, payload: { body: payload, params: request.params },
      run: async () => {
        try { return { status: 200, body: { requestId: id, data: await run() } }; }
        catch (error) { return failure(error, id); }
      } });
  }
  app.post('/v1/calendar-sync/connect', async (request, reply) => {
    const body = parse(connect, request.body), userId = options.resolveUser(request);
    const result = await execute(request, 'calendar_sync_connect', body, () => options.service.connect(userId, body));
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/calendar-sync/:id/run', async (request, reply) => {
    const body = parse(change, request.body), { id } = parse(params, request.params), userId = options.resolveUser(request);
    const result = await execute(request, 'calendar_sync_run', body, () => options.service.run(userId, id, body));
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/calendar-sync/:id/exports', async (request, reply) => {
    const body = parse(exportsBody, request.body), { id } = parse(params, request.params), userId = options.resolveUser(request);
    const result = await execute(request, 'calendar_sync_exports', body, () => options.service.enqueueExports(userId, id, body));
    return reply.code(result.status).send(result.body);
  });
  app.post('/v1/calendar-sync/:id/disconnect', async (request, reply) => {
    const body = parse(change, request.body), { id } = parse(params, request.params), userId = options.resolveUser(request);
    const result = await execute(request, 'calendar_sync_disconnect', body, () => options.service.disconnect(userId, id, body.expectedRevision));
    return reply.code(result.status).send(result.body);
  });
}
