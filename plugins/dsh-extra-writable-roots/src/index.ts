/**
 * Deployment-wide extra writable roots for the DSH file sandbox.
 *
 * The sandbox expresses `workspace-write` as one workspace root plus the
 * platform temp areas (`writableRoots` in `@deepseek-ai/dsh-sandbox`), and its
 * policy type carries no field for extra roots. This plugin therefore replaces
 * both enforcing halves of that fence with copies that add a configured,
 * deployment-wide allow-list:
 *
 * - {@link ExtraRootsSandboxProvider} extends the local process provider and
 *   widens the wrapped runner argv for every confined execution, so bash and
 *   terminals may write the extra roots.
 * - {@link ExtraRootsFileSystem} extends the sandboxing filesystem backend and
 *   admits a mutation whose target canonicalizes under an extra root before the
 *   shipped workspace/temp containment check runs, so the `write` and `edit`
 *   tools agree with the shell.
 *
 * Both halves read one {@link WritableRootSet}, so the shell and the tools can
 * never disagree about which paths are writable. The bundle patch disables the
 * shipped `sandbox` and `fs-sandbox` rows, which is the documented swap for a
 * capability backend ("loading it INSTEAD OF `dsh-fs-local` is the whole
 * swap"); this plugin's row must therefore forward the shipped providers' own
 * config fields verbatim, which its `Config` schema does by composing their
 * published schemas rather than restating their defaults.
 *
 * @module dsh-extra-writable-roots
 */

import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import type { Config as FsLocalConfig } from '@deepseek-ai/dsh-fs-local';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import type { Config as SandboxLocalConfig } from '@deepseek-ai/dsh-sandbox-local';
import z from '@deepseek-ai/schemastery';
import { widenArgv } from './dialects.js';
import type { RunnerDialect } from './dialects.js';
import { grantsExtraRoots, isUnderRoot, resolveWritableRoots, WritableRootSet } from './roots.js';
import type { ResolveOptions } from './roots.js';

export { expandEnv, expandHome, grantsExtraRoots, isUnderRoot, resolveWritableRoots, WritableRootSet } from './roots.js';
export type { ResolveOptions } from './roots.js';
export { detectDialect, widenArgv } from './dialects.js';
export type { RunnerDialect, Widening } from './dialects.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'extra-writable-roots';

/** The policy home this plugin reads; the shipped rows it replaces depend on it too. */
export const inject: string[] = ['sandboxPolicy'];

/**
 * Live plugin config. The first two fields are this plugin's own; the rest
 * belong to the shipped providers it replaces and are forwarded verbatim, so
 * a deployment keeps whatever it configured on the `sandbox` and `fs-sandbox`
 * rows it disabled.
 */
export interface Config extends FsLocalConfig, SandboxLocalConfig {
	/** Extra absolute roots — `~/…` and `$VAR` allowed — that every confined execution may write; defaults to none. */
	writablePaths: Volatile<string[]>;
	/** Whether the extra roots also apply under `read-only`. Defaults to false, which keeps that mode's contract honest. */
	applyInReadOnly: Volatile<boolean>;
	/** Whether a configured root that does not exist yet is created (`0700`) instead of failing the mount; defaults to false. */
	createMissingRoots: Volatile<boolean>;
}

/**
 * Config schema. The forwarded fields are the shipped schemas' own properties,
 * composed rather than restated so an upstream default cannot drift here.
 */
export const Config = z.object({
	...(LocalFileSystem.Config.dict ?? {}),
	...(LocalSandboxProvider.Config.dict ?? {}),
	writablePaths: z.array(z.string()).default([]).volatile(),
	applyInReadOnly: z.boolean().default(false).volatile(),
	createMissingRoots: z.boolean().default(false).volatile(),
});

/**
 * The `sandboxPolicy` service, typed structurally: this plugin must keep
 * working when its own copy of `@deepseek-ai/cordis` differs from the one that
 * carries the service-map augmentation.
 */
interface PolicyHome {
	resolve(): SandboxExecutionPolicy;
}

/** Read the policy home without depending on cross-package type identity. */
function policyHome(ctx: Context): PolicyHome | undefined {
	return (ctx as unknown as { sandboxPolicy?: PolicyHome }).sandboxPolicy;
}

