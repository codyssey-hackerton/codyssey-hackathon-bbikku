import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateFreshContact, type ContactRequest } from './contact-service.ts';
import { ContactResponseService } from './contact-response.ts';
import { PhoneConnections } from './phone-connection.ts';
import type { PlanningService } from './planning-service.ts';
import type { PlanningStore, UserPlanningState } from './planning-store.ts';
import { verifyTwilioSignature, type TwilioFormParams } from './voice-signature.ts';
import { VoiceTokens } from './voice-token.ts';
import type { VoiceClassifier, VoiceOption } from './voice-model.ts';
import { confirmVoiceTwiml, earlyRetryTwiml, finishVoiceTwiml, optionsVoiceTwiml } from './voice-twiml.ts';

const Event = z.strictObject({ hash: z.string(), twiml: z.string() });
const Session = z.strictObject({ version: z.literal(1), contactId: z.string(), callSid: z.string(),
  phase: z.enum(['select', 'confirm', 'done']), turn: z.number().int().min(1).max(8),
  selectedOptionId: z.string().nullable(), events: z.record(z.string(), Event),
  pending: z.strictObject({ turn: z.number().int(), hash: z.string(), claim: z.string() }).nullable() });
type Session = z.infer<typeof Session>;
type HandlerInput = { token: string; rawQuery: string; contentType: string; signature: string; params: TwilioFormParams };
type Output = { status: number; twiml: string };
const end = () => finishVoiceTwiml('확인이 필요하여 담당자에게 전달하겠습니다. 감사합니다.');
const denied = (): Output => ({ status: 403, twiml: '<Response><Hangup/></Response>' });
const success = (twiml: string): Output => ({ status: 200, twiml });

function single(params: TwilioFormParams, key: string): string | undefined {
  return typeof params[key] === 'string' ? params[key] as string : undefined;
}
function digest(params: TwilioFormParams): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(params).sort().map(key => [key, params[key]]))).digest('hex');
}
function bound(contact: ContactRequest | undefined, sid: string, from: string, to: string): boolean {
  return !!contact && contact.channel === 'phone' && contact.recipientSnapshot.address === to &&
    /^CA[0-9a-f]{32}$/i.test(sid) && !!from && contact.providerOperationId === sid && contact.deliveryStatus === 'sent_or_connected';
}
export async function approvedVoiceOptions(store: PlanningStore, planning: PlanningService, userId: string, state: UserPlanningState,
  contact: ContactRequest, clock: () => Date, phase: 'before_call' | 'webhook' = 'webhook'): Promise<VoiceOption[]> {
  const approved = state.contactApprovals.filter(value => value.approval.id === contact.approvalId);
  const approval = approved[0];
  const draft = state.contactDraftSnapshots.get(contact.id);
  if (approved.length !== 1 || !approval || !draft || approval.approval.actorRef !== userId ||
      approval.approval.subjectId !== contact.id || approval.approval.subjectRevision !== contact.revision || approval.approval.decision !== 'accept' ||
      !isDeepStrictEqual(draft.subject, approval.subject) || !isDeepStrictEqual(draft.proposals, approval.proposals) ||
      !isDeepStrictEqual({ ...contact, approvalId: null, deliveryStatus: 'pending_approval', negotiationStatus: 'not_started', providerOperationId: null }, approval.subject) ||
      (phase === 'before_call' ? contact.deliveryStatus !== 'ready' || contact.negotiationStatus !== 'not_started' || contact.providerOperationId !== null
        : contact.deliveryStatus !== 'sent_or_connected' || contact.negotiationStatus !== 'awaiting_response') ||
      contact.allowedOptions.length < 1 || contact.allowedOptions.length > 9) throw new Error('VOICE_APPROVAL_INVALID');
  const baseline = await planning.capture(userId, 'UTC');
  const { proposals } = validateFreshContact(state, userId, draft.subject, draft, baseline, clock);
  const options = contact.allowedOptions.map(option => {
    const proposal = proposals.find(value => value.id === option.proposalId && value.revision === option.proposalRevision);
    if (!proposal || proposal.changeSet.changes.length !== 1) throw new Error('VOICE_OPTION_INVALID');
    const change = proposal.changeSet.changes[0]!;
    if (change.operation === 'delete') return { optionId: option.optionId, label: '기존 약속 취소' };
    if (change.operation !== 'update' || !change.after.timeSlot) throw new Error('VOICE_OPTION_INVALID');
    const { startsAt, endsAt, timezone } = change.after.timeSlot;
    const minuteAligned = (value: string) => /T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (!minuteAligned(startsAt) || !minuteAligned(endsAt)) throw new Error('VOICE_TIME_PRECISION_UNSUPPORTED');
    const formatter = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'long' });
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
    const describe = (value: string) => {
      const date = new Date(value);
      const name = offset.formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
      const match = name?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
      if (!match) throw new Error('VOICE_OFFSET_UNAVAILABLE');
      const hours = Number(match[2] ?? 0); const minutes = Number(match[3] ?? 0);
      const difference = !hours && !minutes ? '협정 세계시와 동일' :
        `협정 세계시보다 ${hours ? `${hours}시간 ` : ''}${minutes ? `${minutes}분 ` : ''}${match[1] === '+' ? '빠름' : '느림'}`;
      return `${formatter.format(date)}, ${difference}`;
    };
    return { optionId: option.optionId, label: `${describe(startsAt)}부터 ${describe(endsAt)}까지` };
  });
  if (new Set(options.map(option => option.label)).size !== options.length) throw new Error('VOICE_OPTIONS_AMBIGUOUS');
  return options;
}

