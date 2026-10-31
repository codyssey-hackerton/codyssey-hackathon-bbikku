import { fileURLToPath } from 'node:url';
import { parseOffsetDateTime } from '@pikku/domain';
import { readGmailCredential, googleUserInfo } from './gmail-connection.ts';
import { PlanningError } from './planning-service.ts';

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const unavailable = () => new PlanningError(503, 'provider_unavailable', '캘린더 조회에 실패했습니다.');
type CalendarEvent = { id: string; etag: string; title: string; startsAt: string; endsAt: string; timezone: string; involvement: 'personal' | 'shared' };

export async function getCalendarConnection(options: { env: NodeJS.ProcessEnv; credentialPath?: string; fetcher?: typeof fetch }) {
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!!clientId !== !!clientSecret) throw unavailable();
  const path = options.credentialPath ?? fileURLToPath(new URL('../../../.local/calendar-connection.json', import.meta.url));
  let saved;
  try { saved = await readGmailCredential(path); } catch { throw unavailable(); }
  if (!saved) return undefined;
  if (!clientId || !clientSecret || saved.clientId !== clientId) throw unavailable();
  const fetcher = options.fetcher ?? fetch;
  async function token(): Promise<string> {
    try {
      const current = await readGmailCredential(path);
      if (!current || current.clientId !== clientId || current.subject !== saved!.subject || current.senderAddress !== saved!.senderAddress) throw unavailable();
      const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString() });
      if (!response.ok) throw unavailable();
      const value = await response.json() as { access_token?: unknown; token_type?: unknown; scope?: unknown; refresh_token?: unknown };
      const scopes = new Set(typeof value.scope === 'string' ? value.scope.split(/\s+/) : []);
      if (typeof value.access_token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(value.access_token) || value.token_type !== 'Bearer' ||
          !scopes.has(EVENTS_SCOPE) || !scopes.has(LIST_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
          (value.refresh_token !== undefined && value.refresh_token !== current.refreshToken)) throw unavailable();
      const info = await googleUserInfo(fetcher, value.access_token);
      if (info.subject !== current.subject || info.senderAddress !== current.senderAddress) throw unavailable();
      const latest = await readGmailCredential(path);
      if (!latest || latest.clientId !== current.clientId || latest.subject !== current.subject || latest.senderAddress !== current.senderAddress || latest.refreshToken !== current.refreshToken) throw unavailable();
      return value.access_token;
    } catch { throw unavailable(); }
  }
  async function pages(url: URL): Promise<{ items: Record<string, any>[]; timeZone?: string }> {
    const accessToken = await token(); const items: Record<string, any>[] = []; const seen = new Set<string>(); let timeZone: string | undefined;
    for (let page = 0; page < 20; page++) {
      let response: Response;
      try { response = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); } catch { throw unavailable(); }
      if (!response.ok) throw unavailable();
      let data: any; try { data = await response.json(); } catch { throw unavailable(); }
      if (!data || !Array.isArray(data.items) || data.items.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item))) throw unavailable();
      if (typeof data.timeZone === 'string') { if (timeZone && timeZone !== data.timeZone) throw unavailable(); timeZone = data.timeZone; }
      items.push(...data.items); if (items.length > 5000) throw unavailable();
      if (data.nextPageToken === undefined) return { items, timeZone };
      if (typeof data.nextPageToken !== 'string' || !data.nextPageToken || seen.has(data.nextPageToken)) throw unavailable();
      seen.add(data.nextPageToken); url.searchParams.set('pageToken', data.nextPageToken);
    }
    throw unavailable();
  }
  async function listCalendars() {
    const result = await pages(new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList'));
    if (result.items.some(c => c.deleted !== true && (typeof c.id !== 'string' || !c.id || typeof c.summary !== 'string' || !c.summary))) throw unavailable();
    const calendars = result.items.filter(c => c.deleted !== true)
      .map(c => ({ id: c.id as string, summary: c.summary as string, ...(typeof c.timeZone === 'string' ? { timeZone: c.timeZone as string } : {}) }));
    return { calendars };
  }
  async function resolveEvents(input: { calendarId: string; from: string; to: string }) {
    const from = parseOffsetDateTime(input.from), to = parseOffsetDateTime(input.to);
    if (!input.calendarId || from === null || to === null || from >= to || to - from > 366 * 86400000) throw new PlanningError(400, 'invalid_request', '조회 기간을 확인해 주세요.');
    if (!(await listCalendars()).calendars.some(c => c.id === input.calendarId)) throw new PlanningError(404, 'not_found', '선택한 캘린더를 찾을 수 없습니다.');
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`);
    url.search = new URLSearchParams({ timeMin: input.from, timeMax: input.to, singleEvents: 'true', showDeleted: 'true', maxResults: '250' }).toString();
    const result = await pages(url); const events: CalendarEvent[] = []; let unsupportedCount = 0;
    for (const value of result.items) {
      const zone = value.start?.timeZone ?? result.timeZone; const start = value.start?.dateTime; const end = value.end?.dateTime;
      let validZone = false; try { new Intl.DateTimeFormat('en', { timeZone: zone }); validZone = typeof zone === 'string' && !!zone; } catch { /* unsupported */ }
      const allowed = value.status !== 'cancelled' && !value.recurrence && !value.recurringEventId && !value.originalStartTime && !value.endTimeUnspecified && value.transparency !== 'transparent' &&
        !value.attendeesOmitted && value.organizer && (value.organizer.self === true || ((value.organizer.self === false || value.organizer.self === undefined) &&
          (typeof value.organizer.email === 'string' || typeof value.organizer.id === 'string'))) && (value.attendees === undefined || Array.isArray(value.attendees)) &&
        typeof value.id === 'string' && !!value.id && typeof value.etag === 'string' && !!value.etag && typeof value.summary === 'string' && !!value.summary.trim() && value.summary.length <= 2000 &&
        typeof start === 'string' && typeof end === 'string' && parseOffsetDateTime(start) !== null && parseOffsetDateTime(end) !== null && Date.parse(start) < Date.parse(end) && validZone;
      if (!allowed) { unsupportedCount++; continue; }
      const shared = value.organizer.self !== true || (value.attendees ?? []).some((a: any) => !a || a.self !== true);
      events.push({ id: value.id, etag: value.etag, title: value.summary, startsAt: start, endsAt: end, timezone: zone, involvement: shared ? 'shared' : 'personal' });
    }
    return { events, unsupportedCount };
  }
  return { userId: 'local-developer' as const, accountRef: `google:${saved.subject}`, accountLabel: saved.senderAddress, listCalendars,
    resolveEvents, async listEvents(input: { calendarId: string; from: string; to: string }) {
      const result = await resolveEvents(input); return { events: result.events.map(({ involvement: _involvement, ...event }) => event), unsupportedCount: result.unsupportedCount };
    } };
}
