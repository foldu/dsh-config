/**
 * Provider tests for dsh-web-search-kagi.
 *
 * The tests exercise the built package, and its peer dependencies resolve from
 * this package's own devDependencies, so the whole suite is self-contained:
 *
 *   pnpm install && pnpm test      # `pretest` rebuilds lib/ first
 *
 * Every test runs against a local HTTP server, so no Kagi key or network
 * access is required.
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { KagiSearchProvider, KAGI_PROVIDER_ID, apply } from '../lib/index.js';

/** Start a throwaway HTTP server; `handler(request, body)` returns the response. */
async function startServer(handler) {
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString('utf8');
		let body;
		try {
			body = text.length === 0 ? undefined : JSON.parse(text);
		} catch {
			body = undefined;
		}
		const result = await handler(request, body, text);
		response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
		response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** Build a provider over one fixed options object. */
function makeProvider(options) {
	return new KagiSearchProvider(() => ({
		apiKey: 'test-key',
		apiKeyEnv: 'KAGI_SEARCH_API_KEY',
		baseURL: 'http://127.0.0.1:1',
		limit: 10,
		workflow: 'search',
		safeSearch: true,
		timeoutMs: 5000,
		...options,
	}));
}

const SAMPLE = {
	meta: { trace: 'abc', ms: 12 },
	data: {
		search: [
			{ url: 'https://example.com/a', title: 'A', snippet: 'first', time: '2024-11-29T03:54:26Z' },
			{ url: 'https://example.com/b', title: 'B' },
			{ url: 'https://example.com/a', title: 'duplicate' },
			{ url: '   ', title: 'blank url' },
			{ url: 'https://example.com/c', title: '', snippet: '   ' },
		],
	},
};

test('registers under the stable provider id with a network-free availability check', async () => {
	const server = await startServer(() => {
		throw new Error('available() must not call the network');
	});
	try {
		const provider = makeProvider({ baseURL: server.url });
		assert.equal(provider.id, KAGI_PROVIDER_ID);
		assert.equal(KAGI_PROVIDER_ID, 'kagi');
		assert.equal(provider.available(), true);
		assert.equal(makeProvider({ baseURL: 'not a url' }).available(), false);
		assert.equal(makeProvider({ limit: 0 }).available(), false);
		assert.equal(makeProvider({ timeoutMs: 0 }).available(), false);
	} finally {
		await server.close();
	}
});

test('posts the documented body with bearer auth and maps data.search[]', async () => {
	let seen;
	const server = await startServer((request, body) => {
		seen = { method: request.method, url: request.url, headers: request.headers, body };
		return { body: SAMPLE };
	});
	try {
		const provider = makeProvider({ baseURL: server.url, limit: 5 });
		const result = await provider.search({ query: '  steve jobs  ', maxResults: 8 });
		assert.equal(seen.method, 'POST');
		assert.equal(seen.url, '/search');
		assert.equal(seen.headers.authorization, 'Bearer test-key');
		assert.equal(seen.headers['content-type'], 'application/json');
		assert.deepEqual(seen.body, {
			query: 'steve jobs',
			workflow: 'search',
			format: 'json',
			limit: 5,
			safe_search: true,
		});
		assert.deepEqual(result, {
			sources: [
				{ url: 'https://example.com/a', title: 'A', snippet: 'first', publishedAt: '2024-11-29T03:54:26Z' },
				{ url: 'https://example.com/b', title: 'B' },
				{ url: 'https://example.com/c' },
			],
			truncated: false,
		});
	} finally {
		await server.close();
	}
});

test('sends the seam bound when it is smaller than the configured limit', async () => {
	let seen;
	const server = await startServer((request, body) => {
		seen = body;
		return { body: SAMPLE };
	});
	try {
		await makeProvider({ baseURL: server.url, limit: 20 }).search({ query: 'q', maxResults: 3 });
		assert.equal(seen.limit, 3);
		await makeProvider({ baseURL: server.url, limit: 4 }).search({ query: 'q', maxResults: 9 });
		assert.equal(seen.limit, 4);
		await makeProvider({ baseURL: server.url, limit: 4 }).search({ query: 'q' });
		assert.equal(seen.limit, 4);
	} finally {
		await server.close();
	}
});

test('honors workflow and safeSearch, and falls back to other result groups', async () => {
	let seen;
	const server = await startServer((request, body) => {
		seen = body;
		return {
			body: {
				data: {
					search: [],
					news: [{ url: 'https://news.example/x', title: 'X', time: '2025-01-02T00:00:00Z' }],
				},
			},
		};
	});
	try {
		const result = await makeProvider({ baseURL: server.url, workflow: 'news', safeSearch: false }).search({ query: 'q' });
		assert.equal(seen.workflow, 'news');
		assert.equal(seen.safe_search, false);
		assert.deepEqual(result.sources, [
			{ url: 'https://news.example/x', title: 'X', publishedAt: '2025-01-02T00:00:00Z' },
		]);
	} finally {
		await server.close();
	}
});

test('surfaces the live errors[] envelope as WEB_PROVIDER_ERROR', async () => {
	const server = await startServer(() => ({
		status: 401,
		body: {
			meta: { trace: 't' },
			data: null,
			errors: [{ code: 'general.invalid_token', message: 'Token signature failed to verify.' }],
		},
	}));
	try {
		await assert.rejects(
			makeProvider({ baseURL: server.url }).search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR');
				assert.match(error.message, /HTTP 401/u);
				assert.match(error.message, /Token signature failed to verify\./u);
				assert.match(error.message, /KAGI_SEARCH_API_KEY/u);
				return true;
			},
		);
	} finally {
		await server.close();
	}
});

