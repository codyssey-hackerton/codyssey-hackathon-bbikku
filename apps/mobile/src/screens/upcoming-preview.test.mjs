import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
globalThis.__upcomingPreview = { jsx };
const built = await build({ stdin: { contents: "export {default} from './UpcomingPreview';", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'preview-host', setup(builder) {
    builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|.*ui\/(typography|ActionButton|ScheduleCard))$/ }, args => ({ path: args.path, namespace: 'preview-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'preview-host' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react' ? 'exports.useMemo=f=>f()' : path === 'react-native' ? 'exports.ScrollView="ScrollView";exports.View="View";exports.StyleSheet={create:x=>x}' :
      path.endsWith('/typography') ? 'exports.Text="Text"' : path.endsWith('/ActionButton') ? 'exports.ActionButton="ActionButton"' :
      path.endsWith('/ScheduleCard') ? 'exports.ScheduleCard="ScheduleCard"' : 'exports.jsx=exports.jsxs=globalThis.__upcomingPreview.jsx' }));
  } }] });
const compiled = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(compiled, compiled.exports);
const Preview = compiled.exports.default;
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}

test('preview renders ten disabled sample cards in a scroll view and closes without a data client', () => {
  let closed = 0, requests = 0;
  const original = globalThis.fetch; globalThis.fetch = () => { requests++; throw new Error('unexpected request'); };
  try {
    const tree = Preview({ timezone: 'Asia/Seoul', onClose: () => { closed++; } });
    const all = nodes(tree), cards = all.filter(node => node.type === 'ScheduleCard');
    assert.equal(cards.length, 10); assert.ok(all.some(node => node.type === 'ScrollView' && node.props.accessibilityLabel === '예시 일정 목록'));
    for (const { props } of cards) {
      assert.equal(props.disabled, true); assert.match(props.item.title, /^예시 · /);
      assert.equal(props.onPress, undefined); assert.equal(props.onStatus, undefined); assert.equal(props.onMore, undefined);
      assert.ok(Date.parse(props.item.timeSlot.startsAt) > Date.now());
    }
    const close = all.find(node => node.type === 'ActionButton' && node.props.label === '예시 닫기');
    assert.ok(close); close.props.onPress(); assert.equal(closed, 1); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});
