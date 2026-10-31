import { operationGuard } from '../api/operationGuard';

export function startWrite(submit: () => void, showMessage: (message: string) => void): void {
  if (operationGuard.hasUnresolved()) {
    showMessage('다른 화면에서 처리 중이거나 결과를 확인하지 못한 요청을 먼저 확인해 주세요.');
    return;
  }
  showMessage('');
  submit();
}
