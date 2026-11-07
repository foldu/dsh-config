/**
 * The NORMAL-mode key router.
 *
 * Pure on purpose: it reads a snapshot and one key, and answers with an action,
 * a held prefix, or nothing. No DOM, no services, so the same table can be
 * unit-tested outside a browser and the plugin body stays about side effects.
 *
 * Only unmodified keys are navigation; `Ctrl+d`/`Ctrl+u` are the two deliberate
 * exceptions. Every other modifier combination belongs to the browser or the
 * shell and is never consumed.
 *
 * @module keymap
 */
import type { Pending, VimState } from './state';

/** One navigation action the plugin knows how to perform. */
export type Action =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'half-down'
  | 'half-up'
  | 'activate'
  | 'insert'
  | 'command'
  | 'toggle-help'
  | 'escape'
  | 'session-next'
  | 'session-prev'
  | 'agents'
  | 'agents-next'
  | 'agents-prev'
  | 'sidebar'
  | 'conversation'
  | 'disable';

/** Outcome of routing one key. */
export type Route =
  | { readonly kind: 'action'; readonly action: Action }
  | { readonly kind: 'pending'; readonly pending: Exclude<Pending, ''> }
  | { readonly kind: 'none' };

/** The key facts the router reads. */
export interface KeyInput {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/** A monotonic action result. */
const action = (name: Action): Route => ({ kind: 'action', action: name });

/**
 * Route one key in NORMAL mode.
 * @param state - current snapshot (only `pending` and `help` are read).
 * @param input - key facts from the DOM event.
 * @returns the action to perform, a held prefix, or nothing.
 */
export function routeNormal(state: VimState, input: KeyInput): Route {
  const ctrl = input.ctrlKey === true;
  const meta = input.metaKey === true;
  const alt = input.altKey === true;

  if (ctrl || meta || alt) {
    if (ctrl && !meta && !alt && (input.key === 'd' || input.key === 'u')) {
      return action(input.key === 'd' ? 'half-down' : 'half-up');
    }
    return { kind: 'none' };
  }

  if (state.pending !== '') return routePrefix(state.pending, input.key);

  switch (input.key) {
    case 'g':
    case ']':
    case '[':
      return { kind: 'pending', pending: input.key };
    case 'j':
      return action('next');
    case 'k':
      return action('prev');
    case 'G':
      return action('last');
    case 'Enter':
      return action('activate');
    case 'i':
      return action('insert');
    case ':':
      return action('command');
    case '?':
      return action('toggle-help');
    case 'Escape':
      return action('escape');
    default:
      return { kind: 'none' };
  }
}

/**
 * Resolve one key after a held prefix.
 * @param prefix - the held prefix.
 * @param key - the key that followed it.
 * @returns the action, or nothing (the prefix is dropped either way).
 */
function routePrefix(prefix: Exclude<Pending, ''>, key: string): Route {
  if (prefix === 'g') {
    switch (key) {
      case 'g':
        return action('first');
      case 's':
        return action('sidebar');
      case 'a':
        return action('agents');
      case 'c':
        return action('conversation');
      case 'v':
        return action('disable');
      default:
        return { kind: 'none' };
    }
  }
  if (prefix === ']') {
    if (key === 'c') return action('session-next');
    if (key === 'a') return action('agents-next');
    return { kind: 'none' };
  }
  if (key === 'c') return action('session-prev');
  if (key === 'a') return action('agents-prev');
  return { kind: 'none' };
}
