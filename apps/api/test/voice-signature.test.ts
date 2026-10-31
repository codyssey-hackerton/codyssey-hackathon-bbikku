import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTwilioSignature, type TwilioFormParams } from '../src/voice-signature.ts';

const token = 'synthetic-token';
const url = 'https://example.test/voice?next=%2Fdone&x=1';
const params = { From: '+821012345678', CallSid: 'CA123' };
const signature = '2+aWYdbvCs/86lkJ15wBPpJuWXA=';

test('accepts a form signature and rejects forged or missing signatures and changed form data', () => {
  assert.equal(verifyTwilioSignature(token, signature, url, params), true);
  assert.equal(verifyTwilioSignature(token, `A${signature.slice(1)}`, url, params), false);
  assert.equal(verifyTwilioSignature('wrong-token', signature, url, params), false);
  assert.equal(verifyTwilioSignature(token, '', url, params), false);
  assert.equal(verifyTwilioSignature(token, signature, url, { ...params, CallSid: 'CA124' }), false);
  assert.equal(verifyTwilioSignature(token, signature, url, { ...params, Extra: 'new' }), false);
});

test('sorts keys and unique values like the Twilio Node algorithm', () => {
  const multi = { Empty: '', Digit: ['2', '1', '2'], Alpha: '한글' };
  const multiSignature = 'PAFilN+SNK3B2AVVBhwjNaLrNVo=';
  assert.equal(verifyTwilioSignature(token, multiSignature, url, multi), true);
  assert.equal(verifyTwilioSignature(token, multiSignature, url, { Alpha: '한글', Digit: ['1', '2'], Empty: '' }), true);
  assert.equal(verifyTwilioSignature(token, multiSignature, url, { ...multi, Digit: ['1', '3'] }), false);
  assert.deepEqual(multi.Digit, ['2', '1', '2']);
});

test('uses the exact configured URL, including encoding, port and query', () => {
  for (const changed of [url.replace('%2F', '%2f'), url.replace('%2F', '/'), url.replace('&x=1', ''), url.replace('example.test', 'example.test:443'), `${url}&x=2`]) {
    assert.equal(verifyTwilioSignature(token, signature, changed, params), false);
  }
});

test('rejects malformed inputs and non-HTTPS URLs', () => {
  for (const invalidUrl of ['', 'http://example.test/voice', '/voice', 'https:///example.test', 'https://example.test/#fragment', 'https://example.test/%ZZ', 'https://example.test/\nvoice', 'https://user:pass@example.test/voice']) {
    assert.equal(verifyTwilioSignature(token, signature, invalidUrl, params), false);
  }
  for (const invalidSignature of ['invalid', `${signature}\n`, `${signature.slice(0, -1)}!`]) {
    assert.equal(verifyTwilioSignature(token, invalidSignature, url, params), false);
  }
  assert.equal(verifyTwilioSignature('', signature, url, params), false);
  assert.equal(verifyTwilioSignature('bad\ntoken', signature, url, params), false);
  for (const invalidParams of [null, [], new URLSearchParams('CallSid=CA123'), { CallSid: 1 }, { Digit: ['1', null] }]) {
    assert.equal(verifyTwilioSignature(token, signature, url, invalidParams as unknown as TwilioFormParams), false);
  }
});
