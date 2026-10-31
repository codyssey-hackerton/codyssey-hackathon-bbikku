import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GMAIL_CREDENTIAL_PATH, GMAIL_SCOPE, googleUserInfo, parseGmailCredential, parseGoogleToken } from '../apps/api/src/gmail-connection.ts';

export const REDIRECT_URI = 'http://127.0.0.1:53682/oauth/google/callback';
const failure = () => new Error('GMAIL_OAUTH_UNAVAILABLE');

export function createAuthorizationRequest(clientId) {
  if (typeof clientId !== 'string' || !clientId || /[\x00-\x20\x7f]/.test(clientId)) throw failure();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: `openid email ${GMAIL_SCOPE}`, access_type: 'offline', prompt: 'consent', state,
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
  if (states.length !== 1 || typeof expectedState !== 'string') return { kind: 'invalid' };
  const actual = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { kind: 'invalid' };
  const codes = target.searchParams.getAll('code');
  const errors = target.searchParams.getAll('error');
  if (errors.length === 1 && errors[0] && codes.length === 0) return { kind: 'denied' };
  if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 4096 || /[\x00-\x20\x7f]/.test(codes[0])) return { kind: 'invalid' };
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
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }).toString(),
    });
    if (!response.ok) throw failure();
    const token = parseGoogleToken(await response.json());
    if (!token.refreshToken) throw failure();
    const identity = await googleUserInfo(fetcher, token.accessToken);
    return { version: 1, clientId, ...identity, refreshToken: token.refreshToken };
  } catch { throw failure(); }
}

export async function saveCredential(credential, path = GMAIL_CREDENTIAL_PATH) {
  const directory = dirname(path);
  let temporary;
  let created = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw failure();
    temporary = join(directory, `.gmail-${randomBytes(16).toString('hex')}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try { await file.writeFile(JSON.stringify(parseGmailCredential(credential)), 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    created = false;
  } catch { throw failure(); }
  finally { if (temporary && created) await unlink(temporary).catch(() => {}); }
}

async function main() {
  const clientId = process.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || /[\x00-\x20\x7f]/.test(clientSecret)) throw failure();
  const request = createAuthorizationRequest(clientId);
  const code = await receiveCode(request.state, () => {
    console.log('다음 주소를 브라우저에서 열고 연결할 계정으로 동의하세요:');
    console.log(request.url);
  });
  const credential = await exchangeCode({ clientId, clientSecret, code, codeVerifier: request.codeVerifier });
  await saveCredential(credential);
  console.log('Gmail 로컬 연결 정보를 저장했습니다. API 서버를 재시작하세요.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error('Gmail 연결 실패. OAuth 설정과 동의 상태를 확인하세요.'); process.exitCode = 1; });
}
