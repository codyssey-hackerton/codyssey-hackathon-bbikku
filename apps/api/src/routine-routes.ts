import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlanningError } from './planning-service.ts';
import type { RoutineService } from './routine-service.ts';
import { routineCreate, routineMaterialize, routinePatch } from './routine-schemas.ts';

export function registerRoutineRoutes(app: FastifyInstance, options: { service?: RoutineService; resolveUser?: (request: FastifyRequest) => string | undefined }) {
  function context(request: FastifyRequest, mutation = false) {
    const userId = options.resolveUser?.(request);
    if (!userId) throw new PlanningError(401, 'unauthenticated', '인증이 필요합니다.');
    if (!options.service) throw new PlanningError(503, 'not_configured', '루틴 저장소가 준비되지 않았습니다.');
    const key = request.headers['idempotency-key'];
    if (mutation && (typeof key !== 'string' || !key.trim() || key.length > 200)) throw new PlanningError(400, 'invalid_request', '중복 방지 키가 필요합니다.');
    return { userId, service: options.service, key: key as string };
  }
  app.get('/v1/routines', async request => {
    const { userId, service } = context(request);
    return { requestId: request.id, data: await service.list(userId) };
  });
  app.post('/v1/routines', async request => {
    const { userId, service, key } = context(request, true); const body = routineCreate.safeParse(request.body);
    if (!body.success) throw new PlanningError(400, 'invalid_request', '루틴 입력을 확인해 주세요.');
    return service.create(userId, key, body.data);
  });
  app.patch('/v1/routines/:id', async request => {
    const { userId, service, key } = context(request, true); const body = routinePatch.safeParse(request.body);
    const params = request.params as { id?: unknown };
    if (!body.success || typeof params.id !== 'string') throw new PlanningError(400, 'invalid_request', '루틴 입력을 확인해 주세요.');
    return service.patch(userId, key, params.id, body.data);
  });
  app.post('/v1/routines/materialize', async request => {
    const { userId, service, key } = context(request, true); const body = routineMaterialize.safeParse(request.body);
    if (!body.success) throw new PlanningError(400, 'invalid_request', '루틴 날짜 범위를 확인해 주세요.');
    return service.materialize(userId, key, body.data);
  });
}
