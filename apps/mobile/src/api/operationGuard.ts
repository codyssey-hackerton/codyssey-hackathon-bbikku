import type { MutationState } from './mutation';

/** Tracks in-memory writes that cannot safely be abandoned on connection changes. */
export function createOperationGuard() {
  const unresolved = new Set<object>();
  return {
    update(owner: object, state: MutationState<unknown>) {
      if (state.status === 'pending' || (state.status === 'error' && state.uncertain)) unresolved.add(owner);
      else unresolved.delete(owner);
    },
    clear(owner: object) { unresolved.delete(owner); },
    hasUnresolved() { return unresolved.size > 0; },
  };
}

// One app root owns this registry. No token or request body is stored here.
export const operationGuard = createOperationGuard();
