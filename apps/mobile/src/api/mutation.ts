import { ApiError } from './http';

export interface Mutation<I> {
  input: I;
  requestId: string;
  idempotencyKey: string;
}

export type MutationState<R> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'success'; result: R }
  | { status: 'error'; error: unknown; uncertain: boolean };

let sequence = 0;
function identifier(prefix: string): string {
  sequence += 1;
  // Correlation and idempotency identifiers are not authentication credentials.
  return `${prefix}-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 12)}`;
}

function snapshot<I>(input: I): I {
  // API mutation inputs are JSON data. Keep retries independent of later form edits.
  return JSON.parse(JSON.stringify(input)) as I;
}

export function isUncertainMutationError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (['network', 'timeout', 'invalid_response', 'operation_in_progress'].includes(error.code)) return true;
  if (error.status !== undefined && error.status >= 500) {
    return !['not_configured', 'not_implemented'].includes(error.code);
  }
  return false;
}

/** Owns one intent until its response is known; retries reuse its exact IDs and body. */
export function createMutationMachine<I, R>(options: {
  execute: (op: Mutation<I>) => Promise<R>;
  changed: (state: MutationState<R>) => void;
  succeeded?: (result: R) => void;
}) {
  let state: MutationState<R> = { status: 'idle' };
  let operation: Mutation<I> | null = null;
  let generation = 0;
  let hadUncertainOutcome = false;
  let checking = false;

  function update(next: MutationState<R>) {
    state = next;
    options.changed(next);
  }

  async function perform(current: Mutation<I>) {
    const thisGeneration = generation;
    update({ status: 'pending' });
    let result: R;
    try {
      result = await options.execute({ ...current, input: snapshot(current.input) });
    } catch (error) {
      if (generation === thisGeneration) {
        // A later authentication or validation error cannot prove an earlier timed-out write failed.
        hadUncertainOutcome = hadUncertainOutcome || isUncertainMutationError(error);
        update({ status: 'error', error, uncertain: hadUncertainOutcome });
      }
      return;
    }
    if (generation !== thisGeneration) return;
    finish(result);
  }

  function finish(result: R) {
    operation = null;
    hadUncertainOutcome = false;
    update({ status: 'success', result });
    options.succeeded?.(result);
  }

  return {
    getState: () => state,
    submit(input: I) {
      if (state.status !== 'idle' || operation !== null) return;
      operation = { input: snapshot(input), requestId: identifier('request'), idempotencyKey: identifier('operation') };
      void perform(operation);
    },
    retry() {
      if (state.status !== 'error' || !operation || checking) return;
      void perform(operation);
    },
    async check<T>(lookup: (operation: Mutation<I>) => Promise<T>, completed: (value: T) => { result: R } | { error: unknown } | null): Promise<T | undefined> {
      if (state.status !== 'error' || !state.uncertain || !operation || checking) return undefined;
      const current = operation, thisGeneration = generation;
      checking = true;
      try {
        const value = await lookup({ ...current, input: snapshot(current.input) });
        if (generation !== thisGeneration || operation !== current || state.status !== 'error') return undefined;
        const recovered = completed(value);
        if (recovered && 'result' in recovered) finish(recovered.result);
        else if (recovered && 'error' in recovered) {
          hadUncertainOutcome = isUncertainMutationError(recovered.error);
          update({ status: 'error', error: recovered.error, uncertain: hadUncertainOutcome });
        }
        return value;
      } finally {
        if (generation === thisGeneration) checking = false;
      }
    },
    reset() {
      if (state.status === 'pending' || (state.status === 'error' && state.uncertain)) return;
      operation = null;
      hadUncertainOutcome = false;
      update({ status: 'idle' });
    },
    invalidate() {
      generation += 1;
      checking = false;
      operation = null;
      hadUncertainOutcome = false;
      state = { status: 'idle' };
    },
  };
}
