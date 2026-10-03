/**
 * Register the Kagi Search API v1 provider in `ctx.web`.
 *
 * Composition mounts this plugin with a volatile config; each search resolves
 * `KAGI_SEARCH_API_KEY` through the credentials service (falling back to the
 * launch environment) and maps Kagi's results onto the seam's portable
 * citation shape. See {@link KagiSearchProvider} for the wire contract.
 *
 * @module dsh-web-search-kagi
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import {
	KAGI_DEFAULT_API_KEY_ENV,
	KAGI_DEFAULT_BASE_URL,
	KAGI_DEFAULT_LIMIT,
	KAGI_DEFAULT_TIMEOUT_MS,
	KAGI_DEFAULT_WORKFLOW,
	KAGI_MAX_LIMIT,
	KagiSearchProvider,
} from './provider.js';
import type { KagiSearchProviderOptions } from './provider.js';

export {
	errorText,
	KAGI_DEFAULT_API_KEY_ENV,
	KAGI_DEFAULT_BASE_URL,
	KAGI_DEFAULT_LIMIT,
	KAGI_DEFAULT_TIMEOUT_MS,
	KAGI_DEFAULT_WORKFLOW,
	KAGI_MAX_LIMIT,
	KAGI_PROVIDER_ID,
	KagiSearchProvider,
	mapSearchResponse,
} from './provider.js';
export type { KagiSearchProviderOptions } from './provider.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-kagi';
/** The web seam this provider registers into. */
export const inject: string[] = ['web'];

/**
 * Live plugin config. Every field is volatile: a change is committed into the
 * running references instead of remounting the plugin, so the next search sees
 * the new value. Fields whose schema declares a default are always present;
 * `apiKey` is not.
 */
export interface Config {
	/** Literal Kagi API key. A non-empty literal wins over {@link apiKeyEnv}. */
	apiKey: Volatile<string | undefined>;
	/** Credential reference resolved for each search. Defaults to `KAGI_SEARCH_API_KEY`. */
	apiKeyEnv: Volatile<string>;
	/** Kagi API v1 base; `/search` is appended. Defaults to `https://kagi.com/api/v1`. */
	baseURL: Volatile<string>;
	/** Upper bound on results requested from Kagi, 1 to 1024. Defaults to 10. */
	limit: Volatile<number>;
	/** Kagi workflow: `search`, `news`, `images`, `videos` or `podcasts`. Defaults to `search`. */
	workflow: Volatile<string>;
	/** Whether Kagi omits potentially NSFW content. Defaults to true. */
	safeSearch: Volatile<boolean>;
	/** Per-search timeout in milliseconds. Defaults to 30000. */
	timeoutMs: Volatile<number>;
}

/**
 * Config schema. `role('secret')` and `role('credential-ref')` keep the
 * literal key out of settings projections; `volatile()` makes each field
 * editable on a live plugin.
 */
export const Config = z.object({
	apiKey: z.string().role('secret').volatile(),
	apiKeyEnv: z.string().role('credential-ref').default(KAGI_DEFAULT_API_KEY_ENV).volatile(),
	baseURL: z.string().default(KAGI_DEFAULT_BASE_URL).volatile(),
	limit: z.number().step(1).min(1).max(KAGI_MAX_LIMIT).default(KAGI_DEFAULT_LIMIT).volatile(),
	workflow: z.string().default(KAGI_DEFAULT_WORKFLOW).volatile(),
	safeSearch: z.boolean().default(true).volatile(),
	timeoutMs: z.number().step(1).min(1).default(KAGI_DEFAULT_TIMEOUT_MS).volatile(),
});

/**
 * Project one resolved config revision into the options the provider serves its
 * next search with. Environment fallbacks stay here rather than in the
 * provider: every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative config revision.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): KagiSearchProviderOptions {
	const apiKeyEnv = credentialRef(config.apiKeyEnv.get());
	const literalApiKey = config.apiKey.get();
	return {
		...(literalApiKey === undefined || literalApiKey.length === 0 ? {} : { apiKey: literalApiKey }),
		apiKeyEnv,
		resolveApiKey: async () => {
			const credentials = ctx.get('credentials') as CredentialProvider | undefined;
			if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
			// The credentials service layers the process environment too, so this
			// fallback only serves compositions that do not mount it.
			let ambient;
			try {
				ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			} catch {
				ambient = undefined;
			}
			return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
		},
		baseURL: config.baseURL.get(),
		limit: config.limit.get(),
		workflow: config.workflow.get(),
		safeSearch: config.safeSearch.get(),
		timeoutMs: config.timeoutMs.get(),
	};
}

/**
 * Register the Kagi search provider with `ctx.web`.
 * @param ctx - the plugin context, which must provide the web seam.
 * @param config - live config references for this plugin instance.
 */
export function apply(ctx: Context, config: Config): void {
	ctx.web.registerSearchProvider(new KagiSearchProvider(() => resolveOptions(ctx, config)));
}
