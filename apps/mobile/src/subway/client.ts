import { ApiError, type ApiClient } from '../api/http';
import { isOffsetTimestamp } from '../memory/client';
import { isTravelFresh, type TravelFreshness } from '../travel/client';

export interface SubwayArrival {
  lineId: string; direction: string; destination: string; arrivalSeconds: number;
  message: string; detailMessage: string; observedAt: string; stale: boolean; staleInMs: number;
}
export interface SubwayResult { provider: 'seoul'; stationName: string; fetchedAt: string; arrivals: SubwayArrival[]; freshness: TravelFreshness }

export function createSubwayClient(api: ApiClient) {
  return {
    async arrivals(name: string): Promise<SubwayResult> {
      const stationName = name.trim();
      if (!stationName || stationName.length > 80 || /[\u0000-\u001f\u007f/\\?#]/.test(stationName) || stationName === '.' || stationName === '..') {
        throw new ApiError('invalid_request', '역 이름을 확인해 주세요.');
      }
      const startedAt = globalThis.performance?.now();
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw new ApiError('not_configured', '조회 유효기간을 확인할 수 없습니다.');
      const data = await api.post<unknown>('/v1/subway/arrivals', { stationName }, { idempotencyKey: '' });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', '지하철 도착 정보를 확인할 수 없습니다.');
      const result = data as Record<string, unknown>;
      const text = (value: unknown) => typeof value === 'string' && value.length <= 300;
      if (result.provider !== 'seoul' || result.stationName !== stationName || !isOffsetTimestamp(result.fetchedAt) ||
          !Array.isArray(result.arrivals) || result.arrivals.length > 1000 || !result.arrivals.every((item: unknown) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            const row = item as Record<string, unknown>;
            return text(row.lineId) && !!(row.lineId as string).trim() && text(row.direction) && text(row.destination) &&
              typeof row.arrivalSeconds === 'number' && Number.isSafeInteger(row.arrivalSeconds) && row.arrivalSeconds >= 0 && row.arrivalSeconds <= 86_400 &&
              text(row.message) && text(row.detailMessage) && isOffsetTimestamp(row.observedAt) && typeof row.stale === 'boolean' &&
              typeof row.staleInMs === 'number' && Number.isSafeInteger(row.staleInMs) && row.staleInMs >= 0 && row.staleInMs <= 120_000 &&
              (row.stale === (row.staleInMs === 0));
          })) throw new ApiError('invalid_response', '지하철 도착 정보를 확인할 수 없습니다.');
      const freshness = { startedAt, validForMs: 15_000 };
      if (!isTravelFresh(freshness)) throw new ApiError('expired', '지하철 도착 정보가 만료되었습니다.');
      return { provider: 'seoul', stationName, fetchedAt: result.fetchedAt as string, arrivals: result.arrivals as SubwayArrival[], freshness };
    },
  };
}
