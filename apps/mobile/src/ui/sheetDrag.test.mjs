import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetDragHandlers } from './sheetDrag.ts';

test('핸들에서 수직 아래 이동만 제스처로 인식한다', () => {
  const { onMoveShouldSetPanResponder: start } = sheetDragHandlers(() => {});
  assert.equal(start(null, { dx: 2, dy: 9 }), true);
  for (const gesture of [{ dx: 0, dy: 8 }, { dx: 12, dy: 9 }, { dx: 0, dy: -30 }]) assert.equal(start(null, gesture), false);
});

test('충분히 아래로 놓았을 때만 기존 닫기 콜백을 호출한다', () => {
  let calls = 0;
  const { onPanResponderRelease: release } = sheetDragHandlers(() => calls++);
  for (const gesture of [{ dx: 0, dy: 79 }, { dx: 100, dy: 80 }, { dx: 0, dy: -100 }]) release(null, gesture);
  assert.equal(calls, 0);
  release(null, { dx: 5, dy: 80 });
  assert.equal(calls, 1);
});

test('상위 onClose의 결과 불명 잠금은 드래그에도 적용된다', () => {
  let pending = true, closed = 0;
  const { onPanResponderRelease: release } = sheetDragHandlers(() => { if (!pending) closed++; });
  release(null, { dx: 0, dy: 100 });
  assert.equal(closed, 0);
  pending = false;
  release(null, { dx: 0, dy: 100 });
  assert.equal(closed, 1);
});
