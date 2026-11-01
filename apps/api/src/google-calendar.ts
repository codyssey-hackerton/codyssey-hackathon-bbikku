import { fileURLToPath } from 'node:url';
import { parseOffsetDateTime } from '@pikku/domain';
import { readGmailCredential, googleUserInfo } from './gmail-connection.ts';
import { PlanningError } from './planning-service.ts';

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const EVENTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const unavailable = () => new PlanningError(503, 'provider_unavailable', '캘린더 조회에 실패했습니다.');
type CalendarEvent = { id: string; etag: string; title: string; startsAt: string; endsAt: string; timezone: string; involvement: 'personal' | 'shared';
  allDay?: boolean; notes?: string | null; blocksTime?: boolean; occurrenceKey?: string };

function calendarDayStart(value: unknown, zone: string): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const nominal = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== value) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateAt = (instant: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    let lower = nominal - 36 * 3_600_000, upper = nominal + 36 * 3_600_000;
    if (dateAt(lower) >= value || dateAt(upper) < value) return null;
    while (upper - lower > 1) { const middle = lower + Math.floor((upper - lower) / 2); if (dateAt(middle) < value) lower = middle; else upper = middle; }
    return dateAt(upper) === value ? new Date(upper).toISOString() : null;
  } catch { return null; }
}

export async function getCalendarConnection(options: { env: NodeJS.ProcessEnv; credentialPath?: string; fetcher?: typeof fetch; userId?: string }) {
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
          !(scopes.has(EVENTS_SCOPE) || scopes.has(EVENTS_WRITE_SCOPE)) || !scopes.has(LIST_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
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
      .map(c => ({ id: c.id as string, summary: c.summary as string, ...(typeof c.timeZone === 'string' ? { timeZone: c.timeZone as string } : {}),
        ...(c.primary === true ? { primary: true as const } : {}) }));
    return { calendars };
  }
  async function resolveEvents(input: { calendarId: string; from: string; to: string }) {
    const from = parseOffsetDateTime(input.from), to = parseOffsetDateTime(input.to);
    if (!input.calendarId || from === null || to === null || from >= to || to - from > 366 * 86400000) throw new PlanningError(400, 'invalid_request', '조회 기간을 확인해 주세요.');
    const calendar = (await listCalendars()).calendars.find(c => c.id === input.calendarId);
    if (!calendar) throw new PlanningError(404, 'not_found', '선택한 캘린더를 찾을 수 없습니다.');
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`);
    url.search = new URLSearchParams({ timeMin: input.from, timeMax: input.to, singleEvents: 'true', showDeleted: 'true', maxResults: '250' }).toString();
    const result = await pages(url); const events: CalendarEvent[] = []; let unsupportedCount = 0;
    for (const value of result.items) {
      if (value.status === 'cancelled') continue;
      const allDay = typeof value.start?.date === 'string' && typeof value.end?.date === 'string';
      const zone = allDay ? result.timeZone ?? calendar.timeZone : value.start?.timeZone ?? result.timeZone ?? calendar.timeZone;
      const start = allDay && typeof zone === 'string' ? calendarDayStart(value.start.date, zone) : value.start?.dateTime;
      const end = allDay && typeof zone === 'string' ? calendarDayStart(value.end.date, zone) : value.end?.dateTime;
      let validZone = false; try { new Intl.DateTimeFormat('en', { timeZone: zone }); validZone = typeof zone === 'string' && !!zone; } catch { /* unsupported */ }
      const allowed = !value.recurrence && !value.endTimeUnspecified && (value.transparency === undefined || value.transparency === 'opaque' || value.transparency === 'transparent') &&
        (value.recurringEventId === undefined || (typeof value.recurringEventId === 'string' && !!value.recurringEventId && value.originalStartTime &&
          (typeof value.originalStartTime.dateTime === 'string' || typeof value.originalStartTime.date === 'string'))) &&
        (value.originalStartTime === undefined || value.recurringEventId !== undefined) &&
        (value.description === undefined || (typeof value.description === 'string' && value.description.length <= 20_000)) &&
        !value.attendeesOmitted && value.organizer && (value.organizer.self === true || ((value.organizer.self === false || value.organizer.self === undefined) &&
          (typeof value.organizer.email === 'string' || typeof value.organizer.id === 'string'))) && (value.attendees === undefined || Array.isArray(value.attendees)) &&
        typeof value.id === 'string' && !!value.id && typeof value.etag === 'string' && !!value.etag && typeof value.summary === 'string' && !!value.summary.trim() && value.summary.length <= 2000 &&
        typeof start === 'string' && typeof end === 'string' && parseOffsetDateTime(start) !== null && parseOffsetDateTime(end) !== null && Date.parse(start) < Date.parse(end) && validZone;
      if (!allowed) { unsupportedCount++; continue; }
      const shared = value.organizer.self !== true || (value.attendees ?? []).some((a: any) => !a || a.self !== true);
      const occurrenceKey = value.recurringEventId ? JSON.stringify([value.recurringEventId, value.originalStartTime.dateTime ?? value.originalStartTime.date]) : undefined;
      events.push({ id: value.id, etag: value.etag, title: value.summary, startsAt: start, endsAt: end, timezone: zone, involvement: shared ? 'shared' : 'personal',
        ...(allDay ? { allDay: true } : {}), ...(value.transparency === 'transparent' ? { blocksTime: false } : {}),
        ...(value.description !== undefined ? { notes: value.description } : {}), ...(occurrenceKey ? { occurrenceKey } : {}) });
    }
    return { events, unsupportedCount };
  }
  return { userId: options.userId ?? 'local-developer', accountRef: `google:${saved.subject}`, accountLabel: saved.senderAddress, listCalendars,
    resolveEvents, async listEvents(input: { calendarId: string; from: string; to: string }) {
      const result = await resolveEvents(input); return { events: result.events.map(({ involvement: _involvement, ...event }) => event), unsupportedCount: result.unsupportedCount };
    } };
}
