import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { expandEnv, expandHome, grantsExtraRoots, isUnderRoot, resolveWritableRoots, WritableRootSet } from '../lib/roots.js';

/** A scratch directory that is writable on every supported host. */
function scratch() {
	return mkdtempSync(join(tmpdir(), 'dwr-'));
}

test('expandHome expands a leading ~ and leaves other spellings alone', () => {
	assert.equal(expandHome('~'), homedir());
	assert.equal(expandHome('~/.cache'), join(homedir(), '.cache'));
	assert.equal(expandHome('~other/.cache'), '~other/.cache');
	assert.equal(expandHome('/absolute/.cache'), '/absolute/.cache');
	assert.equal(expandHome('relative/.cache'), 'relative/.cache');
});

test('expandHome is not applied to a ~ that is not a leading path segment', () => {
	assert.equal(expandHome('/tmp/~/.cache'), '/tmp/~/.cache');
});

test('expandEnv expands $NAME and ${NAME} from the given environment', () => {
	const env = { XDG_RUNTIME_DIR: '/run/user/1000', CACHE: '/home/user/.cache' };
	assert.equal(expandEnv('$XDG_RUNTIME_DIR/pnpm-store-operation-locks-1000', env), '/run/user/1000/pnpm-store-operation-locks-1000');
	assert.equal(expandEnv('${CACHE}/pnpm', env), '/home/user/.cache/pnpm');
	assert.equal(expandEnv('$CACHE/${CACHE}', env), '/home/user/.cache//home/user/.cache');
	assert.equal(expandEnv('/plain/path', env), '/plain/path');
});

test('expandEnv leaves a lone or nameless $ alone', () => {
	assert.equal(expandEnv('$', { HOME: '/home/user' }), '$');
	assert.equal(expandEnv('/tmp/$/cache', { HOME: '/home/user' }), '/tmp/$/cache');
});

test('expandEnv fails loud on an unset or empty variable', () => {
	assert.throws(() => expandEnv('$DSH_NOPE/cache', {}), /environment variable "DSH_NOPE" is unset/u);
	assert.throws(() => expandEnv('${EMPTY}/cache', { EMPTY: '' }), /"EMPTY" is unset/u);
});

test('resolveWritableRoots expands environment references before canonicalizing', () => {
	const dir = scratch();
	mkdirSync(join(dir, 'pnpm'));
	assert.deepEqual(resolveWritableRoots(['$PROBE_HOME/pnpm'], { env: { PROBE_HOME: dir } }), [realpathSync.native(join(dir, 'pnpm'))]);
	assert.throws(() => resolveWritableRoots(['$PROBE_UNSET/pnpm'], { env: {} }), /environment variable "PROBE_UNSET" is unset/u);
});

test('resolveWritableRoots canonicalizes symlinks and deduplicates', () => {
	const dir = scratch();
	const real = join(dir, 'real');
	mkdirSync(real);
	const link = join(dir, 'link');
	symlinkSync(real, link);
	const expected = realpathSync.native(real);
	assert.deepEqual(resolveWritableRoots([link, real, link]), [expected]);
});

test('resolveWritableRoots trims entries', () => {
	const dir = scratch();
	mkdirSync(join(dir, 'padded'));
	assert.deepEqual(resolveWritableRoots([`  ${join(dir, 'padded')}  `]), [realpathSync.native(join(dir, 'padded'))]);
});

test('resolveWritableRoots rejects a relative entry', () => {
	assert.throws(() => resolveWritableRoots(['cache']), /must be an absolute path or start with "~\/"/u);
});

test('resolveWritableRoots rejects an empty entry', () => {
	assert.throws(() => resolveWritableRoots(['   ']), /is empty/u);
});

test('resolveWritableRoots rejects a missing entry', () => {
	const dir = scratch();
	assert.throws(() => resolveWritableRoots([join(dir, 'missing')]), /does not exist/u);
});

