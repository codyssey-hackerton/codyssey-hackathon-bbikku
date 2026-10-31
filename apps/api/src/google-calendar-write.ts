import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseOffsetDateTime } from '@pikku/domain';
import { googleUserInfo, readGmailCredential } from './gmail-connection.ts';

export type GoogleCalendarWriteErrorCode = 'invalid_request' | 'not_found' | 'forbidden' | 'sync_token_expired' | 'conflict' | 'outcome_unknown' | 'provider_unavailable';
export class GoogleCalendarWriteError extends Error {
  constructor(readonly code: GoogleCalendarWriteErrorCode) { super(code); }
}
type TimeSlot = { startsAt: string; endsAt: string; timezone: string };
export type GoogleCalendarEvent = { id: string; etag: string | null; status: 'confirmed' | 'tentative' | 'cancelled';
  title: string | null; description: string | null; timeSlot: TimeSlot | null;
  unsupported: { allDay: boolean; recurring: boolean; shared: boolean; other: boolean }; privateProperties: { pIKKU?: string } };
export type GoogleCalendarEventWrite = { title: string; timeSlot: TimeSlot; description?: string | null; privateProperties: { pIKKU: string } };
const eventScope = 'https://www.googleapis.com/auth/calendar.events';
const listScope = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const err = (code: GoogleCalendarWriteErrorCode): never => { throw new GoogleCalendarWriteError(code); };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const validEtag = (value: unknown): value is string => identifier(value, 1024) && !/[\s,*]/u.test(value);
const timezone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 100 || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};
function parseEvent(value: unknown): GoogleCalendarEvent {
  if (!record(value) || !identifier(value.id) || !['confirmed', 'tentative', 'cancelled'].includes(value.status) ||
      (value.etag !== undefined && !identifier(value.etag, 1024))) return err('provider_unavailable');
  const cancelled = value.status === 'cancelled';
  const start = value.start?.dateTime, end = value.end?.dateTime;
  const zone = value.start?.timeZone ?? value.end?.timeZone ?? 'UTC';
  const from = typeof start === 'string' ? parseOffsetDateTime(start) : null;
  const to = typeof end === 'string' ? parseOffsetDateTime(end) : null;
  const allDay = typeof value.start?.date === 'string' || typeof value.end?.date === 'string';
  const recurring = !!value.recurrence || !!value.recurringEventId || !!value.originalStartTime;
  const shared = !cancelled && (value.organizer?.self !== true || value.attendeesOmitted === true ||
    (value.attendees !== undefined && (!Array.isArray(value.attendees) || value.attendees.some((attendee: any) => !attendee || attendee.self !== true))));
  const validSlot = from !== null && to !== null && from < to && timezone(zone);
  const title = typeof value.summary === 'string' && value.summary.length <= 2000 ? value.summary : null;
  const description = typeof value.description === 'string' && value.description.length <= 20_000 ? value.description : null;
  const other = !cancelled && (!value.etag || !title?.trim() || !validSlot || value.endTimeUnspecified === true || value.transparency === 'transparent' ||
    (value.eventType !== undefined && value.eventType !== 'default') || value.attendeesOmitted === true ||
    (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 20_000)));
  if (value.extendedProperties !== undefined && (!record(value.extendedProperties) ||
      (value.extendedProperties.private !== undefined && !record(value.extendedProperties.private)))) return err('provider_unavailable');
  const marker = value.extendedProperties?.private?.pIKKU;
  if (marker !== undefined && !identifier(marker, 1024)) return err('provider_unavailable');
  return { id: value.id, etag: value.etag ?? null, status: value.status, title, description,
    timeSlot: validSlot ? { startsAt: start, endsAt: end, timezone: zone } : null,
    unsupported: { allDay, recurring, shared, other }, privateProperties: marker === undefined ? {} : { pIKKU: marker } };
}
function writeBody(event: GoogleCalendarEventWrite) {
  if (!record(event) || typeof event.title !== 'string' || !event.title.trim() || event.title.length > 2000 ||
      !record(event.timeSlot) || typeof event.timeSlot.startsAt !== 'string' || typeof event.timeSlot.endsAt !== 'string' ||
      parseOffsetDateTime(event.timeSlot.startsAt) === null || parseOffsetDateTime(event.timeSlot.endsAt) === null ||
      Date.parse(event.timeSlot.startsAt) >= Date.parse(event.timeSlot.endsAt) || !timezone(event.timeSlot.timezone) ||
      (event.description !== undefined && event.description !== null && (typeof event.description !== 'string' || event.description.length > 20_000)) ||
      !record(event.privateProperties) || !identifier(event.privateProperties.pIKKU, 1024) ||
      Object.keys(event.privateProperties).some(key => key !== 'pIKKU')) return err('invalid_request');
  return { summary: event.title, start: { dateTime: event.timeSlot.startsAt, timeZone: event.timeSlot.timezone },
    end: { dateTime: event.timeSlot.endsAt, timeZone: event.timeSlot.timezone },
    ...(event.description === undefined ? {} : { description: event.description }), extendedProperties: { private: { pIKKU: event.privateProperties.pIKKU } } };
}

