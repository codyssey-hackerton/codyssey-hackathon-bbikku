import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REDIRECT_URI = 'http://127.0.0.1:53682/oauth/google/callback';
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
export const CREDENTIAL_PATH = fileURLToPath(new URL('../.local/calendar-connection.json', import.meta.url));
const failure = () => new Error('CALENDAR_OAUTH_UNAVAILABLE');
const textValue = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);
const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validEmail(value) {
  if (!textValue(value) || value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function parseCredential(value) {
  if (!objectValue(value) || value.version !== 1 || !textValue(value.clientId) || !validEmail(value.senderAddress) ||
      !textValue(value.subject) || value.subject.length > 255 || !textValue(value.refreshToken)) throw failure();
  return { version: 1, clientId: value.clientId, senderAddress: value.senderAddress, subject: value.subject, refreshToken: value.refreshToken };
}

export function createAuthorizationRequest(clientId) {
  if (!textValue(clientId)) throw failure();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
    code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
  return { url: url.toString(), state, codeVerifier };
}

export function parseCallback({ method, url, host }, expectedState) {
  if (method !== 'GET' || host !== '127.0.0.1:53682' || typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return { kind: 'invalid' };
  if (url.split('?', 1)[0] !== '/oauth/google/callback') return { kind: 'invalid' };
  let target;
  try { target = new URL(url, REDIRECT_URI); } catch { return { kind: 'invalid' }; }
  if (target.origin !== 'http://127.0.0.1:53682' || target.pathname !== '/oauth/google/callback' || target.hash) return { kind: 'invalid' };
  const states = target.searchParams.getAll('state');
  if (states.length !== 1 || !textValue(expectedState)) return { kind: 'invalid' };
  const actual = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { kind: 'invalid' };
  const codes = target.searchParams.getAll('code');
  const errors = target.searchParams.getAll('error');
  if (errors.length === 1 && errors[0] && codes.length === 0) return { kind: 'denied' };
  if (errors.length || codes.length !== 1 || !textValue(codes[0])) return { kind: 'invalid' };
  return { kind: 'code', code: codes[0] };
}

export function createCallbackHandler(state, finish) {
  return (request, response) => {
    const result = parseCallback({ method: request.method, url: request.url, host: request.headers.host }, state);
    response.writeHead(result.kind === 'code' ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' });
    response.end(result.kind === 'code' ? 'Authorization received. Return to the terminal.' : 'Authorization was not accepted.');
    if (result.kind === 'code') finish(undefined, result.code);
    if (result.kind === 'denied') finish(failure());
  };
}

function receiveCode(state, onListening) {
  return new Promise((resolveCode, rejectCode) => {
    let settled = false;
    let timer;
    const server = createServer(createCallbackHandler(state, finish));
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) rejectCode(failure()); else resolveCode(code);
    }
    server.once('error', () => finish(failure()));
    server.listen(53682, '127.0.0.1', () => {
      timer = setTimeout(() => finish(failure()), 5 * 60_000);
      onListening();
    });
  });
}

export async function exchangeCode({ clientId, clientSecret, code, codeVerifier, fetcher = fetch }) {
  try {
    if (![clientId, clientSecret, code, codeVerifier].every(textValue)) throw failure();
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }).toString(),
    });
    if (!response.ok) throw failure();
    const token = await response.json();
    if (!objectValue(token) || !textValue(token.access_token) || !/^[a-z0-9._~+/-]+=*$/i.test(token.access_token) ||
        token.token_type !== 'Bearer' || !textValue(token.refresh_token) || typeof token.scope !== 'string') throw failure();
    const granted = new Set(token.scope.split(/\s+/));
    if (!granted.has('openid') || !(granted.has('email') || granted.has('https://www.googleapis.com/auth/userinfo.email')) ||
        !SCOPES.slice(2).every(scope => granted.has(scope))) throw failure();
    const userResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!userResponse.ok) throw failure();
    const user = await userResponse.json();
    if (!objectValue(user) || user.email_verified !== true) throw failure();
    return parseCredential({ version: 1, clientId, senderAddress: user.email, subject: user.sub, refreshToken: token.refresh_token });
  } catch { throw failure(); }
}

export async function saveCredential(credential, path = CREDENTIAL_PATH) {
  const directory = dirname(path);
  let temporary;
  let created = false;
  try {
    const parsed = parseCredential(credential);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o7777) !== 0o700 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw failure();
    temporary = join(directory, `.calendar-${randomBytes(16).toString('hex')}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(parsed), 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    created = false;
  } catch { throw failure(); }
  finally { if (temporary && created) await unlink(temporary).catch(() => {}); }
}

async function main() {
  const clientId = process.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!textValue(clientId) || !textValue(clientSecret)) throw failure();
  const request = createAuthorizationRequest(clientId);
  const code = await receiveCode(request.state, () => {
    console.log('다음 주소를 브라우저에서 열고 연결할 계정으로 동의하세요:');
    console.log(request.url);
  });
  const credential = await exchangeCode({ clientId, clientSecret, code, codeVerifier: request.codeVerifier });
  await saveCredential(credential);
  console.log('Calendar 로컬 연결 정보를 저장했습니다.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error('Calendar 연결 실패. OAuth 설정과 동의 상태를 확인하세요.'); process.exitCode = 1; });
}
