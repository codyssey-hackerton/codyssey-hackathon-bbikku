export type CurrentLocation = { latitude: number; longitude: number; accuracyMeters: number; capturedAt: string };
export type CurrentLocationResult = { status: 'available'; location: CurrentLocation } | { status: 'denied' | 'unavailable' | 'timeout' };
export type LocationOptions = { signal?: AbortSignal };

export function positionResult(value: unknown, notBefore?: number): CurrentLocationResult {
  if (!value || typeof value !== 'object' || !('coords' in value) || !('timestamp' in value)) return { status: 'unavailable' };
  const position = value as { coords: unknown; timestamp: unknown };
  if (!position.coords || typeof position.coords !== 'object') return { status: 'unavailable' };
  const { latitude, longitude, accuracy } = position.coords as Record<string, unknown>;
  const now = Date.now(), timestamp = position.timestamp;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 1000 ||
      typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < now - 300_000 || timestamp > now + 15_000 ||
      (notBefore !== undefined && timestamp < notBefore)) return { status: 'unavailable' };
  try { return { status: 'available', location: { latitude, longitude, accuracyMeters: accuracy, capturedAt: new Date(timestamp).toISOString() } }; }
  catch { return { status: 'unavailable' }; }
}

export function runLocation(acquire: (active: () => boolean) => Promise<CurrentLocationResult>, signal?: AbortSignal): Promise<CurrentLocationResult> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ status: 'unavailable' }); return; }
    let settled = false;
    const finish = (result: CurrentLocationResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => finish({ status: 'unavailable' });
    const timer = setTimeout(() => finish({ status: 'timeout' }), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    try { void acquire(() => !settled).then(finish, () => finish({ status: 'unavailable' })); }
    catch { finish({ status: 'unavailable' }); }
  });
}