export async function getCalendarWriteConnection(options: { env: NodeJS.ProcessEnv; credentialPath?: string; fetcher?: typeof fetch; userId?: string }) {
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!!clientId !== !!clientSecret) return err('provider_unavailable');
  const path = options.credentialPath ?? fileURLToPath(new URL('../../../.local/calendar-write-connection.json', import.meta.url));
  let saved;
  try { saved = await readGmailCredential(path); } catch { return err('provider_unavailable'); }
  if (!saved) return undefined;
  if (!clientId || !clientSecret || saved.clientId !== clientId) return err('provider_unavailable');
  const fetcher = options.fetcher ?? fetch;
  async function token(): Promise<string> {
    try {
      const current = await readGmailCredential(path);
      if (!current || current.clientId !== clientId || current.subject !== saved!.subject || current.senderAddress !== saved!.senderAddress || current.refreshToken !== saved!.refreshToken) throw new Error();
      const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString() });
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      if (!record(value)) throw new Error();
      const scopes = new Set(typeof value.scope === 'string' ? value.scope.split(/\s+/) : []);
      if (typeof value.access_token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(value.access_token) || value.token_type !== 'Bearer' ||
          !scopes.has(eventScope) || !scopes.has(listScope) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
          (value.refresh_token !== undefined && value.refresh_token !== current.refreshToken)) throw new Error();
      const info = await googleUserInfo(fetcher, value.access_token);
      if (info.subject !== current.subject || info.senderAddress !== current.senderAddress) throw new Error();
      const latest = await readGmailCredential(path);
      if (!latest || latest.clientId !== current.clientId || latest.subject !== current.subject || latest.senderAddress !== current.senderAddress || latest.refreshToken !== current.refreshToken) throw new Error();
      return value.access_token;
    } catch { return err('provider_unavailable'); }
  }
  async function request(url: URL, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, etag?: string, sync = false): Promise<unknown> {
    const access = await token();
    let response: Response;
    try {
      response = await fetcher(url.toString(), { method, headers: { Authorization: `Bearer ${access}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(etag === undefined ? {} : { 'If-Match': etag }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { return err(method === 'GET' ? 'provider_unavailable' : 'outcome_unknown'); }
    if (!response.ok) {
      if (response.status === 410 && sync && method === 'GET') return err('sync_token_expired');
      if (response.status === 409 || response.status === 412) return err('conflict');
      if (response.status === 403 || response.status === 401) return err('forbidden');
      if (response.status === 404 || response.status === 410) return err('not_found');
      if (response.status === 400) return err('invalid_request');
      return err(method === 'GET' ? 'provider_unavailable' : 'outcome_unknown');
    }
    if (method === 'DELETE' && response.status === 204) return undefined;
    try { return await response.json(); } catch { return err(method === 'GET' ? 'provider_unavailable' : 'outcome_unknown'); }
  }
  const eventUrl = (calendarId: string, eventId?: string) => {
    if (!identifier(calendarId) || (eventId !== undefined && !identifier(eventId))) return err('invalid_request');
    return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${eventId === undefined ? '' : `/${encodeURIComponent(eventId)}`}`);
  };
  return {
    userId: options.userId ?? 'local-developer', subject: saved.subject, accountLabel: saved.senderAddress,
    accountRef: `google:${createHash('sha256').update(saved.subject).digest('hex')}`,
    async listCalendars() {
      const calendars: { id: string; summary: string; accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader' }[] = [];
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList'); url.searchParams.set('maxResults', '250');
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const data = await request(url, 'GET');
        if (!record(data) || !Array.isArray(data.items)) return err('provider_unavailable');
        for (const item of data.items) {
          if (!record(item)) return err('provider_unavailable');
          if (item.deleted === true) continue;
          if (!identifier(item.id) || typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 2000 ||
              !['owner', 'writer', 'reader', 'freeBusyReader'].includes(item.accessRole)) return err('provider_unavailable');
          calendars.push({ id: item.id, summary: item.summary, accessRole: item.accessRole });
          if (calendars.length > 5000) return err('provider_unavailable');
        }
        if (data.nextPageToken === undefined) return { calendars };
        if (!identifier(data.nextPageToken, 4096) || seen.has(data.nextPageToken)) return err('provider_unavailable');
        seen.add(data.nextPageToken); url.searchParams.set('pageToken', data.nextPageToken);
      }
      return err('provider_unavailable');
    },
    async listEvents(input: { calendarId: string; syncToken?: string; pageToken?: string }) {
      if ((input.syncToken !== undefined && !identifier(input.syncToken, 4096)) || (input.pageToken !== undefined && !identifier(input.pageToken, 4096))) return err('invalid_request');
      const url = eventUrl(input.calendarId); url.search = new URLSearchParams({ showDeleted: 'true', singleEvents: 'false', maxResults: '250', timeZone: 'UTC',
        ...(input.syncToken ? { syncToken: input.syncToken } : {}), ...(input.pageToken ? { pageToken: input.pageToken } : {}) }).toString();
      const data = await request(url, 'GET', undefined, undefined, !!input.syncToken);
      if (!record(data) || !Array.isArray(data.items) || data.items.length > 250 ||
          (data.nextPageToken !== undefined && !identifier(data.nextPageToken, 4096)) ||
          (data.nextSyncToken !== undefined && !identifier(data.nextSyncToken, 4096)) ||
          (!!data.nextPageToken === !!data.nextSyncToken)) return err('provider_unavailable');
      return { events: data.items.map(parseEvent), ...(data.nextPageToken ? { nextPageToken: data.nextPageToken as string } : {}),
        ...(data.nextSyncToken ? { nextSyncToken: data.nextSyncToken as string } : {}) };
    },
    async getEvent(input: { calendarId: string; eventId: string }) {
      const url = eventUrl(input.calendarId, input.eventId); url.searchParams.set('timeZone', 'UTC');
      const event = parseEvent(await request(url, 'GET'));
      if (event.id !== input.eventId) return err('provider_unavailable');
      return event;
    },
    async insertEvent(input: { calendarId: string; eventId: string; event: GoogleCalendarEventWrite }) {
      if (typeof input.eventId !== 'string' || !/^[0-9a-v]{5,1024}$/.test(input.eventId)) return err('invalid_request');
      const url = eventUrl(input.calendarId); url.searchParams.set('sendUpdates', 'none');
      const body = { id: input.eventId, ...writeBody(input.event) };
      const data = await request(url, 'POST', body);
      try { const event = parseEvent(data); if (event.id !== input.eventId) throw new Error(); return event; } catch { return err('outcome_unknown'); }
    },
    async updateEvent(input: { calendarId: string; eventId: string; etag: string; event: GoogleCalendarEventWrite }) {
      if (!validEtag(input.etag)) return err('invalid_request');
      const url = eventUrl(input.calendarId, input.eventId); url.searchParams.set('sendUpdates', 'none');
      const data = await request(url, 'PATCH', writeBody(input.event), input.etag);
      try { const event = parseEvent(data); if (event.id !== input.eventId) throw new Error(); return event; } catch { return err('outcome_unknown'); }
    },
    async deleteEvent(input: { calendarId: string; eventId: string; etag: string }) {
      if (!validEtag(input.etag)) return err('invalid_request');
      const url = eventUrl(input.calendarId, input.eventId); url.searchParams.set('sendUpdates', 'none');
      await request(url, 'DELETE', undefined, input.etag);
    },
  };
}
