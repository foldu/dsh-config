/**
 * Tell each agent which model the UI selected and how to credit it in git.
 *
 * The composer's model picker is Agent-scoped: a selection change updates
 * `agent.options`, and the prompt assembly for the next step reads it. This
 * plugin registers one global system-prompt section whose text provider
 * resolves the selected `provider/model` pair against a configured identity map
 * and, when it finds an entry, renders the exact `Co-authored-by:` trailer to
 * append to a git commit message. An unlisted selection contributes no text,
 * so the plugin never guesses a model, vendor, or address.
 *
 * Section text is registered with `interpolate: false`: the rendered text is
 * final, and no configured name or address can be mistaken for a `{{variable}}`
 * reference.
 *
 * @module dsh-coauthor-identity
 */

import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import z from '@deepseek-ai/schemastery';
import {
	renderIdentitySection,
	resolveIdentity,
} from './identity.js';
import type { CoAuthorIdentity, ModelRef } from './identity.js';

export {
	FALLBACK_IDENTITY_KEY,
	renderIdentitySection,
	resolveIdentity,
} from './identity.js';
export type { CoAuthorIdentity, ModelRef } from './identity.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'coauthor-identity';

/** The prompt registry this plugin contributes to. */
export const inject: string[] = ['systemPrompt'];

/**
 * Section order: after the first-party tool guidance and file-reference
 * sections, before structured output and the deployment suffix. Placing the
 * section late keeps an unchanged prompt prefix reusable when the selected
 * model changes mid-session.
 */
export const COAUTHOR_SECTION_ORDER = 9100;

/**
 * Live plugin config.
 *
 * `coAuthors` is keyed by the exact selection the UI made: `provider/model`
 * first, then a bare model id, then `*` as the last resort. Values are the name
 * and address a commit trailer should credit.
 */
export interface Config {
	/** Co-author identities by `provider/model`, bare model id, or `*`. */
	coAuthors: Volatile<Record<string, CoAuthorIdentity>>;
}

/** Config schema; an empty map is valid and contributes no prompt text. */
export const Config = z.object({
	coAuthors: z.dict(z.object({
		name: z.string().required(),
		email: z.string().required(),
	})).required().volatile(),
});

/**
 * Read the selected provider and model from an assembling agent.
 * @param agent - the agent whose prompt is being assembled, when known.
 * @returns the selection to resolve an identity for.
 */
function modelRefOf(agent: Agent | undefined): ModelRef {
	return {
		provider: agent?.options.provider,
		model: agent?.options.model,
	};
}

/**
 * Register the co-author identity section.
 *
 * The section's text is evaluated at every assembly, so a model switch through
 * the UI takes effect on the next step without a reload. For an unlisted
 * selection the provider returns empty text and the section disappears.
 * @param ctx - plugin context carrying the system-prompt registry.
 * @param config - live config references for this plugin instance.
 */
export function apply(ctx: Context, config: Config): void {
	ctx.systemPrompt.section({
		name: 'coauthor:identity',
		order: COAUTHOR_SECTION_ORDER,
		interpolate: false,
		text: (context) => {
			const ref = modelRefOf(context.agent);
			const identity = resolveIdentity(config.coAuthors.get(), ref);
			return identity === undefined ? '' : renderIdentitySection(identity, ref);
		},
	});
}
