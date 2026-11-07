/**
 * Browser entry of `dsh-vim-control`.
 *
 * Exports the Cordis plugin shape the page's module loader expects: `inject`
 * names the Client services the body needs, and `apply` mounts it. The pure
 * router is exported as well so tests can drive the key table without a DOM.
 *
 * @module dsh-vim-control/client
 */
export { apply } from './plugin';
export { routeNormal } from './keymap';
export type { Action, KeyInput, Route } from './keymap';

/** Client services the plugin body requires. */
export const inject: readonly string[] = ['slots', 'locale', 'layout', 'uiWorkspace'];
