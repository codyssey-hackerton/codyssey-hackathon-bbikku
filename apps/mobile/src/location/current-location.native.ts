import * as Location from 'expo-location';
import { positionResult, runLocation } from './current-location-core';
import type { CurrentLocationResult, LocationOptions } from './current-location-core';
export type { CurrentLocation, CurrentLocationResult, LocationOptions } from './current-location-core';

/** Call only from an explicit user gesture. */
export function getCurrentLocation(options: LocationOptions = {}): Promise<CurrentLocationResult> {
  return runLocation(async active => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!active()) return { status: 'unavailable' };
    if (!permission.granted) return { status: 'denied' };
    const requestedAt = Date.now();
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 0 });
    return active() ? positionResult(position, requestedAt) : { status: 'unavailable' };
  }, options.signal);
}
