import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { googleUserInfo, readGmailCredential } from './gmail-connection.ts';
import { getGmailConnection } from './gmail-connection.ts';
import { getGmailReplyConnection } from './gmail-reply-connection.ts';
import { getCalendarConnection } from './google-calendar.ts';
import { getCalendarWriteConnection } from './google-calendar-write.ts';
import { getContactsConnection } from './google-contacts.ts';

export type GoogleOAuthKind = 'calendar' | 'calendar_write' | 'gmail_send' | 'gmail_read' | 'contacts';
const scopes: Record<GoogleOAuthKind, string[]> = {
  calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  calendar_write: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  gmail_send: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'],
  gmail_read: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  contacts: ['openid', 'email', 'https://www.googleapis.com/auth/contacts.readonly'],
};
const filenames: Record<GoogleOAuthKind, string> = { calendar: 'calendar-connection.json', calendar_write: 'calendar-write-connection.json', gmail_send: 'gmail-connection.json', gmail_read: 'gmail-replies-connection.json', contacts: 'contacts-connection.json' };
const b64 = () => randomBytes(32).toString('base64url');
type Flow = { userId: string; kind: GoogleOAuthKind; verifier: string; completionHash: Buffer; expiresAt: number; ticketHash?: string };
type Pending = { flow: Flow; senderAddress: string; subject: string; refreshToken: string };
type Connections = {
  gmailContact?: Awaited<ReturnType<typeof getGmailConnection>>;
  gmailReplyConnection?: Awaited<ReturnType<typeof getGmailReplyConnection>>;
  calendarConnection?: Awaited<ReturnType<typeof getCalendarConnection>>;
  calendarWriteConnection?: Awaited<ReturnType<typeof getCalendarWriteConnection>>;
  contactsConnection?: Awaited<ReturnType<typeof getContactsConnection>>;
  blocked?: { gmailContact: boolean; gmailReplyConnection: boolean; calendarConnection: boolean; calendarWriteConnection: boolean; contactsConnection: boolean };
};

