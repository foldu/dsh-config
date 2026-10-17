#!/usr/bin/env node
/**
 * Print the Nix-installed Ghidra paths a headless launcher needs.
 *
 * The `ghidra` package a Nix profile exposes is often an extension layer whose
 * real installation is a sibling store path, so the install directory cannot be
 * derived from the wrapper's own path. Resolve it through the store references
 * instead: the wrapper references the base Ghidra package, and the base package
 * references the OpenJDK it was built against.
 *
 *   node bin/ghidra-home.mjs            # GHIDRA_INSTALL_DIR
 *   node bin/ghidra-home.mjs java-home  # JAVA_HOME
 *
 * Override the wrapper with GHIDRA_WRAPPER (a path to a `ghidra` launcher).
 * Exits non-zero with a message when Ghidra or its JDK cannot be found.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Run a command and return its stdout lines. */
function lines(command, args) {
	try {
		return execFileSync(command, args, { encoding: 'utf8' }).split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

/** Report a failure the caller can act on. */
function fail(message) {
	process.stderr.write(`ghidra-home: ${message}\n`);
	process.exit(1);
}

/** The requested output mode: `env` (default), `install-dir`, or `java-home`. */
const mode = process.argv[2] ?? 'env';

/** Whether a directory looks like a Ghidra installation. */
function isInstallDir(directory) {
	return (
		existsSync(join(directory, 'support', 'analyzeHeadless')) &&
		existsSync(join(directory, 'Ghidra', 'application.properties'))
	);
}

const wrapper = process.env.GHIDRA_WRAPPER ?? join(homedir(), '.nix-profile', 'bin', 'ghidra');
if (!existsSync(wrapper)) {
	if (mode === 'env') process.exit(0);
	fail(`no Ghidra launcher at ${wrapper} (set GHIDRA_WRAPPER)`);
}
const launcher = realpathSync(wrapper);

// A plain `ghidra` package is its own install; an extension layer references one.
const siblings = lines('nix-store', ['-q', '--references', launcher]);
const candidates = [dirname(launcher), ...siblings]
	.filter((path) => /-ghidra-\d/.test(path) && !/-ghidra-with-extensions-/.test(path))
	.map((path) => join(path, 'lib', 'ghidra'));

const install = candidates.find(isInstallDir);
if (install === undefined) {
	if (mode === 'env') process.exit(0);
	fail(`could not find lib/ghidra under ${launcher}; is Ghidra installed via Nix?`);
}

const jdk = [...lines('nix-store', ['-q', '--references', dirname(dirname(install))]), ...lines('nix-store', ['-q', '--references', launcher])].find(
	(path) => /-openjdk-|-jdk-/.test(path),
);

if (mode === 'install-dir') process.stdout.write(install);
else if (mode === 'java-home') {
	if (jdk === undefined) fail(`no JDK among the store references of ${install}`);
	process.stdout.write(jdk);
} else {
	const found = [['GHIDRA_INSTALL_DIR', install]];
	if (jdk !== undefined) found.push(['JAVA_HOME', jdk]);
	process.stdout.write(found.map(([key, value]) => `${key}=${value}`).join('\n'));
}
