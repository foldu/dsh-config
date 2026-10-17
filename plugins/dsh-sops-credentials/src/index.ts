/**
 * SOPS-backed credential references for the DeepSeek Harness credential seam.
 *
 * The provider is the shipped file-backed store plus one read-only layer above
 * it: every `CredentialRef` defined in an age-encrypted SOPS document resolves
 * from that document, and everything else — writable keys, OAuth grants, sign-in
 * records — keeps working exactly as before. The document is decrypted **once at
 * startup** (`sops -d --output-type json`) into this process's memory and
 * re-decrypted in place when it changes, so no plaintext secret is ever written
 * to disk by this plugin.
 *
 * Layering, most trusted first, matching the shipped store's doctrine:
 *
 * ```text
 * inherited process environment   (read-only, wins — a per-run override)
 * > sops document                 (read-only, this plugin)
 * > $DSH_HOME/.credentials.yaml   (provider-managed, writable)
 * > <invocation cwd>/.env         (read-only fallback)
 * > $DSH_HOME/.env                (read-only fallback)
 * ```
 *
 * A reference the SOPS document defines is reported as `source: 'sops'` and
 * non-writable: `set`/`unset` refuse it, because a write into the lower store
 * would appear to succeed while resolution kept returning the document's value.
 * Edit the document with `sops <file>` instead.
 *
 * Why subclass the local provider rather than layer a second service: the seam
 * exposes exactly one `credentials` service, and records (rotating grants) must
 * keep the local store's locking and atomic writes. Only the reference half is
 * overridden.
 *
 * @module dsh-sops-credentials
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import {
	CredentialProvider,
	credentialRef,
	isCredentialRefName,
	parseCredentialKey,
} from '@deepseek-ai/dsh-credentials';
import type {
	CredentialInfo,
	CredentialKey,
	CredentialRecord,
	CredentialRecordEntry,
	CredentialRecordInfo,
	CredentialRef,
	ResolvedCredential,
} from '@deepseek-ai/dsh-credentials';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import type { Config as LocalConfig } from '@deepseek-ai/dsh-credentials-local';
import z from '@deepseek-ai/schemastery';
import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Largest decrypted SOPS document this provider accepts, in bytes. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Default SOPS executable looked up on `PATH`. */
export const DEFAULT_SOPS_BINARY = 'sops';

/** Default sops file watch debounce, in milliseconds. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 250;

/** Default bound on one `sops` decryption run, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Plugin config: the local store's fields plus the SOPS document. */
export interface Config extends LocalConfig {
	/**
	 * The SOPS document whose string values answer credential references.
	 * Required: an absolute path, normally `$DSH_HOME/secrets.sops.yaml`.
	 */
	sopsFile: string;
	/** SOPS executable; defaults to `sops` on `PATH`. */
	sopsBinary?: string;
	/** Re-decrypt when the document changes on disk; defaults to true. */
	sopsWatch?: boolean;
	/** SOPS watcher write-settle window in milliseconds; defaults to 250. */
	sopsDebounceMs?: number;
	/** Age identity file passed as `SOPS_AGE_KEY_FILE`; defaults to SOPS's own discovery. */
	ageKeyFile?: string;
	/** Bound on one decryption run in milliseconds; defaults to 15000. */
	timeoutMs?: number;
	/** Fail the mount when the document cannot be decrypted; defaults to false. */
	required?: boolean;
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
	path: z.string(),
	dshHome: z.string(),
	watch: z.boolean().default(true),
	debounceMs: z.number().min(0).default(100),
	sopsFile: z.string(),
	sopsBinary: z.string().default(DEFAULT_SOPS_BINARY),
	sopsWatch: z.boolean().default(true),
	sopsDebounceMs: z.number().min(0).default(DEFAULT_WATCH_DEBOUNCE_MS),
	ageKeyFile: z.string(),
	timeoutMs: z.number().min(0).default(DEFAULT_TIMEOUT_MS),
	required: z.boolean().default(false),
});

/** One entry the parser admitted from the decrypted document. */
export interface SopsRefEntry {
	/** The reference name (a POSIX shell identifier). */
	name: string;
	/** The secret value. */
	value: string;
}

/** One stored record admitted from the decrypted document. */
export interface SopsRecordEntry {
	/** The record address, `<scope>/<id>`. */
	key: string;
	/** The record value. */
	record: CredentialRecord;
}

