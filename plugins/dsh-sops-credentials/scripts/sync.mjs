#!/usr/bin/env node
/**
 * Promote the harness's plaintext credential store into a profile's SOPS
 * document, then delete the plaintext copy.
 *
 * The SOPS document is read-only to the running harness, which is deliberate:
 * a token refresh cannot re-encrypt a file. So a sign-in or a record the
 * harness writes lands in `$DSH_HOME/.credentials.yaml`; this script moves it
 * into that profile's document (`secrets.<profile>.sops.yaml` — references at
 * the top level, records under `records:`) and removes the plaintext store. Run
 * it after any sign-in, or on a machine whose store predates the SOPS document.
 *
 *   node scripts/sync.mjs [--profile <name>] [--sops <file>] [--store <file>] [--keep-store]
 *
 * `--profile` picks the document (default `web`); `--sops` overrides it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Parse `--flag value` pairs.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {{ sops?: string, store?: string, profile?: string, keepStore: boolean }}
 */
function parseArgs(argv) {
	const options = { keepStore: false };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === '--keep-store') options.keepStore = true;
		else if (flag === '--sops' || flag === '--store' || flag === '--profile') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			if (flag === '--sops') options.sops = value;
			else if (flag === '--store') options.store = value;
			else options.profile = value;
			index += 1;
		} else throw new Error(`unknown argument: ${flag}`);
	}
	return options;
}

/** Absolute path of this machine's harness home. */
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
/**
 * The credential document a profile mounts. Each profile names its own, so the
 * selection is the profile name — no file is shadowed by another's presence.
 * `--profile` (or `--sops`) overrides the default, and selecting the wrong one
 * would merge this machine's store into another profile's document.
 * @returns {string} absolute path to the document to merge into.
 */
function documentForProfile(profile) {
	return join(dshHome, `secrets.${profile}.sops.yaml`);
}
const options = parseArgs(process.argv.slice(2));
const sopsFile = resolve(options.sops ?? documentForProfile(options.profile ?? 'web'));
const storeFile = resolve(options.store ?? join(dshHome, '.credentials.yaml'));

/** Report progress without ever printing a value. */
function note(message) {
	process.stdout.write(`secrets-sync: ${message}\n`);
}

/**
 * Decrypt the SOPS document, or return an empty document when it is absent.
 * @returns {Promise<Record<string, unknown>>} the decrypted document.
 */
async function readDocument() {
	try {
		await stat(sopsFile);
	} catch {
		note(`${sopsFile} does not exist yet; creating it`);
		return {};
	}
	const text = execFileSync('sops', ['-d', '--output-type', 'json', sopsFile], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
	const parsed = JSON.parse(text);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${sopsFile} did not decrypt to a JSON object`);
	}
	return parsed;
}

/**
 * Read the plaintext store, or `undefined` when the harness has none.
 * @returns {Promise<{ refs?: Record<string, string>, records?: Record<string, unknown> } | undefined>}
 */
async function readStore() {
	let text;
	try {
		text = await readFile(storeFile, 'utf8');
	} catch {
		return undefined;
	}
	const parsed = YAML.parse(text);
	if (typeof parsed !== 'object' || parsed === null) throw new Error(`${storeFile} is not a mapping`);
	return parsed;
}

const document = await readDocument();
const store = await readStore();
if (store === undefined) {
	note(`no ${storeFile}; nothing to promote`);
	process.exit(0);
}

const refs = store.refs ?? {};
const records = store.records ?? {};
let changed = 0;
for (const [name, value] of Object.entries(refs)) {
	if (typeof value !== 'string' || value.length === 0) continue;
	if (document[name] === value) continue;
	document[name] = value;
	changed += 1;
}
if (Object.keys(records).length > 0) {
	const merged = { ...(typeof document.records === 'object' && document.records !== null ? document.records : {}), ...records };
	if (JSON.stringify(merged) !== JSON.stringify(document.records ?? {})) {
		document.records = merged;
		changed += 1;
	}
}

if (changed === 0) {
	note('the document already holds every entry the store has');
} else {
	const directory = await mkdtemp(join(tmpdir(), 'dsh-secrets-sync-'));
	try {
		const encrypted = execFileSync(
			'sops',
			['encrypt', '--input-type', 'json', '--output-type', 'yaml', '--filename-override', sopsFile],
			{ input: JSON.stringify(document), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
		);
		const staged = join(directory, 'secrets.sops.yaml');
		await writeFile(staged, encrypted, { mode: 0o600 });
		await rename(staged, sopsFile);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	note(`wrote ${sopsFile} (${String(Object.keys(refs).length)} reference(s), ${String(Object.keys(records).length)} record(s))`);
}

if (options.keepStore) {
	note(`kept ${storeFile} as asked; delete it once the harness confirms the values`);
} else {
	await rm(storeFile, { force: true });
	note(`removed ${storeFile}; the harness now reads everything from ${sopsFile}`);
}
