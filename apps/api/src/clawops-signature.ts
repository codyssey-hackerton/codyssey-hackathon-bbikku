import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TwilioFormParams } from './voice-signature.ts';

// externalUrl must be the trusted, exact URL that ClawOps signed.
export function verifyClawOpsSignature(signingSecret: string, signature: string, externalUrl: string, params: TwilioFormParams): boolean {
  if (typeof signingSecret !== 'string' || signingSecret.length > 4096 || !/^[\x21-\x7e]+$/.test(signingSecret) ||
      typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
      typeof externalUrl !== 'string' || externalUrl.length > 4096 || !/^https:\/\/[^/?#]+/i.test(externalUrl) ||
      /[\s\\#]|%(?![0-9a-f]{2})/i.test(externalUrl) || !params || typeof params !== 'object' || Array.isArray(params)) return false;
  try {
    const url = new URL(externalUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
    const prototype = Object.getPrototypeOf(params);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(params).sort();
    if (keys.length > 128) return false;
    let data = externalUrl;
    for (const key of keys) {
      const value = params[key];
      if (!key || key.length > 256 || typeof value !== 'string' || value.length > 8192) return false;
      data += key + value;
      if (Buffer.byteLength(data, 'utf8') > 32_768) return false;
    }
    const expected = createHmac('sha256', signingSecret).update(data, 'utf8').digest('base64');
    return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(signature, 'ascii'));
  } catch { return false; }
}
