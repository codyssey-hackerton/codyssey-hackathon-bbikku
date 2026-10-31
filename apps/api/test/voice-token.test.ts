import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceTokens } from '../src/voice-token.ts';

test('voice token is opaque, authenticated, bound to configuration and expires', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const tokens = new VoiceTokens('https://voice.example.test', key);
  const now = new Date('2030-01-01T00:00:00Z');
  const token = tokens.issue('synthetic-user', 'synthetic-contact', now);
  assert.ok(!token.includes('synthetic'));
  assert.equal(tokens.read(token, now)?.contactId, 'synthetic-contact');
  assert.equal(tokens.read(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), now), null);
  assert.equal(new VoiceTokens('https://voice.example.test', Buffer.alloc(32, 8).toString('base64')).read(token, now), null);
  assert.equal(tokens.read(token, new Date(now.getTime() + 10 * 60_000)), null);
  assert.equal(tokens.url(token, 1, 2), `https://voice.example.test/v1/voice/twilio/${token}?turn=1&retry=2`);
  assert.throws(() => tokens.url(token, 9));
  assert.throws(() => new VoiceTokens('http://voice.example.test', key));
  assert.throws(() => new VoiceTokens('https://voice.example.test/path', key));
});
