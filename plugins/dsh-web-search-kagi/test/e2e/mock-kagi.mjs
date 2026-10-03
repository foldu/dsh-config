/**
 * Minimal stand-in for `https://kagi.com/api/v1/search`, used by the
 * end-to-end probe in `test/e2e/`.
 *
 * It echoes each request to stdout and answers with a canned Kagi v1 response
 * body, so the whole path (loader -> ctx.web -> provider -> HTTP -> mapping)
 * can be exercised without a Kagi key.
 *
 * Usage: node mock-kagi.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8788);

const payload = {
	meta: { trace: 'mock-trace', ms: 7, node: 'mock' },
	data: {
		search: [
			{
				url: 'https://example.com/kagi-result',
				title: 'Mock Kagi result',
				snippet: 'Returned by the local mock Kagi server.',
				time: '2025-02-03T04:05:06Z',
			},
			{ url: 'https://example.com/second', title: 'Second result' },
		],
	},
};

createServer((request, response) => {
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		console.log(
			`MOCK ${request.method} ${request.url} auth=${request.headers.authorization} body=${Buffer.concat(chunks).toString('utf8')}`,
		);
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(payload));
	});
}).listen(port, '127.0.0.1', () => console.log(`MOCK listening on http://127.0.0.1:${port}`));
