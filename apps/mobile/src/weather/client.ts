import { ApiError, type ApiClient } from '../api/http';
import { isOffsetTimestamp } from '../memory/client';
import type { Place } from '../places/client';
import { isTravelFresh, type TravelFreshness } from '../travel/client';

export interface WeatherForecast {
  provider: 'open-meteo'; timezone: 'Asia/Seoul'; forecastTime: string;
  temperatureC: number | null; apparentTemperatureC: number | null; precipitationMm: number | null;
  precipitationProbabilityPercent: number | null; windSpeedKmh: number | null;
  fetchedAt: string; expiresAt: string; sourceUrl: 'https://open-meteo.com/'; licenseUrl: 'https://open-meteo.com/en/licence';
  remainingTtlMs: number; freshness: TravelFreshness;
}

export function createWeatherClient(api: ApiClient) {
  return {
    async forecast(destination: Place, appointmentAt: string): Promise<WeatherForecast> {
      if (!isOffsetTimestamp(appointmentAt)) throw new ApiError('invalid_request', '약속 시각을 확인해 주세요.');
      const startedAt = globalThis.performance?.now();
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw new ApiError('not_configured', '예보 유효기간을 확인할 수 없습니다.');
      const data = await api.post<unknown>('/v1/weather/forecast', {
        destination: { latitude: destination.latitude, longitude: destination.longitude }, appointmentAt,
      }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', '날씨 예보를 확인할 수 없습니다.');
      const result = data as Record<string, unknown>;
      const numeric = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
      if (result.provider !== 'open-meteo' || result.timezone !== 'Asia/Seoul' || !isOffsetTimestamp(result.forecastTime) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+09:00$/.test(result.forecastTime) ||
          !isOffsetTimestamp(result.fetchedAt) || !isOffsetTimestamp(result.expiresAt) || Date.parse(result.expiresAt) <= Date.parse(result.fetchedAt) ||
          Date.parse(result.expiresAt) - Date.parse(result.fetchedAt) > 300_000 ||
          typeof result.remainingTtlMs !== 'number' || !Number.isSafeInteger(result.remainingTtlMs) || result.remainingTtlMs < 0 ||
          result.remainingTtlMs > Date.parse(result.expiresAt) - Date.parse(result.fetchedAt) ||
          Date.parse(result.forecastTime) > Date.parse(appointmentAt) || Date.parse(appointmentAt) >= Date.parse(result.forecastTime) + 3_600_000 ||
          !numeric(result.temperatureC) || !numeric(result.apparentTemperatureC) || !numeric(result.precipitationMm) ||
          !numeric(result.precipitationProbabilityPercent) || !numeric(result.windSpeedKmh) ||
          (typeof result.precipitationMm === 'number' && result.precipitationMm < 0) ||
          (typeof result.windSpeedKmh === 'number' && result.windSpeedKmh < 0) ||
          (typeof result.precipitationProbabilityPercent === 'number' && (result.precipitationProbabilityPercent < 0 || result.precipitationProbabilityPercent > 100)) ||
          result.sourceUrl !== 'https://open-meteo.com/' || result.licenseUrl !== 'https://open-meteo.com/en/licence') {
        throw new ApiError('invalid_response', '날씨 예보를 확인할 수 없습니다.');
      }
      const freshness = { startedAt, validForMs: result.remainingTtlMs };
      if (!isTravelFresh(freshness)) throw new ApiError('expired', '날씨 예보가 만료되었습니다.');
      return { ...result, freshness } as unknown as WeatherForecast;
    },
  };
}
