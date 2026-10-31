import { normalizeApiBaseUrl } from './connection';

export type ApiErrorCode =
  | 'unauthenticated'
  | 'invalid_configuration'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | string;

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: object, options: { idempotencyKey: string; timeoutMs?: number }): Promise<T>;
}

interface ApiClientOptions {
  baseUrl: string;
  getSessionToken: () => string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;

  async function request<T>(method: 'GET' | 'POST', path: string, body?: object, idempotencyKey?: string, timeoutOverrideMs?: number): Promise<T> {
    const token = options.getSessionToken().trim();
    if (!token) throw new ApiError('unauthenticated', '개발 세션 토큰을 입력해 주세요.');
    if (baseUrl === null || !path.startsWith('/')) {
      throw new ApiError('invalid_configuration', 'API 서버 주소를 확인해 주세요.');
    }
    if (method === 'POST' && path === '/v1/phone-connection' &&
        !baseUrl.startsWith('https://') && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(baseUrl)) {
      throw new ApiError('invalid_configuration', '전화 연결 설정에는 HTTPS 또는 로컬 연결이 필요합니다.');
    }

    const timeoutMs = timeoutOverrideMs ?? defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ApiError('invalid_configuration', '요청 제한 시간을 확인해 주세요.');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) throw new ApiError('timeout', '서버 응답 시간이 초과되었습니다.', true);
        throw new ApiError('invalid_response', '서버 응답을 읽을 수 없습니다.', false, response.status);
      }

      if (!response.ok) {
        if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string' && typeof payload.error.message === 'string' && typeof payload.error.retryable === 'boolean') {
          throw new ApiError(payload.error.code, payload.error.message, payload.error.retryable, response.status);
        }
        throw new ApiError('invalid_response', '서버 오류 응답 형식이 올바르지 않습니다.', false, response.status);
      }
      if (!isRecord(payload) || typeof payload.requestId !== 'string' || !('data' in payload)) {
        throw new ApiError('invalid_response', '서버 응답 형식이 올바르지 않습니다.', false, response.status);
      }
      return payload.data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('timeout', '서버 응답 시간이 초과되었습니다.', true);
      throw new ApiError('network', '서버에 연결할 수 없습니다.', true);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: object, { idempotencyKey, timeoutMs }: { idempotencyKey: string; timeoutMs?: number }) =>
      request<T>('POST', path, body, idempotencyKey, timeoutMs),
  };
}
