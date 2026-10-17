#!/usr/bin/env node
/**
 * Run a command with one SOPS document's values in its environment.
 *
 * A bridge for children that authenticate from environment variables but take
 * no credential seam of their own — an MCP server launcher, for example. The
 * document is decrypted into this process's memory (`sops -d` to a pipe, never
 * a temp file) and handed to the child's environment only, so the harness
 * process and every other child stay unaware of the value.
 *
 *   node bin/sops-run.mjs <sops-file> [--only NAME[,NAME...]] <command> [args...]
 *
 * `--only` narrows the environment to the named references, so a third-party
 * child receives the one secret it needs instead of every secret in the file.
 * Arguments after the command are passed through untouched.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** POSIX environment-variable name; anything else is not exportable. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Largest decrypted document this bridge accepts, in bytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/**
 * Report a startup failure on stderr and exit with a distinct code.
 * @param {string} message - what failed, without any secret value.
 * @param {number} code - process exit code.
 */
function fail(message, code) {
	process.stderr.write(`sops-run: ${message}\n`);
	process.exit(code);
}

/** Options between the document and the command: `--only` narrows the env. */
const only = [];
const [file, ...rest] = process.argv.slice(2);
if (file === undefined) {
	fail('usage: sops-run.mjs <sops-file> [--only NAME[,NAME...]] <command> [args...]', 64);
}
let index = 0;
for (; index < rest.length; index += 1) {
	const argument = rest[index] ?? '';
	if (argument === '--only') {
		const value = rest[index + 1];
		if (value === undefined) fail('--only needs a name', 64);
		only.push(...value.split(',').map((name) => name.trim()).filter(Boolean));
		index += 1;
	} else if (argument.startsWith('--only=')) {
		only.push(...argument.slice(7).split(',').map((name) => name.trim()).filter(Boolean));
	} else break;
}
const command = rest.slice(index);
if (command.length === 0) {
	fail('usage: sops-run.mjs <sops-file> [--only NAME[,NAME...]] <command> [args...]', 64);
}

let text;
try {
	const result = await run('sops', ['-d', '--output-type', 'json', file], {
		encoding: 'utf8',
		maxBuffer: MAX_DOCUMENT_BYTES,
	});
	text = result.stdout;
} catch {
	fail(`could not decrypt ${file} (is the age key available?)`, 70);
}

let document;
try {
	document = JSON.parse(text);
} catch {
	fail(`${file} did not decrypt to JSON`, 65);
}
if (typeof document !== 'object' || document === null || Array.isArray(document)) {
	fail(`${file} did not decrypt to a JSON object`, 65);
}

const env = { ...process.env };
const admitted = new Map();
for (const [name, value] of Object.entries(document)) {
	if (typeof value === 'string' && value.length > 0 && ENV_NAME.test(name)) admitted.set(name, value);
}
if (only.length === 0) {
	for (const [name, value] of admitted) env[name] = value;
} else {
	for (const name of only) {
		const value = admitted.get(name);
		if (value === undefined) {
			// The child will report its own authentication error; naming the
			// reference here is what saves the next person the hunt.
			process.stderr.write(`sops-run: ${name} is not in ${file}; the child starts without it\n`);
			continue;
		}
		env[name] = value;
	}
}

// Spawn through the shell-free path: the command and its arguments are already
// separate operands here, and no secret is ever interpolated into an argument.
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => {
		child.kill(signal);
	});
}

child.on('error', (error) => {
	fail(`could not run ${command[0]}: ${error.message}`, 127);
});
child.on('exit', (code, signal) => {
	if (signal !== null) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
