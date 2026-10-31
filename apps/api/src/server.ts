import { buildApp } from './app.ts';
import { localDevelopmentSession, teamPreviewSession, teamPreviewSessions } from './auth.ts';
import { readFileSync } from 'node:fs';
import { createResponsesModel } from './model.ts';
import { assertDevelopmentBinding } from './development.ts';
import pg from 'pg';
import { PostgresPlanningStore } from './postgres-store.ts';
import { startReviewScheduler, type ReviewScheduler } from './scheduler.ts';
import { GMAIL_CREDENTIAL_PATH, getGmailConnection } from './gmail-connection.ts';
import { getGmailReplyConnection } from './gmail-reply-connection.ts';
import { getCalendarConnection } from './google-calendar.ts';
import { createKakaoPlaces } from './kakao-places.ts';
import { createKakaoTravel } from './kakao-travel.ts';
import { createOpenMeteo } from './open-meteo.ts';
import { createSeoulSubway } from './seoul-subway.ts';
import { resolveGoogleCredentialPaths } from './google-credential-paths.ts';
import { resolveGoogleConnectionOwner } from './google-connection-owner.ts';
import { createGoogleOAuth } from './google-oauth.ts';
import { PhoneConnections } from './phone-connection.ts';
import { createVoiceResponsesModel } from './voice-model.ts';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST ?? '127.0.0.1';
const developmentAuth = process.env.PIKKU_DEV_AUTH === 'true';
assertDevelopmentBinding(process.env, host);
const previewAuth = process.env.PIKKU_TEAM_PREVIEW === 'true';
if (previewAuth && developmentAuth) throw new Error('Choose either team preview or local development authentication');
const trustProxySetting = process.env.PIKKU_TRUST_PROXY;
if (trustProxySetting && trustProxySetting !== 'loopback') throw new Error('Unsupported proxy trust setting');
const trustLoopbackProxy = trustProxySetting === 'loopback';
if (trustLoopbackProxy && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Trusted proxy requires a loopback HOST');
const previewMembers = previewAuth && process.env.PIKKU_PREVIEW_MEMBERS_FILE
  ? JSON.parse(readFileSync(process.env.PIKKU_PREVIEW_MEMBERS_FILE, 'utf8')) : undefined;
const sessions = previewAuth ? (previewMembers !== undefined
  ? teamPreviewSessions(previewMembers, process.env.PIKKU_PREVIEW_EXPIRES_AT ?? '')
  : teamPreviewSession(process.env.PIKKU_PREVIEW_TOKEN ?? '', process.env.PIKKU_PREVIEW_EXPIRES_AT ?? ''))
  : developmentAuth ? localDevelopmentSession(process.env.PIKKU_DEV_SESSION_TOKEN ?? '') : undefined;
let gmailContact: Awaited<ReturnType<typeof getGmailConnection>>;
let gmailReplyConnection: Awaited<ReturnType<typeof getGmailReplyConnection>>;
let calendarConnection: Awaited<ReturnType<typeof getCalendarConnection>>;
const googlePaths = resolveGoogleCredentialPaths(process.env.PIKKU_GOOGLE_CREDENTIAL_DIR);
const googleUserId = resolveGoogleConnectionOwner({ developmentAuth, previewAuth, previewMembers,
  configuredUserId: process.env.PIKKU_GOOGLE_CONNECTION_USER_ID, credentialDirectory: process.env.PIKKU_GOOGLE_CREDENTIAL_DIR });
const googleOAuth = createGoogleOAuth({ env: process.env, legacyGmail: googleUserId ? { userId: googleUserId, credentialPath: googlePaths.gmailPath ?? GMAIL_CREDENTIAL_PATH } : undefined });
if (googleUserId) {
  try { gmailContact = await getGmailConnection({ env: process.env, credentialPath: googlePaths.gmailPath, userId: googleUserId }); }
  catch { process.emitWarning('Gmail 연결 설정을 확인해 주세요.'); }
  try { gmailReplyConnection = await getGmailReplyConnection({ env: process.env, credentialPath: googlePaths.repliesPath, sendCredentialPath: googlePaths.gmailPath, userId: googleUserId }); }
  catch { process.emitWarning('Gmail 회신 연결 설정을 확인해 주세요.'); }
  try { calendarConnection = await getCalendarConnection({ env: process.env, credentialPath: googlePaths.calendarPath, userId: googleUserId }); }
  catch { process.emitWarning('캘린더 연결 설정을 확인해 주세요.'); }
}
const phoneConnections = new PhoneConnections({ directory: process.env.PIKKU_PHONE_CREDENTIAL_DIR });
const places = createKakaoPlaces({ apiKey: process.env.PIKKU_KAKAO_REST_API_KEY });
const travel = createKakaoTravel({ apiKey: process.env.PIKKU_KAKAO_REST_API_KEY });
const weather = createOpenMeteo();
const subway = createSeoulSubway({ apiKey: process.env.SEOUL_SUBWAY_API_KEY, transport: process.env.SEOUL_SUBWAY_TRANSPORT });
const kakaoConfigured = !!process.env.PIKKU_KAKAO_REST_API_KEY?.trim();
// Only the explicitly named project key is used; do not discover global or other application keys.
const projectKey = process.env.PIKKU_OPENAI_API_KEY;
const model = projectKey?.trim() ? createResponsesModel(projectKey) : undefined;
const voiceBaseUrl = process.env.PIKKU_VOICE_PUBLIC_BASE_URL?.trim();
const voiceSessionKey = process.env.PIKKU_VOICE_SESSION_KEY?.trim();
const voice = voiceBaseUrl && voiceSessionKey && projectKey?.trim()
  ? { publicBaseUrl: voiceBaseUrl, sessionKey: voiceSessionKey, model: createVoiceResponsesModel(projectKey) } : undefined;
const connectionString = process.env.PIKKU_DATABASE_URL?.trim();
const schedulerEnabled = process.env.PIKKU_SCHEDULER_ENABLED === 'true';
if (schedulerEnabled && !connectionString) throw new Error('PIKKU_DATABASE_URL is required when the scheduler is enabled');
let pool: pg.Pool | undefined;
let store: PostgresPlanningStore | undefined;
if (connectionString) {
  pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { process.emitWarning('PostgreSQL pool connection error'); });
  store = new PostgresPlanningStore(pool);
  try { await store.migrate(); } catch { await pool.end(); throw new Error('PostgreSQL initialization failed'); }
}
let scheduler: ReviewScheduler | undefined;
let schedulerState: 'not_configured' | 'available' | 'degraded' = schedulerEnabled ? 'degraded' : 'not_configured';
const webOrigins = (process.env.PIKKU_WEB_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
for (const origin of webOrigins) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('PIKKU_WEB_ORIGINS must contain exact HTTP(S) origins');
}
const app = buildApp({ previewRateLimit: previewAuth, webOrigins, trustLoopbackProxy, sessions, model, store, gmailContact, gmailReplyConnection, calendarConnection, googleOAuth, places, travel, weather, subway, placesConfigured: kakaoConfigured, travelConfigured: kakaoConfigured, phoneConnections, voice, allowLocalPhoneConnect: developmentAuth && ['127.0.0.1', '::1', 'localhost'].includes(host), schedulerStatus: () => schedulerState,
  onReviewScheduleChanged: async () => {
    if (!scheduler) return;
    try { await scheduler.reconcile(); schedulerState = 'available'; }
    catch { schedulerState = 'degraded'; throw new Error('Review schedule reconciliation failed'); }
  },
});
try {
  if (schedulerEnabled) {
    scheduler = await startReviewScheduler({ connectionString: connectionString!, runtime: app.reviewRuntime,
      onError: () => { schedulerState = 'degraded'; } });
    schedulerState = 'available';
  }
  await app.listen({ host, port });
} catch {
  if (scheduler) await scheduler.stop();
  await app.close();
  if (pool) await pool.end();
  throw new Error('PIKKU server initialization failed');
}
console.log(`PIKKU local API listening at ${app.server.address() && `port ${port}`}`);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  void (async () => { if (scheduler) await scheduler.stop(); await app.close(); if (pool) await pool.end(); })()
    .catch(() => { process.exitCode = 1; });
});
