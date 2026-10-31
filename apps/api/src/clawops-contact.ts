import type { ApprovedTwilioContact, TwilioContactResult } from './twilio-contact.ts';

const e164 = /^\+[1-9][0-9]{1,14}$/;
const domestic = (number: string) => number.startsWith('+82') ? `0${number.slice(3)}` : number;
const failed: TwilioContactResult = { status: 'failed', providerOperationId: null };
const unknown: TwilioContactResult = { status: 'outcome_unknown', providerOperationId: null };

async function readCallId(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'callId' in parsed ? parsed.callId : null;
    return typeof id === 'string' && id.length <= 200 && id.trim() === id && id.length > 0 &&
      !/[\x00-\x1f\x7f-\x9f]/u.test(id) && Buffer.from(id, 'utf8').toString('utf8') === id ? id : null;
  } finally { reader.releaseLock(); }
}

export function createClawOpsContact(options: { accountId: string; apiKey: string; fromNumber: string; fetch: typeof fetch; voiceUrl: string }) {
  const { accountId, apiKey, fromNumber, fetch: send, voiceUrl } = options;
  return {
    async dispatch(input: ApprovedTwilioContact, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<TwilioContactResult> {
      if (!input || typeof input.recipient !== 'string' || !e164.test(input.recipient) ||
          (input.recipient.startsWith('+82') && !/^\+82[1-9]/.test(input.recipient)) ||
          typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffe\uffff]/u.test(input.message) ||
          Buffer.from(input.message, 'utf8').toString('utf8') !== input.message ||
          typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId) ||
          typeof apiKey !== 'string' || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey) ||
          typeof fromNumber !== 'string' || !e164.test(fromNumber) ||
          (fromNumber.startsWith('+82') && !/^\+82[1-9]/.test(fromNumber)) || typeof send !== 'function' ||
          typeof voiceUrl !== 'string' || voiceUrl.length > 2048 || !/^https:\/\/[^/?#]+/i.test(voiceUrl) ||
          /[\s\\#]|%(?![0-9a-f]{2})/i.test(voiceUrl)) return failed;
      try {
        const url = new URL(voiceUrl);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return failed;
      } catch { return failed; }
      const body = JSON.stringify({ To: domestic(input.recipient), From: domestic(fromNumber), Url: voiceUrl, Timeout: 30 });
      try {
        signal?.throwIfAborted();
        await beforeSend?.();
        signal?.throwIfAborted();
      } catch { return failed; }
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      try { requestSignal.throwIfAborted(); } catch { return failed; }
      try {
        const response = await send(`https://api.claw-ops.com/v1/accounts/${accountId}/calls`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, redirect: 'error', signal: requestSignal,
        });
        if (requestSignal.aborted) return unknown;
        if (response.status >= 400 && response.status < 500 && response.status !== 408) return failed;
        if (response.status !== 201) return unknown;
        const id = await readCallId(response);
        if (requestSignal.aborted || !id) return unknown;
        return { status: 'submitted', providerOperationId: id };
      } catch { return unknown; }
    },
  };
}
