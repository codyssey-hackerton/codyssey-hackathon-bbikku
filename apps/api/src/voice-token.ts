import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const Payload = z.object({ userId: z.string().min(1).max(200), contactId: z.string().min(1).max(200),
  sessionId: z.uuid(), expiresAt: z.number().int().positive() }).strict();
export type VoiceTokenPayload = z.infer<typeof Payload>;

export class VoiceTokens {
  private readonly key: Buffer;
  readonly publicBaseUrl: string;
  constructor(publicBaseUrl: string, sessionKey: string) {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || url.origin !== publicBaseUrl.replace(/\/$/, '')) throw new Error('VOICE_CONFIGURATION_INVALID');
    const key = Buffer.from(sessionKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== sessionKey) throw new Error('VOICE_CONFIGURATION_INVALID');
    this.publicBaseUrl = url.origin;
    this.key = key;
  }
  issue(userId: string, contactId: string, now: Date = new Date()) {
    const payload = Payload.parse({ userId, contactId, sessionId: randomUUID(), expiresAt: now.getTime() + 10 * 60_000 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  read(token: string, now: Date = new Date()): VoiceTokenPayload | null {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) return null;
    try {
      const input = Buffer.from(token, 'base64url');
      if (input.length <= 28 || input.toString('base64url') !== token) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, input.subarray(0, 12));
      decipher.setAuthTag(input.subarray(12, 28));
      const payload = Payload.parse(JSON.parse(Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8')));
      return now.getTime() < payload.expiresAt ? payload : null;
    } catch { return null; }
  }
  url(token: string, turn: number, retry = 0, provider: 'twilio' | 'clawops' = 'twilio'): string {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token) || !Number.isInteger(turn) || turn < 0 || turn > 8 ||
        !Number.isInteger(retry) || retry < 0 || retry > 3 || !['twilio', 'clawops'].includes(provider)) throw new Error('VOICE_URL_INVALID');
    return `${this.publicBaseUrl}/v1/voice/${provider}/${token}?turn=${turn}&retry=${retry}`;
  }
}
