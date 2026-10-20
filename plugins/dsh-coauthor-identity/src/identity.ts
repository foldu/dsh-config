/**
 * Co-author identity resolution for one selected model.
 *
 * The composer's model picker selects a provider route and a provider-owned
 * model id; the deployment decides, per pair, which name and address a
 * `Co-authored-by:` trailer should credit. This module is pure: {@link
 * resolveIdentity} maps a selection onto a configured entry, and {@link
 * renderIdentitySection} renders the model-facing prompt text. Nothing here
 * reads live services, so the mapping is unit-testable without a harness.
 *
 * @module dsh-coauthor-identity/identity
 */

/** One co-author identity: the name and address a git trailer credits. */
export interface CoAuthorIdentity {
	/** Name in the trailer, e.g. `Kimi K3`. */
	readonly name: string
	/** Address in angle brackets, e.g. `noreply@moonshot.ai`. */
	readonly email: string
}

/**
 * The model selection a trailer identity is resolved for.
 *
 * `provider` and `model` mirror `AgentOptions`; both are `undefined` for an
 * agent that has not selected a route yet, and `model` alone is enough to match
 * a bare id in the map.
 */
export interface ModelRef {
	/** Registered provider route, such as `openrouter`. */
	readonly provider: string | undefined
	/** Provider-owned model id, such as `moonshotai/kimi-k3`. */
	readonly model: string | undefined
}

/** Identity map keys: provider-qualified pair, bare model id, or this catch-all. */
export const FALLBACK_IDENTITY_KEY = '*'

/** Characters that would break a `Name <address>` trailer or split the section. */
const UNSAFE_IDENTITY_TEXT = /[<>\r\n]/u

/**
 * Trim and validate one configured identity.
 *
 * A blank name or address, or one carrying an angle bracket or line break, is
 * unusable: it would corrupt the trailer this plugin exists to produce. Such an
 * entry is treated as absent so resolution can continue to the next key instead
 * of emitting a malformed trailer.
 * @param value - one map entry as configured.
 * @returns the normalized identity, or `undefined` when it is unusable.
 */
function usableIdentity(value: CoAuthorIdentity | undefined): CoAuthorIdentity | undefined {
	if (value === undefined) return undefined
	const name = value.name.trim()
	const email = value.email.trim()
	if (name.length === 0 || email.length === 0) return undefined
	if (UNSAFE_IDENTITY_TEXT.test(name) || UNSAFE_IDENTITY_TEXT.test(email)) return undefined
	return { name, email }
}

/**
 * Resolve the identity configured for one selected model.
 *
 * Lookup order is exact: `provider/model`, then the bare `model`, then `*`.
 * The first usable entry wins, so an empty or malformed provider-qualified
 * entry falls through rather than suppressing the match. With no usable entry
 * the caller contributes no prompt text, and the model is told nothing.
 * @param map - identities keyed by `provider/model`, bare `model`, or `*`.
 * @param ref - the selected provider and model.
 * @returns the matching identity, or `undefined`.
 */
export function resolveIdentity(
	map: Readonly<Record<string, CoAuthorIdentity>>,
	ref: ModelRef,
): CoAuthorIdentity | undefined {
	const model = ref.model?.trim()
	if (model === undefined || model.length === 0) return undefined
	const provider = ref.provider?.trim()
	const keys = provider !== undefined && provider.length > 0
		? [`${provider}/${model}`, model, FALLBACK_IDENTITY_KEY]
		: [model, FALLBACK_IDENTITY_KEY]
	for (const key of keys) {
		const identity = usableIdentity(map[key])
		if (identity !== undefined) return identity
	}
	return undefined
}

/**
 * Render the system-prompt section that names the selected model and the
 * trailer to append.
 *
 * The text is complete on its own: the section is registered with
 * `interpolate: false`, so no `{{…}}` placeholder in a configured name or
 * address could reach the prompt renderer.
 * @param identity - the resolved co-author identity.
 * @param ref - the selected provider and model, for the identity sentence.
 * @returns the model-facing section text.
 */
export function renderIdentitySection(identity: CoAuthorIdentity, ref: ModelRef): string {
	const model = ref.model?.trim()
	const provider = ref.provider?.trim()
	const selection = provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0
		? `${identity.name} (provider ${JSON.stringify(provider)}, model ${JSON.stringify(model)})`
		: identity.name
	return [
		`You are running as the model selected in this session's UI: ${selection}.`,
		'',
		'When you create a git commit, end the commit message with this trailer so the model is credited as co-author:',
		'',
		`Co-authored-by: ${identity.name} <${identity.email}>`,
		'',
		'Use exactly this name and email, add the trailer once, and place it in the final paragraph after a blank line. Do not credit a different model, vendor, or address.',
	].join('\n')
}
