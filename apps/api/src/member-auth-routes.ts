import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MemberAuth } from './member-auth.ts';

const empty = z.strictObject({});
const completeBody = z.strictObject({ completionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), confirmationCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const token = (request: FastifyRequest) => typeof request.headers.authorization === 'string'
  ? /^Bearer ([^\s]+)$/i.exec(request.headers.authorization)?.[1] : undefined;

export type MemberAuthRouteOptions = { allowLocalInsecure?: boolean };
export type MemberAuthRouteGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

export function registerMemberAuthRoutes(app: FastifyInstance, auth: MemberAuth, options: MemberAuthRouteOptions = {}): MemberAuthRouteGuard {
  const limits = new Map<string, { until: number; count: number }>();
  const error = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, retryable = false) =>
    reply.code(status).send({ requestId: request.id, error: { code, message, retryable } });
  const guard: MemberAuthRouteGuard = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.protocol !== 'https' && !(options.allowLocalInsecure && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip))) {
      return error(request, reply, 403, 'permission_denied', '안전한 연결이 필요합니다.');
    }
    const current = Date.now();
    if (limits.size >= 10_000) {
      for (const [key, entry] of limits) if (entry.until <= current) limits.delete(key);
      if (limits.size >= 10_000) return error(request, reply, 503, 'provider_unavailable', '인증을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.', true);
    }
    const scope = request.routeOptions.url?.startsWith('/v1/auth/google/') || request.routeOptions.url === '/v1/google/oauth/callback' ? 'public' : 'private';
    const key = `${scope}:${request.ip}`, previous = limits.get(key);
    const entry = !previous || previous.until <= current ? { until: current + 60_000, count: 0 } : previous;
    entry.count++; limits.set(key, entry);
    if (entry.count > (scope === 'public' ? 20 : 60)) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((entry.until - current) / 1000))));
      return error(request, reply, 429, 'rate_limited', '요청이 많습니다. 잠시 후 다시 시도해 주세요.', true);
    }
  };
  const unavailable = (request: FastifyRequest, reply: FastifyReply) => error(request, reply, 503, 'provider_unavailable', '인증을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.', true);
  const unauthorized = (request: FastifyRequest, reply: FastifyReply) => error(request, reply, 401, 'unauthenticated', '인증이 필요합니다.');

  app.post('/v1/auth/google/start', { onRequest: guard }, async (request, reply) => {
    if (!empty.safeParse(request.body ?? {}).success) return error(request, reply, 400, 'invalid_request', '요청을 확인해 주세요.');
    try {
      const result = auth.start();
      if (!result) return error(request, reply, 503, 'not_configured', 'Google 로그인이 설정되지 않았습니다.');
      return { requestId: request.id, data: result };
    } catch { return unavailable(request, reply); }
  });
  app.post('/v1/auth/google/complete', { onRequest: guard }, async (request, reply) => {
    const body = completeBody.safeParse(request.body);
    if (!body.success) return error(request, reply, 400, 'invalid_request', '요청을 확인해 주세요.');
    try {
      const result = await auth.complete(body.data.completionSecret, body.data.confirmationCode);
      if (!result) return error(request, reply, 400, 'invalid_request', '로그인을 완료하지 못했습니다. 다시 시도해 주세요.');
      return { requestId: request.id, data: result };
    } catch { return unavailable(request, reply); }
  });
  app.get('/v1/auth/me', { onRequest: guard }, async (request, reply) => {
    const bearer = token(request); if (!bearer) return unauthorized(request, reply);
    try {
      const member = await auth.me(bearer);
      return member ? { requestId: request.id, data: { member } } : unauthorized(request, reply);
    } catch { return unavailable(request, reply); }
  });
  app.post('/v1/auth/logout', { onRequest: guard }, async (request, reply) => {
    if (!empty.safeParse(request.body ?? {}).success) return error(request, reply, 400, 'invalid_request', '요청을 확인해 주세요.');
    const bearer = token(request); if (!bearer) return unauthorized(request, reply);
    try {
      if (!await auth.logout(bearer)) return unauthorized(request, reply);
      return { requestId: request.id, data: { status: 'logged_out' } };
    } catch { return unavailable(request, reply); }
  });
  return guard;
}
