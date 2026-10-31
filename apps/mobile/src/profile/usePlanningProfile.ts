import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { createMemoryClient } from '../memory/client';
import type { MemoryWriteInput, MemoryWriteResult } from '../memory/client';
import { emptyPreferences, findPreferences, parsePreferences } from './preferences';
import type { PlanningPreferences } from './preferences';

export type ProfileLoad = { status: 'loading' } | { status: 'error'; error: unknown } |
  { status: 'success'; value: PlanningPreferences | null; contextRevision: number };
let nextScope = 0;
export function usePlanningProfile(api: ApiClient) {
  const client = useMemo(() => createMemoryClient(api), [api]);
  const scope = useMemo(() => ++nextScope, [api]);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ api: ApiClient; attempt: number; load: ProfileLoad }>({ api, attempt, load: { status: 'loading' } });
  const currentApi = useRef(api); currentApi.current = api;
  const requestClient = useRef<{ api: ApiClient; client: typeof client } | null>(null);
  const load = snapshot.api === api && snapshot.attempt === attempt ? snapshot.load : { status: 'loading' as const };
  useEffect(() => {
    let active = true;
    client.list(new Date().toISOString()).then(data => {
      if (!active) return;
      try { setSnapshot({ api, attempt, load: { status: 'success', value: findPreferences(data.facts), contextRevision: data.contextRevision } }); }
      catch (error) { setSnapshot({ api, attempt, load: { status: 'error', error } }); }
    }, error => { if (active) setSnapshot({ api, attempt, load: { status: 'error', error } }); });
    return () => { active = false; };
  }, [api, client, attempt]);
  const mutation = useMutation<MemoryWriteInput, MemoryWriteResult>(operation => requestClient.current!.client.save(operation), result => {
    if (requestClient.current?.api !== currentApi.current) return;
    const value = parsePreferences(result.fact.value);
    if (value) setSnapshot({ api: currentApi.current, attempt, load: { status: 'success', value, contextRevision: result.contextRevision } });
  });
  function save(value: PlanningPreferences, expectedRevision?: number): boolean {
    const parsed = parsePreferences(value);
    if (!parsed || load.status !== 'success' || (expectedRevision !== undefined && expectedRevision !== load.contextRevision) ||
        mutation.state.status === 'pending' || mutation.state.status === 'error' || operationGuard.hasUnresolved()) return false;
    if (mutation.state.status !== 'idle') mutation.reset();
    requestClient.current = { api, client };
    mutation.submit({ expectedContextRevision: load.contextRevision, kind: 'preference', key: 'planning_preferences',
      value: { version: 1, goals: parsed.goals, timing: { ...parsed.timing }, preferredPeriod: parsed.preferredPeriod,
        onboardingStatus: parsed.onboardingStatus }, validUntil: null });
    return true;
  }
  function skip(): boolean { return save({ ...(load.status === 'success' && load.value ? load.value : emptyPreferences()), onboardingStatus: 'skipped' }); }
  function refresh() { if (mutation.state.status !== 'pending' && !(mutation.state.status === 'error' && mutation.state.uncertain)) {
    mutation.reset(); setAttempt(value => value + 1);
  } }
  return { scope, load, mutation: { ...mutation, canRetry: requestClient.current?.api === api }, save, skip, refresh };
}
export type PlanningProfile = ReturnType<typeof usePlanningProfile>;
