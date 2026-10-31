import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.ts';
import type { createGoogleOAuth } from '../src/google-oauth.ts';

test('contacts search authenticates, isolates the actor, validates queries and never writes', async () => {
  const calls: string[] = [];
  const googleOAuth = { connections: async (userId: string) => ({ contactsConnection: {
    userId: 'owner', accountLabel: 'synthetic@example.test', searchContacts: async ({ query }: { query: string }) => {
      calls.push(query);
      return { contacts: [{ id: 'contact-0', displayName: '김민수', phoneNumbers: [{ number: '+821012345678' }] }], truncated: false };
    },
  } }) } as unknown as ReturnType<typeof createGoogleOAuth>;
  const app = buildApp({ googleOAuth, sessions: { resolve: async token => ({ userId: token }) } });
  try {
    assert.equal((await app.inject({ url: '/v1/contacts/google/search?q=test' })).statusCode, 401);
    const other = await app.inject({ url: '/v1/contacts/google/search?q=test', headers: { authorization: 'Bearer other' } });
    assert.equal(other.statusCode, 503);
    const status = await app.inject({ url: '/v1/contacts/google/connection', headers: { authorization: 'Bearer other' } });
    assert.deepEqual(status.json().data, { status: 'not_configured', accountLabel: null });
    for (const query of ['', '?q=', '?q=test&userId=owner', `?q=${'x'.repeat(101)}`]) {
      assert.equal((await app.inject({ url: `/v1/contacts/google/search${query}`, headers: { authorization: 'Bearer owner' } })).statusCode, 400);
    }
    assert.deepEqual(calls, []);
    const found = await app.inject({ url: `/v1/contacts/google/search?q=${encodeURIComponent('민수')}`, headers: { authorization: 'Bearer owner' } });
    assert.equal(found.statusCode, 200);
    assert.equal(found.headers['cache-control'], 'no-store');
    assert.equal(found.json().data.contacts[0].displayName, '김민수');
    assert.deepEqual(calls, ['민수']);
  } finally { await app.close(); }
});
