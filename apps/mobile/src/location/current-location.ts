import { positionResult, runLocation } from './current-location-core';
import type { CurrentLocationResult, LocationOptions } from './current-location-core';
export type { CurrentLocation, CurrentLocationResult, LocationOptions } from './current-location-core';

/** Call only from an explicit user gesture. */
export function getCurrentLocation(options: LocationOptions = {}): Promise<CurrentLocationResult> {
  return runLocation(active => new Promise(resolve => {
    if (globalThis.isSecureContext === false || typeof navigator === 'undefined' || !navigator.geolocation) { resolve({ status: 'unavailable' }); return; }
    navigator.geolocation.getCurrentPosition(position => resolve(active() ? positionResult(position) : { status: 'unavailable' }), error => resolve({
      status: error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable',
    }), { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  }), options.signal);
}
