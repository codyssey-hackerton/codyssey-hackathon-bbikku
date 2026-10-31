// The caller must verify the approved immutable content and record the execution intent before dispatch.
export type ApprovedTwilioContact = Readonly<{ recipient: string; message: string }>;

export type TwilioContactResult =
  | { status: 'submitted'; providerOperationId: string }
  | { status: 'failed' | 'outcome_unknown'; providerOperationId: null };

const e164 = /^\+[1-9][0-9]{1,14}$/;
const callSid = /^CA[0-9a-f]{32}$/i;

export function createTwilioContact(options: { accountSid: string; authToken: string; fromNumber: string; fetch: typeof fetch; voiceUrl?: string }) {
  const { accountSid, authToken, fromNumber, fetch: send } = options;
  return {
    async dispatch(input: ApprovedTwilioContact, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<TwilioContactResult> {
      const failed: TwilioContactResult = { status: 'failed', providerOperationId: null };
      const unknown: TwilioContactResult = { status: 'outcome_unknown', providerOperationId: null };
      if (!input || typeof input.recipient !== 'string' || typeof input.message !== 'string' ||
          typeof accountSid !== 'string' || !/^AC[0-9a-f]{32}$/i.test(accountSid) ||
          typeof authToken !== 'string' || !/^[\x21-\x7e]+$/.test(authToken) ||
          typeof fromNumber !== 'string' || !e164.test(fromNumber)) return failed;
      const { recipient, message } = input;
      if (!e164.test(recipient) || !message.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffe\uffff]/u.test(message) ||
          Buffer.from(message, 'utf8').toString('utf8') !== message) return failed;
      const escaped = message.replace(/[&<>"'\r]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[char]!);
      const messageTwiml = `<Response><Say voice="Google.ko-KR-Standard-A" language="ko-KR">${escaped}</Say></Response>`;
      if (messageTwiml.length > 4000) return failed;
      let twiml = messageTwiml;
      if (options.voiceUrl) {
        try {
          const url = new URL(options.voiceUrl);
          if (url.protocol !== 'https:' || url.username || url.password || url.hash) return failed;
          const safe = options.voiceUrl.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
          twiml = `<Response><Pause length="1"/><Redirect method="POST">${safe}</Redirect></Response>`;
        } catch { return failed; }
      }
      const body = new URLSearchParams({ To: recipient, From: fromNumber, Twiml: twiml });
      const authorization = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
      try {
        signal?.throwIfAborted();
        await beforeSend?.();
        signal?.throwIfAborted();
      } catch { return failed; }
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      try { requestSignal.throwIfAborted(); } catch { return failed; }
      try {
        const response = await send(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
          method: 'POST', headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body, redirect: 'error', signal: requestSignal,
        });
        if (requestSignal.aborted) return unknown;
        if ([400, 401, 403, 404, 405, 422, 429].includes(response.status)) return failed;
        if (response.status !== 201) return unknown;
        const result: unknown = await response.json();
        if (requestSignal.aborted) return unknown;
        const sid = result && typeof result === 'object' && !Array.isArray(result) ? (result as { sid?: unknown }).sid : null;
        return typeof sid === 'string' && callSid.test(sid) ? { status: 'submitted', providerOperationId: sid } : unknown;
      } catch { return unknown; }
    },
  };
}