/** The parts of a decrypted document this provider can use. */
export interface SopsDocument {
	/** Admitted reference entries. */
	entries: SopsRefEntry[];
	/** Admitted record entries from the top-level `records` map. */
	records: SopsRecordEntry[];
	/**
	 * Top-level names the parser skipped: values that are not strings, and
	 * names that are not addressable as a credential reference. Reported by
	 * name only — a value never reaches a diagnostic.
	 */
	skipped: string[];
}

/**
 * Narrow one parsed JSON value to a plain record.
 * @param value - the value to inspect.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one record value from the document.
 *
 * The shape is the seam's own `CredentialRecord`; anything else is refused so a
 * typo reads as a skipped entry instead of a half-applied credential.
 * @param value - the candidate record.
 * @returns the record, or `undefined` when the shape is not one.
 */
export function parseSopsRecord(value: unknown): CredentialRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === 'grant') {
		if (!('payload' in value)) return undefined;
		return { kind: 'grant', payload: value.payload };
	}
	if (value.kind === 'api-key') {
		const key = typeof value.key === 'string' && value.key.length > 0 ? value.key : undefined;
		let env: Record<string, string> | undefined;
		if (isRecord(value.env)) {
			env = {};
			for (const [name, entry] of Object.entries(value.env)) {
				if (typeof entry !== 'string') return undefined;
				env[name] = entry;
			}
		}
		return {
			kind: 'api-key',
			...(key === undefined ? {} : { key }),
			...(env === undefined ? {} : { env }),
		};
	}
	return undefined;
}

/**
 * Split a decrypted SOPS document (JSON text) into references and records.
 *
 * Every top-level string whose name is an addressable `CredentialRef` becomes a
 * reference entry; empty strings are dropped because the seam treats an empty
 * value as absent. A top-level `records` map carries durable records, keyed by
 * the seam's `<scope>/<id>` address. Nested structures, malformed records, and
 * non-string scalars are skipped and named, never guessed at, so a mis-shaped
 * document cannot silently shadow a credential.
 * @param text - decrypted document text, as JSON.
 * @returns the admitted entries, records, and skipped names.
 * @throws when the text is not a JSON object — the caller keeps its last good
 * snapshot and reports the failure.
 */
export function parseSopsDocument(text: string): SopsDocument {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error('the decrypted document is not a JSON object');
	const entries: SopsRefEntry[] = [];
	const records: SopsRecordEntry[] = [];
	const skipped: string[] = [];
	for (const [name, value] of Object.entries(parsed)) {
		if (name === 'sops') continue;
		if (name === 'records') {
			if (!isRecord(value)) {
				skipped.push(name);
				continue;
			}
			for (const [address, candidate] of Object.entries(value)) {
				const record = parseSopsRecord(candidate);
				if (record === undefined) {
					skipped.push(`${name}.${address}`);
					continue;
				}
				try {
					parseCredentialKey(address);
				} catch {
					skipped.push(`${name}.${address}`);
					continue;
				}
				records.push({ key: address, record });
			}
			continue;
		}
		if (typeof value !== 'string' || value.length === 0 || !isCredentialRefName(name)) {
			skipped.push(name);
			continue;
		}
		entries.push({ name, value });
	}
	return { entries, records, skipped };
}

/**
 * Run one `sops -d` and return its JSON output.
 *
 * The decrypted document reaches this process through the child's stdout pipe:
 * no temporary file, no environment copy, and the child's argument list carries
 * only the document path.
 * @param binary - the SOPS executable.
 * @param file - the document to decrypt.
 * @param ageKeyFile - optional `SOPS_AGE_KEY_FILE` override.
 * @param timeoutMs - bound on the run.
 * @returns the decrypted document text.
 */
export function decryptSops(
	binary: string,
	file: string,
	ageKeyFile: string | undefined,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolveText, reject) => {
		execFile(
			binary,
			['-d', '--output-type', 'json', file],
			{
				encoding: 'utf8',
				maxBuffer: MAX_DOCUMENT_BYTES,
				timeout: timeoutMs,
				...(ageKeyFile === undefined ? {} : { env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile } }),
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolveText(stdout);
			},
		);
	});
}

/**
 * Structural equality over two records; `undefined` equals only `undefined`.
 * @param left - one record.
 * @param right - the other.
 * @returns whether both carry the same JSON content.
 */
