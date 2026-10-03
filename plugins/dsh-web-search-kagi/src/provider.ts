/**
 * Kagi Search API v1 provider for the DeepSeek Harness web capability seam
 * (`ctx.web`).
 *
 * Registers a `WebSearchProvider` with the id `kagi`. Each search POSTs a JSON
 * body to Kagi's `/search` endpoint with bearer authentication and maps
 * `data.search[]` onto the seam's portable citation shape (`url`, `title`,
 * `snippet`, `publishedAt`). The seam owns provider selection, result capping
 * and error routing; this module owns only the Kagi wire format.
 *
 * Wire contract (https://kagi.com/api/docs):
 *   POST {baseURL}/search
 *   authorization: Bearer <key>
 *   { "query": "...", "workflow": "search", "format": "json", "limit": 10, "safe_search": true }
 *   -> { "meta": {...}, "data": { "search": [ { url, title, snippet, time, ... } ] } }
 *   failures -> { "meta": {...}, "data": null, "errors": [ { code, message } ] }
 *
 * @module dsh-web-search-kagi/provider
 */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';

/** Stable id this provider registers under. */
export const KAGI_PROVIDER_ID = 'kagi';
/** Default Kagi API v1 base; `/search` is appended. */
export const KAGI_DEFAULT_BASE_URL = 'https://kagi.com/api/v1';
/** Default credential reference holding the Kagi API key. */
export const KAGI_DEFAULT_API_KEY_ENV = 'KAGI_SEARCH_API_KEY';
/** Default upper bound on results requested from Kagi. */
export const KAGI_DEFAULT_LIMIT = 10;
/** Default result workflow; `search` is Kagi's general web search. */
export const KAGI_DEFAULT_WORKFLOW = 'search';
/** Default per-search timeout in milliseconds. */
export const KAGI_DEFAULT_TIMEOUT_MS = 30000;
/** Largest `limit` Kagi accepts. */
export const KAGI_MAX_LIMIT = 1024;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-web-search-kagi/0.1.0';

/**
 * Result groups Kagi may populate, in the order the fallback walk prefers them.
 * `data.search` first, then adjacent collections that still carry citeable
 * pages. Groups whose items are not pages (`related_search`) are last.
 */
const RESULT_GROUPS = [
	'search',
	'news',
	'interesting_news',
	'interesting_finds',
	'code',
	'listicle',
	'web_archive',
	'direct_answer',
	'infobox',
	'package_tracking',
	'public_records',
	'weather',
	'image',
	'video',
	'podcast',
	'podcast_creator',
	'adjacent_question',
	'related_search',
] as const;

/** Kagi `workflow` value -> the response group its results land in. */
const WORKFLOW_GROUPS: Readonly<Record<string, string>> = {
	search: 'search',
	images: 'image',
	videos: 'video',
	news: 'news',
	podcasts: 'podcast',
};

/** One fully resolved config revision, as the provider reads it per operation. */
export interface KagiSearchProviderOptions {
	/** Literal key, when the config supplied one; otherwise {@link resolveApiKey} is used. */
	readonly apiKey?: string;
	/** Credential reference the key is resolved from, named in failure messages. */
	readonly apiKeyEnv: CredentialRef;
	/** Resolve the key through the credentials service or the launch environment. */
	readonly resolveApiKey?: () => Promise<string | undefined>;
	/** Kagi API v1 base URL. */
	readonly baseURL: string;
	/** Upper bound on results requested from Kagi. */
	readonly limit: number;
	/** Kagi workflow. */
	readonly workflow: string;
	/** Whether Kagi omits potentially NSFW content. */
	readonly safeSearch: boolean;
	/** Per-search timeout in milliseconds. */
	readonly timeoutMs: number;
}

/**
 * Narrow an unknown value to a plain record.
 * @param value - candidate.
 * @returns the record, or `undefined` for null, arrays and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Return a trimmed non-empty string, or `undefined`.
 * @param value - candidate.
 * @returns the trimmed string, or `undefined` when absent, non-string, or blank.
 */
