import type { PanResponderCallbacks } from 'react-native';

export function sheetDragHandlers(onClose: () => void): PanResponderCallbacks {
  return {
    onMoveShouldSetPanResponder: (_event, { dx, dy }) => dy > 8 && dy > Math.abs(dx),
    onPanResponderRelease: (_event, { dx, dy }) => {
      if (dy >= 80 && dy > Math.abs(dx)) onClose();
    },
  };
}
