import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { View, Text } from 'react-native-web';

const require = createRequire(import.meta.url);
const bundle = buildSync({ entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), 'PastScheduleStack.tsx')],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  alias: { 'react-native': 'react-native-web' }, external: ['react', 'react/jsx-runtime', 'react-native-web'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { PastScheduleStack } = module.exports;
const front = React.createElement(Text, { key: 'front' }, 'FRONT');
const past = ['PAST1', 'PAST2', 'PAST3', 'PAST4'].map(value => React.createElement(View, { key: value, style: { marginTop: 20 } },
  React.createElement(Text, null, value)));
const render = (props) => renderToStaticMarkup(React.createElement(PastScheduleStack,
  { count: 4, expanded: false, onToggle() {}, front, insetLeft: 60, ...props }, past));

test('접힌 레이어는 실제 과거 카드 최대 세 개를 역순으로 그리며 조작과 접근성에서 숨긴다', () => {
  const html = render();
  assert.ok(html.indexOf('PAST3') < html.indexOf('PAST2') && html.indexOf('PAST2') < html.indexOf('PAST1'));
  assert.ok(html.includes('PAST1') && !html.includes('PAST4') && html.includes('FRONT'));
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /inert=""/);
  assert.match(html, /aria-label="이전 일정 카드 펼치기"/);
  assert.match(html, /margin-left:\s*-60px/);
  assert.doesNotMatch(html, /margin-top:\s*20px/);
});

test('펼치면 모든 과거 카드와 접기, 빈 목록은 앞 카드만 표시한다', () => {
  const expanded = render({ expanded: true });
  assert.ok(expanded.includes('PAST4') && expanded.includes('FRONT'));
  assert.match(expanded, /aria-label="이전 일정 접기"/);
  assert.doesNotMatch(expanded, /aria-label="이전 일정 카드 펼치기"/);
  const empty = render({ count: 0 });
  assert.ok(empty.includes('FRONT'));
  assert.ok(!empty.includes('PAST1'));
});
