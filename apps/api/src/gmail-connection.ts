import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGmailContact } from './gmail-contact.ts';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_CREDENTIAL_PATH = fileURLToPath(new URL('../../../.local/gmail-connection.json', import.meta.url));
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const unavailable = () => new Error('GMAIL_CONNECTION_UNAVAILABLE');
const withTimeout = (signal?: AbortSignal): AbortSignal => signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
const textValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);
const objectValue = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type GmailCredential = { version: 1; clientId: string; senderAddress: string; subject: string; refreshToken: string };

function validSender(value: unknown): value is string {
  if (!textValue(value) || value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function parseGmailCredential(value: unknown): GmailCredential {
  if (!objectValue(value) || value.version !== 1 || !textValue(value.clientId) || !validSender(value.senderAddress) ||
      !textValue(value.subject) || !textValue(value.refreshToken)) throw unavailable();
  return { version: 1, clientId: value.clientId, senderAddress: value.senderAddress, subject: value.subject, refreshToken: value.refreshToken };
}

export function parseGoogleToken(value: unknown): { accessToken: string; refreshToken?: string } {
  if (!objectValue(value) || !textValue(value.access_token) || !/^[a-z0-9._~+/-]+=*$/i.test(value.access_token) ||
      value.token_type !== 'Bearer' || typeof value.scope !== 'string') throw unavailable();
  const scopes = new Set(value.scope.split(/\s+/));
  if (!scopes.has(GMAIL_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email'))) throw unavailable();
  if (value.refresh_token !== undefined && !textValue(value.refresh_token)) throw unavailable();
  return { accessToken: value.access_token, ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}) };
}

export async function googleUserInfo(fetcher: typeof fetch, accessToken: string, signal?: AbortSignal): Promise<{ senderAddress: string; subject: string }> {
  try {
    const requestSignal = withTimeout(signal);
    requestSignal.throwIfAborted();
    const response = await fetcher(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: requestSignal,
    });
    requestSignal.throwIfAborted();
    if (!response.ok) throw unavailable();
    const value: unknown = await response.json();
    requestSignal.throwIfAborted();
    if (!objectValue(value) || value.email_verified !== true || !validSender(value.email) || !textValue(value.sub)) throw unavailable();
    return { senderAddress: value.email, subject: value.sub };
  } catch { throw unavailable(); }
}

export async function readGmailCredential(path: string): Promise<GmailCredential | undefined> {
  let handle;
  try {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw unavailable();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o7777) !== 0o600 || info.size > 65_536 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw unavailable();
    return parseGmailCredential(JSON.parse(await handle.readFile('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw unavailable();
  } finally { await handle?.close(); }
}

export async function getGmailConnection(options: { env: NodeJS.ProcessEnv; credentialPath?: string; fetcher?: typeof fetch }) {
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!!clientId !== !!clientSecret || (clientId && !textValue(clientId)) || (clientSecret && !textValue(clientSecret))) throw unavailable();
  const path = options.credentialPath ?? GMAIL_CREDENTIAL_PATH;
  const saved = await readGmailCredential(path);
  if (!saved) return undefined;
  if (!clientId || !clientSecret || saved.clientId !== clientId) throw unavailable();
  const fetcher = options.fetcher ?? fetch;
  const adapter = createGmailContact({
    fetch: fetcher, senderAddress: saved.senderAddress,
    async getAccessToken(signal) {
      try {
        signal?.throwIfAborted();
        const current = await readGmailCredential(path);
        signal?.throwIfAborted();
        if (!current || current.clientId !== clientId || current.subject !== saved.subject || current.senderAddress !== saved.senderAddress) throw unavailable();
        const requestSignal = withTimeout(signal);
        requestSignal.throwIfAborted();
        const response = await fetcher(TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: requestSignal,
          body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString(),
        });
        requestSignal.throwIfAborted();
        if (!response.ok) throw unavailable();
        const token = parseGoogleToken(await response.json());
        requestSignal.throwIfAborted();
        // A rotated refresh token needs a new connection rather than an unrecorded credential change.
        if (token.refreshToken && token.refreshToken !== current.refreshToken) throw unavailable();
        const identity = await googleUserInfo(fetcher, token.accessToken, signal);
        signal?.throwIfAborted();
        if (identity.subject !== current.subject || identity.senderAddress !== current.senderAddress) throw unavailable();
        const latest = await readGmailCredential(path);
        signal?.throwIfAborted();
        if (!latest || latest.clientId !== current.clientId || latest.subject !== current.subject ||
            latest.senderAddress !== current.senderAddress || latest.refreshToken !== current.refreshToken) throw unavailable();
        return token.accessToken;
      } catch { throw unavailable(); }
    },
  });
  return { userId: 'local-developer' as const, senderAddress: saved.senderAddress, dispatch: adapter.dispatch };
}
