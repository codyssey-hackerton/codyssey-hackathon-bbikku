import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsx = (type, props) => ({ type, props: props ?? {} });
globalThis.__scheduleCardTest = { jsx };
const result = await build({ entryPoints: [new URL('./ScheduleCard.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.png': 'empty' },
  plugins: [{ name: 'host', setup(b) {
    b.onResolve({ filter: /^(react\/jsx-runtime|react-native|\.\/(Icon|ScheduleStatusButton|typography))$/ }, a => ({ path: a.path, namespace: 'host' }));
    b.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ loader: 'js', contents: path === 'react-native'
      ? 'exports.View="View";exports.Image="Image";exports.Pressable="Pressable";exports.StyleSheet={create:x=>x}'
      : path === './typography' ? 'exports.Text="Text"' : path === './Icon' ? 'exports.Icon="Icon"'
      : path === './ScheduleStatusButton' ? 'exports.ScheduleStatusButton="ScheduleStatusButton"'
      : 'exports.jsx=exports.jsxs=globalThis.__scheduleCardTest.jsx' }));
  } }] });
const mod = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports);
const item = { id: '1', revision: 1, title: '약속', kind: 'event', timeSlot: null, completion: 'pending', sourceRefs: [] };
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
for (const variant of ['list', 'timeline']) test(`${variant} card shows location accessibly only when present`, () => {
  const withLocation = nodes(mod.exports.ScheduleCard({ item: { ...item, location: '홍대' }, timezone: 'Asia/Seoul', variant }));
  assert.ok(withLocation.some(node => node.type === 'Text' && node.props.children?.join?.('') === '장소: 홍대'));
  assert.ok(withLocation.some(node => node.type === 'Pressable' && node.props.accessibilityLabel?.includes('장소 홍대')));
  const withoutLocation = nodes(mod.exports.ScheduleCard({ item, timezone: 'Asia/Seoul', variant }));
  assert.ok(!withoutLocation.some(node => node.type === 'Text' && node.props.children?.join?.('').includes('장소:')));
});
