/**
 * Canonicalization of the deployment's extra writable roots and the
 * containment test both enforcing halves share.
 *
 * The file sandbox expresses `workspace-write` as a canonical allow-list
 * (`{@link https://www.npmjs.com/package/@deepseek-ai/dsh-sandbox writableRoots}`:
 * the workspace root plus the platform temp areas). This module derives the
 * *extra* entries the same way — `~` expanded, `$VAR` references expanded,
 * absolute, existing, symlinks resolved — so the process runner's bind set and
 * the filesystem fence's containment check compare exactly the spellings their
 * own canonicalization produces.
 *
 * Two deployment realities shape the resolution rules. A root may be spelled
 * through the environment (`$XDG_RUNTIME_DIR/…`), because a per-login runtime
 * directory is not a fixed path. And a root may be created lazily by the tool
 * that owns it, so the first boot can mount this row before the directory
 * exists; `createMissing` creates such an entry instead of failing the mount,
 * which matters because this plugin is the only sandbox provider the
 * composition mounts.
 *
 * @module dsh-extra-writable-roots/roots
 */

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';

/**
 * Whether this deployment's extra roots are granted under one standing mode.
 *
 * `read-only` denies every mutation by contract, so granting the extra roots
 * there would make the policy layer's model-visible text false — a deployment
 * opts in with `applyInReadOnly` instead. `danger-full-access` needs no grant
 * at all, since the shipped backends already delegate it unfenced.
 *
 * @param mode - the effective per-call sandbox mode.
 * @param applyInReadOnly - whether the deployment opted into the extra roots under `read-only`.
 * @returns whether the extra roots apply to this call.
 */
export function grantsExtraRoots(mode: SandboxMode, applyInReadOnly: boolean): boolean {
	if (mode === 'danger-full-access') return false;
	if (mode === 'read-only') return applyInReadOnly;
	return true;
}

/** The zero-width prefix comparison used by containment, case-folded off win32. */
function comparable(path: string, caseSensitive: boolean): string {
	return caseSensitive ? path : path.toLowerCase();
}

/**
 * Expand a leading `~` (`~` alone, or `~/…`) to the host's home directory.
 * Other spellings — including `~user` — pass through untouched so a typo fails
 * the absolute-path check instead of silently resolving somewhere unexpected.
 * @param entry - one configured root.
 * @returns the entry with a leading `~` expanded.
 */
export function expandHome(entry: string): string {
	if (entry === '~') return homedir();
	if (entry.startsWith(`~${sep}`)) return resolve(homedir(), entry.slice(2));
	return entry;
}

/** The two `$` spellings an entry may use: `$NAME` and `${NAME}`. */
const ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;

/**
 * Expand every `$NAME` and `${NAME}` reference against the environment.
 *
 * A per-login directory such as `$XDG_RUNTIME_DIR` has no fixed path, so the
 * deployment spells it through the environment and this resolves it at the
 * same moment the rest of the entry is canonicalized. An unset or empty
 * variable fails loud with the variable's name: expanding it to the empty
 * string would silently turn the entry into a *different*, possibly broader
 * path — `/pnpm-store-operation-locks-1000` is absolute and would otherwise
 * pass every later check.
 * @param entry - one configured root, with `~` already expanded.
 * @param env - the environment to read; defaults to the process environment.
 * @returns the entry with every reference replaced by its value.
 */
export function expandEnv(entry: string, env: NodeJS.ProcessEnv = process.env): string {
	return entry.replace(ENV_REFERENCE, (match, braced: string | undefined, bare: string | undefined) => {
		const variable = braced ?? bare;
		if (variable === undefined) return match;
		const value = env[variable];
		if (value === undefined || value === '') {
			throw new Error(`extra-writable-roots: the environment variable "${variable}" is unset, so "${entry}" cannot be resolved`);
		}
		return value;
	});
}

