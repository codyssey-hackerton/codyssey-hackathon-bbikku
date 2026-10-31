import { isDeepStrictEqual } from 'node:util';
import { ContactDispatch, type GmailContactPort } from './contact-dispatch.ts';
import { createTwilioContact } from './twilio-contact.ts';
import { createClawOpsContact } from './clawops-contact.ts';
import { PhoneConnections, validPhoneNumber } from './phone-connection.ts';
import type { HttpResult } from './idempotency.ts';
import { PlanningError, type PlanningService } from './planning-service.ts';
import type { PlanningStore } from './planning-store.ts';
import type { VoiceTokens } from './voice-token.ts';
import { approvedVoiceOptions } from './voice-webhook.ts';

// ContactDispatch owns the durable approval, idempotency and pre-send checks.
const internalSender = (number: string) => `phone${number.slice(1)}@phone.invalid`;
export class PhoneDispatch {
  constructor(private readonly store: PlanningStore, private readonly planning: PlanningService,
    private readonly connections: PhoneConnections, private readonly clock: () => Date = () => new Date(), private readonly voiceTokens?: VoiceTokens,
    private readonly twilioClassifierAvailable = true) {}

  async call(userId: string, id: string, input: { requestId: string; contactRevision: number; expectedSenderNumber: string }, key: string,
    expectedProvider?: 'twilio' | 'clawops'): Promise<HttpResult> {
    if (!validPhoneNumber(input.expectedSenderNumber)) return { status: 400, body: { requestId: input.requestId,
      error: { code: 'invalid_request', message: '발신번호를 확인해 주세요.', retryable: false } } };
    const current = (await this.store.read(userId)).contactRequests.get(id);
    if (current && current.channel !== 'phone') return { status: 409, body: { requestId: input.requestId,
      error: { code: 'conflict', message: '전화 연락 요청이 아닙니다.', retryable: false } } };
    const credential = await this.connections.read(userId).catch(() => undefined);
    const usable = credential && (!expectedProvider || (credential.provider ?? 'twilio') === expectedProvider) &&
      (credential.provider === 'clawops' ? !!this.voiceTokens : this.twilioClassifierAvailable) ? credential : undefined;
    if (this.store.durable && this.voiceTokens && usable && usable.fromNumber === input.expectedSenderNumber && current?.deliveryStatus === 'ready') {
      try {
        await this.store.atomic(userId, async () => {
          const state = await this.store.read(userId);
          if (state.idempotency.has(JSON.stringify(['contact_send', key]))) return;
          const latest = state.contactRequests.get(id);
          if (latest?.deliveryStatus === 'ready') await approvedVoiceOptions(this.store, this.planning, userId, state, latest, this.clock, 'before_call');
        });
      } catch (error) {
        if (!(error instanceof PlanningError) && !(error instanceof Error && error.message.startsWith('VOICE_'))) throw error;
        return { status: 409, body: { requestId: input.requestId, error: { code: 'conflict',
          message: '전화로 안내할 수 없는 일정 대안입니다. 내용을 다시 확인해 주세요.', retryable: false } } };
      }
    }
    const provider: GmailContactPort | undefined = usable ? {
      userId, senderAddress: internalSender(usable.fromNumber),
      dispatch: async (payload, signal, beforeSend) => {
        const token = this.voiceTokens?.issue(userId, id, this.clock());
        const adapter = usable.provider === 'clawops'
          ? createClawOpsContact({ ...usable, fetch: this.connections.fetcher, voiceUrl: this.voiceTokens!.url(token!, 0, 0, 'clawops') })
          : createTwilioContact({ ...usable, fetch: this.connections.fetcher,
            ...(token ? { voiceUrl: this.voiceTokens!.url(token, 0) } : {}) });
        return adapter.dispatch(payload, signal, async () => {
          await beforeSend?.();
          const latest = await this.connections.read(userId);
          if (!isDeepStrictEqual(latest, usable) || (await this.store.read(userId)).contactRequests.get(id)?.channel !== 'phone') {
            throw new Error('PHONE_CONNECTION_CHANGED');
          }
          signal?.throwIfAborted();
        });
      },
    } : undefined;
    const dispatch = new ContactDispatch(this.store, this.planning, provider, this.clock, 'phone');
    const result = await dispatch.send(userId, id, { requestId: input.requestId, contactRevision: input.contactRevision,
      expectedSenderAddress: internalSender(input.expectedSenderNumber) }, key);
    const body = result.body as { error?: { code?: string; message?: string } };
    if (body.error?.code === 'not_configured') body.error.message = '지속 저장소와 전화 연결이 필요합니다.';
    return result;
  }
}
