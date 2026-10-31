import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createClawOpsReplies } from './clawops-replies.ts';
import { managedCallBindingKey } from './phone-dispatch.ts';
import type { PhoneConnections } from './phone-connection.ts';
import type { PlanningStore } from './planning-store.ts';

// Exact phrases only: never infer a hang-up request from a negation or quotation.
function requestsHangup(text: string): boolean {
  if (/["'“”‘’「」『』]/u.test(text)) return false;
  const normalized = text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (/^통화\s*그만$/u.test(normalized)) return true;
  return /^(?:(?:네|예|알겠어|알겠어요|알겠습니다|좋아요|좋습니다)[\s,.!?。？！]*)?(?:(?:이제|그럼|이만)\s*)?(?:(?:(?:통화|전화)\s*)?(?:끊어\s*(?:줘|주세요)?|끊어요|끊으세요|끊자|끝내|끝내줘|끝내주세요|종료해|종료해줘|종료해주세요)|왜\s*안\s*끊어(?:요)?)[\s.!?。？！]*$/u.test(normalized);
}

function abortableFetch(fetcher: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const abort = () => { combined.removeEventListener('abort', abort); reject(new Error('ABORTED')); };
    if (combined.aborted) { abort(); return; }
    combined.addEventListener('abort', abort, { once: true });
    try {
      fetcher(input, { ...init, signal: combined }).then(
        response => { combined.removeEventListener('abort', abort); resolve(response); },
        error => { combined.removeEventListener('abort', abort); reject(error); },
      );
    } catch (error) { combined.removeEventListener('abort', abort); reject(error); }
  });
}

export function createManagedCallWatch(options: {
  store: PlanningStore; connections: PhoneConnections; fetch?: typeof fetch; now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const fetcher = options.fetch ?? options.connections.fetcher;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (async (milliseconds: number, signal: AbortSignal) => { await delay(milliseconds, undefined, { signal }); });
  const active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  const attempted = new Set<string>();
  let stopped = false;

  async function watch(userId: string, contactId: string, signal: AbortSignal) {
    const started = now();
    if (!Number.isFinite(started)) return;
    const deadline = started + 150_000;
    const initial = await options.store.read(userId);
    const contact = initial.contactRequests.get(contactId);
    const credential = await options.connections.read(userId).catch(() => undefined);
    if (signal.aborted || !contact || contact.channel !== 'phone' || contact.deliveryStatus !== 'sent_or_connected' ||
        !contact.providerOperationId || contact.recipientSnapshot.channel !== 'phone' || !credential ||
        credential.provider !== 'clawops' || credential.mode !== 'agent') return;
    const agentCredential = credential;
    const binding = { contactId, accountId: credential.accountId, agentId: credential.agentId, fromNumber: credential.fromNumber, mode: 'agent' };
    const bindingKey = managedCallBindingKey(contact.executionKey);
    if (!isDeepStrictEqual(initial.voiceSessions.get(bindingKey), binding)) return;
    const callId = contact.providerOperationId;
    const attemptKey = JSON.stringify([userId, contactId, callId]);
    if (attempted.has(attemptKey)) return;
    const checkInput = { callId, fromNumber: credential.fromNumber, toNumber: contact.recipientSnapshot.address, createdAt: contact.createdAt };
    const unchanged = async () => {
      const latestCredential = await options.connections.read(userId).catch(() => undefined);
      const state = await options.store.read(userId);
      return !signal.aborted && isDeepStrictEqual(latestCredential, credential) &&
        isDeepStrictEqual(state.contactRequests.get(contactId), contact) && isDeepStrictEqual(state.voiceSessions.get(bindingKey), binding);
    };
    let connectedAt: number | undefined; let verified = false;
    while (!signal.aborted) {
      if (!await unchanged()) return;
      const current = now();
      if (!Number.isFinite(current) || current < started) return;
      if (current >= deadline || (connectedAt !== undefined && current - connectedAt >= 120_000)) {
        if (!verified || !await unchanged()) return;
        await terminate(); return;
      }
      const remaining = Math.max(1, Math.ceil(deadline - current));
      const timed = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      const replies = createClawOpsReplies({ accountId: credential.accountId, apiKey: credential.apiKey, fetch: abortableFetch(fetcher, timed) });
      const result = await replies.check(checkInput);
      if (signal.aborted || !await unchanged()) return;
      if (result.ok) {
        verified = true;
        if (!['queued', 'ringing', 'in-progress'].includes(result.callStatus)) return;
        if (result.callStatus === 'in-progress' && connectedAt === undefined) connectedAt = now();
        if (result.events.some(event => event.role === 'user' && requestsHangup(event.text))) {
          if (await unchanged()) await terminate();
          return;
        }
      } else if (result.error === 'forbidden' || result.error === 'invalid_request') return;
      const next = Math.min(3000, Math.max(0, deadline - now()), connectedAt === undefined ? Infinity : Math.max(0, connectedAt + 120_000 - now()));
      if (next > 0) { try { await wait(next, signal); } catch { return; } }
    }

    async function terminate() {
      let request: Promise<unknown> | undefined;
      await options.store.atomic(userId, async () => {
        if (attempted.has(attemptKey) || attempted.size >= 10_000 || !await unchanged()) return;
        attempted.add(attemptKey);
        const url = `https://api.claw-ops.com/v1/accounts/${encodeURIComponent(agentCredential.accountId)}/calls/${encodeURIComponent(callId)}`;
        request = abortableFetch(fetcher, signal)(url, { method: 'POST', headers: { Authorization: `Bearer ${agentCredential.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ Status: 'completed' }), redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => {});
      });
      await request;
    }
  }

  function start(userId: string, contactId: string): void {
    if (stopped || !userId || !contactId || active.size >= 1000) return;
    const key = JSON.stringify([userId, contactId]);
    if (active.has(key)) return;
    const controller = new AbortController();
    const task = watch(userId, contactId, controller.signal).catch(() => {}).finally(() => {
      if (active.get(key)?.controller === controller) active.delete(key);
    });
    active.set(key, { controller, task });
  }
  async function stop(): Promise<void> {
    stopped = true;
    const entries = [...active.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.task));
  }
  return { start, stop };
}
