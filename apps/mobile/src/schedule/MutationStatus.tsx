import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MutationState } from '../api/useMutation';

export function mutationErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'contact_required': return '공동 일정의 시간 변경에는 상대방과의 조정이 필요합니다. 기존 일정은 유지됩니다.';
    case 'conflict': return '일정이 충돌했거나 변경된 버전입니다. 최신 목록을 불러와 확인해 주세요.';
    case 'stale_revision':
    case 'stale_schedule':
    case 'stale_proposal': return '일정이 다른 곳에서 변경되었습니다. 최신 목록을 불러와 다시 편집해 주세요.';
    case 'idempotency_conflict': return '요청 식별자가 다른 저장 내용과 충돌했습니다. 새로 입력해 주세요.';
    case 'missing_information': return '필수 정보가 부족합니다. 입력한 내용을 확인해 주세요.';
    case 'not_configured': return '일정 저장 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '이 일정 저장 기능은 아직 구현되지 않았습니다.';
    case 'unauthenticated': return '저장하려면 로그인 또는 세션 설정이 필요합니다.';
    case 'permission_denied': return '이 일정을 변경할 권한이 없습니다.';
    case 'not_found': return '일정을 찾을 수 없습니다. 최신 목록을 확인해 주세요.';
    case 'invalid_configuration': return '서버 주소를 확인해 주세요.';
    case 'invalid_request': return '서버가 입력 내용을 받아들이지 않았습니다. 내용을 확인해 주세요.';
    case 'operation_in_progress': return '같은 요청이 서버에서 처리 중입니다.';
    case 'invalid_response': return '서버의 처리 결과를 확인할 수 없습니다.';
    case 'timeout': return '서버 응답 시간이 초과되었습니다.';
    case 'network': return '서버에 연결할 수 없습니다.';
    case 'provider_unavailable': return '일정 저장 서비스를 사용할 수 없습니다.';
    default: return '일정 저장 결과를 확인할 수 없습니다.';
  }
}

export function MutationStatus<R>({ state, retry, reset, refresh, canRetry, success }: {
  state: MutationState<R>;
  retry: () => void;
  reset: () => void;
  refresh: () => void;
  canRetry: boolean;
  success: string;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'pending') return (
    <View accessibilityLiveRegion="polite" accessibilityState={{ busy: true }} style={styles.box}>
      <ActivityIndicator size="small" /><Text style={styles.text}>서버에 저장하는 중입니다.</Text>
    </View>
  );
  if (state.status === 'success') return <Text accessibilityLiveRegion="polite" style={styles.success}>{success}</Text>;
  return (
    <View style={styles.box}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{mutationErrorMessage(state.error)}</Text>
      {state.uncertain && <Text style={styles.text}>저장 여부가 불확실합니다. 같은 요청으로 다시 확인할 때까지 새 변경은 잠깁니다.</Text>}
      {!canRetry && <Text style={styles.text}>연결이 바뀌어 이전 요청을 이 연결에서 재시도할 수 없습니다.</Text>}
      {!state.uncertain && <Text style={styles.text}>충돌이나 버전 오류가 있으면 최신 목록을 확인하고 편집을 취소한 뒤 다시 열어 주세요.</Text>}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canRetry }} disabled={!canRetry}
          onPress={retry} style={[styles.button, !canRetry && styles.disabled]}><Text style={styles.buttonText}>같은 요청 재시도</Text></Pressable>
        {!state.uncertain && <Pressable accessibilityRole="button" onPress={reset} style={styles.button}>
          <Text style={styles.buttonText}>오류 닫고 다시 입력</Text>
        </Pressable>}
        {!state.uncertain && <Pressable accessibilityRole="button" onPress={refresh} style={styles.button}>
          <Text style={styles.buttonText}>최신 목록 불러오기</Text>
        </Pressable>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 12, gap: 8 },
  text: { color: '#475569', fontSize: 14, lineHeight: 20 },
  error: { color: '#a01818', fontSize: 15, lineHeight: 22 },
  success: { color: '#166534', marginTop: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#e2e8f0' },
  buttonText: { color: '#172033', fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