function sameRecord(left: CredentialRecord | undefined, right: CredentialRecord | undefined): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A file-backed credential provider layered with an in-memory SOPS document.
 *
 * References resolve from the environment first (a per-run override cannot be
 * edited from inside and must stay visible), then the SOPS document, then the
 * shipped store and its `.env` fallbacks. Records are inherited untouched.
 */
export class SopsCredentialProvider extends LocalCredentialProvider {
	static override Config: z<LocalConfig> = Config as unknown as z<LocalConfig>;

	/** Decrypted reference snapshot, keyed by reference name. */
	private sopsValues = new Map<string, string>();

	/** Decrypted record snapshot, keyed by `<scope>/<id>`. */
	private sopsRecords = new Map<string, CredentialRecord>();

	/** Raw text of the last decrypted document; reloads that yield the same text are no-ops. */
	private sopsText: string | undefined;

	/** Whether at least one decryption has succeeded in this lifetime. */
	private sopsLoaded = false;

	/** Pending debounced reload timer, if any. */
	private sopsTimer: ReturnType<typeof setTimeout> | undefined;

	/** Live directory watcher, if watching is enabled. */
	private sopsWatcher: FSWatcher | undefined;

	constructor(ctx: Context, config: Config) {
		super(ctx, config);
	}

	/** The plugin config, narrowed to this provider's own shape. */
	private get sopsConfig(): Config {
		return this.config as Config;
	}

	/** The document path this provider serves. */
	get sopsFile(): string {
		return this.sopsConfig.sopsFile;
	}

	/** Whether the document defines this reference. */
	private owns(ref: CredentialRef): boolean {
		const value = this.sopsValues.get(ref);
		return value !== undefined && value.length > 0;
	}

