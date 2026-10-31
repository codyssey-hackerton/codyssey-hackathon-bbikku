export type TravelMode = 'walk' | 'transit' | 'car';
export type TravelInput = {
  origin: { longitude: number; latitude: number };
  destination: { longitude: number; latitude: number };
  mode: TravelMode;
  departureAt?: string;
};
export type TravelResult =
  | { ok: true; durationMinutes: number; provider: 'kakao'; fetchedAt: string; expiresAt: string }
  | { ok: false; error: 'invalid_request' | 'unsupported' | 'not_configured' | 'timeout' | 'unavailable' | 'no_route' | 'invalid_response' };

const failure = (error: Extract<TravelResult, { ok: false }>['error']): TravelResult => ({ ok: false, error });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const point = (value: unknown): value is TravelInput['origin'] => record(value) &&
  typeof value.longitude === 'number' && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180 &&
  typeof value.latitude === 'number' && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90;

function duration(body: unknown, mode: TravelMode): number | TravelResult {
  if (!record(body)) return failure('invalid_response');
  let properties: unknown;
  if (mode === 'car') {
    if (!Array.isArray(body.routes) || !body.routes.length || !record(body.routes[0]) || !Number.isInteger(body.routes[0].result_code)) return failure('invalid_response');
    if (body.routes[0].result_code !== 0) return failure('no_route');
    properties = body.routes[0].summary;
  } else {
    if (typeof body.status !== 'string') return failure('invalid_response');
    if (body.status !== 'OK') {
      const noRoute = mode === 'walk'
        ? ['SAME_POINT', 'START_LINK_NOT_FOUND', 'END_LINK_NOT_FOUND', 'TOO_MANY_SEARCH_LINK', 'TOO_FAR_AWAY', 'ROUTE_RESULT_NOT_FOUND']
        : ['STARTNODES_NULL', 'ENDNODES_NULL', 'EQUAL_POINTS', 'NO_RESULTS'];
      return failure(noRoute.includes(body.status) ? 'no_route' : 'unavailable');
    }
    const route = mode === 'walk' ? body.route : Array.isArray(body.routes) ? body.routes[0] : undefined;
    properties = record(route) ? route.properties : undefined;
  }
  const seconds = record(properties) ? properties[mode === 'car' ? 'duration' : 'totalTime'] : undefined;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) return failure('invalid_response');
  const minutes = Math.ceil(seconds / 60);
  return Number.isSafeInteger(minutes * 60_000) ? minutes : failure('invalid_response');
}

export function createKakaoTravel(options: { apiKey?: string; fetch?: typeof fetch; timeoutMs?: number; clock?: () => number }) {
  const apiKey = options.apiKey?.trim();
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function estimate(input: unknown): Promise<TravelResult> {
    if (!record(input) || !point(input.origin) || !point(input.destination) || typeof input.mode !== 'string') return failure('invalid_request');
    if (!['walk', 'transit', 'car'].includes(input.mode)) return failure('unsupported');
    if (input.departureAt !== undefined) return failure('unsupported');
    if (!apiKey || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return failure('not_configured');
    const mode = input.mode as TravelMode;
    const origin = input.origin, destination = input.destination;
    const url = mode === 'car'
      ? new URL('https://apis-navi.kakaomobility.com/v1/directions')
      : new URL(`https://dapi.kakao.com/v2/routing/${mode === 'walk' ? 'walk' : 'publictraffic'}`);
    if (mode === 'car') {
      url.searchParams.set('origin', `${origin.longitude},${origin.latitude}`);
      url.searchParams.set('destination', `${destination.longitude},${destination.latitude}`);
      url.searchParams.set('summary', 'true');
    } else {
      url.searchParams.set('start_x', String(origin.longitude)); url.searchParams.set('start_y', String(origin.latitude));
      url.searchParams.set('end_x', String(destination.longitude)); url.searchParams.set('end_y', String(destination.latitude));
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TravelResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure('timeout')); }, timeoutMs); });
    const request = async (): Promise<TravelResult> => {
      let response: Response;
      try { response = await fetcher(url, { headers: { Authorization: `KakaoAK ${apiKey}` }, redirect: 'error', signal: controller.signal }); }
      catch { return failure(controller.signal.aborted ? 'timeout' : 'unavailable'); }
      if (!response.ok) return failure('unavailable');
      let body: unknown;
      try { body = await response.json(); } catch { return failure(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
      const minutes = duration(body, mode);
      if (typeof minutes !== 'number') return minutes;
      const fetched = (options.clock ?? Date.now)();
      if (!Number.isFinite(new Date(fetched).getTime()) || !Number.isFinite(new Date(fetched + 300_000).getTime())) return failure('invalid_response');
      return { ok: true, durationMinutes: minutes, provider: 'kakao', fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(fetched + 300_000).toISOString() };
    };
    try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
  }
  return { estimate };
}
