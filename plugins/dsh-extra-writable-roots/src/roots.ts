/**
 * Canonicalization of the deployment's extra writable roots and the
 * containment test both enforcing halves share.
 *
 * The file sandbox expresses `workspace-write` as a canonical allow-list
 * (`{@link https://www.npmjs.com/package/@deepseek-ai/dsh-sandbox writableRoots}`:
 * the workspace root plus the platform temp areas). This module derives the
 * *extra* entries the same way — `~` expanded, absolute, existing, symlinks
 * resolved — so the process runner's bind set and the filesystem fence's
 * containment check compare exactly the spellings their own canonicalization
 * produces.
 *
 * @module dsh-extra-writable-roots/roots
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
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

/**
 * Resolve configured entries into the canonical, existing directories the
 * sandbox may grant. Failing loud is deliberate: a nonexistent or relative
 * entry would otherwise silently grant nothing and look like a sandbox bug.
 * @param entries - the configured roots, in user order.
 * @returns canonical absolute paths, deduplicated, in first-seen order.
 */
export function resolveWritableRoots(entries: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const entry of entries) {
		const expanded = expandHome(entry.trim());
		if (expanded.length === 0) throw new Error('extra-writable-roots: a writablePaths entry is empty');
		if (!isAbsolute(expanded)) {
			throw new Error(`extra-writable-roots: "${entry}" must be an absolute path or start with "~/"`);
		}
		if (!existsSync(expanded)) throw new Error(`extra-writable-roots: "${entry}" does not exist`);
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

	/**
	 * @param read - reads the current configured entries; called on every access.
	 * @param onError - reports a live edit that no longer resolves; the set fails closed to empty.
	 */
	constructor(read: () => readonly string[], onError: (error: Error) => void) {
		this.read = read;
		this.onError = onError;
	}

	/**
	 * The current canonical roots, re-resolved when the configuration changed.
	 * A configuration that stops resolving grants nothing rather than a stale
	 * set, so a live edit can only narrow the sandbox.
	 */
	get value(): readonly string[] {
		const entries = this.read();
		const key = JSON.stringify(entries);
		if (key === this.key) return this.roots;
		this.key = key;
		try {
			this.roots = resolveWritableRoots(entries);
		} catch (error) {
			this.roots = [];
			this.onError(error instanceof Error ? error : new Error(String(error)));
		}
		return this.roots;
	}
}
