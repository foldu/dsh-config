/**
 * The formatting route's request contract: method, content type, body shape,
 * trust fence, and the `enabled: false` short circuit.
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { apply, FORMAT_PATH } from '../lib/index.js';

/** The transform the route's formatter runs, as a node one-liner. */
const TRANSFORM = "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write(s.split(' && ').join(' &&\\n')));";

const volatile = (value) => ({ get: () => value });

/**
 * Mount the plugin on a stand-in context and return the registered route.
 * @param {object} overrides - config overrides for this mount.
 * @param {number | undefined} rejection - status the trust fence returns.
 * @returns {object} the registered route plus the mount context.
 */
function mount(overrides = {}, rejection = undefined) {
	const routes = [];
	const context = {
		effect: (register) => register(),
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {};
			},
		},
		connection: { requestRejection: () => rejection },
	};
	const config = {
		enabled: volatile(true),
		binary: volatile(process.execPath),
		args: volatile(['-e', TRANSFORM]),
		timeoutMs: volatile(5000),
		maxBodyBytes: volatile(1024),
		cacheSize: volatile(8),
		...overrides,
	};
	apply(context, config);
	assert.equal(routes.length, 1);
	const route = routes[0];
	assert.equal(route.path, FORMAT_PATH);
	assert.equal(route.kind, 'exact');
	return { route, context };
}

/**
 * One request carrying an optional JSON body.
 * @param {string} method - HTTP method.
 * @param {string} [body] - raw body text.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {object} a readable request stand-in.
 */
function request(method, body = '', headers = {}) {
	const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
	stream.method = method;
	stream.headers = { 'content-type': 'application/json', ...headers };
	return stream;
}

/** A response stand-in collecting status, headers and body. */
function response() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(key, value) {
			this.headers[key] = value;
		},
		end(chunk) {
			if (typeof chunk === 'string') this.body += chunk;
		},
	};
}

const post = (route, body, headers) => {
	const res = response();
	return Promise.resolve(route.handler(request('POST', body, headers), res)).then(() => res);
};

test('formats a command posted by the client', async () => {
	const { route } = mount();
	const res = await post(route, JSON.stringify({ command: 'cd /tmp && ls -la' }));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { formatted: 'cd /tmp &&\nls -la', applied: true });
});

test('rejects a method the route does not serve', async () => {
	const { route } = mount();
	const res = response();
	await route.handler(request('GET'), res);
	assert.equal(res.statusCode, 405);
	assert.equal(res.headers.allow, 'POST');
});

test('rejects another content type', async () => {
	const { route } = mount();
	const res = await post(route, 'command=ls', { 'content-type': 'text/plain' });
	assert.equal(res.statusCode, 415);
});

test('rejects a malformed or empty payload', async () => {
	const { route } = mount();
	assert.equal((await post(route, 'not json')).statusCode, 400);
	assert.equal((await post(route, JSON.stringify({}))).statusCode, 400);
	assert.equal((await post(route, JSON.stringify({ command: '' }))).statusCode, 400);
	assert.equal((await post(route, JSON.stringify({ command: 7 }))).statusCode, 400);
});

test('refuses a body past the configured ceiling', async () => {
	const { route } = mount({ maxBodyBytes: volatile(16) });
	const res = await post(route, JSON.stringify({ command: 'echo '.repeat(20) }));
	assert.equal(res.statusCode, 413);
});

test('a refused request never reaches the formatter', async () => {
	const { route } = mount({}, 403);
	const res = await post(route, JSON.stringify({ command: 'echo hi && echo there' }));
	assert.equal(res.statusCode, 403);
	assert.equal(res.body, '');
});

test('a disabled plugin answers with the original command', async () => {
	const { route } = mount({
		enabled: volatile(false),
		// A missing binary proves the short circuit happens before formatting.
		binary: volatile('dsh-bash-shfmt-not-a-real-binary'),
	});
	const res = await post(route, JSON.stringify({ command: 'echo hi && echo there' }));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { formatted: 'echo hi && echo there', applied: false });
});

test('a missing binary leaves the command unchanged', async () => {
	const { route } = mount({ binary: volatile('dsh-bash-shfmt-not-a-real-binary') });
	const res = await post(route, JSON.stringify({ command: 'echo hi && echo there' }));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { formatted: 'echo hi && echo there', applied: false });
});
