import { useCallback, useEffect, useState } from 'react';
import type { MemoryList, createMemoryClient } from './client';

type MemoryClient = ReturnType<typeof createMemoryClient>;
export type MemoryLoad =
  | { status: 'loading' }
  | { status: 'success'; data: MemoryList; at: string }
  | { status: 'error'; error: unknown };

export function useMemory(client: MemoryClient) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ attempt: number; load: MemoryLoad }>({
    attempt: 0, load: { status: 'loading' },
  });
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const load: MemoryLoad = snapshot.attempt === attempt ? snapshot.load : { status: 'loading' };

  useEffect(() => {
    let active = true;
    const at = new Date().toISOString();
    client.list(at).then(
      (data) => {
        if (active) setSnapshot((previous) => previous.attempt > attempt
          ? previous : { attempt, load: { status: 'success', data, at } });
      },
      (error: unknown) => {
        if (active) setSnapshot((previous) => previous.attempt > attempt
          ? previous : { attempt, load: { status: 'error', error } });
      },
    );
    return () => { active = false; };
  }, [attempt, client]);

  useEffect(() => {
    if (load.status !== 'success') return;
    const expirations = load.data.facts.flatMap((fact) => fact.validUntil === null ? [] : [Date.parse(fact.validUntil)]);
    if (expirations.length === 0) return;
    const next = Math.min(...expirations);
    // setTimeout has a signed 32-bit maximum; re-evaluate distant expirations when it fires.
    const delay = Math.max(1, Math.min(next - Date.now() + 1, 2_147_483_647));
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [load, refresh]);

  return { load, refresh };
}
