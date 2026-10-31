import { useEffect, useRef, useState } from 'react';
import { createMutationMachine } from './mutation';
import { operationGuard } from './operationGuard';
import type { Mutation, MutationState } from './mutation';

export type { Mutation, MutationState } from './mutation';

export function useMutation<I, R>(execute: (op: Mutation<I>) => Promise<R>, onSuccess?: (result: R) => void) {
  const executeRef = useRef(execute);
  const successRef = useRef(onSuccess);
  executeRef.current = execute;
  successRef.current = onSuccess;
  const active = useRef(true);
  const owner = useRef<object>({});
  const [state, setState] = useState<MutationState<R>>({ status: 'idle' });
  const machineRef = useRef<ReturnType<typeof createMutationMachine<I, R>> | null>(null);
  if (!machineRef.current) {
    machineRef.current = createMutationMachine<I, R>({
      execute: (operation) => executeRef.current(operation),
      changed: (next) => {
        if (active.current) {
          operationGuard.update(owner.current, next);
          setState(next);
        }
      },
      succeeded: (result) => { if (active.current) successRef.current?.(result); },
    });
  }
  const machine = machineRef.current;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      machine.invalidate();
      operationGuard.clear(owner.current);
    };
  }, [machine]);
  return { state, submit: machine.submit, retry: machine.retry, reset: machine.reset };
}
