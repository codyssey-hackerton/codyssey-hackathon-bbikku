import { PlanningError } from './planning-service.ts';

const unavailable = () => new PlanningError(503, 'provider_unavailable', '이메일 회신을 확인하지 못했습니다.');
type Message = { id?: unknown; threadId?: unknown; internalDate?: unknown; labelIds?: unknown; payload?: any };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
function headers(message: Message): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!Array.isArray(message.payload?.headers)) return result;
  for (const item of message.payload.headers) {
    if (typeof item?.name !== 'string' || typeof item?.value !== 'string' || /[\r\n\x00]/.test(item.value)) continue;
    const name = item.name.toLowerCase(); result.set(name, [...(result.get(name) ?? []), item.value]);
  }
  return result;
}
function one(values: Map<string, string[]>, name: string): string | null {
  const found = values.get(name); return found?.length === 1 ? found[0] : null;
}
function mailbox(value: string | null): string | null {
  if (!value || /[,;\r\n]/.test(value)) return null;
  const address = /^(?:[^<>]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+)>?$/i.exec(value.trim());
  return address?.[1].toLowerCase() ?? null;
}
function messageId(value: string | null): string | null {
  return value && /^<[^<>\s]{1,500}>$/.test(value.trim()) ? value.trim() : null;
}
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const time = Number(value); return Number.isSafeInteger(time) && Number.isFinite(new Date(time).getTime()) ? time : null;
}
function plainText(payload: any): string | null {
  let visited = 0;
  function find(part: any): string | null {
    if (!part || typeof part !== 'object' || ++visited > 30 || part.filename || part.body?.attachmentId) return null;
    if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(part.body.data) && part.body.data.length <= 100_000) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) { const text = find(child); if (text !== null) return text; }
    return null;
  }
  const raw = find(payload); if (raw === null) return null;
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:>|--\s*$|_{5,}|-{3,}\s*(?:original message|원본 메시지)|on .+wrote:|.+님이 작성:)/i.test(line)) break;
    lines.push(line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ''));
  }
  const text = lines.join('\n').trim().slice(0, 2000).replace(/[\ud800-\udbff]$/, ''); return text || null;
}

export function createGmailReplies(options: { senderAddress: string; getAccessToken: () => Promise<string>; fetcher: typeof fetch }) {
  async function read(url: string, token: string): Promise<any> {
    try {
      const response = await options.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw unavailable(); return await response.json();
    } catch { throw unavailable(); }
  }
  return {
    async checkReplies(input: { providerOperationId: string; recipientAddress: string; expectedSenderAddress: string }) {
      if (!validId(input.providerOperationId) || mailbox(input.recipientAddress) === null || mailbox(input.expectedSenderAddress) !== mailbox(options.senderAddress)) throw unavailable();
      let token: string; try { token = await options.getAccessToken(); } catch { throw unavailable(); }
      if (typeof token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(token)) throw unavailable();
      const original = await read(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.providerOperationId)}?format=metadata`, token) as Message;
      const h = headers(original); const originId = messageId(one(h, 'message-id')); const sentAt = instant(original.internalDate);
      if (original.id !== input.providerOperationId || !validId(original.threadId) || !Array.isArray(original.labelIds) || !original.labelIds.includes('SENT') ||
          mailbox(one(h, 'from')) !== mailbox(options.senderAddress) || mailbox(one(h, 'to')) !== mailbox(input.recipientAddress) || !originId || sentAt === null) throw unavailable();
      const thread = await read(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(original.threadId)}?format=full`, token);
      if (!thread || thread.id !== original.threadId || !Array.isArray(thread.messages) || thread.messages.length > 200) throw unavailable();
      const events: { providerEventId: string; providerOperationId: string; channel: 'email'; recipientAddress: string; receivedAt: string; outcome: 'unclear'; selectedOptionId: null; evidenceRef: string; displayText: string | null; reviewReason: string }[] = [];
      let unmatchedCount = 0; const seen = new Set<string>();
      for (const message of thread.messages as Message[]) {
        if (message.id === original.id) continue;
        if (!validId(message.id) || seen.has(message.id) || message.threadId !== original.threadId || !Array.isArray(message.labelIds)) { unmatchedCount++; continue; }
        seen.add(message.id);
        if (message.labelIds.includes('SENT')) continue;
        if (message.labelIds.some(label => ['SPAM', 'TRASH', 'DRAFT'].includes(label))) { unmatchedCount++; continue; }
        const values = headers(message); const received = instant(message.internalDate);
        const refs: string[] = `${one(values, 'in-reply-to') ?? ''} ${one(values, 'references') ?? ''}`.match(/<[^<>\s]{1,500}>/g) ?? [];
        if (received === null || received <= sentAt || mailbox(one(values, 'from')) !== mailbox(input.recipientAddress) ||
            mailbox(one(values, 'to')) !== mailbox(options.senderAddress) || !refs.includes(originId)) { unmatchedCount++; continue; }
        const automatic = (values.get('auto-submitted') ?? []).some(value => value.trim().toLowerCase() !== 'no') ||
          (values.get('precedence') ?? []).some(value => /^(bulk|junk|list|auto_reply)$/i.test(value.trim())) || (values.get('x-autoreply')?.length ?? 0) > 0;
        events.push({ providerEventId: message.id, providerOperationId: input.providerOperationId, channel: 'email', recipientAddress: input.recipientAddress,
          receivedAt: new Date(received).toISOString(), outcome: 'unclear', selectedOptionId: null, evidenceRef: `gmail:${message.id}`,
          displayText: plainText(message.payload), reviewReason: automatic ? 'automatic_message' : 'sender_unverified' });
        if (events.length > 100) throw unavailable();
      }
      return { events, unmatchedCount };
    },
  };
}
