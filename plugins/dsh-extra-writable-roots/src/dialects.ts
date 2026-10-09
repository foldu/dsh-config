/**
 * Runner-dialect translation of extra writable roots.
 *
 * `@deepseek-ai/dsh-sandbox-local` returns the confined argv already wrapped in
 * a platform runner, and its profile arguments are built from the shared
 * `writableRoots` allow-list that this plugin cannot reach. The wrapped argv is
 * therefore the extension point: this module recognizes the runner's dialect
 * from the profile arguments and widens them in that dialect's own spelling —
 * a later bwrap mount shadows the earlier read-only bind of `/`, a Landlock
 * launcher simply receives more grants, and a Seatbelt profile gains another
 * allow form. Dialects that cannot express another root (the Windows ACL runner
 * takes exactly one workspace and one temp root) report `applied: false` so the
 * caller can say so instead of pretending the grant exists.
 *
 * A declared root must be *the host directory*, not a private copy of it. A
 * bwrap `workspace-write` profile mounts a fresh `--tmpfs /tmp`, which would
 * make a declared `/tmp` a per-call throwaway that disagrees with the host
 * `/tmp` the filesystem half already grants; this module therefore drops the
 * runner's own ephemeral mount for a declared path before binding it, so one
 * declared root means one directory in every execution world.
 *
 * @module dsh-extra-writable-roots/dialects
 */

import { realpathSync } from 'node:fs';

/** The confinement dialects this plugin knows how to widen. */
export type RunnerDialect = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl' | 'unknown';

/** The separator every local runner invocation places before the wrapped command argv. */
const SEPARATOR = '--';

/** One widening attempt. */
export interface Widening {
	/** The argv to spawn: widened, or the caller's argv unchanged when nothing applied. */
	argv: readonly string[];
	/** Which dialect the wrapped argv speaks. */
	dialect: RunnerDialect;
	/** Whether every requested root was added. */
	applied: boolean;
}

/** Index of the argv separator, or -1 when the wrapped argv carries none. */
function separatorIndex(argv: readonly string[]): number {
	for (let index = argv.length - 1; index >= 0; index -= 1) {
		if (argv[index] === SEPARATOR) return index;
	}
	return -1;
}

/** Lexical profile arguments (everything before the separator), or the whole argv when it has none. */
function profileOf(argv: readonly string[]): readonly string[] {
	const at = separatorIndex(argv);
	return at === -1 ? argv : argv.slice(0, at);
}

/**
 * Recognize the runner dialect of one wrapped argv. Detection is by the
 * profile flag spellings each dialect owns, never by the program name alone:
 * the operator-configured `runnerCommand` override receives bwrap-shaped
 * profile arguments under an arbitrary program path.
 * @param argv - a `SandboxProvider.confine` result.
 * @returns the dialect name, or `unknown` for a wrapper this plugin cannot widen.
 */
export function detectDialect(argv: readonly string[]): RunnerDialect {
	const profile = profileOf(argv);
	if (profile.some((argument) => argument === '--ro-bind' || argument === '--bind' || argument === '--tmpfs')) return 'bwrap';
	if (profile.some((argument) => argument === '--ro' || argument === '--rw')) return 'landlock';
	const program = argv[0] ?? '';
	if (/(^|[/\\])sandbox-exec$/u.test(program)) return 'seatbelt';
	if (profile.some((argument) => argument.includes('windows-acl'))) return 'windows-acl';
	return 'unknown';
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
	return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/** The spelling mount comparison should use; the raw path when it cannot be resolved. */
function canonicalSpelling(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * Whether a runner's mount target names the directory a canonical root names.
 * The shipped bwrap profile spells `/tmp` literally while a configured root has
 * already been canonicalized, so both spellings are compared.
 * @param target - the mount target exactly as the runner's profile spells it.
 * @param root - one canonical configured root.
 * @returns whether the two name the same directory.
 */
function namesSameRoot(target: string, root: string): boolean {
	return target === root || canonicalSpelling(target) === root;
}

/**
 * Drop the runner's own ephemeral mount for every path this deployment
 * declares writable, so the recursive read-only bind of `/` supplies the host
 * directory that the following `--bind` then makes writable. Without this, a
 * declared `/tmp` would bind the runner's fresh `--tmpfs /tmp` onto itself and
 * stay a per-call throwaway.
 * @param profile - the runner's profile arguments (everything before the separator).
 * @param roots - canonical configured roots.
 * @returns the profile arguments with those ephemeral mounts removed.
 */
function dropEphemeralMounts(profile: readonly string[], roots: readonly string[]): string[] {
	const kept: string[] = [];
	for (let index = 0; index < profile.length; index += 1) {
		const argument = profile[index];
		const target = profile[index + 1];
		if (argument === '--tmpfs' && target !== undefined && roots.some((root) => namesSameRoot(target, root))) {
			index += 1;
			continue;
		}
		if (argument !== undefined) kept.push(argument);
	}
	return kept;
}

/**
 * Append one `(allow file-write* (subpath …))` form per root to a Seatbelt
 * profile argument. SBPL accumulates rules, so appending to the profile the
 * runner already built is exactly equivalent to having built it wider.
 * @param argv - the wrapped argv.
 * @param at - separator index.
 * @param roots - canonical roots to allow.
 * @returns the widened argv, or `undefined` when no `-p <profile>` pair exists.
 */
function widenSeatbeltProfile(argv: readonly string[], at: number, roots: readonly string[]): readonly string[] | undefined {
	const flag = argv.indexOf('-p');
	if (flag === -1 || flag + 1 >= at) return undefined;
	const profile = argv[flag + 1];
	if (profile === undefined) return undefined;
	const forms = roots.map((root) => `(subpath ${sbplString(root)})`).join(' ');
	const widened = [...argv];
	widened[flag + 1] = `${profile} (allow file-write* ${forms})`;
	return widened;
}

/**
 * Widen one wrapped argv by the extra writable roots, in the dialect it speaks.
 * @param argv - the exact argv a sandbox provider returned for the call.
 * @param roots - canonical extra roots; an empty list is a no-op that reports success.
 * @returns the argv to spawn plus whether the widening applied.
 */
export function widenArgv(argv: readonly string[], roots: readonly string[]): Widening {
	const dialect = detectDialect(argv);
	if (roots.length === 0) return { argv, dialect, applied: true };
	const at = separatorIndex(argv);
	if (at === -1) return { argv, dialect, applied: false };
	switch (dialect) {
		case 'bwrap': {
			const profile = dropEphemeralMounts(argv.slice(0, at), roots);
			const mounts = roots.flatMap((root) => ['--bind', root, root]);
			return { argv: [...profile, ...mounts, ...argv.slice(at)], dialect, applied: true };
		}
		case 'landlock': {
			const grants = roots.flatMap((root) => ['--rw', root]);
			return { argv: [...argv.slice(0, at), ...grants, ...argv.slice(at)], dialect, applied: true };
		}
		case 'seatbelt': {
			const widened = widenSeatbeltProfile(argv, at, roots);
			return widened === undefined ? { argv, dialect, applied: false } : { argv: widened, dialect, applied: true };
		}
		case 'windows-acl':
		case 'unknown':
			return { argv, dialect, applied: false };
	}
}