export function createGoogleOAuth(options: { env: NodeJS.ProcessEnv; fetcher?: typeof fetch; clock?: () => number; legacyGmail?: { userId: string; credentialPath: string } }) {
  const env = options.env, fetcher = options.fetcher ?? fetch, clock = options.clock ?? Date.now;
  const clientId = env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const directory = env.PIKKU_GOOGLE_USER_CREDENTIAL_DIR?.trim(), redirect = env.PIKKU_GOOGLE_OAUTH_REDIRECT_URI?.trim();
  let redirectUrl: URL | undefined;
  try { if (redirect) redirectUrl = new URL(redirect); } catch { /* configuration rejected below */ }
  const configured = !!clientId && !!clientSecret && !!directory && isAbsolute(directory) && !!redirectUrl &&
    redirectUrl.protocol === 'https:' && !redirectUrl.username && !redirectUrl.password && !redirectUrl.search && !redirectUrl.hash &&
    redirectUrl.pathname === '/v1/google/oauth/callback';
  const states = new Map<string, Flow>(), latest = new Map<string, Flow>(), pending = new Map<string, Pending>();
  const locks = new Map<string, Promise<void>>();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const keyFor = (userId: string, kind: GoogleOAuthKind) => JSON.stringify([userId, kind]);
  async function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key); let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; }); locks.set(key, next);
    if (previous) await previous;
    try { return await run(); } finally { if (locks.get(key) === next) locks.delete(key); release(); }
  }
  const userDir = (userId: string) => join(directory!, createHash('sha256').update(userId).digest('hex'));
  async function privateDirectory(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('unavailable');
  }
  async function pathFor(userId: string, kind: GoogleOAuthKind, create = false) {
    await privateDirectory(directory!);
    const path = userDir(userId);
    if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await privateDirectory(path);
    return join(path, filenames[kind]);
  }
  async function sendPath(userId: string) {
    const current = join(userDir(userId), filenames.gmail_send);
    try { await privateDirectory(directory!); await privateDirectory(userDir(userId)); await lstat(current); return current; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      return options.legacyGmail?.userId === userId ? options.legacyGmail.credentialPath : current;
    }
  }
  async function start(userId: string, kind: GoogleOAuthKind) {
    if (!configured) return undefined;
    await privateDirectory(directory!);
    return locked(keyFor(userId, kind), async () => {
    const now = clock();
    for (const [state, flow] of states) if (flow.expiresAt <= now) { states.delete(state); if (latest.get(keyFor(flow.userId, flow.kind)) === flow) latest.delete(keyFor(flow.userId, flow.kind)); }
    if (states.size + pending.size >= 1000) throw new Error('unavailable');
    const state = b64(), verifier = b64(), completionSecret = b64();
    const previous = latest.get(keyFor(userId, kind));
    if (previous?.ticketHash) pending.delete(previous.ticketHash);
    const flow: Flow = { userId, kind, verifier, completionHash: digest(completionSecret), expiresAt: now + 10 * 60_000 };
    states.set(state, flow); latest.set(keyFor(userId, kind), flow);
    const timer = setTimeout(() => { states.delete(state); if (flow.ticketHash) pending.delete(flow.ticketHash); if (latest.get(keyFor(userId, kind)) === flow) latest.delete(keyFor(userId, kind)); }, 10 * 60_000);
    timer.unref();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId!, redirect_uri: redirect!, response_type: 'code', scope: scopes[kind].join(' '),
      access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { authorizationUrl: url.toString(), completionSecret };
    });
  }
  async function callback(state: string, code: string): Promise<string | undefined> {
    const flow = states.get(state); states.delete(state);
    if (!configured || !flow) return undefined;
    let completed = false;
    try {
      if (flow.expiresAt <= clock() || latest.get(keyFor(flow.userId, flow.kind)) !== flow || !code || code.length > 2048) return undefined;
      const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, redirect_uri: redirect!, grant_type: 'authorization_code', code, code_verifier: flow.verifier }).toString() });
      if (!response.ok) return undefined;
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
      const token = data as Record<string, unknown>, granted = new Set(typeof token.scope === 'string' ? token.scope.split(/\s+/) : []);
      if (typeof token.access_token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(token.access_token) || token.token_type !== 'Bearer' ||
          typeof token.refresh_token !== 'string' || !/^[^\x00-\x20\x7f]{1,4096}$/.test(token.refresh_token) ||
          !scopes[flow.kind].filter(x => x !== 'email').every(x => granted.has(x)) || !(granted.has('email') || granted.has('https://www.googleapis.com/auth/userinfo.email'))) return undefined;
      const identity = await googleUserInfo(fetcher, token.access_token);
      if (flow.kind === 'gmail_read') {
        const sent = await readGmailCredential(await sendPath(flow.userId));
        if (!sent || sent.subject !== identity.subject || sent.senderAddress !== identity.senderAddress) return undefined;
      }
      if (flow.expiresAt <= clock() || latest.get(keyFor(flow.userId, flow.kind)) !== flow) return undefined;
      const confirmationCode = b64(); flow.ticketHash = digest(confirmationCode).toString('hex');
      pending.set(flow.ticketHash, { flow, senderAddress: identity.senderAddress, subject: identity.subject, refreshToken: token.refresh_token });
      completed = true;
      return confirmationCode;
    } catch { return undefined; }
    finally { if (!completed && latest.get(keyFor(flow.userId, flow.kind)) === flow) latest.delete(keyFor(flow.userId, flow.kind)); }
  }
  async function complete(userId: string, completionSecret: string, confirmationCode: string): Promise<boolean> {
    const ticketHash = digest(confirmationCode).toString('hex'), item = pending.get(ticketHash);
    if (!item || item.flow.userId !== userId) return false;
    return locked(keyFor(userId, item.flow.kind), async () => {
    if (pending.get(ticketHash) !== item || item.flow.expiresAt <= clock() ||
        latest.get(keyFor(userId, item.flow.kind)) !== item.flow || !timingSafeEqual(item.flow.completionHash, digest(completionSecret))) return false;
    const flow = item.flow; pending.delete(ticketHash);
    try {
      if (flow.kind === 'gmail_read') {
        const sent = await readGmailCredential(await sendPath(userId));
        if (!sent || sent.subject !== item.subject || sent.senderAddress !== item.senderAddress) return false;
      }
      const path = await pathFor(userId, flow.kind, true), temporary = `${path}.${b64()}.tmp`;
      let handle; let created = false;
      try {
        handle = await open(temporary, 'wx', 0o600);
        created = true;
        await handle.writeFile(JSON.stringify({ version: 1, clientId, senderAddress: item.senderAddress, subject: item.subject, refreshToken: item.refreshToken }));
        await handle.close(); handle = undefined;
        if (flow.expiresAt <= clock() || latest.get(keyFor(flow.userId, flow.kind)) !== flow) return false;
        await rename(temporary, path);
      } finally { await handle?.close(); if (created) await unlink(temporary).catch(() => {}); }
      return true;
    } catch { return false; }
    finally { if (latest.get(keyFor(flow.userId, flow.kind)) === flow) latest.delete(keyFor(flow.userId, flow.kind)); }
    });
  }
  async function connections(userId: string): Promise<Connections> {
    if (!configured) return {};
    const blocked = { gmailContact: true, gmailReplyConnection: true, calendarConnection: true, calendarWriteConnection: true, contactsConnection: true };
    try {
      const dir = userDir(userId); await privateDirectory(directory!);
      try { await privateDirectory(dir); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
        return { blocked };
      }
      const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'; } };
      blocked.gmailContact = await exists(join(dir, filenames.gmail_send));
      blocked.gmailReplyConnection = blocked.gmailContact || await exists(join(dir, filenames.gmail_read));
      const calendarReadPath = join(dir, filenames.calendar), calendarWritePath = join(dir, filenames.calendar_write);
      const hasCalendarRead = await exists(calendarReadPath);
      blocked.calendarWriteConnection = await exists(calendarWritePath);
      blocked.calendarConnection = hasCalendarRead || blocked.calendarWriteConnection;
      blocked.contactsConnection = await exists(join(dir, filenames.contacts));
      let gmailContact: Awaited<ReturnType<typeof getGmailConnection>>;
      let gmailReplyConnection: Awaited<ReturnType<typeof getGmailReplyConnection>>;
      let calendarConnection: Awaited<ReturnType<typeof getCalendarConnection>>;
      let calendarWriteConnection: Awaited<ReturnType<typeof getCalendarWriteConnection>>;
      let contactsConnection: Awaited<ReturnType<typeof getContactsConnection>>;
      try { gmailContact = await getGmailConnection({ env, credentialPath: join(dir, filenames.gmail_send), userId, fetcher }); } catch { /* independently unavailable */ }
      try { gmailReplyConnection = await getGmailReplyConnection({ env, credentialPath: join(dir, filenames.gmail_read), sendCredentialPath: await sendPath(userId), userId, fetcher }); } catch { /* independently unavailable */ }
      try { calendarConnection = await getCalendarConnection({ env, credentialPath: hasCalendarRead ? calendarReadPath : calendarWritePath, userId, fetcher }); } catch { /* independently unavailable */ }
      try { calendarWriteConnection = await getCalendarWriteConnection({ env, credentialPath: calendarWritePath, userId, fetcher }); } catch { /* independently unavailable */ }
      try { contactsConnection = await getContactsConnection({ env, credentialPath: join(dir, filenames.contacts), userId, fetcher }); } catch { /* independently unavailable */ }
      return { gmailContact, gmailReplyConnection, calendarConnection, calendarWriteConnection, contactsConnection, blocked };
    } catch { return { blocked }; }
  }
  return { start, callback, complete, connections };
}
