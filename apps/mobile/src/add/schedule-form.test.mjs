import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('event form hides completion choice while task form retains it', async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const result = await build({
    stdin: { contents: "export { ScheduleForm } from '../schedule/ScheduleForm';", resolveDir: directory, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-native-web'],
    plugins: [{ name: 'native-web', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-web', external: true }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const props = { item: null, timezone: 'UTC', disabled: false, cancelDisabled: false, onCancel() {}, onSave() {} };
  const event = renderToStaticMarkup(React.createElement(module.exports.ScheduleForm, { ...props, initialKind: 'event' }));
  const task = renderToStaticMarkup(React.createElement(module.exports.ScheduleForm, { ...props, initialKind: 'task' }));
  assert.doesNotMatch(event, /완료 상태/);
  assert.match(task, /완료 상태/);
});