function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Collect the response arrays worth citing for one search. The workflow's own
 * group wins when it holds results; otherwise every known group is walked in
 * preference order. Either way the seam performs the final `maxResults` cap,
 * so no group is truncated here.
 * @param data - the response's `data` object, as received.
 * @param workflow - the requested Kagi workflow.
 * @returns arrays of candidate results, most relevant first.
 */
function resultGroupsFor(data: unknown, workflow: string): readonly unknown[][] {
	const root = asRecord(data);
	if (root === undefined) return [];
	const preferred = root[WORKFLOW_GROUPS[workflow] ?? 'search'];
	if (Array.isArray(preferred) && preferred.length > 0) return [preferred];
	const groups: unknown[][] = [];
	for (const group of RESULT_GROUPS) {
		const value = root[group];
		if (Array.isArray(value) && value.length > 0) groups.push(value);
	}
	return groups;
}

/**
 * Map a Kagi response body onto the seam's normalized search result.
 * @param payload - the parsed response body.
 * @param workflow - the requested Kagi workflow.
 * @returns deduplicated sources with optional title, snippet and timestamp.
 */
export function mapSearchResponse(payload: unknown, workflow: string): WebSearchResult {
	const groups = resultGroupsFor(asRecord(payload)?.data, workflow);
	const seen = new Set<string>();
	const sources: WebSearchSource[] = [];
	for (const group of groups) {
		for (const item of group) {
			const record = asRecord(item);
			const url = nonEmptyString(record?.url);
			if (url === undefined || seen.has(url)) continue;
			seen.add(url);
			const title = nonEmptyString(record?.title);
			const snippet = nonEmptyString(record?.snippet);
			const publishedAt = nonEmptyString(record?.time);
			sources.push({
				url,
				...(title === undefined ? {} : { title }),
				...(snippet === undefined ? {} : { snippet }),
				...(publishedAt === undefined ? {} : { publishedAt }),
			});
		}
	}
	return { sources, truncated: false };
}

/**
 * Extract the most useful human-readable failure text from a Kagi error body.
 * The live API returns `errors[]`; the OpenAPI document names `error[]`, so
 * both are accepted.
 * @param payload - the parsed error body, when it parsed.
 * @param text - the raw body text, when it did not parse.
 * @returns one diagnostic sentence, or `undefined` when the body said nothing.
 */
export function errorText(payload: unknown, text: string): string | undefined {
	const root = asRecord(payload);
	const list = Array.isArray(root?.errors) ? root.errors : Array.isArray(root?.error) ? root.error : [];
	const first = asRecord(list.find((entry) => asRecord(entry) !== undefined));
	const message = nonEmptyString(first?.message) ?? nonEmptyString(root?.message);
	if (message !== undefined) return message;
	const code = nonEmptyString(first?.code);
	if (code !== undefined) return code;
	return nonEmptyString(text)?.slice(0, 300);
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal: AbortSignal | undefined, fallback?: unknown): WebError {
	return new WebError('Kagi search aborted', 'WEB_ABORTED', {
		cause: signal?.aborted === true ? signal.reason : fallback,
	});
}

/**
 * The Kagi-backed search provider.
 *
 * `available()` is a purely structural, network-free check. It deliberately
 * does not prove that a key is present: the credential may live in the
 * asynchronous credential service, which a synchronous availability probe
 * cannot read. Reporting `false` there would make a pinned provider look
 * unavailable while its key is in fact stored, so a missing key surfaces at
 * search time as `WEB_PROVIDER_CREDENTIAL_MISSING` instead.
 */
export class KagiSearchProvider implements WebSearchProvider {
	/** Stable provider id; the seam's registry key. */
	readonly id = KAGI_PROVIDER_ID;

