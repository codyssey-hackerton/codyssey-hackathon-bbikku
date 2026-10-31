import { timestamp } from './planning-schemas.ts';

export type WeatherForecast = {
  provider: 'open-meteo'; timezone: 'Asia/Seoul'; forecastTime: string;
  temperatureC: number | null; apparentTemperatureC: number | null;
  precipitationMm: number | null; precipitationProbabilityPercent: number | null; windSpeedKmh: number | null;
  fetchedAt: string; expiresAt: string; sourceUrl: 'https://open-meteo.com/'; licenseUrl: 'https://open-meteo.com/en/licence';
};
export type WeatherResult = { ok: true; forecast: WeatherForecast } | { ok: false; error: 'invalid_request' | 'unsupported_range' | 'timeout' | 'unavailable' | 'invalid_response' };
const failure = (error: Extract<WeatherResult, { ok: false }>['error']): WeatherResult => ({ ok: false, error });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const TTL = 300_000;
const seoulOffset = 9 * 60 * 60_000;
const fields = ['temperature_2m', 'apparent_temperature', 'precipitation', 'precipitation_probability', 'wind_speed_10m'] as const;

export function createOpenMeteo(options: { fetch?: typeof fetch; clock?: () => number; timeoutMs?: number } = {}) {
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cache = new Map<string, { expires: number; forecast: WeatherForecast }>();
  const inflight = new Map<string, Promise<WeatherResult>>();

  async function forecast(input: unknown): Promise<WeatherResult> {
    if (!record(input) || !record(input.destination) || !timestamp.safeParse(input.appointmentAt).success) return failure('invalid_request');
    const { latitude, longitude } = input.destination;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return failure('invalid_request');
    const appointment = Date.parse(input.appointmentAt as string);
    const now = clock();
    if (!Number.isFinite(now) || !Number.isFinite(appointment) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return failure('invalid_request');
    // The provider allows today plus 15 calendar days, based on the requested time zone.
    const today = Math.floor((now + seoulOffset) / 86_400_000);
    const day = Math.floor((appointment + seoulOffset) / 86_400_000);
    if (appointment < now || day < today || day >= today + 16) return failure('unsupported_range');
    const localHour = new Date(Math.floor((appointment + seoulOffset) / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ':00';
    const key = JSON.stringify([latitude, longitude, localHour]);
    const cached = cache.get(key);
    if (cached && cached.expires > now) return { ok: true, forecast: cached.forecast };
    if (cached) cache.delete(key);
    const existing = inflight.get(key);
    if (existing) return existing;
    if (inflight.size >= 100) return failure('unavailable');
    const request = async (): Promise<WeatherResult> => {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', String(latitude)); url.searchParams.set('longitude', String(longitude));
      url.searchParams.set('hourly', fields.join(',')); url.searchParams.set('timezone', 'Asia/Seoul');
      url.searchParams.set('start_date', localHour.slice(0, 10)); url.searchParams.set('end_date', localHour.slice(0, 10));
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<WeatherResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure('timeout')); }, timeoutMs); });
      const call = async (): Promise<WeatherResult> => {
        let response: Response;
        try { response = await fetcher(url, { signal: controller.signal, redirect: 'error' }); }
        catch { return failure(controller.signal.aborted ? 'timeout' : 'unavailable'); }
        if (!response.ok) return failure('unavailable');
        let value: unknown;
        try { value = await response.json(); } catch { return failure(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
        if (!record(value) || value.timezone !== 'Asia/Seoul' || value.utc_offset_seconds !== 32400 || !record(value.hourly) || !Array.isArray(value.hourly.time)) return failure('invalid_response');
        const hourly = value.hourly;
        const times = hourly.time as unknown[];
        if (!times.every(time => typeof time === 'string') || fields.some(field => !Array.isArray(hourly[field]) || hourly[field].length !== times.length)) return failure('invalid_response');
        const index = times.indexOf(localHour);
        if (index < 0) return failure('unsupported_range');
        if (times.lastIndexOf(localHour) !== index) return failure('invalid_response');
        const values = fields.map(field => (hourly[field] as unknown[])[index]);
        if (values.some(item => item !== null && (typeof item !== 'number' || !Number.isFinite(item)))) return failure('invalid_response');
        const [temperatureC, apparentTemperatureC, precipitationMm, precipitationProbabilityPercent, windSpeedKmh] = values as (number | null)[];
        if ((precipitationMm !== null && precipitationMm < 0) || (windSpeedKmh !== null && windSpeedKmh < 0) ||
            (precipitationProbabilityPercent !== null && (precipitationProbabilityPercent < 0 || precipitationProbabilityPercent > 100))) return failure('invalid_response');
        if (values.every(item => item === null)) return failure('unsupported_range');
        const fetched = clock();
        if (!Number.isFinite(new Date(fetched).getTime()) || !Number.isFinite(new Date(fetched + TTL).getTime())) return failure('invalid_response');
        const result: WeatherForecast = { provider: 'open-meteo', timezone: 'Asia/Seoul', forecastTime: `${localHour}:00+09:00`,
          temperatureC, apparentTemperatureC, precipitationMm, precipitationProbabilityPercent, windSpeedKmh,
          fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(fetched + TTL).toISOString(),
          sourceUrl: 'https://open-meteo.com/', licenseUrl: 'https://open-meteo.com/en/licence' };
        // A timed-out request must never populate the cache later if fetch ignores abort.
        if (controller.signal.aborted) return failure('timeout');
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: fetched + TTL, forecast: result });
        return { ok: true, forecast: result };
      };
      try { return await Promise.race([call(), timeout]); } finally { clearTimeout(timer); }
    };
    const pending = request();
    inflight.set(key, pending);
    try { return await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
  }
  return { forecast };
}
