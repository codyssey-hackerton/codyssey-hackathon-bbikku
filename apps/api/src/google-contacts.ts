import { googleUserInfo, readGmailCredential } from './gmail-connection.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizePhoneNumber, validPhoneNumber } from './phone-connection.ts';
import { PlanningError } from './planning-service.ts';

const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
const unavailable = () => new PlanningError(503, 'provider_unavailable', 'Google 연락처를 조회할 수 없습니다.', true);
const invalid = () => new PlanningError(400, 'invalid_request', '검색할 이름을 확인해 주세요.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let finished = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { finished = true; break; }
      size += part.value.length;
      if (size > limit) throw unavailable();
      chunks.push(part.value);
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function getContactsConnection(options: { env: NodeJS.ProcessEnv; credentialPath: string; userId: string; fetcher?: typeof fetch }) {
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!options.userId.trim() || !clientId || !clientSecret) throw unavailable();
  const path = options.credentialPath, fetcher = options.fetcher ?? fetch;
  const saved = await readGmailCredential(path).catch(() => { throw unavailable(); });
  if (!saved) return undefined;
  if (saved.clientId !== clientId) throw unavailable();
  async function current() {
    const credential = await readGmailCredential(path);
    if (!credential || credential.clientId !== clientId || credential.subject !== saved!.subject || credential.senderAddress !== saved!.senderAddress || credential.refreshToken !== saved!.refreshToken) throw unavailable();
    return credential;
  }
  async function searchContacts(input: { query: string }, request?: { signal?: AbortSignal }) {
    if (!clean(input?.query, 100)) throw invalid();
    const query = input.query.trim();
    const deadline = AbortSignal.timeout(15_000);
    const signal = request?.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
    try {
      signal.throwIfAborted();
      const credential = await abortable(current(), signal);
      signal.throwIfAborted();
      const tokenResponse = await abortable(fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: credential.refreshToken }).toString() }), signal);
      const token = await boundedJson(tokenResponse, 65_536, signal);
      if (!record(token) || typeof token.access_token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(token.access_token) || token.token_type !== 'Bearer' || typeof token.scope !== 'string' ||
          (token.refresh_token !== undefined && token.refresh_token !== credential.refreshToken)) throw unavailable();
      const scopes = new Set(token.scope.split(/\s+/));
      if (!scopes.has(CONTACTS_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email'))) throw unavailable();
      const identityFetcher: typeof fetch = async (url, init) => {
        signal.throwIfAborted();
        const response = await abortable(fetcher(url, { ...init, signal }), signal);
        return Response.json(await boundedJson(response, 65_536, signal));
      };
      const identity = await abortable(googleUserInfo(identityFetcher, token.access_token, signal), signal);
      if (identity.subject !== credential.subject || identity.senderAddress !== credential.senderAddress) throw unavailable();
      const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
      url.search = new URLSearchParams({ query: '', readMask: 'names,phoneNumbers', pageSize: '30' }).toString();
      const get = () => { signal.throwIfAborted(); return abortable(fetcher(url.toString(), { headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal }), signal); };
      const warmup = await get(); if (!warmup.ok) throw unavailable();
      if (warmup.body) await abortable(warmup.body.cancel(), signal);
      // Google documents a several-second warmup before querying its lazy contacts cache.
      await delay(5000, undefined, { signal });
      await abortable(current(), signal);
      url.searchParams.set('query', query);
      const response = await get();
      const data = await boundedJson(response, 524_288, signal);
      if (!record(data) || (data.results !== undefined && (!Array.isArray(data.results) || data.results.length > 30))) throw unavailable();
      const results = (data.results ?? []) as unknown[];
      let truncated = results.length === 30;
      const contacts: { id: string; displayName: string; phoneNumbers: { label?: string; number: string }[] }[] = [];
      for (const [index, entry] of results.entries()) {
        if (!record(entry) || !record(entry.person)) continue;
        const person = entry.person;
        const names = Array.isArray(person.names) ? person.names : [];
        const name = names.find(value => record(value) && clean(value.displayName, 200) && value.displayName.toLocaleLowerCase('ko-KR').includes(query.toLocaleLowerCase('ko-KR')));
        if (!record(name) || !clean(name.displayName, 200)) continue;
        const phoneNumbers: { label?: string; number: string }[] = [];
        if (Array.isArray(person.phoneNumbers) && person.phoneNumbers.length > 20) truncated = true;
        for (const phone of Array.isArray(person.phoneNumbers) ? person.phoneNumbers.slice(0, 20) : []) {
          if (!record(phone)) continue;
          const raw = validPhoneNumber(typeof phone.canonicalForm === 'string' ? phone.canonicalForm : '') ? phone.canonicalForm : phone.value;
          if (!clean(raw, 100)) continue;
          const compact = /^[+\d\s()./-]+$/.test(raw) ? raw.replace(/[\s()./-]/g, '') : '';
          const number = normalizePhoneNumber(compact) ?? raw.trim();
          if (phoneNumbers.some(value => value.number === number)) continue;
          const label = clean(phone.formattedType, 100) ? phone.formattedType : clean(phone.type, 100) ? phone.type : undefined;
          phoneNumbers.push({ ...(label ? { label } : {}), number });
        }
        if (phoneNumbers.length) contacts.push({ id: `contact-${index}`, displayName: name.displayName.trim(), phoneNumbers });
      }
      await abortable(current(), signal);
      return { contacts, truncated };
    } catch { throw unavailable(); }
  }
  return { userId: options.userId, accountLabel: saved.senderAddress, searchContacts };
}