	readonly #resolveOptions: () => KagiSearchProviderOptions;

	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one search never mixes two config
	 * revisions. A thunk rather than a value because the plugin's settings can
	 * change between searches.
	 */
	constructor(resolveOptions: () => KagiSearchProviderOptions) {
		this.#resolveOptions = resolveOptions;
	}

	/** Cheap local usability check; never makes a network call. */
	available(): boolean {
		const options = this.#resolveOptions();
		return (
			URL.canParse(options.baseURL) &&
			Number.isInteger(options.limit) &&
			options.limit >= 1 &&
			options.limit <= KAGI_MAX_LIMIT &&
			Number.isInteger(options.timeoutMs) &&
			options.timeoutMs > 0
		);
	}

	/**
	 * Run one Kagi search.
	 * @param request - the query and optional seam-imposed result bound.
	 * @param signal - caller cancellation, combined with the configured timeout.
	 * @returns the mapped, deduplicated result.
	 */
	async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
		const options = this.#resolveOptions();
		const query = nonEmptyString(request.query);
		if (query === undefined) {
			throw new WebError('Kagi search was called with an empty query', 'WEB_PROVIDER_ERROR');
		}
		const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/search`;
		const apiKey = await this.#apiKey(options, signal);
		throwIfAborted(signal);

		const requested = Number.isInteger(request.maxResults) && (request.maxResults ?? 0) > 0 ? request.maxResults : undefined;
		const limit = requested === undefined ? options.limit : Math.min(options.limit, requested);
		const body = {
			query,
			workflow: options.workflow,
			format: 'json',
			limit,
			safe_search: options.safeSearch,
		};

		const timeout = AbortSignal.timeout(options.timeoutMs);
		const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: 'POST',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json',
					'user-agent': USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: combined,
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (timeout.aborted) {
				throw new WebError(`Kagi search timed out after ${options.timeoutMs} ms`, 'WEB_PROVIDER_ERROR', { cause: error });
			}
			throw new WebError(`Kagi search request to ${JSON.stringify(endpoint)} failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
				cause: error,
			});
		}

		const text = await response.text().catch((error: unknown) => {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			return '';
		});
		let payload: unknown;
		try {
			payload = text.length === 0 ? undefined : JSON.parse(text);
		} catch {
			payload = undefined;
		}

		if (!response.ok) {
			const detail = errorText(payload, text);
			const suffix = detail === undefined ? '' : `: ${detail}`;
			throw new WebError(
				`Kagi search failed (HTTP ${response.status})${suffix}\n\nThe request used endpoint ${JSON.stringify(endpoint)} with the credential reference "${options.apiKeyEnv}". If the key is wrong, expired, out of credit, or lacks Search API access, replace it in the credentials store ($DSH_HOME/.credentials.yaml) or in the launching environment; the endpoint itself only needs changing for a self-hosted or proxied Kagi API.`,
				'WEB_PROVIDER_ERROR',
			);
		}

		if (payload === undefined) {
			throw new WebError(`Kagi returned an unprocessable response body from ${JSON.stringify(endpoint)}`, 'WEB_PROVIDER_ERROR');
		}
		return mapSearchResponse(payload, options.workflow);
	}

	/**
	 * Resolve one operation's API key without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one config revision.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no key resolves.
	 */
	async #apiKey(options: KagiSearchProviderOptions, signal?: AbortSignal): Promise<string> {
		throwIfAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		const { resolveApiKey } = options;
		let resolved: string | undefined;
		if (resolveApiKey !== undefined) {
			try {
				resolved = await resolveApiKey();
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				throw new WebError(`Kagi search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
			}
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(
			`Kagi search has no API key for "${options.apiKeyEnv}"; store it in the credentials service (or $DSH_HOME/.credentials.yaml), export it in the launching environment, or set a literal "apiKey" in the web-search-kagi config. Create a key at https://kagi.com/api/keys.`,
			'WEB_PROVIDER_CREDENTIAL_MISSING',
		);
	}
}
