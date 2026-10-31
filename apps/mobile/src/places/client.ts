import { ApiError, type ApiClient } from '../api/http';

export interface Place {
  id: string; name: string; address: string; roadAddress: string; longitude: number; latitude: number;
}

export function createPlacesClient(api: ApiClient) {
  return {
    async search(query: string): Promise<Place[]> {
      const trimmed = query.trim();
      if (!trimmed || trimmed.length > 100) throw new ApiError('invalid_request', '검색어를 확인해 주세요.');
      const data = await api.get<unknown>(`/v1/places/search?query=${encodeURIComponent(trimmed)}`);
      if (!data || typeof data !== 'object' || !('places' in data) || !Array.isArray(data.places) || data.places.length > 15 ||
          !data.places.every((value: unknown) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const place = value as Record<string, unknown>;
            return typeof place.id === 'string' && !!place.id.trim() && typeof place.name === 'string' && !!place.name.trim() &&
              typeof place.address === 'string' && typeof place.roadAddress === 'string' &&
              typeof place.longitude === 'number' && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180 &&
              typeof place.latitude === 'number' && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90;
          }) || new Set(data.places.map((place: Place) => place.id)).size !== data.places.length) {
        throw new ApiError('invalid_response', '장소 검색 결과를 확인할 수 없습니다.');
      }
      return data.places as Place[];
    },
  };
}
