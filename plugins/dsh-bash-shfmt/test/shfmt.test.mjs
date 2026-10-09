/**
 * `ShfmtFormatter` against stand-in binaries: a working transform (node -e), a
 * missing binary, a failing one, and a cache that must not re-spawn per render.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShfmtFormatter } from '../lib/shfmt.js';

/** A node one-liner that rewrites stdin the way a formatter would. */
const TRANSFORM = "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write(s.split(' && ').join(' &&\\n')));";

const nodeFormatter = (cacheSize = 8) =>
	new ShfmtFormatter(
		() => ({ binary: process.execPath, args: ['-e', TRANSFORM], timeoutMs: 5000 }),
		() => cacheSize,
	);

test('formats a command through the configured binary', async () => {
	const outcome = await nodeFormatter().format('cd /tmp && ls -la');
	assert.equal(outcome.applied, true);
	assert.equal(outcome.formatted, 'cd /tmp &&\nls -la');
});

test('a missing binary returns the original command', async () => {
	const formatter = new ShfmtFormatter(
		() => ({ binary: 'dsh-bash-shfmt-not-a-real-binary', args: [], timeoutMs: 5000 }),
		() => 8,
	);
	const outcome = await formatter.format('echo hi && echo there');
	assert.deepEqual(outcome, { formatted: 'echo hi && echo there', applied: false });
});

test('a failing binary returns the original command', async () => {
	const formatter = new ShfmtFormatter(
		() => ({ binary: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000 }),
		() => 8,
	);
	const outcome = await formatter.format('echo hi');
	assert.deepEqual(outcome, { formatted: 'echo hi', applied: false });
});

test('empty output returns the original command', async () => {
	const formatter = new ShfmtFormatter(
		() => ({ binary: process.execPath, args: ['-e', 'process.stdin.resume();'], timeoutMs: 5000 }),
		() => 8,
	);
	const outcome = await formatter.format('echo hi');
	assert.deepEqual(outcome, { formatted: 'echo hi', applied: false });
});

test('a command is formatted once per cache lifetime', async () => {
	const tally = `${process.env.TMPDIR ?? '/tmp'}/dsh-bash-shfmt-${String(process.pid)}-tally.txt`;
	const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(tally)},'x');let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write(s));`;
	const formatter = new ShfmtFormatter(
		() => ({ binary: process.execPath, args: ['-e', script], timeoutMs: 5000 }),
		() => 8,
	);
	const first = await formatter.format('echo one && echo two');
	const second = await formatter.format('echo one && echo two');
	assert.equal(first.formatted, 'echo one && echo two');
	assert.deepEqual(second, first);
	const { readFileSync, rmSync } = await import('node:fs');
	// The probe runs `--version` once; the command itself must run once.
	assert.equal(readFileSync(tally, 'utf8').length, 1);
	rmSync(tally, { force: true });
});

test('the cache ceiling evicts the oldest command', async () => {
	const formatter = nodeFormatter(1);
	await formatter.format('a && b');
	const second = await formatter.format('c && d');
	assert.equal(second.formatted, 'c &&\nd');
	// 'a && b' left the cache and is formatted again, still correctly.
	const again = await formatter.format('a && b');
	assert.equal(again.formatted, 'a &&\nb');
});

test('a timeout keeps the original command', async () => {
	const formatter = new ShfmtFormatter(
		() => ({ binary: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 200 }),
		() => 8,
	);
	const outcome = await formatter.format('echo slow');
	assert.deepEqual(outcome, { formatted: 'echo slow', applied: false });
});
