import { useEffect, useState } from 'react';
import type { ScheduleClient, ScheduleQuery, ScheduleResult } from './client';

type LoadState =
  | { status: 'loading' }
  | { status: 'success'; data: ScheduleResult }
  | { status: 'error'; error: unknown };

interface RequestState {
  client: ScheduleClient;
  key: string | null;
  attempt: number;
  refreshVersion: number;
  load: LoadState;
}

export function useSchedule(client: ScheduleClient, query: ScheduleQuery | null, refreshVersion = 0) {
  const [attempt, setAttempt] = useState(0);
  const { from, to, timezone, includeUnscheduled } = query ?? {};
  const key = query ? JSON.stringify([from, to, timezone, includeUnscheduled]) : null;
  const [state, setState] = useState<RequestState>(() => ({
    client, key, attempt, refreshVersion, load: { status: 'loading' },
  }));

  // Clear the previous data during the render that receives different inputs.
  let current = state;
  if (state.client !== client || state.key !== key || state.attempt !== attempt || state.refreshVersion !== refreshVersion) {
    current = { client, key, attempt, refreshVersion, load: { status: 'loading' } };
    setState(current);
  }

  useEffect(() => {
    if (from === undefined || to === undefined || timezone === undefined || includeUnscheduled === undefined) return;
    let active = true;
    Promise.resolve().then(() => client.list({ from, to, timezone, includeUnscheduled })).then(
      (data) => {
        if (active) setState((previous) => previous.client === client && previous.key === key && previous.attempt === attempt && previous.refreshVersion === refreshVersion
          ? { ...previous, load: { status: 'success', data } } : previous);
      },
      (error: unknown) => {
        if (active) setState((previous) => previous.client === client && previous.key === key && previous.attempt === attempt && previous.refreshVersion === refreshVersion
          ? { ...previous, load: { status: 'error', error } } : previous);
      },
    );
    return () => { active = false; };
  }, [client, key, attempt, refreshVersion, from, to, timezone, includeUnscheduled]);

  return { ...current.load, retry: () => setAttempt((value) => value + 1) };
}

export function scheduleErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'not_configured': return '일정 서비스가 아직 설정되지 않았습니다.';
    case 'not_implemented': return '일정 조회 기능이 아직 구현되지 않았습니다.';
    case 'unauthenticated': return '일정을 보려면 로그인 또는 세션 설정이 필요합니다.';
    case 'invalid_response': return '서버의 일정 응답을 확인할 수 없습니다.';
    case 'invalid_configuration': return '서버 주소를 확인해 주세요.';
    case 'timeout': return '서버 응답 시간이 초과되었습니다.';
    case 'network': return '서버에 연결할 수 없습니다.';
    default: return '일정을 불러오지 못했습니다.';
  }
}
