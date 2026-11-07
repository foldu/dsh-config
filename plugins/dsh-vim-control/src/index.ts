/**
 * Host half of `dsh-vim-control`.
 *
 * Modal navigation is entirely a browser concern: the keys, the row cursor,
 * and the mode badge live in the Client half. The Host row exists so the Loader
 * can resolve this package, apply its patch, and hand the Client half to
 * `dsh-client-modules`; there is no Host service, projection, or tool.
 *
 * @module dsh-vim-control
 */
import type { Context } from '@deepseek-ai/cordis';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vim-control';

/**
 * Keep the row mountable without Host behavior.
 * @param _ctx - Host context; nothing is registered on it.
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: the Client half owns every effect.
}
