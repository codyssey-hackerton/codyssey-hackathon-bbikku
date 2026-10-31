export type KakaoPlace = {
  id: string; name: string; address: string; roadAddress: string; longitude: number; latitude: number;
};

export type KakaoPlacesResult =
  | { ok: true; places: KakaoPlace[] }
  | { ok: false; error: 'invalid_query' | 'not_configured' | 'timeout' | 'unavailable' | 'invalid_response' };

const failure = (error: Extract<KakaoPlacesResult, { ok: false }>['error']): KakaoPlacesResult => ({ ok: false, error });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function coordinate(value: unknown, limit: number): number | undefined {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : undefined;
}

export function createKakaoPlaces(options: { apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const apiKey = options.apiKey?.trim();
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function search(query: unknown): Promise<KakaoPlacesResult> {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 100) return failure('invalid_query');
    if (!apiKey || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return failure('not_configured');
    if (query.includes(apiKey)) return failure('invalid_query');

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<KakaoPlacesResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(failure('timeout')); }, timeoutMs);
    });
    const request = async (): Promise<KakaoPlacesResult> => {
      const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
      url.searchParams.set('query', query.trim());
      let response: Response;
      try {
        response = await fetcher(url, { headers: { Authorization: `KakaoAK ${apiKey}` }, redirect: 'error', signal: controller.signal });
      } catch { return failure(controller.signal.aborted ? 'timeout' : 'unavailable'); }
      if (!response.ok) return failure('unavailable');
      let body: unknown;
      try { body = await response.json(); } catch { return failure(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
      if (!record(body) || !Array.isArray(body.documents) || body.documents.length > 15) return failure('invalid_response');
      const places: KakaoPlace[] = [];
      for (const item of body.documents) {
        if (!record(item)) return failure('invalid_response');
        const { id, place_name: name, address_name: address, road_address_name: roadAddress, x, y } = item;
        if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim() ||
          typeof address !== 'string' || typeof roadAddress !== 'string' ||
          [id, name, address, roadAddress].some(value => value.includes(apiKey))) return failure('invalid_response');
        const longitude = coordinate(x, 180), latitude = coordinate(y, 90);
        if (longitude === undefined || latitude === undefined) return failure('invalid_response');
        places.push({ id, name, address, roadAddress, longitude, latitude });
      }
      return { ok: true, places };
    };
    try { return await Promise.race([request(), timeout]); } finally { clearTimeout(timer); }
  }
  return { search };
}