/** What one resolution pass may do beyond canonicalizing existing directories. */
export interface ResolveOptions {
	/** The environment `$VAR` references are read from; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Whether a configured root that does not exist yet is created (owner-only,
	 * `0700`) instead of failing the resolution. Intended for a directory the
	 * tool that owns it creates lazily — pnpm's runtime store-lock directory is
	 * created by the first store operation, which on a fresh boot happens after
	 * this row mounts. Defaults to false, which keeps the shipped fail-loud
	 * behavior for a typo.
	 */
	createMissing?: boolean;
}

/**
 * Resolve configured entries into the canonical, existing directories the
 * sandbox may grant. Failing loud is deliberate: a nonexistent or relative
 * entry would otherwise silently grant nothing and look like a sandbox bug.
 * @param entries - the configured roots, in user order.
 * @param options - environment for `$VAR` references, and whether a missing root may be created.
 * @returns canonical absolute paths, deduplicated, in first-seen order.
 */
export function resolveWritableRoots(entries: readonly string[], options: ResolveOptions = {}): string[] {
	const env = options.env ?? process.env;
	const createMissing = options.createMissing ?? false;
	const roots = new Set<string>();
	for (const entry of entries) {
		const expanded = expandEnv(expandHome(entry.trim()), env);
		if (expanded.length === 0) throw new Error('extra-writable-roots: a writablePaths entry is empty');
		if (!isAbsolute(expanded)) {
			throw new Error(`extra-writable-roots: "${entry}" must be an absolute path or start with "~/"`);
		}
		if (!existsSync(expanded)) {
			if (!createMissing) throw new Error(`extra-writable-roots: "${entry}" does not exist`);
			mkdirSync(expanded, { recursive: true, mode: 0o700 });
		}
		if (!statSync(expanded).isDirectory()) throw new Error(`extra-writable-roots: "${entry}" is not a directory`);
		roots.add(realpathSync.native(expanded));
	}
	return [...roots];
}

/**
 * Determine whether a canonical path is `root` or lies beneath it. Both sides
 * come from the same canonicalization (realpath), so the lexical fast path is
 * the complete answer on the supported platforms; the case fold serves the
 * case-insensitive filesystems of win32 and darwin.
 * @param path - canonical candidate path.
 * @param root - canonical writable root.
 * @param caseSensitive - whether the comparison preserves case; defaults to the host filesystem convention.
 * @returns whether the candidate is contained by the root.
 */
export function isUnderRoot(path: string, root: string, caseSensitive = process.platform !== 'win32'): boolean {
	const candidate = comparable(path, caseSensitive);
	const parent = comparable(root, caseSensitive);
	if (candidate === parent) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return candidate.startsWith(prefix);
}

/** A live, canonicalized view over the configured roots. */
export class WritableRootSet {
	private key: string | undefined;
	private roots: readonly string[] = [];
	private readonly read: () => readonly string[];
	private readonly onError: (error: Error) => void;
	private readonly options: () => ResolveOptions;

	/**
	 * @param read - reads the current configured entries; called on every access.
	 * @param onError - reports a live edit that no longer resolves; the set fails closed to empty.
	 * @param options - resolution options, re-read on every access so a live edit applies.
	 */
	constructor(read: () => readonly string[], onError: (error: Error) => void, options: () => ResolveOptions = () => ({})) {
		this.read = read;
		this.onError = onError;
		this.options = options;
	}

	/**
	 * The current canonical roots, re-resolved when the configuration changed.
	 * A configuration that stops resolving grants nothing rather than a stale
	 * set, so a live edit can only narrow the sandbox.
	 *
	 * The cache key covers the entries and the create-missing flag, so a live
	 * edit to either applies. Environment references are read only when a
	 * resolution actually runs — a deployment that changes `XDG_RUNTIME_DIR`
	 * inside one harness process is not a case this plugin claims to support.
	 */
	get value(): readonly string[] {
		const entries = this.read();
		const key = JSON.stringify([entries, this.options().createMissing ?? false]);
		if (key === this.key) return this.roots;
		this.key = key;
		try {
			this.roots = resolveWritableRoots(entries, this.options());
		} catch (error) {
			this.roots = [];
			this.onError(error instanceof Error ? error : new Error(String(error)));
		}
		return this.roots;
	}
}
