const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// The caller must verify the approved immutable content and record the execution intent before dispatch.
export type ApprovedGmailContact = Readonly<{
  recipient: string;
  subject: string;
  message: string;
  executionKey: string;
}>;

export type GmailContactResult =
  | { status: 'submitted'; providerOperationId: string }
  | { status: 'failed' | 'outcome_unknown'; providerOperationId: null };

function validRecipient(address: string): boolean {
  if (address.length > 254) return false;
  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function encodedSubject(subject: string): string {
  const words: string[] = [];
  let part = '';
  for (const character of subject) {
    if (Buffer.byteLength(part + character, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
      part = '';
    }
    part += character;
  }
  if (part) words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

// The caller must bind senderAddress and getAccessToken to the same verified account.
export function createGmailContact(options: { fetch: typeof fetch; getAccessToken: (signal?: AbortSignal) => Promise<string>; senderAddress: string }) {
  return {
    async dispatch(input: ApprovedGmailContact, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<GmailContactResult> {
      const failed: GmailContactResult = { status: 'failed', providerOperationId: null };
      const unknown: GmailContactResult = { status: 'outcome_unknown', providerOperationId: null };
      if (!input || typeof input.recipient !== 'string' || typeof input.subject !== 'string' ||
          typeof input.message !== 'string' || typeof input.executionKey !== 'string') return failed;
      const { recipient, subject, message, executionKey } = input;
      const senderAddress = options.senderAddress;
      if (typeof senderAddress !== 'string' || !validRecipient(senderAddress) || !validRecipient(recipient) || !subject.trim() || /[\x00-\x1f\x7f]/.test(subject) || !message.trim() ||
          !executionKey.trim() || /[\x00-\x20\x7f]/.test(executionKey) ||
          Buffer.from(subject, 'utf8').toString('utf8') !== subject || Buffer.from(message, 'utf8').toString('utf8') !== message) return failed;

      const body = Buffer.from(message, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
      const date = new Date().toUTCString().replace(' GMT', ' +0000');
      const mime = [`From: ${senderAddress}`, `To: ${recipient}`, `Date: ${date}`, `Subject: ${encodedSubject(subject)}`, 'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
      const raw = Buffer.from(mime, 'utf8').toString('base64url');

      let token: string;
      try {
        signal?.throwIfAborted();
        token = await options.getAccessToken(signal);
        signal?.throwIfAborted();
        if (typeof token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(token)) return failed;
      } catch { return failed; }

      try {
        await beforeSend?.();
        signal?.throwIfAborted();
      } catch { return failed; }

      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      try { requestSignal.throwIfAborted(); } catch { return failed; }
      try {
        const response = await options.fetch(SEND_URL, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }), redirect: 'error', signal: requestSignal,
        });
        if (requestSignal.aborted) return unknown;
        if (!response.ok) return [400, 401, 403, 404].includes(response.status) ? failed : unknown;
        const result: unknown = await response.json();
        if (requestSignal.aborted) return unknown;
        const id = result && typeof result === 'object' && !Array.isArray(result) ? (result as { id?: unknown }).id : null;
        if (typeof id !== 'string' || !id.trim() || id !== id.trim() || /[\x00-\x1f\x7f]/.test(id)) return unknown;
        return { status: 'submitted', providerOperationId: id };
      } catch { return unknown; }
    },
  };
}
