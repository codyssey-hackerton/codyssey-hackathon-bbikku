import { ApiError, type ApiClient } from '../api/http';
import { normalizeApiBaseUrl } from '../api/connection';

export type Member = { id: string; email: string; displayName: string };
export type LoginResult = { sessionToken: string; expiresAt: string; member: Member };
type Start = { authorizationUrl: string; completionSecret: string };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new ApiError('invalid_response', '로그인 응답을 확인할 수 없습니다.');
function member(value: unknown): Member {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.email !== 'string' || !value.email || typeof value.displayName !== 'string') throw invalid();
  return { id: value.id, email: value.email, displayName: value.displayName };
}
function trustedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try {
    const url = new URL(value), params = url.searchParams;
    const redirect = new URL(params.get('redirect_uri') ?? '');
    const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port && !url.username && !url.password && !url.hash &&
      url.pathname === '/o/oauth2/v2/auth' && params.get('response_type') === 'code' && !!params.get('client_id') &&
      /^member_[A-Za-z0-9_-]{43}$/.test(params.get('state') ?? '') && tokenPattern.test(params.get('nonce') ?? '') &&
      tokenPattern.test(params.get('code_challenge') ?? '') && params.get('code_challenge_method') === 'S256' &&
      ['client_id', 'response_type', 'state', 'scope', 'redirect_uri', 'nonce', 'code_challenge', 'code_challenge_method'].every(key => params.getAll(key).length === 1) &&
      scopes.length === 3 && new Set(scopes).size === 3 && ['openid', 'email', 'profile'].every(scope => scopes.includes(scope)) &&
      redirect.protocol === 'https:' && !redirect.username && !redirect.password && !redirect.search && !redirect.hash && redirect.pathname === '/v1/google/oauth/callback' &&
      !['code', 'access_token', 'id_token', 'refresh_token', 'completionSecret'].some(key => params.has(key));
  } catch { return false; }
}
export function createAuthClient(baseUrlInput: string, fetcher: typeof fetch = fetch) {
  const baseUrl = normalizeApiBaseUrl(baseUrlInput);
  async function publicPost(path: string, body: object): Promise<unknown> {
    if (!baseUrl || (!baseUrl.startsWith('https://') && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(baseUrl))) throw new ApiError('invalid_configuration', '로그인에는 HTTPS 또는 로컬 연결이 필요합니다.');
    const controller = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const response = await fetcher(`${baseUrl}${path}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify(body), signal: controller.signal });
      let payload: unknown;
      try { payload = await response.json(); } catch { if (timedOut) throw new ApiError('timeout', '로그인 응답 시간이 초과되었습니다.'); throw invalid(); }
      if (!response.ok) {
        if (record(payload) && record(payload.error) && typeof payload.error.code === 'string') throw new ApiError(payload.error.code, '로그인 요청을 완료하지 못했습니다.', false, response.status);
        throw invalid();
      }
      if (!record(payload) || typeof payload.requestId !== 'string' || !('data' in payload)) throw invalid();
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('timeout', '로그인 응답 시간이 초과되었습니다.');
      throw new ApiError('network', '로그인 서버에 연결할 수 없습니다.');
    } finally { clearTimeout(timer); }
  }
  return {
    async start(): Promise<Start> {
      const value = await publicPost('/v1/auth/google/start', {});
      if (!record(value) || !trustedUrl(value.authorizationUrl) || typeof value.completionSecret !== 'string' || !tokenPattern.test(value.completionSecret)) throw invalid();
      return { authorizationUrl: value.authorizationUrl, completionSecret: value.completionSecret };
    },
    async complete(completionSecret: string, confirmationCode: string): Promise<LoginResult> {
      if (!tokenPattern.test(completionSecret) || !tokenPattern.test(confirmationCode)) throw new ApiError('invalid_request', '로그인 확인 코드를 확인해 주세요.');
      const value = await publicPost('/v1/auth/google/complete', { completionSecret, confirmationCode });
      if (!record(value) || typeof value.sessionToken !== 'string' || !value.sessionToken.trim() || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw invalid();
      return { sessionToken: value.sessionToken, expiresAt: value.expiresAt, member: member(value.member) };
    },
    async poll(completionSecret: string): Promise<{ status: 'pending' } | { status: 'completed'; result: LoginResult }> {
      if (!tokenPattern.test(completionSecret)) throw new ApiError('invalid_request', '로그인 요청을 확인할 수 없습니다.');
      const value = await publicPost('/v1/auth/google/complete', { completionSecret });
      if (!record(value)) throw invalid();
      if (value.status === 'pending') return { status: 'pending' };
      if (value.status !== 'completed' || typeof value.sessionToken !== 'string' || !tokenPattern.test(value.sessionToken) ||
          typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw invalid();
      return { status: 'completed', result: { sessionToken: value.sessionToken, expiresAt: value.expiresAt, member: member(value.member) } };
    },
    async cancel(completionSecret: string): Promise<void> {
      if (!tokenPattern.test(completionSecret)) return;
      const value = await publicPost('/v1/auth/google/complete', { completionSecret, cancel: true });
      if (!record(value) || value.status !== 'cancelled') throw invalid();
    },
    async me(api: ApiClient): Promise<Member> {
      const value = await api.get<unknown>('/v1/auth/me');
      if (!record(value)) throw invalid(); return member(value.member);
    },
    async logout(api: ApiClient): Promise<void> {
      const value = await api.post<unknown>('/v1/auth/logout', {}, { idempotencyKey: '' });
      if (!record(value) || value.status !== 'logged_out') throw invalid();
    },
  };
}
