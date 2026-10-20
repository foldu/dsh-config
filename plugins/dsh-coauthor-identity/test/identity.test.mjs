import assert from 'node:assert/strict';
import test from 'node:test';

import { renderIdentitySection, resolveIdentity } from '../lib/identity.js';

const glm = { name: 'GLM-5.3', email: 'noreply@z.ai' };
const kimi = { name: 'Kimi K3', email: 'noreply@moonshot.ai' };
const fallback = { name: 'AI Agent', email: 'noreply@example.com' };

test('resolveIdentity prefers the provider-qualified pair', () => {
	const map = { 'openrouter/z-ai/glm-5.3': glm, 'z-ai/glm-5.3': kimi };
	assert.deepEqual(resolveIdentity(map, { provider: 'openrouter', model: 'z-ai/glm-5.3' }), glm);
});

test('resolveIdentity falls back to a bare model id for another provider', () => {
	const map = { 'z-ai/glm-5.3': glm };
	assert.deepEqual(resolveIdentity(map, { provider: 'somewhere-else', model: 'z-ai/glm-5.3' }), glm);
});

test('resolveIdentity uses the bare id when no provider is selected', () => {
	const map = { 'z-ai/glm-5.3': glm };
	assert.deepEqual(resolveIdentity(map, { provider: undefined, model: 'z-ai/glm-5.3' }), glm);
});

test('resolveIdentity uses the catch-all only after both exact keys miss', () => {
	const map = { 'openrouter/z-ai/glm-5.3': glm, '*': fallback };
	assert.deepEqual(resolveIdentity(map, { provider: 'openrouter', model: 'z-ai/glm-5.3' }), glm);
	assert.deepEqual(resolveIdentity(map, { provider: 'openrouter', model: 'unknown/model' }), fallback);
});

test('resolveIdentity returns undefined for an unselected or blank model', () => {
	const map = { '*': fallback };
	assert.equal(resolveIdentity(map, { provider: 'deepseek', model: undefined }), undefined);
	assert.equal(resolveIdentity(map, { provider: 'deepseek', model: '   ' }), undefined);
});

test('resolveIdentity skips an unusable entry instead of emitting a broken trailer', () => {
	const map = {
		'deepseek/deepseek-flash': { name: '  ', email: 'noreply@deepseek.com' },
		'deepseek-flash': fallback,
	};
	assert.deepEqual(resolveIdentity(map, { provider: 'deepseek', model: 'deepseek-flash' }), fallback);
	assert.equal(resolveIdentity({ 'deepseek/deepseek-flash': { name: 'A\nB', email: 'x@y' } }, { provider: 'deepseek', model: 'deepseek-flash' }), undefined);
	assert.equal(resolveIdentity({ '*': { name: 'DeepSeek <flash>', email: 'x@y' } }, { provider: 'deepseek', model: 'deepseek-flash' }), undefined);
});

test('resolveIdentity trims the configured name and address', () => {
	assert.deepEqual(
		resolveIdentity({ '*': { name: '  Kimi K3 ', email: ' noreply@moonshot.ai ' } }, { provider: undefined, model: 'kimi-k3' }),
		kimi,
	);
});

test('renderIdentitySection names the selection and the exact trailer', () => {
	const text = renderIdentitySection(glm, { provider: 'openrouter', model: 'z-ai/glm-5.3' });
	assert.match(text, /^You are running as the model selected in this session's UI: GLM-5\.3 \(provider "openrouter", model "z-ai\/glm-5\.3"\)\./u);
	assert.match(text, /Co-authored-by: GLM-5\.3 <noreply@z\.ai>/u);
	assert.match(text, /add the trailer once/u);
});

test('renderIdentitySection names only the identity when no provider is selected', () => {
	const text = renderIdentitySection(kimi, { provider: undefined, model: 'kimi-k3' });
	assert.match(text, /UI: Kimi K3\./u);
	assert.doesNotMatch(text, /provider/u);
});

test('renderIdentitySection leaves no template braces for interpolation', () => {
	const text = renderIdentitySection({ name: 'A {{model}}', email: 'a@b' }, { provider: 'p', model: 'm' });
	assert.match(text, /A \{\{model\}\}/u);
});
