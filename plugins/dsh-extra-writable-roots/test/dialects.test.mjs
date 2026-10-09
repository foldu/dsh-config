import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectDialect, widenArgv } from '../lib/dialects.js';

const CACHE = '/home/user/.cache';

/** The argv before the separator, the separator index, and the wrapped command. */
function parts(argv) {
	const at = argv.indexOf('--');
	return { at, profile: argv.slice(0, at), command: argv.slice(at + 1) };
}

test('detects the bwrap dialect from its profile flags', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/ws', '/ws', '--', 'bash'];
	assert.equal(detectDialect(argv), 'bwrap');
});

test('detects bwrap behind an operator-configured runnerCommand', () => {
	const argv = ['/home/user/bin/my-runner', '--ro-bind', '/', '/', '--bind', '/ws', '/ws', '--', 'bash'];
	assert.equal(detectDialect(argv), 'bwrap');
});

test('widens a bwrap workspace-write profile with a later bind of the extra root', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', '/ws', '/ws', '--', 'bash', '-c', 'echo hi'];
	const widened = widenArgv(argv, [CACHE]);
	assert.equal(widened.dialect, 'bwrap');
	assert.equal(widened.applied, true);
	const { at, profile, command } = parts(widened.argv);
	assert.deepEqual(profile.slice(-3), ['--bind', CACHE, CACHE]);
	assert.equal(profile.includes('/tmp'), true);
	assert.deepEqual(command, ['bash', '-c', 'echo hi']);
	assert.equal(widened.argv.filter((argument) => argument === '--').length, 1);
	assert.equal(at, argv.indexOf('--') + 3);
});

test('widens a bwrap read-only profile too, when asked', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--', 'bash', '-c', 'echo'];
	const widened = widenArgv(argv, [CACHE]);
	assert.equal(widened.applied, true);
	assert.deepEqual(parts(widened.argv).profile.slice(-3), ['--bind', CACHE, CACHE]);
});

test('a declared /tmp replaces the runner private tmpfs with the host directory', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', '/ws', '/ws', '--', 'bash', '-c', 'echo'];
	const widened = widenArgv(argv, [CACHE, '/tmp']);
	assert.equal(widened.applied, true);
	const { profile, command } = parts(widened.argv);
	assert.equal(profile.includes('--tmpfs'), false);
	// The workspace bind survives and each declared root is bound exactly once.
	assert.deepEqual(profile.slice(0, 9), ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--bind', '/ws', '/ws']);
	assert.deepEqual(profile.slice(9), ['--bind', CACHE, CACHE, '--bind', '/tmp', '/tmp']);
	assert.deepEqual(command, ['bash', '-c', 'echo']);
});

test('an undeclared /tmp keeps the runner private tmpfs', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/ws', '/ws', '--', 'bash'];
	const widened = widenArgv(argv, [CACHE]);
	const { profile } = parts(widened.argv);
	assert.deepEqual(profile.slice(0, 4), ['bwrap', '--ro-bind', '/', '/']);
	assert.equal(profile.includes('--tmpfs'), true);
	assert.equal(profile.includes('/tmp'), true);
	assert.equal(profile.filter((argument) => argument === '/tmp').length, 1);
});

test('a declared root is matched against the mount target canonically', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'dwr-dialect-'));
	const real = join(scratch, 'real');
	mkdirSync(real);
	const link = join(scratch, 'link');
	symlinkSync(real, link);
	const argv = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', link, '--', 'bash'];
	const widened = widenArgv(argv, [realpathSync.native(real)]);
	const { profile } = parts(widened.argv);
	assert.equal(profile.includes('--tmpfs'), false);
	assert.deepEqual(profile.slice(-3), ['--bind', realpathSync.native(real), realpathSync.native(real)]);
});

test('a declared /tmp also reaches a read-only bwrap profile when asked', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--', 'bash'];
	const widened = widenArgv(argv, ['/tmp']);
	assert.equal(widened.applied, true);
	assert.deepEqual(parts(widened.argv).profile.slice(-3), ['--bind', '/tmp', '/tmp']);
});

test('widens the landlock dialect with --rw grants', () => {
	const argv = ['/nix/store/x/bin/landlock-run', '--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/ws', '--', 'bash', '-c', 'echo'];
	const widened = widenArgv(argv, [CACHE, '/var/tmp/cache']);
	assert.equal(widened.dialect, 'landlock');
	assert.equal(widened.applied, true);
	assert.deepEqual(parts(widened.argv).profile.slice(-4), ['--rw', CACHE, '--rw', '/var/tmp/cache']);
});

test('widens the seatbelt dialect by appending an allow form to the profile', () => {
	const argv = ['sandbox-exec', '-p', '(version 1) (allow default) (deny file-write*)', '--', 'bash', '-c', 'echo'];
	const widened = widenArgv(argv, [CACHE]);
	assert.equal(widened.dialect, 'seatbelt');
	assert.equal(widened.applied, true);
	assert.equal(widened.argv[0], 'sandbox-exec');
	assert.equal(widened.argv[1], '-p');
	assert.equal(widened.argv[2], `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "${CACHE}"))`);
	assert.deepEqual(widened.argv.slice(3), ['--', 'bash', '-c', 'echo']);
});

test('escapes a seatbelt path that needs SBPL quoting', () => {
	const argv = ['sandbox-exec', '-p', '(version 1)', '--', 'bash'];
	const widened = widenArgv(argv, ['/home/od"d/\\cache']);
	assert.equal(widened.applied, true);
	assert.equal(widened.argv[2], '(version 1) (allow file-write* (subpath "/home/od\\"d/\\\\cache"))');
});

test('reports the windows-acl and unknown dialects as not widened', () => {
	const acl = ['node', '/opt/windows-acl-run/runner.js', '--workspace', '/ws', '--temp', '/tmp', '--mode', 'workspace-write', '--', 'cmd', '/c', 'exit'];
	const unknown = ['/opt/some-wrapper', '--', 'bash', '-c', 'echo'];
	assert.equal(detectDialect(acl), 'windows-acl');
	assert.equal(detectDialect(unknown), 'unknown');
	assert.deepEqual(widenArgv(acl, [CACHE]), { argv: acl, dialect: 'windows-acl', applied: false });
	assert.deepEqual(widenArgv(unknown, [CACHE]), { argv: unknown, dialect: 'unknown', applied: false });
});

test('an argv without a separator is never widened', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/'];
	const widened = widenArgv(argv, [CACHE]);
	assert.equal(widened.dialect, 'bwrap');
	assert.equal(widened.applied, false);
	assert.equal(widened.argv, argv);
});

test('an empty root list is a successful no-op', () => {
	const argv = ['bwrap', '--ro-bind', '/', '/', '--', 'bash'];
	const widened = widenArgv(argv, []);
	assert.equal(widened.applied, true);
	assert.equal(widened.argv, argv);
});
