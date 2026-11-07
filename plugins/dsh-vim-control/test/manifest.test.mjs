/**
 * Package shape: the manifest the Loader reads, the patch row it applies, and
 * the two build artifacts (Host entry, Client bundle).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the manifest declares a bundle and a web Client half', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, 'dsh-vim-control');
  assert.equal(manifest.main, 'lib/index.js');
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.icon, 'the plugin declares an icon');
});

test('the patch inserts exactly its own row', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /id: vim-control/);
  assert.match(patch, /name: 'dsh-vim-control'/);
});

test('the Host entry exports apply', async () => {
  const host = await import('../lib/index.js');
  assert.equal(typeof host.apply, 'function');
  assert.equal(host.name, 'vim-control');
});

test('the Client bundle registers the module-loader entry', async () => {
  const bundle = await read('lib/client.js');
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/);
  assert.match(bundle, /id: 'dsh-vim-control'/);
  assert.match(bundle, /factory: \(require\) =>/);
});
