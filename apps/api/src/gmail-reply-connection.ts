import { fileURLToPath } from 'node:url';
import { GMAIL_CREDENTIAL_PATH, readGmailCredential, googleUserInfo } from './gmail-connection.ts';
import { createGmailReplies } from './gmail-replies.ts';
import { PlanningError } from './planning-service.ts';

const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const unavailable = () => new PlanningError(503, 'provider_unavailable', '이메일 회신 연결을 확인해 주세요.');
export async function getGmailReplyConnection(options: { env: NodeJS.ProcessEnv; credentialPath?: string; sendCredentialPath?: string; fetcher?: typeof fetch; userId?: string }) {
  const clientId = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_ID?.trim(); const clientSecret = options.env.PIKKU_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!!clientId !== !!clientSecret) throw unavailable();
  const path = options.credentialPath ?? fileURLToPath(new URL('../../../.local/gmail-replies-connection.json', import.meta.url));
  const sendPath = options.sendCredentialPath ?? GMAIL_CREDENTIAL_PATH;
  let saved; let sent;
  try { saved = await readGmailCredential(path); if (!saved) return undefined; sent = await readGmailCredential(sendPath); } catch { throw unavailable(); }
  if (!clientId || !clientSecret || !sent || saved.clientId !== clientId || sent.clientId !== clientId || saved.subject !== sent.subject || saved.senderAddress !== sent.senderAddress) throw unavailable();
  const fetcher = options.fetcher ?? fetch;
  const replies = createGmailReplies({ senderAddress: saved.senderAddress, fetcher,
    async getAccessToken() {
      try {
        const current = await readGmailCredential(path); const currentSend = await readGmailCredential(sendPath);
        if (!current || !currentSend || current.clientId !== clientId || currentSend.clientId !== clientId || current.subject !== saved!.subject ||
            current.senderAddress !== saved!.senderAddress || currentSend.subject !== saved!.subject || currentSend.senderAddress !== saved!.senderAddress) throw unavailable();
        const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString() });
        if (!response.ok) throw unavailable();
        const value = await response.json() as { access_token?: unknown; token_type?: unknown; scope?: unknown; refresh_token?: unknown };
        const scopes = new Set(typeof value.scope === 'string' ? value.scope.split(/\s+/) : []);
        if (typeof value.access_token !== 'string' || !/^[a-z0-9._~+/-]+=*$/i.test(value.access_token) || value.token_type !== 'Bearer' || !scopes.has(READ_SCOPE) ||
            !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
            (value.refresh_token !== undefined && value.refresh_token !== current.refreshToken)) throw unavailable();
        const identity = await googleUserInfo(fetcher, value.access_token);
        const latest = await readGmailCredential(path); const latestSend = await readGmailCredential(sendPath);
        if (identity.subject !== saved!.subject || identity.senderAddress !== saved!.senderAddress || !latest || !latestSend ||
            latest.subject !== current.subject || latest.senderAddress !== current.senderAddress || latest.clientId !== current.clientId || latest.refreshToken !== current.refreshToken ||
            latestSend.subject !== currentSend.subject || latestSend.senderAddress !== currentSend.senderAddress || latestSend.clientId !== currentSend.clientId || latestSend.refreshToken !== currentSend.refreshToken) throw unavailable();
        return value.access_token;
      } catch { throw unavailable(); }
    },
  });
  return { userId: options.userId ?? 'local-developer', senderAddress: saved.senderAddress, checkReplies: replies.checkReplies };
}
