/**
 * Host half of the sidebar brand override.
 *
 * The Client half (`./client.js`) owns the rendering; this row exists so the
 * bundle is selectable in the profile and its Client module is served to the
 * page. There is nothing for the Host process to do, so `apply` is empty.
 */
export function apply() {}
