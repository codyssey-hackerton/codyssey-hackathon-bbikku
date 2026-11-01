import { ApiError, type ApiClient } from '../api/http';

export type GoogleConnectionKind = 'calendar' | 'calendar_write' | 'gmail_send' | 'gmail_read' | 'contacts';
export type ConnectionStatus = { status: 'available' | 'not_configured'; account: string | null };
export interface GoogleStart { authorizationUrl: string; completionSecret: string }

function trustedAuthorizationUrl(value: unknown, kind: GoogleConnectionKind): value is string {
  if (typeof value !== 'string' || value.length > 16_384) return false;
  try {
    const url = new URL(value);
    const scopeByKind: Record<GoogleConnectionKind, string[]> = {
      calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
      calendar_write: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
      gmail_send: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'],
      gmail_read: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
      contacts: ['openid', 'email', 'https://www.googleapis.com/auth/contacts.readonly'],
    };
    const scope = (url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port && !url.username && !url.password &&
      url.pathname === '/o/oauth2/v2/auth' && !url.hash && url.searchParams.get('response_type') === 'code' &&
      !!url.searchParams.get('client_id') && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') && url.searchParams.get('code_challenge_method') === 'S256' &&
      ['client_id', 'response_type', 'state', 'scope', 'redirect_uri', 'code_challenge', 'code_challenge_method'].every((key) => url.searchParams.getAll(key).length === 1) &&
      scope.length === scopeByKind[kind].length && new Set(scope).size === scope.length && scopeByKind[kind].every((item) => scope.includes(item)) &&
      redirect.protocol === 'https:' && !redirect.username && !redirect.password && !redirect.search && !redirect.hash && redirect.pathname === '/v1/google/oauth/callback' &&
      !['code', 'access_token', 'id_token', 'refresh_token'].some((key) => url.searchParams.has(key));
  } catch { return false; }
}

export function createGoogleClient(api: ApiClient) {
  return {
    async status(kind: GoogleConnectionKind): Promise<ConnectionStatus> {
      const path = kind === 'contacts' ? '/v1/contacts/google/connection' : kind === 'calendar' ? '/v1/calendar-connection' : kind === 'calendar_write' ? '/v1/calendar-write-connection' : kind === 'gmail_send' ? '/v1/email-connection' : '/v1/email-reply-connection';
      const data = await api.get<unknown>(path);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', '연결 상태를 확인할 수 없습니다.');
      const result = data as Record<string, unknown>;
      const account = kind === 'calendar' || kind === 'calendar_write' || kind === 'contacts' ? result.accountLabel : result.senderAddress;
      if ((result.status !== 'available' && result.status !== 'not_configured') || !(account === null || typeof account === 'string') ||
          (result.status === 'available' && kind !== 'calendar' && kind !== 'calendar_write' && (typeof account !== 'string' || !account.trim()))) {
        throw new ApiError('invalid_response', '연결 상태를 확인할 수 없습니다.');
      }
      return { status: result.status, account: account as string | null };
    },
    async start(kind: GoogleConnectionKind): Promise<GoogleStart> {
      const data = await api.post<unknown>('/v1/google/oauth/start', { kind }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('authorizationUrl' in data) || !trustedAuthorizationUrl(data.authorizationUrl, kind) ||
          !('completionSecret' in data) || typeof data.completionSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.completionSecret)) {
        throw new ApiError('invalid_response', 'Google 동의 화면을 확인할 수 없습니다.');
      }
      return { authorizationUrl: data.authorizationUrl, completionSecret: data.completionSecret };
    },
    async complete(completionSecret: string, confirmationCode: string): Promise<void> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(completionSecret) || !/^[A-Za-z0-9_-]{43}$/.test(confirmationCode)) {
        throw new ApiError('invalid_request', '연결 확인 코드를 확인해 주세요.');
      }
      const data = await api.post<unknown>('/v1/google/oauth/complete', { completionSecret, confirmationCode }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('status' in data) || data.status !== 'connected') {
        throw new ApiError('invalid_response', 'Google 연결 결과를 확인할 수 없습니다.');
      }
    },
    async poll(completionSecret: string): Promise<'pending' | 'completed'> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(completionSecret)) throw new ApiError('invalid_request', 'Google 연결 요청을 확인할 수 없습니다.');
      const data = await api.post<unknown>('/v1/google/oauth/complete', { completionSecret }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('status' in data) || (data.status !== 'pending' && data.status !== 'completed')) {
        throw new ApiError('invalid_response', 'Google 연결 결과를 확인할 수 없습니다.');
      }
      return data.status;
    },
    async cancel(completionSecret: string): Promise<void> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(completionSecret)) return;
      const data = await api.post<unknown>('/v1/google/oauth/complete', { completionSecret, cancel: true }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('status' in data) || data.status !== 'cancelled') {
        throw new ApiError('invalid_response', 'Google 연결 요청을 취소할 수 없습니다.');
      }
    },
  };
}
