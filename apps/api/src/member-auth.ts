import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MemberAuthStore, type Member } from './member-auth-store.ts';

const randomToken = () => randomBytes(32).toString('base64url');
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest();
const flowTtl = 10 * 60_000;
const sessionTtl = 7 * 24 * 60 * 60_000;
type LoginResult = { sessionToken: string; expiresAt: string; member: Member };
type Flow = { state: string; verifier: string; nonce: string; completionHash: Buffer; expiresAt: number; ticketHash?: string;
  cancelled?: boolean; result?: LoginResult; completing?: Promise<LoginResult | null> };
type Pending = { flow: Flow; identity: { subject: string; email: string; displayName: string } };

async function tokenResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('MEMBER_AUTH_PROVIDER');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel().catch(() => {}); throw new Error('MEMBER_AUTH_PROVIDER'); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}

function supportedGoogleToken(value: string): boolean {
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) || segments[0]!.length > 4096) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(segments[0]!, 'base64url').toString('utf8'));
    return !!header && typeof header === 'object' && !Array.isArray(header) && 'alg' in header && header.alg === 'RS256' &&
      'kid' in header && typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 200;
  } catch { return false; }
}

export function createMemberAuth(options: { pool: Pool; env: NodeJS.ProcessEnv; fetcher?: typeof fetch; clock?: () => Date }) {
  const store = new MemberAuthStore(options.pool); const clock = options.clock ?? (() => new Date());
  const fetcher = options.fetcher ?? fetch;
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirect = options.env.PIKKU_GOOGLE_OAUTH_REDIRECT_URI?.trim();
  let redirectUrl: URL | undefined;
  try { if (redirect) redirectUrl = new URL(redirect); } catch { /* invalid configuration */ }
  const configured = !!clientId && !!clientSecret && !!redirectUrl && redirectUrl.protocol === 'https:' &&
    !redirectUrl.username && !redirectUrl.password && !redirectUrl.search && !redirectUrl.hash &&
    redirectUrl.pathname === '/v1/google/oauth/callback';
  const verifier = new OAuth2Client({ clientId, transporterOptions: { timeout: 15_000, retry: false } });
  const states = new Map<string, Flow>(); const pending = new Map<string, Pending>(); const flows = new Map<string, Flow>();
  const now = () => { const value = clock().getTime(); if (!Number.isFinite(value)) throw new Error('MEMBER_AUTH_CLOCK'); return value; };
  const cleanup = (current: number) => {
    for (const [state, flow] of states) if (flow.expiresAt <= current) states.delete(state);
    for (const [key, item] of pending) if (item.flow.expiresAt <= current) pending.delete(key);
    for (const [key, flow] of flows) if (flow.expiresAt <= current) { flow.cancelled = true; flows.delete(key); }
  };

  function start(): { authorizationUrl: string; completionSecret: string } | undefined {
    if (!configured) return undefined;
    const current = now(); cleanup(current);
    if (flows.size >= 1000) throw new Error('MEMBER_AUTH_UNAVAILABLE');
    const state = `member_${randomToken()}`, codeVerifier = randomToken(), nonce = randomToken(), completionSecret = randomToken();
    const flow: Flow = { state, verifier: codeVerifier, nonce, completionHash: hash(completionSecret), expiresAt: current + flowTtl };
    states.set(state, flow);
    const flowKey = flow.completionHash.toString('hex'); flows.set(flowKey, flow);
    const timer = setTimeout(() => { flow.cancelled = true; states.delete(state); if (flow.ticketHash) pending.delete(flow.ticketHash); flows.delete(flowKey); }, flowTtl);
    timer.unref();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId!, redirect_uri: redirect!, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: hash(codeVerifier).toString('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return { authorizationUrl: url.toString(), completionSecret };
  }

  const ownsState = (state: unknown): boolean => typeof state === 'string' && state.startsWith('member_');

  async function callback(state: string, code: string): Promise<string | undefined> {
    if (!/^member_[A-Za-z0-9_-]{43}$/.test(state)) return undefined;
    const flow = states.get(state); states.delete(state);
    if (!configured || !flow || flow.expiresAt <= now() || typeof code !== 'string' || !code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) {
      if (flow) flows.delete(flow.completionHash.toString('hex'));
      return undefined;
    }
    let completed = false;
    try {
      const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!,
          redirect_uri: redirect!, grant_type: 'authorization_code', code, code_verifier: flow.verifier }).toString() });
      const raw = await tokenResponse(response);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('id_token' in raw) ||
          typeof raw.id_token !== 'string' || raw.id_token.length > 16_384 || !supportedGoogleToken(raw.id_token)) return undefined;
      const ticket = await verifier.verifyIdToken({ idToken: raw.id_token, audience: clientId! });
      const payload = ticket.getPayload(); const current = now();
      if (!payload || payload.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
          !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= current || payload.nonce !== flow.nonce ||
          typeof payload.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) ||
          payload.email_verified !== true || typeof payload.email !== 'string' || !z.email().max(254).safeParse(payload.email).success ||
          flow.expiresAt <= current || flow.cancelled) return undefined;
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const displayName = name && name.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(name) && Buffer.from(name, 'utf8').toString('utf8') === name ? name : '회원';
      const confirmationCode = randomToken();
      flow.ticketHash = hash(confirmationCode).toString('hex');
      pending.set(flow.ticketHash, { flow, identity: { subject: payload.sub, email: payload.email, displayName } });
      completed = true;
      return confirmationCode;
    } catch { return undefined; }
    finally { if (!completed) flows.delete(flow.completionHash.toString('hex')); }
  }

  async function finish(key: string, item: Pending): Promise<LoginResult | null> {
    const flow = item.flow;
    if (flow.completing) return flow.completing;
    if (pending.get(key) !== item || flow.cancelled || flow.expiresAt <= now()) return null;
    pending.delete(key);
    flow.completing = (async () => {
      const sessionToken = randomToken(); const current = now(); const expiresAt = new Date(current + sessionTtl);
      const member = await store.createSession(item.identity, hash(sessionToken).toString('hex'), new Date(current), expiresAt);
      if (flow.cancelled || flow.expiresAt <= now()) {
        await store.revokeSession(hash(sessionToken).toString('hex'), new Date(now()));
        return null;
      }
      return flow.result = { sessionToken, expiresAt: expiresAt.toISOString(), member };
    })();
    try { return await flow.completing; }
    catch (error) { flows.delete(flow.completionHash.toString('hex')); throw error; }
    finally { delete flow.completing; }
  }
  async function complete(completionSecret: string, confirmationCode: string): Promise<LoginResult | null> {
    if (!secretPattern.test(completionSecret) || !secretPattern.test(confirmationCode)) return null;
    const key = hash(confirmationCode).toString('hex'), item = pending.get(key);
    if (!item) return null;
    const current = now();
    if (item.flow.expiresAt <= current) { pending.delete(key); return null; }
    if (!timingSafeEqual(item.flow.completionHash, hash(completionSecret))) return null;
    return finish(key, item);
  }
  async function poll(completionSecret: string): Promise<{ status: 'pending' } | ({ status: 'completed' } & LoginResult) | null> {
    if (!secretPattern.test(completionSecret)) return null;
    const flow = flows.get(hash(completionSecret).toString('hex'));
    if (!flow || flow.cancelled || flow.expiresAt <= now() || !timingSafeEqual(flow.completionHash, hash(completionSecret))) return null;
    if (flow.result) return { status: 'completed', ...flow.result };
    if (flow.completing) { const result = await flow.completing; return result ? { status: 'completed', ...result } : null; }
    const item = flow.ticketHash && pending.get(flow.ticketHash);
    if (!item || !flow.ticketHash) return { status: 'pending' };
    const result = await finish(flow.ticketHash, item);
    return result ? { status: 'completed', ...result } : null;
  }
  function cancel(completionSecret: string): boolean {
    if (!secretPattern.test(completionSecret)) return false;
    const key = hash(completionSecret).toString('hex'), flow = flows.get(key);
    if (!flow || flow.cancelled || flow.result || flow.expiresAt <= now()) return false;
    flow.cancelled = true; flows.delete(key); states.delete(flow.state);
    if (flow.ticketHash) pending.delete(flow.ticketHash);
    return true;
  }

  async function me(token: string): Promise<Member | null> {
    return typeof token === 'string' && secretPattern.test(token) ? store.findSession(hash(token).toString('hex'), new Date(now())) : null;
  }
  async function logout(token: string): Promise<boolean> {
    return typeof token === 'string' && secretPattern.test(token) ? store.revokeSession(hash(token).toString('hex'), new Date(now())) : false;
  }
  async function resolve(token: string) { const member = await me(token); return member ? { userId: member.id } : null; }
  return { migrate: () => store.migrate(), start, ownsState, callback, complete, poll, cancel, me, logout, resolve };
}

export type MemberAuth = ReturnType<typeof createMemberAuth>;