	override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
		const inherited = await super.resolve(ref);
		if (inherited?.source === 'env') return inherited;
		if (this.owns(ref)) return { value: this.sopsValues.get(ref) as string, source: 'sops' };
		return inherited;
	}

	override async describe(ref: CredentialRef): Promise<CredentialInfo> {
		const inherited = await super.describe(ref);
		if (inherited.source === 'env') return inherited;
		if (this.owns(ref)) return { configured: true, source: 'sops', writable: false };
		return inherited;
	}

	override async set(ref: CredentialRef, value: string): Promise<void> {
		if (this.owns(ref)) this.refuseWrite(ref);
		await super.set(ref, value);
	}

	override async unset(ref: CredentialRef): Promise<void> {
		if (this.owns(ref)) this.refuseWrite(ref);
		await super.unset(ref);
	}

	override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
		const stored = this.sopsRecords.get(key);
		if (stored !== undefined) return stored;
		return super.readRecord(key);
	}

	override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
		const stored = this.sopsRecords.get(key);
		if (stored !== undefined) return { configured: true, kind: stored.kind, writable: false };
		return super.describeRecord(key);
	}

	override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
		const inherited = await super.listRecords();
		const fromSops: CredentialRecordEntry[] = [...this.sopsRecords].map(([key, record]) => ({
			key: key as CredentialKey,
			kind: record.kind,
		}));
		const shadowed = new Set(fromSops.map((entry) => entry.key));
		return [...fromSops, ...inherited.filter((entry) => !shadowed.has(entry.key))];
	}

	/**
	 * Read-modify-write over a record the document owns.
	 *
	 * The mutation still runs, because the answer decides whether anything needs
	 * writing: a caller that creates a record only when none exists returns
	 * `undefined` and keeps working against the document's value. A caller that
	 * really wants to replace one is refused — this file is not a write target.
	 */
	override async modifyRecord(
		key: CredentialKey,
		mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
	): Promise<CredentialRecord | undefined> {
		const stored = this.sopsRecords.get(key);
		if (stored === undefined) return super.modifyRecord(key, mutate);
		const next = await mutate(stored);
		if (next === undefined) return stored;
		throw new Error(
			`sops-credentials: record "${key}" is defined in ${this.sopsFile}; edit that document ` +
				'(sops ' + this.sopsFile + ') instead of the credential store',
		);
	}

	override async deleteRecord(key: CredentialKey): Promise<void> {
		if (this.sopsRecords.has(key)) {
			throw new Error(
				`sops-credentials: record "${key}" is defined in ${this.sopsFile}; edit that document ` +
					'(sops ' + this.sopsFile + ') instead of the credential store',
			);
		}
		await super.deleteRecord(key);
	}

	/** Refuse a write the SOPS layer would shadow, naming the file and the fix. */
	private refuseWrite(ref: CredentialRef): never {
		throw new Error(
			`sops-credentials: "${ref}" is defined in ${this.sopsFile}; edit that document ` +
				'(sops ' + this.sopsFile + ') instead of the credential store',
		);
	}

	override async *[Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
		try {
			await this.reloadSops('startup');
		} catch (error) {
			if (this.sopsConfig.required === true) throw error;
			this.warn('could not decrypt %s at startup', this.sopsFile, error);
		}
		yield* super[Service.init]();
		if (this.sopsConfig.sopsWatch !== false) this.startWatching();
		yield () => this.stopWatching();
	}

	/** Report a contained failure without ever including a secret value. */
	private warn(message: string, ...args: unknown[]): void {
		this.ctx.logger.warn(`sops-credentials: ${message}`, ...args);
	}

	/**
	 * Decrypt the document and replace the in-memory snapshot.
	 *
	 * A read that yields the same document text as the previous one is a no-op,
	 * which keeps `sops edit` rewrites that changed only formatting from
	 * fanning out reference updates. A failed read leaves the previous snapshot
	 * serving; only the diagnostic changes.
	 * @param reason - why the reload ran, for the diagnostic.
	 */
	private async reloadSops(reason: string): Promise<void> {
		const config = this.sopsConfig;
		const text = await decryptSops(
			config.sopsBinary ?? DEFAULT_SOPS_BINARY,
			config.sopsFile,
			config.ageKeyFile,
			config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		if (this.sopsLoaded && text === this.sopsText) return;
		const document = parseSopsDocument(text);
		const previous = this.sopsValues;
		const previousRecords = this.sopsRecords;
		const next = new Map<string, string>();
		for (const entry of document.entries) next.set(entry.name, entry.value);
		const nextRecords = new Map<string, CredentialRecord>();
		for (const entry of document.records) nextRecords.set(entry.key, entry.record);
		this.sopsText = text;
		this.sopsValues = next;
		this.sopsRecords = nextRecords;
		this.sopsLoaded = true;
		if (document.skipped.length > 0) {
			this.warn(
				'skipped %d unusable entr%s in %s (names: %s)',
				document.skipped.length,
				document.skipped.length === 1 ? 'y' : 'ies',
				config.sopsFile,
				document.skipped.join(', '),
			);
		}
		this.ctx.logger.info(
			`sops-credentials: %s loaded %d reference(s) and %d record(s) from %s`,
			reason,
			next.size,
			nextRecords.size,
			config.sopsFile,
		);
		for (const name of new Set([...previous.keys(), ...next.keys()])) {
			if (previous.get(name) !== next.get(name)) this.notifyUpdated(credentialRef(name));
		}
		for (const key of new Set([...previousRecords.keys(), ...nextRecords.keys()])) {
			if (!sameRecord(previousRecords.get(key), nextRecords.get(key))) {
				this.notifyRecordUpdated(key as CredentialKey);
			}
		}
	}

	/** Watch the document's directory, so an atomic replace is noticed. */
	private startWatching(): void {
		const file = this.sopsFile;
		const target = basename(file);
		try {
			this.sopsWatcher = watch(dirname(file), { persistent: false }, (_event, filename) => {
				if (filename !== null && filename !== target) return;
				this.scheduleReload();
			});
			this.sopsWatcher.on('error', (error) => {
				this.warn('watcher error on %s', file, error);
			});
		} catch (error) {
			this.warn('could not watch %s', file, error);
		}
	}

	/** Debounce a filesystem event into one reload. */
	private scheduleReload(): void {
		if (this.sopsTimer !== undefined) clearTimeout(this.sopsTimer);
		this.sopsTimer = setTimeout(() => {
			this.sopsTimer = undefined;
			this.reloadSops('reload').catch((error: unknown) => {
				this.warn('could not re-decrypt %s; keeping the previous snapshot', this.sopsFile, error);
			});
		}, this.sopsConfig.sopsDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
		this.sopsTimer.unref?.();
	}

	/** Stop watching and cancel a pending reload. */
	private stopWatching(): void {
		if (this.sopsTimer !== undefined) {
			clearTimeout(this.sopsTimer);
			this.sopsTimer = undefined;
		}
		this.sopsWatcher?.close();
		this.sopsWatcher = undefined;
	}
}

export { CredentialProvider, LocalCredentialProvider };
export default SopsCredentialProvider;
