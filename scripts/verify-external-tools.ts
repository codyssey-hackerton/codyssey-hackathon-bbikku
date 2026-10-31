import { readFileSync } from 'node:fs';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { ModelPort, Observation } from '../apps/api/src/agent.ts';
import { buildApp } from '../apps/api/src/app.ts';
import { getCalendarConnection } from '../apps/api/src/google-calendar.ts';
import { createKakaoPlaces } from '../apps/api/src/kakao-places.ts';
import { createKakaoTravel } from '../apps/api/src/kakao-travel.ts';
import { createOpenMeteo } from '../apps/api/src/open-meteo.ts';
import { createResponsesModel, MODEL_ID, REASONING_EFFORT } from '../apps/api/src/model.ts';
import { MemoryPlanningStore } from '../apps/api/src/planning-store.ts';
import { PlanningService } from '../apps/api/src/planning-service.ts';

const userId = 'synthetic-external-verification';
const permitted = new Set(['search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals',
  'list_calendars', 'read_calendar_events', 'list_contact_requests', 'read_contact_replies']);
type Trace = { nativeCalls: string[]; internalCalls: string[]; results: { tool: string; ok: boolean }[]; externalExpiries: number[]; observationsSeen: number; modelCalls: number };

async function main() {
  if (process.argv[2] !== '--live' || (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--scenario' && ['weather', 'transit', 'calendar', 'proposal'].includes(process.argv[4])))) {
    console.log(JSON.stringify({ status: 'not_run', reason: 'explicit_live_flag_required' })); return;
  }
  const root = process.env.PIKKU_VERIFICATION_ROOT;
  if (!root || !isAbsolute(root)) { console.log(JSON.stringify({ status: 'not_run', reason: 'verification_root_required' })); process.exitCode = 2; return; }
  const secrets = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
  const kakao = parseEnv(readFileSync(join(root, '.local/kakao.env'), 'utf8'));
  const modelKey = secrets.PIKKU_OPENAI_API_KEY?.trim(), kakaoKey = kakao.PIKKU_KAKAO_REST_API_KEY?.trim();
  if (!modelKey || !kakaoKey) { console.log(JSON.stringify({ status: 'not_configured' })); process.exitCode = 2; return; }
  const store = new MemoryPlanningStore();
  const model = createResponsesModel(modelKey);
  let trace: Trace = { nativeCalls: [], internalCalls: [], results: [], externalExpiries: [], observationsSeen: 0, modelCalls: 0 };
  const instrumented: ModelPort = { async decide(input) {
    trace.modelCalls++;
    for (const observation of input.observations.slice(trace.observationsSeen) as Observation[]) {
      if (permitted.has(observation.name)) trace.results.push({ tool: observation.name,
        ok: !!observation.result && typeof observation.result === 'object' && 'ok' in observation.result && observation.result.ok === true });
      if (permitted.has(observation.name) && observation.result && typeof observation.result === 'object' && 'ok' in observation.result && observation.result.ok === true &&
          'expiresAt' in observation.result && typeof observation.result.expiresAt === 'string') trace.externalExpiries.push(Date.parse(observation.result.expiresAt));
    }
    trace.observationsSeen = input.observations.length;
    const decision = await model.decide(input);
    if (decision && typeof decision === 'object' && 'kind' in decision && decision.kind === 'tool_call' &&
        'name' in decision && typeof decision.name === 'string' && permitted.has(decision.name) && 'providerTrace' in decision && decision.providerTrace) {
      trace.nativeCalls.push(decision.name);
    }
    if (decision && typeof decision === 'object' && 'kind' in decision && decision.kind === 'tool_call' && 'name' in decision &&
        typeof decision.name === 'string' && ['read_schedule', 'calculate_timing', 'validate_changes', 'read_memory'].includes(decision.name) &&
        'providerTrace' in decision && decision.providerTrace) trace.internalCalls.push(decision.name);
    return decision;
  } };
  let calendarConnection: Awaited<ReturnType<typeof getCalendarConnection>>;
  try {
    calendarConnection = await getCalendarConnection({ env: { PIKKU_GOOGLE_OAUTH_CLIENT_ID: secrets.PIKKU_GOOGLE_OAUTH_CLIENT_ID,
      PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: secrets.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET },
      credentialPath: join(root, '.local/calendar-connection.json'), userId });
  } catch { /* Reported via the model/tool result, never print provider errors. */ }
  const app = buildApp({ store, model: instrumented, sessions: { async resolve(token) { return token === 'synthetic-session' ? { userId } : null; } },
    places: createKakaoPlaces({ apiKey: kakaoKey }), placesConfigured: true,
    travel: createKakaoTravel({ apiKey: kakaoKey }), travelConfigured: true, weather: createOpenMeteo(), calendarConnection });
  const seoulNow = new Date(Date.now() + 9 * 60 * 60_000);
  const at = new Date(Date.UTC(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth(), seoulNow.getUTCDate() + 1, 9)).toISOString();
  const scenarios = [
    { name: 'weather', expected: ['search_places', 'get_weather'], message: `서울 중구 통일로 1 서울역 1번출구 장소를 선택했어. ${at}의 날씨를 조회해줘. 읽기만 하고 일정을 수정하거나 제안하지 마.` },
    { name: 'transit', expected: ['search_places', 'search_places', 'estimate_travel'], message: '서울 중구 통일로 1 서울역 1번출구에서 서울 중구 세종대로 40 숭례문까지 지금 대중교통으로 이동해. 두 장소를 검색해 현재 대중교통 이동시간을 조회해줘. 읽기만 하고 일정을 수정하거나 제안하지 마.' },
    { name: 'calendar', expected: ['list_calendars'], message: '내가 연결한 구글 캘린더 목록만 조회해줘. 일정을 수정하거나 제안하지 마.' },
    { name: 'proposal', expected: ['search_places', 'get_weather'], message: '내일 18시 약속 장소의 날씨를 확인하고 준비 15분, 이동 30분, 여유 10분으로 준비계획을 제안해줘. 승인 전 일정은 변경하지 마.' },
  ];
  try {
    for (const scenario of scenarios.filter(item => process.argv.length === 3 || item.name === process.argv[4])) {
      trace = { nativeCalls: [], internalCalls: [], results: [], externalExpiries: [], observationsSeen: 0, modelCalls: 0 };
      if (scenario.name === 'proposal') {
        const planning = new PlanningService(store);
        await planning.command(userId, { expectedScheduleRevision: 0, changeSet: { changes: [{ changeId: 'synthetic-appointment', operation: 'create',
          after: { kind: 'event', title: '서울 중구 통일로 1 서울역 1번출구 약속', timeSlot: { startsAt: at,
            endsAt: new Date(Date.parse(at) + 60 * 60_000).toISOString(), timezone: 'Asia/Seoul' }, durationMinutes: null, deadline: null,
            flexibility: 'fixed', involvement: 'personal', completion: 'pending' } }] } });
      }
      const before = await store.read(userId), started = Date.now();
      const response = await app.inject({ method: 'POST', url: '/v1/chat', headers: { authorization: 'Bearer synthetic-session', 'idempotency-key': randomUUID() },
        payload: { requestId: randomUUID(), conversationId: null, message: scenario.message, timezone: 'Asia/Seoul' } });
      const after = await store.read(userId);
      const unchanged = before.scheduleRevision === after.scheduleRevision && before.contextRevision === after.contextRevision &&
        isDeepStrictEqual(before.items, after.items) && (scenario.name === 'proposal' || isDeepStrictEqual(before.proposals, after.proposals)) &&
        isDeepStrictEqual(before.contactRequests, after.contactRequests);
      let matched = 0;
      for (const name of trace.nativeCalls) if (name === scenario.expected[matched]) matched++;
      const success = matched === scenario.expected.length && trace.results.length === trace.nativeCalls.length && trace.results.every(result => result.ok);
      let finalKind: string | undefined, message = '';
      try { const result = response.json().data?.result; finalKind = result?.kind; message = typeof result?.message === 'string' ? result.message : ''; } catch { /* Report only the status. */ }
      const proposal = scenario.name === 'proposal' ? [...after.proposals.values()].find(value => value.status === 'pending') : undefined;
      const proposalPending = !!proposal;
      const timingConstraintsPresent = !!proposal?.changeSet.timingConstraints?.length;
      const externalTtlCap = !!proposal?.expiresAt && trace.externalExpiries.length > 0 && Date.parse(proposal.expiresAt) <= Math.min(...trace.externalExpiries);
      const internalToolsUsed = trace.internalCalls.includes('read_schedule') && trace.internalCalls.includes('calculate_timing');
      const validReply = scenario.name === 'proposal' ? finalKind === 'proposal' && proposalPending && timingConstraintsPresent && externalTtlCap && internalToolsUsed : finalKind === 'reply' && !!message.trim();
      const sourceAttribution = scenario.name === 'weather' ? /Open-Meteo/i.test(message) && /https:\/\/open-meteo\.com\//i.test(message) : undefined;
      console.log(JSON.stringify({ scenario: scenario.name, httpStatus: response.statusCode, model: MODEL_ID, reasoningEffort: REASONING_EFFORT,
        nativeCalls: trace.nativeCalls, toolResults: trace.results, modelCalls: trace.modelCalls, latencyMs: Date.now() - started,
        resultKind: finalKind, nonemptyReply: !!message.trim(), ...(sourceAttribution === undefined ? {} : { sourceAttribution }),
        ...(scenario.name === 'proposal' ? { internalCalls: trace.internalCalls, proposalPending, timingConstraintsPresent, externalTtlCap, internalToolsUsed } : {}),
        readOnlyStateUnchanged: unchanged, success: success && validReply && sourceAttribution !== false }));
      if (response.statusCode !== 200 || !unchanged || !success || !validReply || sourceAttribution === false) process.exitCode = 1;
    }
  } finally { await app.close(); }
}

void main().catch(() => { console.log(JSON.stringify({ status: 'failed', reason: 'verification_unavailable' })); process.exitCode = 1; });
