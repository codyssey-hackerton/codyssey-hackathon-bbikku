export type SubwayArrival = {
  lineId: string;
  direction: string;
  destination: string;
  arrivalSeconds: number;
  message: string;
  detailMessage: string;
  observedAt: string;
  stale: boolean;
  staleInMs: number;
};
export type SubwayResult =
  | { ok: true; provider: 'seoul'; stationName: string; fetchedAt: string; arrivals: SubwayArrival[] }
  | { ok: false; error: 'invalid_request' | 'not_configured' | 'timeout' | 'unavailable' | 'invalid_response' | 'rate_limited' };
type SubwayError = Extract<SubwayResult, { ok: false }>['error'];
type SourceArrival = Omit<SubwayArrival, 'arrivalSeconds' | 'stale' | 'staleInMs'> & { sourceSeconds: number; observedMs: number };
type Snapshot = { stationName: string; fetchedMs: number; arrivals: SourceArrival[] };

const failure = (error: SubwayError): SubwayResult => ({ ok: false, error });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shortString = (value: unknown): value is string => typeof value === 'string' && value.length <= 300;

// Seoul supplies a local wall-clock timestamp without a timezone.
function observedTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return undefined;
  const iso = value.replace(' ', 'T') + '+09:00';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  const local = new Date(parsed + 9 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  return local === value ? parsed : undefined;
}

function sourceArrivals(body: unknown, now: number): SourceArrival[] | SubwayError {
  if (!record(body)) return 'invalid_response';
  const status = record(body.errorMessage) ? body.errorMessage.code : record(body.RESULT) ? body.RESULT.CODE : undefined;
  if (status === 'INFO-200') return [];
  if (status !== 'INFO-000') return typeof status === 'string' ? 'unavailable' : 'invalid_response';
  if (!Array.isArray(body.realtimeArrivalList) || body.realtimeArrivalList.length > 1000) return 'invalid_response';
  const output: SourceArrival[] = [];
  for (const item of body.realtimeArrivalList) {
    if (!record(item) || !shortString(item.subwayId) || !item.subwayId || !shortString(item.updnLine) ||
        !shortString(item.trainLineNm) || !shortString(item.arvlMsg2) || !shortString(item.arvlMsg3)) return 'invalid_response';
    const seconds = typeof item.barvlDt === 'string' && /^\d{1,5}$/.test(item.barvlDt) ? Number(item.barvlDt) : item.barvlDt;
    const observedMs = observedTime(item.recptnDt);
    if (!Number.isSafeInteger(seconds) || (seconds as number) < 0 || (seconds as number) > 86_400 ||
        observedMs === undefined || observedMs > now + 30_000) return 'invalid_response';
    output.push({ lineId: item.subwayId, direction: item.updnLine, destination: item.trainLineNm,
      sourceSeconds: seconds as number, message: item.arvlMsg2, detailMessage: item.arvlMsg3,
      observedAt: new Date(observedMs).toISOString(), observedMs });
  }
  return output;
}

export function createSeoulSubway(options: { apiKey?: string; fetch?: typeof fetch; clock?: () => number; timeoutMs?: number; transport?: string } = {}) {
  const key = options.apiKey?.trim();
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const transport = options.transport ?? 'https';
  const cache = new Map<string, Snapshot>();
  const pending = new Map<string, Promise<SubwayResult>>();
  let day = ''; let dailyCalls = 0; let recentCalls: number[] = [];

  function render(snapshot: Snapshot, now: number): SubwayResult {
    return { ok: true, provider: 'seoul', stationName: snapshot.stationName, fetchedAt: new Date(snapshot.fetchedMs).toISOString(),
      arrivals: snapshot.arrivals.map(({ observedMs, sourceSeconds, ...row }) => {
        const elapsedSeconds = Math.max(0, Math.floor((now - observedMs) / 1000));
        const staleInMs = Math.min(120_000, Math.max(0, observedMs + 120_000 - now));
        return { ...row, arrivalSeconds: Math.max(0, sourceSeconds - elapsedSeconds), stale: staleInMs === 0, staleInMs };
      }) };
  }

  async function arrivals(input: unknown): Promise<SubwayResult> {
    if (!record(input) || typeof input.stationName !== 'string') return failure('invalid_request');
    const stationName = input.stationName.trim();
    if (!stationName || stationName.length > 80 || /[\u0000-\u001f\u007f/\\?#]/.test(stationName) || stationName === '.' || stationName === '..') return failure('invalid_request');
    if (!key || !/^[A-Za-z0-9]+$/.test(key) || (transport !== 'https' && transport !== 'http') || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) return failure('not_configured');
    const now = clock();
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return failure('invalid_response');
    const cached = cache.get(stationName);
    if (cached && now >= cached.fetchedMs && now - cached.fetchedMs < 15_000) return render(cached, now);
    const running = pending.get(stationName);
    if (running) return running;
    const today = new Date(now + 9 * 60 * 60_000).toISOString().slice(0, 10);
    if (day !== today) { day = today; dailyCalls = 0; }
    recentCalls = recentCalls.filter(time => time <= now && now - time < 60_000);
    if (dailyCalls >= 900 || recentCalls.length >= 20) return failure('rate_limited');
    dailyCalls++; recentCalls.push(now);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SubwayResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure('timeout')); }, timeoutMs); });
    const request = async (): Promise<SubwayResult> => {
      let response: Response;
      try {
        const url = `${transport}://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/99/${encodeURIComponent(stationName)}`;
        response = await fetcher(url, { signal: controller.signal, redirect: 'error' });
      } catch { return failure(controller.signal.aborted ? 'timeout' : 'unavailable'); }
      if (!response.ok) return failure('unavailable');
      let body: unknown;
      try { body = await response.json(); } catch { return failure(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
      const fetchedMs = clock();
      if (!Number.isFinite(fetchedMs) || !Number.isFinite(new Date(fetchedMs).getTime())) return failure('invalid_response');
      const rows = sourceArrivals(body, fetchedMs);
      if (typeof rows === 'string') return failure(rows);
      const snapshot = { stationName, fetchedMs, arrivals: rows };
      if (controller.signal.aborted) return failure('timeout');
      if (cache.size >= 100 && !cache.has(stationName)) cache.delete(cache.keys().next().value!);
      cache.set(stationName, snapshot);
      return render(snapshot, fetchedMs);
    };
    const operation = Promise.race([request(), timeout]).finally(() => { clearTimeout(timer); pending.delete(stationName); });
    pending.set(stationName, operation);
    return operation;
  }
  return { arrivals };
}
