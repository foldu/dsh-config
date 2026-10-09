/**
 * `shfmt` invocation for display formatting.
 *
 * The command text a model writes is often code golf: one line of `&&`, pipes
 * and inline substitutions. `shfmt` rewrites it into the shape a human would
 * write without changing what it does, which is what makes it usable as a
 * *display* transform: nothing here executes the command, and a command shfmt
 * cannot parse is returned untouched.
 *
 * Every failure mode collapses to the original text (missing binary, non-zero
 * exit, timeout, empty output), so a caller can render the result unconditionally.
 *
 * @module dsh-bash-shfmt/shfmt
 */
import { spawn } from 'node:child_process';

/** Verdict cache lifetime for a binary that was *not* found on `PATH`. */
const MISSING_RETRY_MS = 30_000;

/** One formatting request's live configuration. */
export interface ShfmtOptions {
	/** Executable name or path; resolved through the Host process `PATH`. */
	readonly binary: string;
	/** Arguments that precede the command on stdin. */
	readonly args: readonly string[];
	/** Hard per-invocation ceiling; the child is killed and the original kept. */
	readonly timeoutMs: number;
}

/** What a caller renders, and whether `shfmt` is what produced it. */
export interface ShfmtOutcome {
	/** Text to show: `shfmt`'s rewrite, or the original command when it failed. */
	readonly formatted: string;
	/** Whether `shfmt` produced {@link formatted} (false means the original). */
	readonly applied: boolean;
}

/** One completed child process. */
interface ProcessOutcome {
	readonly status: number;
	readonly stdout: string;
}

/**
 * Run one `shfmt` process with the command on stdin and a hard timeout.
 * @param options - resolved binary, arguments and timeout.
 * @param command - the command text to format.
 * @returns the exit status and stdout, or undefined for spawn failure or timeout.
 */
function runShfmt(options: ShfmtOptions, command: string): Promise<ProcessOutcome | undefined> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(options.binary, [...options.args], {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch {
			resolve(undefined);
			return;
		}
		let stdout = '';
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: ProcessOutcome | undefined): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(outcome);
		};
		timer = setTimeout(() => {
			// `shfmt` never waits on input once stdin ends, so reaching this point
			// means a stuck plugin host, not a slow parse.
			child.kill('SIGKILL');
			finish(undefined);
		}, options.timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
		});
		// Drain stderr so an unparseable command cannot fill the pipe buffer and
		// deadlock the child before it exits.
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', () => {});
		child.on('error', () => {
			finish(undefined);
		});
		child.on('close', (status) => {
			finish({ status: status ?? -1, stdout });
		});
		// A parse error closes the inputs before the pipe is written; that EPIPE is
		// reported through the exit status, which is the outcome that matters.
		child.stdin?.on('error', () => {});
		child.stdin?.end(command);
	});
}

/**
 * Resolve and cache `shfmt` invocations for one plugin instance.
 *
 * Results are memoized per command text: a session renders the same call many
 * times (streaming, re-render, scroll), and `shfmt` is deterministic, so one
 * process per distinct command is enough. A *missing* binary is re-probed after
 * {@link MISSING_RETRY_MS} so installing `shfmt` does not require a restart.
 */
export class ShfmtFormatter {
	readonly #options: () => ShfmtOptions;
	readonly #cache = new Map<string, ShfmtOutcome>();
	readonly #verdicts = new Map<string, { readonly ok: boolean; readonly at: number }>();
	readonly #cacheSize: () => number;

	/**
	 * @param options - reads the current (volatile) config revision per call.
	 * @param cacheSize - reads the retained-command ceiling (at least 1).
	 */
	constructor(options: () => ShfmtOptions, cacheSize: () => number) {
		this.#options = options;
		this.#cacheSize = cacheSize;
	}

	/**
	 * Format one command, or return it unchanged.
	 * @param command - the exact command text from the tool call.
	 * @returns the display text and whether `shfmt` produced it.
	 */
	async format(command: string): Promise<ShfmtOutcome> {
		const cached = this.#cache.get(command);
		if (cached !== undefined) return cached;
		const fallback: ShfmtOutcome = { formatted: command, applied: false };
		const options = this.#options();
		if (!(await this.available(options.binary, options.timeoutMs))) return fallback;
		const outcome = await runShfmt(options, command);
		if (outcome === undefined || outcome.status !== 0 || outcome.stdout.length === 0) return fallback;
		const applied: ShfmtOutcome = { formatted: outcome.stdout.replace(/\n$/, ''), applied: true };
		this.#remember(command, applied);
		return applied;
	}

	/**
	 * Whether the binary answers `--version` with exit status 0.
	 * @param binary - executable to probe.
	 * @param timeoutMs - probe ceiling.
	 * @returns true when the binary ran successfully.
	 */
	async available(binary: string, timeoutMs: number): Promise<boolean> {
		const cached = this.#verdicts.get(binary);
		if (cached !== undefined && (cached.ok || Date.now() - cached.at < MISSING_RETRY_MS)) return cached.ok;
		const outcome = await runShfmt({ binary, args: ['--version'], timeoutMs }, '');
		const ok = outcome !== undefined && outcome.status === 0;
		this.#verdicts.set(binary, { ok, at: Date.now() });
		return ok;
	}

	/**
	 * Insert one outcome, evicting the oldest entry past the cache ceiling.
	 * @param command - the exact command text (cache key).
	 * @param outcome - the applied outcome for that text.
	 */
	#remember(command: string, outcome: ShfmtOutcome): void {
		this.#cache.set(command, outcome);
		const ceiling = Math.max(1, Math.trunc(this.#cacheSize()));
		while (this.#cache.size > ceiling) {
			const oldest = this.#cache.keys().next();
			if (oldest.done === true) break;
			this.#cache.delete(oldest.value);
		}
	}
}