/** The `systemPrompt` service, typed structurally for the same reason as {@link PolicyHome}. */
interface SystemPromptHome {
	getContextOrder(name: 'SANDBOX_POLICY'): number;
	context(contribution: { name: string; order: number; text: () => string }): unknown;
}

/** The `ctx.inject` entry point, typed structurally for the same reason as {@link PolicyHome}. */
interface InjectHome {
	inject(deps: readonly string[], callback: (scope: Context) => void): unknown;
}

/**
 * The process-sandbox provider with this deployment's extra roots added to
 * every confined execution. It inherits the shipped provider unchanged — chain
 * selection, probing, the Windows ACL grants, denial and runner-failure facts —
 * and only widens the argv it returns.
 */
export class ExtraRootsSandboxProvider extends LocalSandboxProvider {
	private readonly roots: WritableRootSet;
	private readonly applyInReadOnly: Volatile<boolean>;
	private warnedDialect: RunnerDialect | undefined;

	/**
	 * @param ctx - the plugin context the provider registers on.
	 * @param config - the resolved row config, forwarded whole to the shipped provider.
	 * @param roots - the shared live root set.
	 */
	constructor(ctx: Context, config: Config, roots: WritableRootSet) {
		super(ctx, config);
		this.roots = roots;
		this.applyInReadOnly = config.applyInReadOnly;
	}

	/**
	 * Wrap the argv, then widen the returned profile by the extra roots in the
	 * dialect the selected runner speaks. A runner that cannot express another
	 * root is reported once instead of silently pretending the grant exists.
	 * @param argv - the exact argv the caller is about to spawn.
	 * @param policy - the file-effect policy this execution runs under.
	 * @param signal - cancellation while the provider resolves the policy and runner.
	 * @returns the argv to spawn instead, plus the shipped provider's enforcement facts.
	 */
	override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
		const confined = await super.confine(argv, policy, signal);
		const roots = this.roots.value;
		if (roots.length === 0) return confined;
		if (!grantsExtraRoots(policy.mode, this.applyInReadOnly.get())) return confined;
		const widened = widenArgv(confined.argv, roots);
		if (!widened.applied) {
			if (this.warnedDialect !== widened.dialect) {
				this.warnedDialect = widened.dialect;
				this.ctx.logger.warn(`extra-writable-roots: the "${widened.dialect}" sandbox runner cannot express an extra writable root; confined commands keep the workspace-only grant, while the filesystem tools still honour the configured roots`);
			}
			return confined;
		}
		return { ...confined, argv: [...widened.argv] };
	}
}

/**
 * The filesystem backend with this deployment's extra roots admitted before the
 * shipped fence. Reads, listings, and every other operation pass through
 * untouched; only an extra-root mutation takes the unfenced local
 * implementation, using the freshly canonicalized target the shipped fence
 * would have returned.
 */
export class ExtraRootsFileSystem extends SandboxedFileSystem {
	private readonly roots: WritableRootSet;
	private readonly applyInReadOnly: Volatile<boolean>;

	/**
	 * @param ctx - the plugin context the backend registers on.
	 * @param config - the resolved row config, forwarded whole to the shipped backend.
	 * @param roots - the shared live root set.
	 */
	constructor(ctx: Context, config: Config, roots: WritableRootSet) {
		super(ctx, config);
		this.roots = roots;
		this.applyInReadOnly = config.applyInReadOnly;
	}

	/**
	 * Fence the write by the policy, admitting the extra roots.
	 * @param target - the resolved target to write.
	 * @param content - the full new file content.
	 * @param expected - the write intent guarding the write; omit for unconditional.
	 * @param signal - aborts before atomic publication takes effect.
	 * @param sandboxPolicy - the per-call mode and workspace root; omit to use the deployment fallback.
	 * @returns the write outcome.
	 */
	override async writeText(
		target: FsTarget,
		content: string,
		expected?: FsWriteIntent,
		signal?: AbortSignal,
		sandboxPolicy?: SandboxExecutionPolicy,
	): Promise<FsWriteOutcome> {
		const allowed = await this.extraRootTarget(target, sandboxPolicy);
		if (allowed === undefined) return super.writeText(target, content, expected, signal, sandboxPolicy);
		return LocalFileSystem.prototype.writeText.call(this, allowed, content, expected, signal);
	}

