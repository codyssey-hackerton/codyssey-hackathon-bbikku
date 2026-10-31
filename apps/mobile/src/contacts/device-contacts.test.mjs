import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const source = new URL('./device-contacts.native.ts', import.meta.url).pathname;
let permission, requested, query, data;
globalThis.__deviceContactsMock = {
 Fields: { PhoneNumbers: 'phoneNumbers' }, async isAvailableAsync() { return true; },
 async getPermissionsAsync() { return permission; }, async requestPermissionsAsync() { requested++; return permission; },
 async getContactsAsync(value) { query = value; return data; },
};
const built = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'mock', setup(b) {
 b.onResolve({ filter: /^expo-contacts\/legacy$/ }, () => ({ path: 'contacts', namespace: 'mock' }));
 b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'module.exports=globalThis.__deviceContactsMock', loader: 'js' }));
} }] });
const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
test('native adapter requests only on user search, scopes fields and respects limited access', async () => {
 permission = { granted: false, accessPrivileges: 'limited', canAskAgain: true }; requested = 0;
 data = { data: [{ id: 'one', name: '상대', phoneNumbers: [{ number: '010-1234-5678', label: 'mobile' }], emails: [{ email: 'private@example.test' }] }], hasNextPage: true };
 const result = await mod.exports.searchDeviceContacts('상대'); assert.equal(requested, 0);
 assert.deepEqual(query, { name: '상대', fields: ['phoneNumbers'], pageSize: 30, pageOffset: 0 });
 assert.deepEqual(result, { status: 'ok', limited: true, truncated: true, contacts: [{ id: 'one', displayName: '상대', phoneNumbers: [{ number: '010-1234-5678', label: 'mobile' }] }] });
});
test('native adapter requests access once only if allowed and fails closed when denied', async () => {
 permission = { granted: false, accessPrivileges: 'none', canAskAgain: true }; requested = 0; query = null;
 assert.deepEqual(await mod.exports.searchDeviceContacts('이름'), { status: 'denied' }); assert.equal(requested, 1); assert.equal(query, null);
 permission = { granted: false, accessPrivileges: 'none', canAskAgain: false }; requested = 0;
 assert.deepEqual(await mod.exports.searchDeviceContacts('이름'), { status: 'denied' }); assert.equal(requested, 0);
});
