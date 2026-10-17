// Exercises the built lib/, not the sources.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptSops, parseSopsDocument, parseSopsRecord } from '../lib/index.js';

test('admits addressable string references and ignores the rest', () => {
	const document = parseSopsDocument(
		JSON.stringify({
			DEEPSEEK_API_KEY: 'sk-live',
			KAGI_SEARCH_API_KEY: 'kagi-live',
			github_token: 'pat-live',
			EMPTY: '',
			NOT_A_STRING: 42,
			'nested map': { a: 'b' },
			sops: { version: '3.13.3' },
		}),
	);
	assert.deepEqual(
		document.entries.map((entry) => entry.name).sort(),
		['DEEPSEEK_API_KEY', 'KAGI_SEARCH_API_KEY', 'github_token'],
	);
	assert.deepEqual(document.skipped.sort(), ['EMPTY', 'NOT_A_STRING', 'nested map']);
});

test('admits records and skips malformed ones', () => {
	const document = parseSopsDocument(
		JSON.stringify({
			DEEPSEEK_API_KEY: 'sk-live',
			records: {
				'client-connection/browser-session': { kind: 'grant', payload: { version: 1, secret: 's' } },
				'llm-pi-ai/openrouter': { kind: 'api-key', key: 'sk-or' },
				'no-slash': { kind: 'grant', payload: {} },
				'owner/bad-kind': { kind: 'nope' },
				'owner/no-payload': { kind: 'grant' },
			},
		}),
	);
	assert.deepEqual(
		document.records.map((entry) => entry.key).sort(),
		['client-connection/browser-session', 'llm-pi-ai/openrouter'],
	);
	assert.deepEqual(document.skipped.sort(), [
		'records.no-slash',
		'records.owner/bad-kind',
		'records.owner/no-payload',
	]);
	assert.equal(document.records[0]?.record.kind, 'grant');
});

test('validates record shapes', () => {
	assert.equal(parseSopsRecord({ kind: 'grant' }), undefined);
	assert.deepEqual(parseSopsRecord({ kind: 'grant', payload: null }), { kind: 'grant', payload: null });
	assert.deepEqual(parseSopsRecord({ kind: 'api-key', key: 'sk', env: { A: 'b' } }), {
		kind: 'api-key',
		key: 'sk',
		env: { A: 'b' },
	});
	assert.equal(parseSopsRecord({ kind: 'api-key', env: { A: 1 } }), undefined);
	assert.equal(parseSopsRecord('nope'), undefined);
});

test('rejects a document that is not an object', () => {
	assert.throws(() => parseSopsDocument('[]'), /not a JSON object/);
	assert.throws(() => parseSopsDocument('"scalar"'), /not a JSON object/);
	assert.throws(() => parseSopsDocument('not json'), SyntaxError);
});

test('decrypts through the configured binary without writing a file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-sops-test-'));
	try {
		const binary = join(dir, 'fake-sops');
		await writeFile(binary, '#!/bin/sh\nprintf %s \'{"OPENROUTER_API_KEY":"or-live"}\'\n', 'utf8');
		await chmod(binary, 0o755);
		const text = await decryptSops(binary, join(dir, 'secrets.sops.yaml'), undefined, 5_000);
		assert.equal(text, '{"OPENROUTER_API_KEY":"or-live"}');
		assert.deepEqual(parseSopsDocument(text).entries, [
			{ name: 'OPENROUTER_API_KEY', value: 'or-live' },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reports a failing decryption instead of an empty document', async () => {
	await assert.rejects(
		decryptSops('/bin/false', '/nonexistent/secrets.sops.yaml', undefined, 5_000),
	);
});
