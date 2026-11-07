/**
 * Plugin state and its observable store.
 *
 * One immutable snapshot per change, so React can read it with
 * `useSyncExternalStore` and the keyboard router can read it without React.
 *
 * @module state
 */

/** Editor posture: this plugin owns keys only in `normal` and `command`. */
export type Mode = 'normal' | 'insert' | 'command';

/** Which row list the cursor addresses. */
export type RowList = 'chat' | 'sessions' | 'tree';

/** Held multi-key prefix (`g`, `]`, `[`). */
export type Pending = '' | 'g' | ']' | '[';

/** The plugin snapshot. */
export interface VimState {
  /** Master switch, persisted in this origin's storage. */
  readonly enabled: boolean;
  readonly mode: Mode;
  /** Text of the open `:` line. */
  readonly command: string;
  /** Whether the key list is open. */
  readonly help: boolean;
  readonly list: RowList;
  readonly cursor: number;
  /** Transient note shown in the chip. */
  readonly hint: string;
  readonly pending: Pending;
}

/** Minimal observable store over one state shape. */
export interface SnapshotStore<T> {
  /** Current immutable snapshot. */
  get(): T;
  /** Merge a patch and notify subscribers. */
  set(patch: Partial<T>): void;
  /** Observe changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Build a store over one initial snapshot.
 * @param initial - starting state.
 * @returns the store.
 */
export function createStore(initial: VimState): SnapshotStore<VimState> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set: (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
