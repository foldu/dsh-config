/**
 * The key router, driven through the built Client bundle.
 *
 * The bundle is the artifact the page loads, so the test loads it too: the
 * module-loader call is captured from a fake `window`, the factory runs with a
 * stub `require` (React is only touched inside `apply`), and the exported
 * `routeNormal` is exercised as a pure function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Loader entries captured from the bundle. */
const loaded = [];

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry);
    },
  },
};

await import('../lib/client.js');

const [entry] = loaded;
assert.ok(entry, 'the bundle registers one module-loader entry');
assert.equal(entry.id, 'dsh-vim-control');

const plugin = entry.factory(() => ({}));
const { routeNormal, inject } = plugin;

/** Minimal snapshot the router reads. */
const state = (patch = {}) => ({
  enabled: true,
  mode: 'normal',
  command: '',
  help: false,
  list: 'chat',
  cursor: 0,
  hint: '',
  pending: '',
  ...patch,
});

const key = (value, extra = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test('the bundle exports the plugin shape the loader needs', () => {
  assert.deepEqual([...inject], ['slots', 'locale', 'layout', 'uiWorkspace']);
  assert.equal(typeof plugin.apply, 'function');
});

test('plain motions route to actions', () => {
  assert.deepEqual(routeNormal(state(), key('j')), { kind: 'action', action: 'next' });
  assert.deepEqual(routeNormal(state(), key('k')), { kind: 'action', action: 'prev' });
  assert.deepEqual(routeNormal(state(), key('Enter')), { kind: 'action', action: 'activate' });
  assert.deepEqual(routeNormal(state(), key(':')), { kind: 'action', action: 'command' });
  assert.deepEqual(routeNormal(state(), key('?')), { kind: 'action', action: 'toggle-help' });
  assert.deepEqual(routeNormal(state(), key('i')), { kind: 'action', action: 'insert' });
});

test('prefixes hold until the next key', () => {
  assert.deepEqual(routeNormal(state(), key('g')), { kind: 'pending', pending: 'g' });
  assert.deepEqual(routeNormal(state({ pending: 'g' }), key('g')), { kind: 'action', action: 'first' });
  assert.deepEqual(routeNormal(state({ pending: 'g' }), key('s')), { kind: 'action', action: 'sidebar' });
  assert.deepEqual(routeNormal(state({ pending: 'g' }), key('a')), { kind: 'action', action: 'agents' });
  assert.deepEqual(routeNormal(state({ pending: 'g' }), key('c')), { kind: 'action', action: 'conversation' });
  assert.deepEqual(routeNormal(state({ pending: ']' }), key('c')), { kind: 'action', action: 'session-next' });
  assert.deepEqual(routeNormal(state({ pending: '[' }), key('c')), { kind: 'action', action: 'session-prev' });
  assert.deepEqual(routeNormal(state({ pending: ']' }), key('a')), { kind: 'action', action: 'agents-next' });
  assert.deepEqual(routeNormal(state({ pending: '[' }), key('a')), { kind: 'action', action: 'agents-prev' });
});

test('an unknown key drops the held prefix', () => {
  assert.deepEqual(routeNormal(state({ pending: 'g' }), key('x')), { kind: 'none' });
});

test('modified keys stay with the browser except Ctrl+d and Ctrl+u', () => {
  assert.deepEqual(routeNormal(state(), key('j', { ctrlKey: true })), { kind: 'none' });
  assert.deepEqual(routeNormal(state(), key('d', { ctrlKey: true })), { kind: 'action', action: 'half-down' });
  assert.deepEqual(routeNormal(state(), key('u', { ctrlKey: true })), { kind: 'action', action: 'half-up' });
  assert.deepEqual(routeNormal(state(), key('d', { metaKey: true })), { kind: 'none' });
  assert.deepEqual(routeNormal(state(), key('d', { ctrlKey: true, altKey: true })), { kind: 'none' });
});

test('Escape always routes so the plugin can clear its own state', () => {
  assert.deepEqual(routeNormal(state(), key('Escape')), { kind: 'action', action: 'escape' });
});