	/**
	 * Fence the edit by the policy, admitting the extra roots.
	 * @param target - the resolved target to edit.
	 * @param edit - the literal search/replace request.
	 * @param expected - the version guard; omit for an unconditional edit.
	 * @param signal - aborts before atomic publication takes effect.
	 * @param sandboxPolicy - the per-call mode and workspace root; omit to use the deployment fallback.
	 * @returns the edit outcome.
	 */
	override async editText(
		target: FsTarget,
		edit: FsEditRequest,
		expected?: { version: FsVersion },
		signal?: AbortSignal,
		sandboxPolicy?: SandboxExecutionPolicy,
	): Promise<FsEditOutcome> {
		const allowed = await this.extraRootTarget(target, sandboxPolicy);
		if (allowed === undefined) return super.editText(target, edit, expected, signal, sandboxPolicy);
		return LocalFileSystem.prototype.editText.call(this, allowed, edit, expected, signal);
	}

	/**
	 * The freshly canonicalized target when this mutation is admitted by an
	 * extra root, or `undefined` when the shipped fence must decide. Admission
	 * re-resolves the target first, so the target that is mutated is the one
	 * that was checked, exactly as the shipped `workspace-write` path does.
	 * @param target - the caller's resolved target.
	 * @param sandboxPolicy - the per-call policy; omitted for the deployment fallback.
	 * @returns the target to mutate unfenced, or `undefined` to defer to the shipped fence.
	 */
	private async extraRootTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget | undefined> {
		const roots = this.roots.value;
		if (roots.length === 0) return undefined;
		const policy = sandboxPolicy ?? policyHome(this.ctx)?.resolve();
		if (policy === undefined) return undefined;
		if (!grantsExtraRoots(policy.mode, this.applyInReadOnly.get())) return undefined;
		const fresh = await this.resolve(target.displayPath);
		const key = String(fresh.targetKey);
		return roots.some((root) => isUnderRoot(key, root)) ? fresh : undefined;
	}
}

/**
 * Render the extra roots for the model's runtime-context snapshot, so the model
 * knows it may write there instead of escalating every time.
 * @param roots - canonical extra roots.
 * @param applyInReadOnly - whether the roots also apply under `read-only`.
 * @returns the context text, or an empty string when no roots are configured.
 */
function renderExtraRoots(roots: readonly string[], applyInReadOnly: boolean): string {
	if (roots.length === 0) return '';
	const list = roots.map((root) => JSON.stringify(root)).join(', ');
	const modes = applyInReadOnly ? 'every standing mode, including read-only' : 'workspace-write';
	return `Additional writable roots for this deployment: available operations may modify files under ${list} in ${modes}. This is deployment configuration, not an escalation — do not request sandbox_permissions for these paths.`;
}

/**
 * Mount the extended provider and backend, plus the model-visible statement of
 * what they grant.
 * @param ctx - the plugin context; the policy home must already be mounted.
 * @param config - the live row config.
 */
export function apply(ctx: Context, config: Config): void {
	// Environment references and the create-missing decision are read on every
	// resolution, so a live edit to either applies to the next confined call
	// without a remount.
	const resolveOptions = (): ResolveOptions => ({
		env: process.env,
		createMissing: config.createMissingRoots.get(),
	});
	// Fail loud at mount: a configured root that does not resolve would
	// otherwise look like a sandbox bug at write time. Live edits after mount
	// re-resolve through the set and fail closed to no extra roots.
	resolveWritableRoots(config.writablePaths.get(), resolveOptions());
	const roots = new WritableRootSet(
		() => config.writablePaths.get(),
		(error) => {
			ctx.logger.warn(`extra-writable-roots: ${error.message}; granting no extra roots until the configuration resolves again`);
		},
		resolveOptions,
	);
	new ExtraRootsSandboxProvider(ctx, config, roots);
	new ExtraRootsFileSystem(ctx, config, roots);
	(ctx as unknown as InjectHome).inject(['systemPrompt'], (scope) => {
		const systemPrompt = (scope as unknown as { systemPrompt: SystemPromptHome }).systemPrompt;
		systemPrompt.context({
			name: 'sandbox:extra-writable-roots',
			order: systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
			text: () => renderExtraRoots(roots.value, config.applyInReadOnly.get()),
		});
	});
}
