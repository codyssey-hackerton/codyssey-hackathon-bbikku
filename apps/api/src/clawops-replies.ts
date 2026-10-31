import { parseOffsetDateTime } from '@pikku/domain';
import { normalizePhoneNumber, validPhoneNumber } from './phone-connection.ts';

type Event = { id: string; receivedAt: string; role: 'user' | 'agent'; text: string };
export type ClawOpsRepliesResult =
  | { ok: true; callStatus: string; events: Event[]; complete: boolean; truncated: boolean }
  | { ok: false; error: 'invalid_request' | 'provider_unavailable' | 'forbidden' };
type Failure = Extract<ClawOpsRepliesResult, { ok: false }>;
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const callStates = new Set(['queued', 'ringing', 'in-progress', 'completed', 'no-answer', 'busy', 'rejected', 'canceled', 'failed']);
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const eventIdPattern = /^[0-9]{1,19}$/;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('INVALID_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel().catch(() => {}); throw new Error('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}

export function createClawOpsReplies(options: { accountId: string; apiKey: string; fetch?: typeof fetch }) {
  const { accountId, apiKey } = options;
  const fetcher = options.fetch ?? fetch;
  async function read(url: URL): Promise<{ ok: true; data: unknown } | Failure> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Failure>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(fail('provider_unavailable')); }, 5000); });
    const request = async (): Promise<{ ok: true; data: unknown } | Failure> => {
      try {
        const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: controller.signal });
        if (response.status === 403 || response.status === 404) return fail('forbidden');
        if (!response.ok) return fail('provider_unavailable');
        return { ok: true, data: await boundedJson(response) };
      } catch { return fail('provider_unavailable'); }
    };
    try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
  }
  async function check(input: { callId: string; fromNumber: string; toNumber: string; createdAt: string }): Promise<ClawOpsRepliesResult> {
    if (!object(input) || typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId) ||
        typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(apiKey) || typeof input.callId !== 'string' || !idPattern.test(input.callId) ||
        typeof input.fromNumber !== 'string' || !validPhoneNumber(input.fromNumber) || typeof input.toNumber !== 'string' || !validPhoneNumber(input.toNumber) ||
        typeof input.createdAt !== 'string' || parseOffsetDateTime(input.createdAt) === null) return fail('invalid_request');
    const root = `https://api.claw-ops.com/v1/accounts/${accountId}/calls/${input.callId}`;
    const found = await read(new URL(root)); if (!found.ok) return found;
    const call = found.data;
    if (!object(call) || typeof call.callId !== 'string' || typeof call.accountId !== 'string' || typeof call.from !== 'string' ||
        typeof call.to !== 'string' || typeof call.direction !== 'string' || typeof call.status !== 'string' || !callStates.has(call.status) ||
        typeof call.dateCreated !== 'string' || parseOffsetDateTime(call.dateCreated) === null) return fail('provider_unavailable');
    if (call.callId !== input.callId || call.accountId !== accountId || call.direction !== 'outbound' ||
        normalizePhoneNumber(call.from) !== input.fromNumber || normalizePhoneNumber(call.to) !== input.toNumber ||
        parseOffsetDateTime(call.dateCreated)! < parseOffsetDateTime(input.createdAt)!) return fail('forbidden');

    const events: Event[] = []; const seen = new Map<string, string>();
    let after: string | undefined; let exhausted = false; let completeData = true; let truncated = false;
    let started = false; let ended = false; let lastId: bigint | undefined;
    for (let page = 0; page < 4; page++) {
      const url = new URL(`${root}/live-events`); url.searchParams.set('limit', '100'); if (after) url.searchParams.set('after', after);
      const result = await read(url); if (!result.ok) return result;
      if (!object(result.data) || !Array.isArray(result.data.data) || result.data.data.length > 100 || typeof result.data.hasMore !== 'boolean') return fail('provider_unavailable');
      let lastNewId: string | undefined;
      for (const entry of result.data.data) {
        if (!object(entry) || typeof entry.id !== 'string' || !eventIdPattern.test(entry.id) || typeof entry.event !== 'string' ||
            typeof entry.timestamp !== 'string' || parseOffsetDateTime(entry.timestamp) === null) return fail('provider_unavailable');
        const serialized = JSON.stringify(entry); const previous = seen.get(entry.id);
        if (previous !== undefined) { if (previous !== serialized) return fail('provider_unavailable'); continue; }
        const numericId = BigInt(entry.id);
        if (lastId !== undefined && numericId <= lastId) return fail('provider_unavailable');
        lastId = numericId; lastNewId = entry.id; seen.set(entry.id, serialized);
        if (parseOffsetDateTime(entry.timestamp)! < parseOffsetDateTime(call.dateCreated)!) { completeData = false; continue; }
        if (entry.event === 'stream.started') { if (started || ended) completeData = false; started = true; }
        else if (entry.event === 'stream.ended') {
          if (!started || ended || !object(entry.detail) || entry.detail.reason !== 'completed') completeData = false;
          ended = true;
        } else if (entry.event === 'transcript.final') {
          if (!started || ended || !object(entry.detail) || !['user', 'agent'].includes(String(entry.detail.role)) ||
              typeof entry.detail.utteranceId !== 'string' || !entry.detail.utteranceId || entry.detail.utteranceId.length > 200 ||
              typeof entry.detail.text !== 'string' || !entry.detail.text.trim()) { completeData = false; continue; }
          const original = entry.detail.text;
          const cleaned = original.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').slice(0, 2000).replace(/[\ud800-\udbff]$/, '');
          if (cleaned !== original) { truncated = true; completeData = false; }
          if (!cleaned.trim()) { completeData = false; continue; }
          events.push({ id: entry.id, receivedAt: entry.timestamp, role: entry.detail.role as 'user' | 'agent', text: cleaned });
        }
      }
      if (!result.data.hasMore) { exhausted = true; break; }
      if (!lastNewId || lastNewId === after) return fail('provider_unavailable');
      after = lastNewId;
    }
    if (!exhausted) truncated = true;
    return { ok: true, callStatus: call.status, events, complete: call.status === 'completed' && exhausted && completeData && started && ended &&
      events.some(event => event.role === 'user') && !truncated, truncated };
  }
  return { check };
}
