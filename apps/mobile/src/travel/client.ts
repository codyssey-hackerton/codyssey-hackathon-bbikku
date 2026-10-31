import { ApiError, type ApiClient } from '../api/http';
import { isOffsetTimestamp } from '../memory/client';
import { parseMinutes } from '../preparation/client';
import type { Place } from '../places/client';

export type TravelMode = 'walk' | 'transit' | 'car';
export interface TravelFreshness { startedAt: number; validForMs: number }
export interface TravelEstimate { durationMinutes: number; provider: 'kakao'; fetchedAt: string; expiresAt: string; mode: TravelMode; freshness: TravelFreshness }

export function isTravelFresh(freshness: TravelFreshness): boolean {
  const now = globalThis.performance?.now();
  return typeof now === 'number' && Number.isFinite(now) && Number.isFinite(freshness.startedAt) &&
    Number.isFinite(freshness.validForMs) && now >= freshness.startedAt && now - freshness.startedAt < freshness.validForMs;
}

export function travelRemainingMs(freshness: TravelFreshness): number {
  if (!isTravelFresh(freshness)) return 0;
  return Math.max(0, freshness.validForMs - (globalThis.performance.now() - freshness.startedAt));
}

export function createTravelClient(api: ApiClient) {
  return {
    async estimate(origin: Place, destination: Place, mode: TravelMode): Promise<TravelEstimate> {
      const startedAt = globalThis.performance?.now();
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw new ApiError('not_configured', '경로 조회 유효기간을 확인할 수 없습니다.');
      const data = await api.post<unknown>('/v1/travel/estimate', {
        origin: { longitude: origin.longitude, latitude: origin.latitude },
        destination: { longitude: destination.longitude, latitude: destination.latitude }, mode,
      }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', '경로 조회 결과를 확인할 수 없습니다.');
      const result = data as Record<string, unknown>;
      if (typeof result.durationMinutes !== 'number' || parseMinutes(String(result.durationMinutes)) !== result.durationMinutes ||
          result.provider !== 'kakao' || result.mode !== mode || !isOffsetTimestamp(result.fetchedAt) || !isOffsetTimestamp(result.expiresAt) ||
          Date.parse(result.expiresAt) <= Date.parse(result.fetchedAt)) throw new ApiError('invalid_response', '경로 조회 결과를 확인할 수 없습니다.');
      const validForMs = Date.parse(result.expiresAt) - Date.parse(result.fetchedAt);
      if (validForMs > 5 * 60_000) throw new ApiError('invalid_response', '경로 조회 결과의 유효기간을 확인할 수 없습니다.');
      const freshness = { startedAt, validForMs };
      if (!isTravelFresh(freshness)) throw new ApiError('expired', '경로 조회 결과가 만료되었습니다.');
      return { durationMinutes: result.durationMinutes, provider: 'kakao', fetchedAt: result.fetchedAt, expiresAt: result.expiresAt, mode, freshness };
    },
  };
}
