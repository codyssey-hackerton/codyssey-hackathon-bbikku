import { createHash, timingSafeEqual } from 'node:crypto';

export type Session = { userId: string };
export interface SessionResolver {
  resolve(token: string): Promise<Session | null>;
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
