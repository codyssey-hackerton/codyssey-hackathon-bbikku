import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = { Accuracy: { High: 5 }, requestForegroundPermissionsAsync: async () => ({ granted: true }), getCurrentPositionAsync: async () => position() };
globalThis.__locationNativeMock = native;
const built = await build({ stdin: { contents: "export { getCurrentLocation as web } from './current-location'; export { getCurrentLocation as native } from './current-location.native';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
 bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'mock-expo', setup(b) {
  b.onResolve({ filter: /^expo-location$/ }, () => ({ path: 'expo-location', namespace: 'mock' }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'module.exports=globalThis.__locationNativeMock', loader: 'js' }));
 } }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
const { web, native: getNative } = mod.exports;
const position = (overrides = {}) => ({ coords: { latitude: 37.5, longitude: 127, accuracy: 25 }, timestamp: Date.now(), ...overrides });
function installWeb(t, geolocation, secure = true) {
 const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), previousSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
 Object.defineProperty(globalThis, 'navigator', { value: { geolocation }, configurable: true });
 Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true });
 t.after(() => { if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
  if (previousSecure) Object.defineProperty(globalThis, 'isSecureContext', previousSecure); else delete globalThis.isSecureContext; });
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('web requests one fresh position only when called, with no cached position', async t => {
 let calls = 0, options; installWeb(t, { getCurrentPosition(success, _failure, input) { calls++; options = input; success(position()); } });
 assert.equal(calls, 0); const result = await web();
 assert.equal(calls, 1); assert.deepEqual(options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
 assert.equal(result.status, 'available'); assert.equal(result.location.latitude, 37.5); assert.equal(result.location.longitude, 127);
 assert.equal(result.location.accuracyMeters, 25); assert.ok(Number.isFinite(Date.parse(result.location.capturedAt)));
});
test('web reports insecure context, denial, timeout and provider failure separately', async t => {
 let calls = 0; installWeb(t, { getCurrentPosition() { calls++; } }, false);
 assert.deepEqual(await web(), { status: 'unavailable' }); assert.equal(calls, 0);
 Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
 for (const [code, status] of [[1, 'denied'], [2, 'unavailable'], [3, 'timeout']]) {
  globalThis.navigator.geolocation.getCurrentPosition = (_success, failure) => failure({ code });
  assert.deepEqual(await web(), { status });
 }
});
test('invalid coordinates, missing or inaccurate accuracy, stale and future positions fail closed', async t => {
 t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
 let value; installWeb(t, { getCurrentPosition(success) { success(value); } });
 for (const bad of [position({ coords: { latitude: 91, longitude: 0, accuracy: 3 } }), position({ coords: { latitude: 0, longitude: 181, accuracy: 3 } }),
  position({ coords: { latitude: NaN, longitude: 0, accuracy: 3 } }), position({ coords: { latitude: 0, longitude: 0, accuracy: -1 } }),
  position({ coords: { latitude: 0, longitude: 0, accuracy: 0 } }), position({ coords: { latitude: 0, longitude: 0, accuracy: 1001 } }),
  position({ coords: { latitude: 0, longitude: 0, accuracy: null } }), position({ timestamp: Date.now() - 300_001 }), position({ timestamp: Date.now() + 15_001 })]) {
  value = bad; assert.deepEqual(await web(), { status: 'unavailable' });
 }
});
test('five minute age, fifteen second future and 1000 meter accuracy boundaries match the server contract', async t => {
 t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 }); let value;
 installWeb(t, { getCurrentPosition(success) { success(value); } });
 for (const timestamp of [Date.now() - 300_000, Date.now() + 15_000]) {
  value = position({ coords: { latitude: 0, longitude: 0, accuracy: 1000 }, timestamp });
  const result = await web(); assert.equal(result.status, 'available'); assert.equal(result.location.accuracyMeters, 1000);
  assert.equal(result.location.capturedAt, new Date(timestamp).toISOString());
 }
});
test('native asks only foreground permission and requests one current position', async () => {
 let permissionCalls = 0, positionCalls = 0, options;
 native.requestForegroundPermissionsAsync = async () => { permissionCalls++; return { granted: true }; };
 native.getCurrentPositionAsync = async input => { positionCalls++; options = input; return position(); };
 assert.equal(permissionCalls, 0); const result = await getNative();
 assert.equal(result.status, 'available'); assert.equal(permissionCalls, 1); assert.equal(positionCalls, 1); assert.deepEqual(options, { accuracy: 5, timeInterval: 0 });
 native.requestForegroundPermissionsAsync = async () => ({ granted: false });
 assert.deepEqual(await getNative(), { status: 'denied' }); assert.equal(positionCalls, 1);
});
test('native rejects an older position even when it remains within server validity', async () => {
 native.requestForegroundPermissionsAsync = async () => ({ granted: true });
 native.getCurrentPositionAsync = async () => position({ timestamp: Date.now() - 1000 });
 assert.deepEqual(await getNative(), { status: 'unavailable' });
});
test('cancelling a native permission request prevents any later position request', async () => {
 const wait = deferred(); let positionCalls = 0; const controller = new AbortController();
 native.requestForegroundPermissionsAsync = () => wait.promise;
 native.getCurrentPositionAsync = async () => { positionCalls++; return position(); };
 const pending = getNative({ signal: controller.signal }); controller.abort();
 assert.deepEqual(await pending, { status: 'unavailable' }); wait.resolve({ granted: true }); await Promise.resolve(); await Promise.resolve();
 assert.equal(positionCalls, 0);
});
test('timeouts settle once and ignore a late web or native response', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); let success; installWeb(t, { getCurrentPosition(callback) { success = callback; } });
 const pending = web(); t.mock.timers.tick(15_000); assert.deepEqual(await pending, { status: 'timeout' });
 success(position()); assert.deepEqual(await pending, { status: 'timeout' });
 const permission = deferred(); let calls = 0; native.requestForegroundPermissionsAsync = () => permission.promise;
 native.getCurrentPositionAsync = async () => { calls++; return position(); };
 const nativePending = getNative(); t.mock.timers.tick(15_000); assert.deepEqual(await nativePending, { status: 'timeout' });
 permission.resolve({ granted: true }); await Promise.resolve(); await Promise.resolve(); assert.equal(calls, 0);
});
test('already-cancelled or cancelled in-flight requests cannot expose late positions', async t => {
 let callback, calls = 0; installWeb(t, { getCurrentPosition(success) { calls++; callback = success; } });
 const controller = new AbortController(); controller.abort(); assert.deepEqual(await web({ signal: controller.signal }), { status: 'unavailable' }); assert.equal(calls, 0);
 const later = new AbortController(); const pending = web({ signal: later.signal }); later.abort(); assert.deepEqual(await pending, { status: 'unavailable' });
 let accessed = false; const latePosition = { get coords() { accessed = true; return position().coords; }, timestamp: Date.now() };
 callback(latePosition); assert.deepEqual(await pending, { status: 'unavailable' }); assert.equal(accessed, false);
 const wait = deferred(); native.requestForegroundPermissionsAsync = async () => ({ granted: true }); native.getCurrentPositionAsync = () => wait.promise;
 const nativeController = new AbortController(); const nativePending = getNative({ signal: nativeController.signal }); await Promise.resolve();
 nativeController.abort(); assert.deepEqual(await nativePending, { status: 'unavailable' }); wait.resolve(latePosition); await Promise.resolve();
 assert.deepEqual(await nativePending, { status: 'unavailable' }); assert.equal(accessed, false);
});
