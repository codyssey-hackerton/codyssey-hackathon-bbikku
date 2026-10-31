import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const directory = dirname(fileURLToPath(import.meta.url));
const bundle = buildSync({ entryPoints: [resolve(directory, 'ProfileAvatar.tsx')], bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', alias: { 'react-native': 'react-native-web' },
  external: ['react', 'react/jsx-runtime', 'react-native-web'], loader: { '.png': 'dataurl' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { ProfileAvatar } = module.exports;

test('기본 그림으로 접근성 표시하며 크기를 지정할 수 있다', () => {
  const render = size => renderToStaticMarkup(React.createElement(ProfileAvatar, size === undefined ? {} : { size }));
  const html = render();
  assert.ok(html.includes('기본 프로필 그림'));
  assert.match(html, /width:\s*39px/);
  assert.match(render(64), /width:\s*64px/);
  assert.match(render(-1), /width:\s*39px/);
});

test('원본 그림 레이어와 4배 PNG가 로컬에 존재한다', () => {
  const root = resolve(directory, '../../assets/profile-avatar');
  for (const file of ['background', 'hair', 'face', 'left-eye', 'right-eye', 'clothes']) assert.ok(statSync(resolve(root, 'source', `${file}.svg`)).size > 0);
  const png = readFileSync(resolve(root, 'profile.png'));
  assert.equal(png.readUInt32BE(16), 156);
  assert.equal(png.readUInt32BE(20), 156);
});