test('resolveWritableRoots creates a missing entry only when asked', () => {
	const dir = scratch();
	const leaf = join(dir, 'runtime-locks');
	const created = resolveWritableRoots([leaf], { createMissing: true });
	assert.deepEqual(created, [realpathSync.native(leaf)]);
	assert.equal(statSync(leaf).isDirectory(), true);
	assert.equal(statSync(leaf).mode & 0o777, 0o700);
});

test('resolveWritableRoots creates a missing entry through an existing parent chain', () => {
	const dir = scratch();
	const leaf = join(dir, 'a', 'b');
	assert.deepEqual(resolveWritableRoots([leaf], { createMissing: true }), [realpathSync.native(leaf)]);
});

test('resolveWritableRoots rejects a non-directory entry', () => {
	const dir = scratch();
	const file = join(dir, 'file');
	writeFileSync(file, 'not a directory');
	assert.throws(() => resolveWritableRoots([file]), /is not a directory/u);
});

test('resolveWritableRoots accepts an empty list', () => {
	assert.deepEqual(resolveWritableRoots([]), []);
});

test('grantsExtraRoots keeps read-only denying unless the deployment opts in', () => {
	assert.equal(grantsExtraRoots('workspace-write', false), true);
	assert.equal(grantsExtraRoots('workspace-write', true), true);
	assert.equal(grantsExtraRoots('read-only', false), false);
	assert.equal(grantsExtraRoots('read-only', true), true);
	assert.equal(grantsExtraRoots('danger-full-access', false), false);
	assert.equal(grantsExtraRoots('danger-full-access', true), false);
});

test('isUnderRoot contains the root and its descendants only', () => {
	assert.equal(isUnderRoot('/a/b', '/a/b'), true);
	assert.equal(isUnderRoot('/a/b/c', '/a/b'), true);
	assert.equal(isUnderRoot('/a/bc', '/a/b'), false);
	assert.equal(isUnderRoot('/a', '/a/b'), false);
	assert.equal(isUnderRoot('/ab', '/a'), false);
});

test('isUnderRoot folds case for a case-insensitive host', () => {
	assert.equal(isUnderRoot('/A/B/c', '/a/b', false), true);
	assert.equal(isUnderRoot('/A/B/c', '/a/b', true), false);
});

test('WritableRootSet re-resolves only when the configuration changes', () => {
	const dir = scratch();
	const one = join(dir, 'one');
	const two = join(dir, 'two');
	mkdirSync(one);
	mkdirSync(two);
	let configured = [one];
	const failures = [];
	const set = new WritableRootSet(() => configured, (error) => failures.push(error));
	assert.deepEqual(set.value, [realpathSync.native(one)]);
	assert.equal(set.value, set.value);
	configured = [one, two];
	assert.deepEqual(set.value, [realpathSync.native(one), realpathSync.native(two)]);
	assert.deepEqual(failures, []);
});

test('WritableRootSet fails closed when a live edit stops resolving', () => {
	const dir = scratch();
	const good = join(dir, 'good');
	mkdirSync(good);
	let configured = [good];
	const failures = [];
	const set = new WritableRootSet(() => configured, (error) => failures.push(error));
	assert.deepEqual(set.value, [realpathSync.native(good)]);
	configured = [join(dir, 'gone')];
	assert.deepEqual(set.value, []);
	assert.equal(failures.length, 1);
	assert.match(failures[0].message, /does not exist/u);
	configured = [good];
	assert.deepEqual(set.value, [realpathSync.native(good)]);
});

test('WritableRootSet honours live resolution options', () => {
	const dir = scratch();
	const leaf = join(dir, 'lazy-locks');
	let createMissing = false;
	const failures = [];
	const set = new WritableRootSet(
		() => ['$PROBE_HOME/lazy-locks'],
		(error) => failures.push(error),
		() => ({ env: { PROBE_HOME: dir }, createMissing }),
	);
	assert.deepEqual(set.value, []);
	assert.equal(failures.length, 1);
	createMissing = true;
	// The configuration string did not change, so the set must re-resolve on a
	// changed option alone; otherwise a live `createMissingRoots` edit would
	// have no effect.
	assert.deepEqual(set.value, [realpathSync.native(leaf)]);
});

