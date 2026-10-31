import { timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';

export type TwilioFormParams = Readonly<Record<string, string | readonly string[]>>;

// externalUrl must come from trusted configuration, including its exact encoded query string.
export function verifyTwilioSignature(authToken: string, signature: string, externalUrl: string, params: TwilioFormParams): boolean {
  if (typeof authToken !== 'string' || !/^[\x21-\x7e]+$/.test(authToken) ||
      typeof signature !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(signature) ||
      typeof externalUrl !== 'string' || !/^https:\/\/[^/?#]+/i.test(externalUrl) ||
      /[\s\\#]|%(?![0-9a-f]{2})/i.test(externalUrl) || !params || typeof params !== 'object' || Array.isArray(params)) return false;

  try {
    const url = new URL(externalUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
    const prototype = Object.getPrototypeOf(params);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const validated: Record<string, string | string[]> = Object.create(null);
    for (const key of Object.keys(params).sort()) {
      const value = params[key];
      const values = Array.isArray(value) ? [...value] : [value];
      if (values.some(item => typeof item !== 'string')) return false;
      validated[key] = Array.isArray(value) ? values as string[] : value as string;
    }
    const expected = Buffer.from(twilio.getExpectedTwilioSignature(authToken, externalUrl, validated), 'ascii');
    const received = Buffer.from(signature, 'ascii');
    return expected.length === received.length && timingSafeEqual(expected, received) && twilio.validateRequest(authToken, signature, externalUrl, validated);
  } catch {
    return false;
  }
}
