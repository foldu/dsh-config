/**
 * Minimal HTTP helpers for one plugin-owned JSON route.
 *
 * Deliberately local: the shipped Host routes keep helpers like these private to
 * their package, and a shared helper package would be a wider dependency than
 * one exact route needs.
 *
 * @module dsh-bash-shfmt/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Answer with JSON and no caching: the caller's own request decided the payload.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

/**
 * Answer 405 naming the route's one supported method.
 * @param res - the response to own.
 * @param allow - the method the route serves.
 */
export function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
	res.statusCode = 405;
	res.setHeader('allow', allow);
	res.end();
}

/**
 * Collect a request body as UTF-8 text, refusing to buffer past `limit`.
 * @param req - the request to drain.
 * @param limit - maximum accepted byte length.
 * @returns the body text, or null when the ceiling was passed (stream drained).
 */
export async function readBoundedBody(req: IncomingMessage, limit: number): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.byteLength;
		if (size > limit) {
			req.resume();
			return null;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, size).toString('utf8');
}
