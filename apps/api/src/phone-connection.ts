import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PlanningError } from './planning-service.ts';

export type PhoneCredential = { accountSid: string; authToken: string; fromNumber: string };
export const validPhoneNumber = (value: string) => /^\+[1-9]\d{1,14}$/.test(value);
const validCredential = (value: PhoneCredential) => /^AC[0-9a-f]{32}$/i.test(value.accountSid) &&
  /^[a-z0-9]{32}$/i.test(value.authToken) && validPhoneNumber(value.fromNumber);
const unavailable = () => new PlanningError(503, 'not_configured', '전화 연결 저장소를 사용할 수 없습니다.');
const invalid = () => new PlanningError(400, 'invalid_request', '전화 계정 또는 발신번호를 확인해 주세요.');
const validRequestId = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && value.trim().length > 0;
type SavedConnection = PhoneCredential & { lastRequestId: string | null };

export class PhoneConnections {
  private readonly directory: string | undefined;
  readonly fetcher: typeof fetch;
  constructor(options: { directory: string | undefined; fetcher?: typeof fetch }) {
    this.directory = options.directory;
    this.fetcher = options.fetcher ?? fetch;
  }
  private async path(userId: string): Promise<string> {
    if (!this.directory || !userId.trim()) throw unavailable();
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw unavailable();
      return join(this.directory, `${createHash('sha256').update(userId).digest('hex')}.json`);
    } catch { throw unavailable(); }
  }
  private async readSaved(userId: string): Promise<SavedConnection | undefined> {
    const path = await this.path(userId);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o7777) !== 0o600 || info.size > 4096 ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw unavailable();
      const value = JSON.parse(await handle.readFile('utf8')) as PhoneCredential & { lastRequestId?: unknown };
      if (!value || typeof value.accountSid !== 'string' || typeof value.authToken !== 'string' ||
          typeof value.fromNumber !== 'string' || !validCredential(value) ||
          (value.lastRequestId !== undefined && value.lastRequestId !== null && !validRequestId(value.lastRequestId))) throw unavailable();
      return { accountSid: value.accountSid, authToken: value.authToken, fromNumber: value.fromNumber,
        lastRequestId: value.lastRequestId ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw unavailable();
    } finally { await handle?.close(); }
  }
  async read(userId: string): Promise<PhoneCredential | undefined> {
    const saved = await this.readSaved(userId);
    return saved && { accountSid: saved.accountSid, authToken: saved.authToken, fromNumber: saved.fromNumber };
  }
  async status(userId: string): Promise<{ status: 'available' | 'not_configured'; senderNumber: string | null; lastRequestId: string | null }> {
    try {
      const saved = await this.readSaved(userId);
      return saved ? { status: 'available', senderNumber: saved.fromNumber, lastRequestId: saved.lastRequestId }
        : { status: 'not_configured', senderNumber: null, lastRequestId: null };
    } catch { return { status: 'not_configured', senderNumber: null, lastRequestId: null }; }
  }
  async connect(userId: string, credential: PhoneCredential, requestId?: string) {
    if (!credential || typeof credential.accountSid !== 'string' || typeof credential.authToken !== 'string' ||
        typeof credential.fromNumber !== 'string' || !validCredential(credential) || (requestId !== undefined && !validRequestId(requestId))) throw invalid();
    credential = { accountSid: credential.accountSid, authToken: credential.authToken, fromNumber: credential.fromNumber };
    const path = await this.path(userId);
    const query = new URLSearchParams({ PhoneNumber: credential.fromNumber, PageSize: '20' });
    try {
      const response = await this.fetcher(`https://api.twilio.com/2010-04-01/Accounts/${credential.accountSid}/IncomingPhoneNumbers.json?${query}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${credential.accountSid}:${credential.authToken}`).toString('base64')}` },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw invalid();
      const value: unknown = await response.json();
      const numbers = (value as { incoming_phone_numbers?: unknown })?.incoming_phone_numbers;
      if (!Array.isArray(numbers) || !numbers.some(number => number?.phone_number === credential.fromNumber && number?.capabilities?.voice === true)) throw invalid();
    } catch (error) { if (error instanceof PlanningError) throw error; throw new PlanningError(503, 'provider_unavailable', '전화 계정을 확인할 수 없습니다.'); }
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ ...credential, lastRequestId: requestId ?? null }), 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, path);
    } catch { throw unavailable(); }
    finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
    return { status: 'available' as const, senderNumber: credential.fromNumber, lastRequestId: requestId ?? null };
  }
}
