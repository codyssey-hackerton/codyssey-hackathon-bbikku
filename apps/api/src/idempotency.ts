import { createHash, randomUUID } from 'node:crypto';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';

export type HttpResult = { status: number; body: unknown; retryableWithoutEffects?: true };
export type IdempotencyControl = { finalize: (run: () => Promise<HttpResult>) => Promise<HttpResult> };
export type IdempotencyInput = { userId: string; operation: string; key: string; requestId: string; payload: unknown;
  guard?: (state: UserPlanningState) => HttpResult | undefined;
  guardExisting?: (state: UserPlanningState) => HttpResult | undefined;
  run: (control: IdempotencyControl) => Promise<HttpResult> };
export type ChatRequestStatus = { status: 'running' | 'retryable' | 'completed'; result?: { status: number; body: unknown } };
export interface IdempotencyPort {
  execute(input: IdempotencyInput): Promise<HttpResult>;
  getChat?(userId: string, key: string, requestId: string): Promise<ChatRequestStatus | null>;
}
type RecordEntry = { fingerprint: string; operationId: string; state: 'running' | 'retryable' | 'completed'; result?: HttpResult; requestId?: string };

function chatStatus(entry: RecordEntry | undefined, requestId: string): ChatRequestStatus | null {
  if (!entry || entry.requestId !== requestId) return null;
  if (entry.state === 'completed') {
    if (!entry.result) return null;
    return { status: 'completed', result: { status: entry.result.status, body: entry.result.body } };
  }
  return { status: entry.state };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function retryableReview(operation: string, result: HttpResult): boolean {
  const status = (result.body as { status?: string } | null)?.status;
  return operation === 'scheduled_review' && result.retryableWithoutEffects === true &&
    ((result.status === 503 && status === 'failed') || (result.status === 200 && status === 'skipped'));
}
function retryableReplyLookup(operation: string, result: HttpResult): boolean {
  const body = result.body as { error?: { code?: string } } | null;
  return (operation === 'contact_reply_check' || operation === 'contact_call_check') && result.retryableWithoutEffects === true &&
    result.status === 503 && body?.error?.code === 'provider_unavailable';
}

// Volatile, single-process protection only; replace with transactional DB storage before deployment.
export class MemoryIdempotency implements IdempotencyPort {
  private recordsByUser = new Map<string, Map<string, RecordEntry>>();

  constructor(private readonly maxRecordsPerUser = 10_000) {
    if (!Number.isSafeInteger(maxRecordsPerUser) || maxRecordsPerUser < 1) throw new Error('Invalid per-user idempotency limit');
  }

  async getChat(userId: string, key: string, requestId: string): Promise<ChatRequestStatus | null> {
    return chatStatus(this.recordsByUser.get(userId)?.get(JSON.stringify(['chat', key])), requestId);
  }

  async execute(input: IdempotencyInput): Promise<HttpResult> {
    const identity = JSON.stringify([input.operation, input.key]);
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input.payload))).digest('hex');
    let userRecords = this.recordsByUser.get(input.userId);
    let entry = userRecords?.get(identity);
    if (entry) {
      if (entry.fingerprint !== fingerprint || (input.operation === 'chat' && entry.requestId !== undefined && entry.requestId !== input.requestId)) return {
        status: 409, body: { requestId: input.requestId, error: { code: 'idempotency_conflict', message: '동일한 중복 키에 다른 요청을 사용할 수 없습니다.', retryable: false } },
      };
      if (entry.state === 'running') return {
        status: 409, body: { requestId: input.requestId, error: { code: 'operation_in_progress', message: '요청을 처리 중입니다.', retryable: true, details: { operationId: entry.operationId } } },
      };
      if (entry.state === 'completed') return entry.result!;
      entry.state = 'running';
    } else {
      if (userRecords && userRecords.size >= this.maxRecordsPerUser) return {
        status: 503, body: { requestId: input.requestId, error: { code: 'provider_unavailable', message: '임시 요청 저장 공간이 가득 찼습니다.', retryable: false } },
      };
      entry = { fingerprint, operationId: randomUUID(), state: 'running', ...(input.operation === 'chat' ? { requestId: input.requestId } : {}) };
      if (!userRecords) { userRecords = new Map(); this.recordsByUser.set(input.userId, userRecords); }
      userRecords.set(identity, entry);
    }
    try {
      const result = await input.run({ finalize: run => run() });
      const body = result.body as { error?: { code?: string } } | null;
      // Only explicitly marked pre-write provider failures may be rerun.
      const safeProviderFailure = result.retryableWithoutEffects === true && result.status === 503 &&
        ((input.operation === 'chat' && body?.error?.code === 'provider_unavailable') ||
         (input.operation === 'scheduled_review' && (result.body as { status?: string })?.status === 'failed'));
      const busyConversation = input.operation === 'chat' && result.status === 409 && body?.error?.code === 'operation_in_progress';
      if (safeProviderFailure || busyConversation || retryableReview(input.operation, result) || retryableReplyLookup(input.operation, result)) entry.state = 'retryable';
      else { entry.state = 'completed'; entry.result = result; }
      return result;
    } catch {
      // A thrown write may have committed; keep its key and never rerun it automatically.
      const result = { status: 500, body: { requestId: input.requestId, error: { code: 'internal_error', message: '요청을 처리하지 못했습니다.', retryable: false } } };
      entry.state = 'completed'; entry.result = result;
      return result;
    }
  }
}

