/**
 * `shfmt` display formatting for the Web GUI's bash surfaces.
 *
 * The Web client renders a bash tool call from the raw `tool/call` arguments it
 * reads out of the session log, so the text on screen is whatever the model
 * wrote — often one golfed line. This plugin does not touch that log: it runs
 * `shfmt` on a command the client sends it and returns display text, and the
 * Client half of this package substitutes that text where a bash command is
 * shown (the approval prompt and the bash tool row).
 *
 * The Host/Client split exists because a browser cannot run `shfmt`. The route
 * is one exact same-origin path behind the connection's Host/Origin fence and
 * browser authentication, and it is a pure text transform: `shfmt` parses the
 * command and never executes it.
 *
 * @module dsh-bash-shfmt
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from '@deepseek-ai/schemastery';
import { readBoundedBody, sendJson, sendMethodNotAllowed } from './http.js';
import { ShfmtFormatter } from './shfmt.js';

export { readBoundedBody, sendJson, sendMethodNotAllowed } from './http.js';
export { ShfmtFormatter } from './shfmt.js';
export type { ShfmtOptions, ShfmtOutcome } from './shfmt.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bash-shfmt';

/**
 * The route needs a web server and the connection's request fence. A
 * composition without either (a headless profile) stays inert instead of
 * throwing.
 */
export const inject: string[] = ['webServer', 'connection'];

/** The one route the Client half posts a command to, relative to the app origin. */
export const FORMAT_PATH = '/bash-shfmt/format';

/** Body ceiling for one formatting request: far larger than any real command. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Live plugin config. Every field is volatile: a change is committed into the
 * running references instead of remounting the plugin, so the next request
 * formats with the new value.
 */
export interface Config {
	/** When false the route answers every request with the original command. */
	enabled: Volatile<boolean>;
	/** `shfmt` executable name or path, resolved through the Host `PATH`. */
	binary: Volatile<string>;
	/** Arguments that precede the command on stdin. */
	args: Volatile<string[]>;
	/** Hard per-invocation ceiling in milliseconds. */
	timeoutMs: Volatile<number>;
	/** Longest accepted request body in bytes. */
	maxBodyBytes: Volatile<number>;
	/** Distinct commands whose formatting is reused, oldest evicted first. */
	cacheSize: Volatile<number>;
}

/**
 * Config schema. The defaults match the flags `~/.pi/agent`'s guard extension
 * uses, so both agents format a command the same way.
 */
export const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	binary: z.string().default('shfmt').volatile(),
	args: z
		.array(z.string())
		.default(['--language-dialect', 'bash', '--simplify', '--binary-next-line'])
		.volatile(),
	timeoutMs: z.number().step(1).min(1).default(5000).volatile(),
	maxBodyBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BODY_BYTES).volatile(),
	cacheSize: z.number().step(1).min(1).default(512).volatile(),
});

/** One accepted request body. */
interface FormatRequest {
	readonly command: string;
}

/**
 * Narrow one request body to a command string.
 * @param text - the raw JSON body.
 * @returns the request, or null for a malformed or empty payload.
 */
function parseFormatRequest(text: string): FormatRequest | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof body !== 'object' || body === null) return null;
	const { command } = body as { command?: unknown };
	return typeof command === 'string' && command.length > 0 ? { command } : null;
}

/**
 * Answer requests this Host/Origin fence or the browser authentication refuses.
 * @param ctx - plugin context holding the connection service.
 * @param req - the incoming request.
 * @param res - the response to own when the request is refused.
 * @returns true when the request was refused and the response was finished.
 */
function rejected(ctx: Context, req: Parameters<WebRoute['handler']>[0], res: Parameters<WebRoute['handler']>[1]): boolean {
	const connection = ctx.connection as HostConnectionHandle;
	const rejection = connection.requestRejection(req);
	if (rejection === undefined) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}

/**
 * Register the formatting route.
 * @param ctx - the plugin context, which must provide `webServer` and `connection`.
 * @param config - live config references for this plugin instance.
 */
export function apply(ctx: Context, config: Config): void {
	const formatter = new ShfmtFormatter(
		() => ({
			binary: config.binary.get(),
			args: config.args.get(),
			timeoutMs: config.timeoutMs.get(),
		}),
		() => config.cacheSize.get(),
	);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: FORMAT_PATH,
				handler: async (req, res) => {
					if (rejected(ctx, req, res)) return;
					if (req.method !== 'POST') {
						sendMethodNotAllowed(res, 'POST');
						return;
					}
					if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
						sendJson(res, 415, {
							code: 'unsupported-media-type',
							message: 'content-type must be application/json',
						});
						return;
					}
					const text = await readBoundedBody(req, config.maxBodyBytes.get());
					if (text === null) {
						sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' });
						return;
					}
					const request = parseFormatRequest(text);
					if (request === null) {
						sendJson(res, 400, {
							code: 'bad-request',
							message: 'request body must be JSON with a non-empty string "command"',
						});
						return;
					}
					if (!config.enabled.get()) {
						sendJson(res, 200, { formatted: request.command, applied: false });
						return;
					}
					sendJson(res, 200, await formatter.format(request.command));
				},
			}),
		`bash-shfmt: POST ${FORMAT_PATH}`,
	);
}