export class VoiceWebhook {
  private readonly tokens: VoiceTokens;
  private readonly responses: ContactResponseService;
  private readonly clock: () => Date;
  constructor(private readonly options: { store: PlanningStore; planning: PlanningService; connections: PhoneConnections;
    responseService: ContactResponseService; model: VoiceClassifier; publicBaseUrl: string; sessionKey: string; clock?: () => Date }) {
    this.tokens = new VoiceTokens(options.publicBaseUrl, options.sessionKey);
    this.responses = options.responseService;
    this.clock = options.clock ?? (() => new Date());
  }

  async handle(input: HandlerInput): Promise<Output> {
    const query = /^\?turn=([0-8])&retry=([0-3])$/.exec(input.rawQuery);
    if (!this.options.store.durable || !query || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(input.contentType) ||
        !input.params || typeof input.params !== 'object' || Array.isArray(input.params)) return denied();
    if (['AccountSid', 'CallSid', 'From', 'To', 'Digits', 'SpeechResult'].some(key =>
      input.params[key] !== undefined && typeof input.params[key] !== 'string')) return denied();
    const identity = this.tokens.read(input.token, this.clock());
    if (!identity) return denied();
    const credential = await this.options.connections.read(identity.userId).catch(() => undefined);
    if (!credential || !verifyTwilioSignature(credential.authToken, input.signature,
      this.tokens.publicBaseUrl + `/v1/voice/twilio/${input.token}` + input.rawQuery, input.params)) return denied();
    const sid = single(input.params, 'CallSid'); const account = single(input.params, 'AccountSid');
    const from = single(input.params, 'From'); const to = single(input.params, 'To');
    if (!sid || account !== credential.accountSid || from !== credential.fromNumber || !to || !/^CA[0-9a-f]{32}$/i.test(sid)) return denied();
    const turn = Number(query[1]); const retry = Number(query[2]);
    const hash = digest(input.params);
    const existing = await this.options.store.read(identity.userId);
    const initial = existing.contactRequests.get(identity.contactId);
    if (!bound(initial, sid, from, to)) {
      if (initial?.channel === 'phone' && initial.recipientSnapshot.address === to && initial.deliveryStatus === 'submitting' &&
          initial.providerOperationId === null && turn === 0 && retry < 3) {
        return success(earlyRetryTwiml(this.tokens.url(input.token, 0, retry + 1)));
      }
      return denied();
    }
    try {
      const stage = await this.options.store.atomic(identity.userId, async () => {
        const state = await this.options.store.read(identity.userId);
        const contact = state.contactRequests.get(identity.contactId);
        if (!contact || !bound(contact, sid, from, to)) return { result: denied() };
        const raw = state.voiceSessions.get(identity.sessionId);
        const parsed = raw === undefined ? null : Session.safeParse(raw);
        if (parsed && !parsed.success) return { result: denied() };
        const session: Session | null = parsed?.success ? parsed.data : null;
        if (session && (session.contactId !== contact.id || session.callSid !== sid)) return { result: denied() };
        const cached = session?.events[String(turn)];
        if (cached) return { result: cached.hash === hash ? success(cached.twiml) : denied() };
        if (!session && turn !== 0) return { result: denied() };
        if (session?.pending) {
          if (session.pending.turn !== turn || session.pending.hash !== hash) return { result: denied() };
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'interrupted');
          const twiml = end();
          await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', pending: null,
            events: { ...session.events, [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        if (session && (session.phase === 'done' || session.turn !== turn)) return { result: denied() };
        let options: VoiceOption[];
        try { options = await approvedVoiceOptions(this.options.store, this.options.planning, identity.userId, state, contact, this.clock); }
        catch {
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'stale_or_invalid_options');
          const twiml = end();
          await this.save(identity.userId, identity.sessionId, { version: 1, contactId: contact.id, callSid: sid, phase: 'done',
            turn: Math.max(1, turn), selectedOptionId: null, pending: null, events: { ...(session?.events ?? {}), [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        const nextUrl = this.tokens.url(input.token, Math.min(turn + 1, 8));
        if (!session) {
          const twiml = optionsVoiceTwiml({ actionUrl: nextUrl, introduction: contact.messageOrCallBrief, options });
          await this.save(identity.userId, identity.sessionId, { version: 1, contactId: contact.id, callSid: sid, phase: 'select', turn: 1,
            selectedOptionId: null, pending: null, events: { '0': { hash, twiml } } });
          return { result: success(twiml) };
        }
        const digits = single(input.params, 'Digits'); const speech = single(input.params, 'SpeechResult');
        if (session.phase === 'confirm') {
          if (digits === '1' && !speech && session.selectedOptionId && options.some(option => option.optionId === session.selectedOptionId)) {
            const result = await this.record(identity.userId, contact, sid, turn, 'accepted', session.selectedOptionId, 'confirmed_dtmf');
            const twiml = finishVoiceTwiml(result.contactRequest.negotiationStatus === 'applied'
              ? '선택한 시간을 확인했습니다. 감사합니다.' : '변경안은 담당자가 다시 확인하겠습니다. 감사합니다.');
            await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', pending: null, events: { ...session.events, [turn]: { hash, twiml } } });
            return { result: success(twiml) };
          }
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'confirmation_missing');
          const twiml = end();
          await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', pending: null, events: { ...session.events, [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        if (turn >= 6 || digits === '0' || (digits && speech) || (digits && !/^[1-9]$/.test(digits))) {
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'voice_review');
          const twiml = end();
          await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', pending: null, events: { ...session.events, [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        if (digits) {
          const option = options[Number(digits) - 1];
          if (!option) {
            await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'outside_approved_options');
            const twiml = end();
            await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', events: { ...session.events, [turn]: { hash, twiml } } });
            return { result: success(twiml) };
          }
          const twiml = confirmVoiceTwiml({ actionUrl: nextUrl, label: option.label });
          await this.save(identity.userId, identity.sessionId, { ...session, phase: 'confirm', turn: turn + 1,
            selectedOptionId: option.optionId, events: { ...session.events, [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        if (!speech?.trim() || speech.length > 2000) {
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, 'voice_unclear');
          const twiml = end();
          await this.save(identity.userId, identity.sessionId, { ...session, phase: 'done', events: { ...session.events, [turn]: { hash, twiml } } });
          return { result: success(twiml) };
        }
        const claim = randomUUID();
        await this.save(identity.userId, identity.sessionId, { ...session, pending: { turn, hash, claim } });
        return { work: { claim, speech, options } };
      });
      if ('result' in stage && stage.result) return stage.result;
      if (!('work' in stage) || !stage.work) return denied();
      const { claim, speech, options } = stage.work;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const classification = await Promise.race([
        this.options.model.classify({ transcript: speech, options }, controller.signal).catch(() => ({ kind: 'unclear' as const })),
        new Promise<{ kind: 'unclear' }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unclear' }); }, 2800); }),
      ]);
      if (timer) clearTimeout(timer);
      return await this.options.store.atomic(identity.userId, async () => {
        const state = await this.options.store.read(identity.userId); const contact = state.contactRequests.get(identity.contactId);
        if (!contact || !bound(contact, sid, from, to)) return denied();
        const parsed = Session.safeParse(state.voiceSessions.get(identity.sessionId));
        if (!parsed.success) return denied();
        const session = parsed.data;
        const cached = session.events[String(turn)];
        if (cached) return cached.hash === hash ? success(cached.twiml) : denied();
        if (!session.pending || session.pending.claim !== claim || session.pending.hash !== hash || session.pending.turn !== turn) return denied();
        const freshOptions = await approvedVoiceOptions(this.options.store, this.options.planning, identity.userId, state, contact, this.clock);
        const option = classification.kind === 'select' ? freshOptions.find(value => value.optionId === classification.optionId) : undefined;
        let twiml: string; let next: Session;
        if (option) {
          twiml = confirmVoiceTwiml({ actionUrl: this.tokens.url(input.token, turn + 1), label: option.label });
          next = { ...session, phase: 'confirm', turn: turn + 1, selectedOptionId: option.optionId, pending: null };
        } else if (classification.kind === 'unclear' && turn < 5) {
          twiml = optionsVoiceTwiml({ actionUrl: this.tokens.url(input.token, turn + 1), options: freshOptions,
            explanation: '말씀을 분명히 확인하지 못했습니다. 번호를 눌러 선택해 주세요.' });
          next = { ...session, phase: 'select', turn: turn + 1, selectedOptionId: null, pending: null };
        } else {
          await this.record(identity.userId, contact, sid, turn, 'unclear', null, `voice_${classification.kind}`);
          twiml = end(); next = { ...session, phase: 'done', pending: null };
        }
        await this.save(identity.userId, identity.sessionId, { ...next, events: { ...next.events, [turn]: { hash, twiml } } });
        return success(twiml);
      });
    } catch { return { status: 503, twiml: end() }; }
  }
  private async save(userId: string, sessionId: string, session: Session) {
    await this.options.store.transaction(userId, state => { state.voiceSessions.set(sessionId, session); });
  }
  private record(userId: string, contact: ContactRequest, sid: string, turn: number, outcome: 'accepted' | 'unclear', selectedOptionId: string | null, reviewReason: string) {
    return this.responses.recordVerified(userId, contact.id, { providerEventId: `voice:${sid}:${turn}`, providerOperationId: sid,
      channel: 'phone', recipientAddress: contact.recipientSnapshot.address, receivedAt: this.clock().toISOString(), outcome,
      selectedOptionId, evidenceRef: `voice:${sid}:${turn}`, reviewReason });
  }
}
