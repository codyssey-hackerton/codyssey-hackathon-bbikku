import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialVoiceTwiml, earlyRetryTwiml, optionsVoiceTwiml, confirmVoiceTwiml, finishVoiceTwiml } from '../src/voice-twiml.ts';

const url = 'https://example.test/voice?token=a&step=1';
const options = [{ optionId: 'first', label: '월요일 오전 9시' }, { optionId: 'second', label: '화요일 오후 2시' }];

test('initial and retry responses pause then redirect with the exact escaped URL', () => {
  const xml = initialVoiceTwiml(url);
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Redirect method="POST">https://example.test/voice?token=a&amp;step=1</Redirect></Response>');
  assert.equal(earlyRetryTwiml(url), xml);
});

test('options include uninterrupted AI disclosure and approved introduction before the gather', () => {
  const xml = optionsVoiceTwiml({ actionUrl: url, introduction: '안녕하세요.\n원문\r\t그대로', options, explanation: '일정 조정 안내' });
  assert.match(xml, /인공지능 대리 통화입니다\. 안녕하세요\.&#10;원문&#13;&#9;그대로<\/Say><Gather/);
  assert.match(xml, /<Gather input="dtmf speech" language="ko-KR" action="https:\/\/example\.test\/voice\?token=a&amp;step=1" method="POST" timeout="5" numDigits="1" actionOnEmptyResult="true">/);
  assert.match(xml, /1번, 월요일 오전 9시\. 2번, 화요일 오후 2시\./);
  assert.match(xml, /0번을 눌러/);
  assert.ok(xml.includes('일정 조정 안내'));
  assert.ok(!optionsVoiceTwiml({ actionUrl: url, options }).includes('인공지능 대리 통화입니다'));
});

test('confirmation accepts only a one digit DTMF response and finish hangs up', () => {
  const xml = confirmVoiceTwiml({ actionUrl: url, label: options[0].label });
  assert.match(xml, /<Gather input="dtmf"[^>]*numDigits="1" actionOnEmptyResult="true">/);
  assert.match(xml, /선택하신 시간은 월요일 오전 9시입니다/);
  assert.match(xml, /1번을 눌러/);
  assert.match(xml, /다른 입력이나 응답이 없으면 확인 후 검토/);
  assert.match(finishVoiceTwiml('종료합니다.'), /종료합니다\.<\/Say><Hangup\/><\/Response>$/);
});

test('escapes markup and XML whitespace in text and URLs', () => {
  const injection = `</Say><Hangup/> & "'\n\r\t`;
  const escaped = '&lt;/Say&gt;&lt;Hangup/&gt; &amp; &quot;&apos;&#10;&#13;&#9;';
  const xml = optionsVoiceTwiml({ actionUrl: 'https://example.test/?q="x"&a=1', introduction: injection, explanation: injection, options: [{ optionId: 'id', label: injection }] });
  assert.equal(xml.split(escaped).length - 1, 3);
  assert.ok(xml.includes('action="https://example.test/?q=&quot;x&quot;&amp;a=1"'));
  assert.ok(!xml.includes('<Hangup/>'));
  assert.ok(confirmVoiceTwiml({ actionUrl: url, label: injection }).includes(escaped));
  assert.ok(finishVoiceTwiml(injection).includes(escaped));
  assert.equal((finishVoiceTwiml(injection).match(/<Hangup\/>/g) ?? []).length, 1);
});

test('rejects bad URLs, invalid XML characters and invalid options', () => {
  for (const invalid of ['http://example.test', '/voice', 'https:///example.test', 'https://user:pass@example.test', 'https://example.test/#fragment', 'https://example.test/%ZZ', 'https://example.test/\nvoice']) {
    assert.throws(() => initialVoiceTwiml(invalid));
    assert.throws(() => optionsVoiceTwiml({ actionUrl: invalid, options }));
    assert.throws(() => confirmVoiceTwiml({ actionUrl: invalid, label: '시간' }));
  }
  for (const invalid of ['\u0000', '\u000b', '\ufffe', '\ud800']) {
    assert.throws(() => finishVoiceTwiml(invalid));
    assert.throws(() => optionsVoiceTwiml({ actionUrl: url, introduction: invalid, options }));
    assert.throws(() => optionsVoiceTwiml({ actionUrl: url, options: [{ optionId: 'id', label: invalid }] }));
  }
  assert.throws(() => optionsVoiceTwiml({ actionUrl: url, options: [] }));
  assert.throws(() => optionsVoiceTwiml({ actionUrl: url, options: Array.from({ length: 10 }, (_, i) => ({ optionId: String(i), label: '시간' })) }));
  assert.throws(() => optionsVoiceTwiml({ actionUrl: url, options: [options[0], options[0]] }));
  assert.throws(() => confirmVoiceTwiml({ actionUrl: url, label: ' ' }));
  const nine = Array.from({ length: 9 }, (_, i) => ({ optionId: String(i), label: `시간 ${i}` }));
  assert.match(optionsVoiceTwiml({ actionUrl: url, options: nine }), /9번, 시간 8/);
});