test('accepts the OpenAPI error[] spelling and non-JSON failure bodies', async () => {
	const server = await startServer((request, body) => {
		if (body?.query === 'openapi') return { status: 429, body: { error: [{ code: 'rate.limited' }] } };
		return { status: 500, body: 'gateway exploded' };
	});
	try {
		await assert.rejects(
			makeProvider({ baseURL: server.url }).search({ query: 'openapi' }),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR');
				assert.match(error.message, /rate\.limited/u);
				assert.match(error.message, /HTTP 429/u);
				return true;
			},
		);
		await assert.rejects(
			makeProvider({ baseURL: server.url }).search({ query: 'q' }),
			(error) => {
				assert.match(error.message, /HTTP 500/u);
				assert.match(error.message, /gateway exploded/u);
				return true;
			},
		);
	} finally {
		await server.close();
	}
});

test('rejects an empty query before dispatching', async () => {
	const server = await startServer(() => {
		throw new Error('an empty query must not dispatch');
	});
	try {
		await assert.rejects(
			makeProvider({ baseURL: server.url }).search({ query: '   ' }),
			(error) => error.code === 'WEB_PROVIDER_ERROR',
		);
	} finally {
		await server.close();
	}
});

test('reports a missing key as WEB_PROVIDER_CREDENTIAL_MISSING without dispatching', async () => {
	const server = await startServer(() => {
		throw new Error('a missing key must not dispatch');
	});
	try {
		const provider = makeProvider({ baseURL: server.url, apiKey: undefined, resolveApiKey: async () => undefined });
		await assert.rejects(
			provider.search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
				assert.match(error.message, /KAGI_SEARCH_API_KEY/u);
				return true;
			},
		);
	} finally {
		await server.close();
	}
});

test('resolves the key through resolveApiKey when no literal key is configured', async () => {
	let seenAuth;
	const server = await startServer((request) => {
		seenAuth = request.headers.authorization;
		return { body: { data: { search: [{ url: 'https://example.com', title: 'T' }] } } };
	});
	try {
		const provider = makeProvider({ baseURL: server.url, apiKey: undefined, resolveApiKey: async () => 'resolved-key' });
		await provider.search({ query: 'q' });
		assert.equal(seenAuth, 'Bearer resolved-key');
	} finally {
		await server.close();
	}
});

test('maps caller cancellation to WEB_ABORTED', async () => {
	const server = await startServer(
		() => new Promise(() => {
			// never responds; the caller aborts instead
		}),
	);
	try {
		const controller = new AbortController();
		const pending = makeProvider({ baseURL: server.url }).search({ query: 'q' }, controller.signal);
		controller.abort(new Error('user cancelled'));
		await assert.rejects(pending, (error) => {
			assert.equal(error.code, 'WEB_ABORTED');
			return true;
		});
	} finally {
		await server.close();
	}
});

test('maps the configured timeout to WEB_PROVIDER_ERROR', async () => {
	const server = await startServer(
		() => new Promise(() => {
			// never responds; the provider's own timeout fires
		}),
	);
	try {
		await assert.rejects(
			makeProvider({ baseURL: server.url, timeoutMs: 50 }).search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR');
				assert.match(error.message, /timed out after 50 ms/u);
				return true;
			},
		);
	} finally {
		await server.close();
	}
});

test('rejects an unprocessable success body', async () => {
	const server = await startServer(() => ({ body: 'not json' }));
	try {
		await assert.rejects(
			makeProvider({ baseURL: server.url }).search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR');
				assert.match(error.message, /unprocessable response body/u);
				return true;
			},
		);
	} finally {
		await server.close();
	}
});

test('apply() registers a kagi provider that reads live config references', async () => {
	let seenBody;
	const server = await startServer((request, body) => {
		seenBody = body;
		return { body: { data: { search: [{ url: 'https://example.com', title: 'T' }] } } };
	});
	try {
		let registered;
		const ctx = {
			web: { registerSearchProvider: (provider) => { registered = provider; } },
			get: () => undefined,
		};
		const values = {
			apiKey: 'live-key',
			apiKeyEnv: 'KAGI_SEARCH_API_KEY',
			baseURL: server.url,
			limit: 7,
			workflow: 'search',
			safeSearch: true,
			timeoutMs: 5000,
		};
		const config = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }]));
		apply(ctx, config);
		assert.equal(registered.id, 'kagi');
		assert.equal(registered.available(), true);
		await registered.search({ query: 'hello' });
		assert.equal(seenBody.query, 'hello');
		assert.equal(seenBody.limit, 7);
	} finally {
		await server.close();
	}
});