// Durable reservations survive restart. Final state and result share one user-row transaction.
export class RepositoryIdempotency implements IdempotencyPort {
  constructor(private readonly store: PlanningStore, private readonly clock: () => Date = () => new Date(), private readonly maxRecordsPerUser = 10_000) {}
  async getChat(userId: string, key: string, requestId: string): Promise<ChatRequestStatus | null> {
    return chatStatus((await this.store.read(userId)).idempotency.get(JSON.stringify(['chat', key])), requestId);
  }
  async execute(input: IdempotencyInput): Promise<HttpResult> {
    const identity = JSON.stringify([input.operation, input.key]);
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input.payload))).digest('hex');
    const token = randomUUID(); const now = this.clock();
    const leaseUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
    const conflict = (): HttpResult => ({ status: 409, body: { requestId: input.requestId, error: { code: 'idempotency_conflict', message: '동일한 중복 키에 다른 요청을 사용할 수 없습니다.', retryable: false } } });
    const busy = (operationId: string): HttpResult => ({ status: 409, body: { requestId: input.requestId, error: { code: 'operation_in_progress', message: '요청을 처리 중입니다.', retryable: true, details: { operationId } } } });
    const readOnlyAttempt = input.operation === 'chat' || input.operation === 'scheduled_review' || input.operation === 'calendar_import' || input.operation === 'contact_reply_check' || input.operation === 'contact_call_check';
    // Calendar sync owns its durable effect ledger and transactions; an outer transaction would self-lock its final sync-row update.
    const detachedAttempt = readOnlyAttempt || input.operation === 'calendar_sync_run' ||
      ['schedule_call_approve', 'schedule_call_check', 'schedule_call_propose'].includes(input.operation);
    // Only operations whose entire effect is committed with this record may recover a stale claim.
    const recoverable = readOnlyAttempt || ['schedule_command', 'schedule_checkin', 'schedule_attendance', 'schedule_undo', 'memory_write', 'proposal_decision', 'review_schedule_write',
      'recipient_create', 'contact_request_create', 'contact_decision', 'preparation_proposal', 'contact_response_confirm',
      'schedule_call_create', 'schedule_call_decision'].includes(input.operation);
    const claim = await this.store.transaction(input.userId, state => {
      const previous = state.idempotency.get(identity);
      if (previous) {
        if (previous.fingerprint !== fingerprint || (input.operation === 'chat' && previous.requestId !== undefined && previous.requestId !== input.requestId)) return { result: conflict() };
        if (previous.state === 'completed') return { result: input.guardExisting?.(state) ?? previous.result! };
        // A completed DB write and its result commit together; running after lease expiry means neither committed.
        if (previous.state === 'running' && !(recoverable && previous.leaseUntil && Date.parse(previous.leaseUntil) <= now.getTime())) {
          return { result: busy(previous.operationId) };
        }
        const guarded = input.guard?.(state);
        if (guarded) {
          previous.state = retryableReview(input.operation, guarded) ? 'retryable' : 'completed';
          if (previous.state === 'completed') previous.result = guarded; else delete previous.result;
          delete previous.token; delete previous.leaseUntil; return { result: guarded };
        }
        previous.state = 'running'; previous.token = token; previous.leaseUntil = leaseUntil;
        return { operationId: previous.operationId };
      }
      if (state.idempotency.size >= this.maxRecordsPerUser) return { result: { status: 503, body: { requestId: input.requestId,
        error: { code: 'provider_unavailable', message: '임시 요청 저장 공간이 가득 찼습니다.', retryable: false } } } as HttpResult };
      const operationId = randomUUID();
      const guarded = input.guard?.(state);
      if (guarded) {
        const retryable = retryableReview(input.operation, guarded);
        state.idempotency.set(identity, { fingerprint, operationId, state: retryable ? 'retryable' : 'completed', ...(input.operation === 'chat' ? { requestId: input.requestId } : {}), ...(!retryable ? { result: guarded } : {}) });
        return { result: guarded };
      }
      state.idempotency.set(identity, { fingerprint, operationId, state: 'running', token, leaseUntil, ...(input.operation === 'chat' ? { requestId: input.requestId } : {}) });
      return { operationId };
    });
    if (claim.result) return claim.result;
    const operationId = claim.operationId!;
    let finalized = false;
    const finalize = async (run: () => Promise<HttpResult>): Promise<HttpResult> => {
      const result = await this.store.atomic(input.userId, async () => {
        const current = (await this.store.read(input.userId)).idempotency.get(identity);
        if (!current || current.state !== 'running' || current.token !== token || (current.leaseUntil && Date.parse(current.leaseUntil) <= this.clock().getTime())) return busy(operationId);
        const value = await run();
        await this.store.transaction(input.userId, state => {
          const record = state.idempotency.get(identity)!;
          const mayRetry = retryableReview(input.operation, value);
          record.state = mayRetry ? 'retryable' : 'completed';
          if (!mayRetry) record.result = value; else delete record.result;
          delete record.token; delete record.leaseUntil;
        });
        return value;
      });
      finalized = true;
      return result;
    };
    let result: HttpResult;
    try {
      result = detachedAttempt ? await input.run({ finalize }) : await finalize(() => input.run({ finalize }));
    } catch {
      // A scheduled review only writes inside finalize, atomically with its result.
      result = input.operation === 'scheduled_review'
        ? { status: 503, body: { status: 'failed' }, retryableWithoutEffects: true }
        : { status: 500, body: { requestId: input.requestId, error: { code: 'internal_error', message: '요청을 처리하지 못했습니다.', retryable: false } } };
    }
    if (finalized) return result;
    // Only explicitly known-no-effect preflight failures can be retried. Unknown writes remain reserved.
    return this.store.transaction(input.userId, state => {
      const record = state.idempotency.get(identity);
      if (!record || record.token !== token) return record?.state === 'completed' && record.result ? record.result : busy(operationId);
      const body = result.body as { error?: { code?: string } } | null;
      const retryable = (input.operation === 'chat' && ((result.retryableWithoutEffects === true && result.status === 503 && body?.error?.code === 'provider_unavailable') ||
        (result.status === 409 && body?.error?.code === 'operation_in_progress'))) ||
        retryableReview(input.operation, result) || retryableReplyLookup(input.operation, result);
      record.state = retryable ? 'retryable' : 'completed';
      if (!retryable) record.result = result;
      delete record.token; delete record.leaseUntil;
      return result;
    });
  }
}
