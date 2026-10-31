import { createHash, timingSafeEqual } from 'node:crypto';

export type Session = { userId: string };
export interface SessionResolver {
  resolve(token: string): Promise<Session | null>;
}

// Explicit, expiring access to synthetic preview users, separate from local authentication.
export function teamPreviewSession(token: string, expiresAt: string, now = () => Date.now()): SessionResolver {
  return teamPreviewSessions([{ token, userId: 'team-preview' }], expiresAt, now);
}

export function teamPreviewSessions(members: { token: string; userId: string }[], expiresAt: string, now = () => Date.now()): SessionResolver {
  const expiry = Date.parse(expiresAt);
  if (!Array.isArray(members) || !members.length || members.length > 50 || !Number.isFinite(expiry) || expiry <= now()) throw new Error('Invalid preview member configuration');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  const expected = members.map(member => {
    if (typeof member?.token !== 'string' || member.token.length < 32 || /\s/.test(member.token) || typeof member.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(member.userId) || ids.has(member.userId) || tokens.has(member.token)) throw new Error('Invalid or duplicate preview member');
    ids.add(member.userId); tokens.add(member.token);
    return { userId: member.userId, hash: createHash('sha256').update(member.token).digest() };
  });
  return { async resolve(candidate) {
    if (now() >= expiry) return null;
    const received = createHash('sha256').update(candidate).digest();
    let userId: string | undefined;
    for (const member of expected) if (timingSafeEqual(member.hash, received)) userId = member.userId;
    return userId ? { userId } : null;
  } };
}

// This adapter is for one explicitly configured local developer, not real user authentication.
export function localDevelopmentSession(token: string): SessionResolver {
  if (!token || /\s/.test(token) || token.length < 16) throw new Error('Set a local session token of at least 16 non-whitespace characters');
  const expected = createHash('sha256').update(token).digest();
  return {
    async resolve(candidate) {
      const received = createHash('sha256').update(candidate).digest();
      return timingSafeEqual(expected, received) ? { userId: 'local-developer' } : null;
    },
  };
}
