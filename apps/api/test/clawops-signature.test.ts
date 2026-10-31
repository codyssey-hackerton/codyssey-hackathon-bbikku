import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyClawOpsSignature } from '../src/clawops-signature.ts';
import type { TwilioFormParams } from '../src/voice-signature.ts';

// Cross-checked with openssl HMAC-SHA256 using synthetic values.
const secret = 'synthetic-signing-secret';
const url = 'https://example.test/voice?token=%2F1';
const params = { To: '01012345678', From: '07012345678', Digits: '1', CallId: 'CAabcdef1234567890' };
const signature = '8rv4lsKDFDjDiNZRu+h2N2ZURaoo93KNn9g7AZyqtQM=';

test('verifies the provider HMAC and rejects modified signature, data, secret or raw URL', () => {
  assert.equal(verifyClawOpsSignature(secret, signature, url, params), true);
  assert.equal(verifyClawOpsSignature(secret, `A${signature.slice(1)}`, url, params), false);
  assert.equal(verifyClawOpsSignature('other-secret', signature, url, params), false);
  assert.equal(verifyClawOpsSignature(secret, signature, url, { ...params, Digits: '2' }), false);
  for (const changed of [url.replace('%2F', '%2f'), url.replace('%2F', '/'), `${url}&extra=1`, url.replace('example.test', 'example.test:443')]) {
    assert.equal(verifyClawOpsSignature(secret, signature, changed, params), false);
  }
});

test('rejects duplicate or non-string params, malformed inputs and bounds violations', () => {
  for (const value of [null, [], new URLSearchParams(), { Digits: ['1', '1'] }, { Digits: ['1'] }, { Digits: 1 },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, 'v'])), { ['x'.repeat(257)]: 'v' }, { a: 'x'.repeat(8193) },
    { a: 'x'.repeat(8192), b: 'x'.repeat(8192), c: 'x'.repeat(8192), d: 'x'.repeat(8192) }]) {
    assert.equal(verifyClawOpsSignature(secret, signature, url, value as unknown as TwilioFormParams), false);
  }
  for (const bad of ['', 'http://example.test/voice', 'https:///example.test', 'https://user@example.test/', 'https://example.test/#x', 'https://example.test/%ZZ']) {
    assert.equal(verifyClawOpsSignature(secret, signature, bad, params), false);
  }
  for (const bad of ['', 'bad\nsignature', signature.slice(1)]) assert.equal(verifyClawOpsSignature(secret, bad, url, params), false);
  assert.equal(verifyClawOpsSignature('', signature, url, params), false);
  assert.equal(verifyClawOpsSignature('bad\nsecret', signature, url, params), false);
});
