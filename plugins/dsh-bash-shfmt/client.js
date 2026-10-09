/**
 * Client half of `dsh-bash-shfmt`.
 *
 * A browser cannot run `shfmt`, and the Web client renders a bash tool call from
 * the raw `tool/call` arguments in the session log. So this module does two
 * things:
 *
 * 1. It asks the Host half for the formatted text (`POST bash-shfmt/format`) and
 *    shows the original command until that answer arrives or if it never does.
 * 2. It shadows the two shipped seats that print a bash command — the approval
 *    prompt's detail row and the keyed `tool.call.toolview` entry for `bash` —
 *    because the shipped rows read the raw arguments themselves and would
 *    otherwise keep showing the unformatted command.
 *
 * Shadowing is by `priority: -1`: the slot core renders the lowest priority of a
 * cell, and a crashing entry abdicates back to the shipped one, so the worst
 * case is the stock row.
 *
 * The row's markup, class structure and CSS are copied from the shipped bash
 * row and terminal block (`@deepseek-ai/dsh-client-ui-tool`,
 * `@deepseek-ai/dsh-client-ui-primitives`) with renamed classes and theme tokens
 * only, because a plain-JS client plugin must not import Harness Client
 * packages. What is deliberately not reproduced: the running-title shimmer, and
 * ANSI colour in output (escape sequences are stripped).
 *
 * Hand-written JavaScript on purpose: the browser artifact is the lazy-factory
 * format the host serves directly, and this repo has no client bundler for local
 * plugins.
 */
window.__ModuleLoader__.load({
	id: 'dsh-bash-shfmt',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace for this plugin's own visible text. */
		const NS = 'dsh-bash-shfmt';
		/** Host route that formats one command; keep in step with FORMAT_PATH. */
		const FORMAT_ROUTE = 'bash-shfmt/format';
		/** Output lines rendered before the head/tail cap collapses the middle. */
		const TERMINAL_MAX_LINES = 16;
		/** How long the copy button reports success, in ms. */
		const COPIED_FEEDBACK_MS = 1000;

		const en = {
			copy: 'Copy',
			copied: 'Copied',
			collapse: 'Collapse',
			'row.preparing': 'Preparing tool call',
			'row.inspect': 'Inspect',
			'row.input': 'IN',
			'row.output': 'OUT',
			'tool.title.bash': 'Bash',
			'bash.running': 'Running',
			'bash.failed': 'Failed',
			'bash.stopped': 'Stopped',
			'terminal.signal': 'signal {signal}',
			'terminal.exitCode': 'exit code {code}',
			'terminal.noExitCode': 'no exit code',
			'terminal.noOutput': 'No output',
			'terminal.collapseAria': 'Collapse output',
			'terminal.expandAria': 'Expand the remaining {n} output lines',
			'terminal.expandRest': '… {n} more lines',
		};
		const zh = {
			copy: '复制',
			copied: '复制成功',
			collapse: '收起',
			'row.preparing': '正在准备工具调用',
			'row.inspect': '查看',
			'row.input': 'IN',
			'row.output': 'OUT',
			'tool.title.bash': 'Bash',
			'bash.running': '运行中',
			'bash.failed': '失败',
			'bash.stopped': '已停止',
			'terminal.signal': '信号 {signal}',
			'terminal.exitCode': '退出码 {code}',
			'terminal.noExitCode': '无退出码',
			'terminal.noOutput': '无输出',
			'terminal.collapseAria': '收起输出',
			'terminal.expandAria': '展开剩余 {n} 行输出',
			'terminal.expandRest': '… 还有 {n} 行',
		};

		/* ------------------------------------------------------------------ *
		 * Host formatter: one request per distinct command, cached on both
		 * sides of the wire. A missing or refusing Host never blocks a row:
		 * the raw command is a valid answer to every request.
		 * ------------------------------------------------------------------ */

		/** command text -> formatted text, for commands the Host already answered. */
		const resolved = new Map();
		/** command text -> in-flight request, so N renders share one POST. */
		const pending = new Map();
		/** Bound so a long session cannot grow this table without limit. */
		const RESOLVED_LIMIT = 512;

		function remember(command, formatted) {
			resolved.set(command, formatted);
			while (resolved.size > RESOLVED_LIMIT) {
				const oldest = resolved.keys().next();
				if (oldest.done === true) break;
				resolved.delete(oldest.value);
			}
		}

		/**
		 * Ask the Host to format one command.
		 * @param {string} command - the exact command text from the tool call.
		 * @returns {Promise<string>} formatted text, or the original on any failure.
		 */
		function requestFormatted(command) {
			const inFlight = pending.get(command);
			if (inFlight !== undefined) return inFlight;
			const request = fetch(FORMAT_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ command }),
			})
				.then((response) => (response.ok ? response.json() : null))
				.then((payload) =>
					payload !== null && typeof payload === 'object' && typeof payload.formatted === 'string'
						? payload.formatted
						: command,
				)
				.catch(() => command)
				.then((formatted) => {
					pending.delete(command);
					if (formatted !== command) remember(command, formatted);
					return formatted;
				});
			pending.set(command, request);
			return request;
		}

		/**
		 * Display text for one command, starting from whatever is already known.
		 * @param {string | undefined} command - raw command text, when the call has one.
		 * @returns {string | undefined} text to show.
		 */
		function useFormatted(command) {
			const [text, setText] = React.useState(() =>
				command === undefined ? undefined : resolved.get(command) ?? command,
			);
			React.useEffect(() => {
				if (command === undefined) {
					setText(undefined);
					return undefined;
				}
				const known = resolved.get(command);
				if (known !== undefined) {
					setText(known);
					return undefined;
				}
				setText(command);
				let live = true;
				requestFormatted(command).then((formatted) => {
					if (live) setText(formatted);
				});
				return () => {
					live = false;
				};
			}, [command]);
			return text;
		}

		/* ------------------------------------------------------------------ *
		 * Call shapes. The conversation hands this slot the same inputs the
		 * shipped bash row receives (`owner` + standard slot props).
		 * ------------------------------------------------------------------ */

		/**
		 * Parse a call's argument JSON.
		 * @param {unknown} argsRaw - raw argument string.
		 * @returns {Record<string, unknown> | undefined} parsed object arguments.
		 */
		function parseArgs(argsRaw) {
			if (typeof argsRaw !== 'string') return undefined;
			let value;
			try {
				value = JSON.parse(argsRaw);
			} catch {
				return undefined;
			}
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
		}

		/**
		 * Read a bash call out of the conversation's phase props.
		 * @param {string | undefined} phase - `preparing`, `start`, or `result`.
		 * @param {object} block - the block admitted at that phase.
		 * @returns {object} the call facts this row renders.
		 */
		function readCall(phase, block) {
			const settled = phase === 'result' || (typeof block === 'object' && block !== null && 'kind' in block);
			const preparing = !settled && (phase === 'preparing' || block?.phase === 'preparing');
			const running = !settled && !preparing;
			const argsRaw = settled ? block.call?.argsRaw ?? '' : running ? block.argsRaw : undefined;
			const args = parseArgs(argsRaw);
			const command = typeof args?.command === 'string' && args.command.trim() !== '' ? args.command : undefined;
			return {
				settled,
				preparing,
				running,
				args,
				command,
				description: typeof args?.description === 'string' ? args.description : undefined,
				workdir: typeof args?.workdir === 'string' ? args.workdir : undefined,
				background: args?.run_in_background === true,
			};
		}

		/**
		 * The single text block a first-party card derivation consumes.
		 * @param {object} block - settled Tool block.
		 * @returns {string | undefined} its text, or undefined for another layout.
		 */
		function singleResultText(block) {
			if (!Array.isArray(block.content) || block.content.length !== 1) return undefined;
			const only = block.content[0];
			return only !== null && typeof only === 'object' && only.type === 'text' ? only.text : undefined;
		}

		/**
		 * Split a settled result into output text and its exit marker.
		 * @param {string} text - rendered shell result text.
		 * @returns {{ output: string, exitCode: number | undefined, signal: string | undefined }}
		 */
		function parseExitStatus(text) {
			const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
			if (signal !== null && signal[1] !== undefined) {
				return { output: text.slice(0, signal.index), exitCode: undefined, signal: signal[1] };
			}
			const exit = /\n\[exit code: (\d+)\]$/.exec(text);
			if (exit !== null && exit[1] !== undefined) {
				return { output: text.slice(0, exit.index), exitCode: Number(exit[1]), signal: undefined };
			}
			return { output: text, exitCode: 0, signal: undefined };
		}

		/** Strip ANSI/VT escape sequences; see the module note on colour. */
		const ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

		/**
		 * Join one shell result's text for display.
		 * @param {object} block - settled Tool block.
		 * @returns {string} output text without escape sequences.
		 */
		function resultText(block) {
			if (!Array.isArray(block.content)) return '';
			const parts = [];
			for (const part of block.content) {
				if (part !== null && typeof part === 'object' && part.type === 'text') parts.push(String(part.text));
			}
			return parts.join('\n').replace(ESCAPE, '');
		}

		/**
		 * Resolve the directory a command ran in, for the prompt label.
		 * @param {string | undefined} workdir - the call's declared workdir.
		 * @param {string | undefined} sessionCwd - session workspace root.
		 * @returns {string | undefined} absolute display directory.
		 */
		function resolveCwd(workdir, sessionCwd) {
			if (workdir === undefined || workdir === '') return sessionCwd;
			if (workdir.startsWith('/')) return workdir;
			if (sessionCwd === undefined || sessionCwd === '') return workdir;
			return `${sessionCwd.replace(/[/\\]+$/, '')}/${workdir}`;
		}

		/**
		 * Prompt label for a directory: `~` for home, else its last segment.
		 * @param {string} cwd - display directory.
		 * @param {string | undefined} home - absolute home directory.
		 * @returns {string} the label.
		 */
		function promptLabel(cwd, home) {
			const trimmed = cwd.replace(/[/\\]+$/, '');
			if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~';
			const segment = trimmed.split(/[/\\]/).pop();
			return segment === undefined || segment === '' ? cwd : segment;
		}

		/**
		 * Head/tail cap arithmetic for a list of output rows.
		 * @param {number} total - row count.
		 * @param {number} maxLines - rows kept while collapsed.
		 * @param {boolean} expanded - whether the caller expanded the block.
		 * @returns {{ hidden: number, capped: boolean, headLines: number, tailLines: number }}
		 */
		function headTailCap(total, maxLines, expanded) {
			const hidden = total - maxLines;
			const headLines = Math.ceil(maxLines / 2);
			return { hidden, capped: hidden > 0 && !expanded, headLines, tailLines: maxLines - headLines };
		}

		/** Status pill text, or undefined for a clean settle. */
		function statusText(exitCode, signal, t) {
			if (signal !== undefined) return t('terminal.signal', { signal });
			if (exitCode === null) return t('terminal.noExitCode');
			if (exitCode !== undefined && exitCode !== 0) return t('terminal.exitCode', { code: exitCode });
			return undefined;
		}

		/** Run-state dot state and its (visually hidden) text label. */
		function runState(running, exitCode, signal, t) {
			if (running === true) return { state: 'ongoing', label: t('terminal.running') };
			if (statusText(exitCode, signal, t) !== undefined) return { state: 'error', label: t('terminal.failed') };
			return { state: 'done', label: t('terminal.done') };
		}

		/* ------------------------------------------------------------------ *
		 * Icons: the same artwork the shipped rows use, inlined because a
		 * client plugin may not import the primitives package.
		 * ------------------------------------------------------------------ */

		function svg(children, size, extra) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 16 16',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true',
					strokeWidth: 1,
					...extra,
				},
				children,
			);
		}

		const path = (d, key) => h('path', { d, stroke: 'currentColor', key });

		const BashIcon = () => svg([path('M3 4L7 8L3 12', 'a'), path('M9 12H13', 'b')], 14);
		const ChevronDownIcon = () => svg(path('M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', 'c'), 14);
		const ChevronUpIcon = () => svg(path('M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10', 'd'), 14);
		const InspectIcon = () =>
			svg(
				[
					path('M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494', 'e'),
					path('M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494', 'f'),
					path('M9.56222 3.62573L6.43774 12.3743', 'g'),
				],
				12,
			);

		/**
		 * Run-state indicator: a state-coloured core, or the host's spinner.
		 * @param {{ state: string }} props - dot state.
		 * @returns {object} the indicator element.
		 */
		function RunStateDot({ state }) {
			if (state === 'ongoing') {
				return h(
					'svg',
					{ className: css.spinnerDot, 'data-state': 'ongoing', width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
					h(
						'g',
						{ className: css.spinnerMotion },
						h('circle', { className: css.spinnerTrack, cx: '12', cy: '12', r: '9.5' }),
						h('circle', { className: css.spinnerArc, cx: '12', cy: '12', r: '9.5' }),
					),
				);
			}
			return h('span', { className: css.dot, 'data-state': state, 'aria-hidden': 'true' });
		}

		/* ------------------------------------------------------------------ *
		 * Clipboard feedback shared by the terminal block's copy control.
		 * ------------------------------------------------------------------ */

		/**
		 * Copy `text` with one-second success feedback.
		 * @param {string} text - the text to write.
		 * @returns {{ copied: boolean, onCopy: () => void }}
		 */
		function useCopyFeedback(text) {
			const [copied, setCopied] = React.useState(false);
			const onCopy = React.useCallback(() => {
				if (copied) return;
				let write;
				try {
					write = navigator.clipboard.writeText(text);
				} catch {
					return;
				}
				Promise.resolve(write).then(
					() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
					},
					() => {},
				);
			}, [copied, text]);
			return { copied, onCopy };
		}

		/* ------------------------------------------------------------------ *
		 * Terminal surface: the shipped TerminalBlock's markup and CSS with
		 * the command supplied by this plugin instead of the raw arguments.
		 * ------------------------------------------------------------------ */

		/**
		 * Render a shell command and its output as a terminal card.
		 * @param {object} props - command, cwd, output, status and locale seat.
		 * @returns {object} the terminal card.
		 */
		function TerminalSurface({ command, cwd, home, output, exitCode, signal, running, t }) {
			const text = output === undefined ? '' : output;
			const lines = text === '' ? [''] : text.split('\n');
			const [expanded, setExpanded] = React.useState(false);
			const { copied, onCopy } = useCopyFeedback(command);
			const commandLines = (command.endsWith('\n') ? command.slice(0, -1) : command).split('\n');
			const empty = lines.every((line) => line.trim() === '');
			const { hidden, capped, headLines, tailLines } = headTailCap(lines.length, TERMINAL_MAX_LINES, expanded);
			const status = statusText(exitCode, signal, t);
			const state = runState(running, exitCode, signal, t);
			const body = running !== true || !empty;
			return h(
				'div',
				{
					className: css.term,
					'data-terminal': '',
					'data-running': running === true ? '' : undefined,
					'data-body': body ? '' : undefined,
				},
				h(
					'div',
					{ className: css.termHeader },
					h(
						'div',
						{ className: css.prompt },
						h('span', { className: css.runStateLabel }, state.label),
						commandLines.map((line, index) =>
							h(
								'div',
								{ className: css.promptLine, key: index },
								index === 0 ? h(RunStateDot, { state: state.state }) : null,
								h('span', { className: css.termCwd }, index > 0 || cwd === undefined ? '$' : promptLabel(cwd, home)),
								h('span', { className: css.command }, line),
							),
						),
					),
					status !== undefined ? h('span', { className: css.status }, status) : null,
					h('button', { type: 'button', className: css.copyButton, onClick: onCopy }, copied ? t('copied') : t('copy')),
				),
				body
					? empty
						? h('div', { className: css.empty }, t('terminal.noOutput'))
						: h(
								'div',
								{ className: css.output },
								(capped ? lines.slice(0, headLines) : lines).map((line, index) =>
									h('div', { className: css.line, key: index }, line),
								),
								hidden > 0
									? h(
											'button',
											{
												type: 'button',
												className: css.expand,
												'aria-expanded': expanded,
												'aria-label': expanded ? t('terminal.collapseAria') : t('terminal.expandAria', { n: hidden }),
												onClick: () => setExpanded((value) => !value),
											},
											expanded ? t('collapse') : t('terminal.expandRest', { n: hidden }),
										)
									: null,
								capped
									? lines
											.slice(lines.length - tailLines)
											.map((line, index) => h('div', { className: css.line, key: `tail-${index}` }, line))
									: null,
							)
					: null,
			);
		}

		/* ------------------------------------------------------------------ *
		 * The shadowed bash row.
		 * ------------------------------------------------------------------ */

		/**
		 * Render one bash tool call with its command formatted by the Host.
		 * @param {object} props - the keyed toolview's owner and slot props.
		 * @returns {object} the bash row.
		 */
		function BashRow(props) {
			const t = props.t;
			const call = readCall(props.phase, props.block);
			const formatted = useFormatted(call.command);
			const own = React.useState(false);
			const provided = props.useDisclosure;
			const disclosure = provided !== undefined ? provided() : { expanded: own[0], toggle: () => own[1]((value) => !value) };
			const sessionCwd = props.cwd;
			const home = props.home;
			const cwd = resolveCwd(call.workdir, sessionCwd);
			const settled = call.settled ? props.block : undefined;
			const errorCode = settled !== undefined && settled.error !== undefined ? settled.error.code : undefined;
			const shown =
				call.preparing
					? 'preparing'
					: call.running
						? 'running'
						: errorCode === 'interrupted'
							? 'stopped'
							: settled !== undefined && settled.isError === true
								? 'error'
								: 'ok';
			const rawOutput = settled === undefined ? undefined : resultText(settled);
			const background = call.background;
			const failed = settled !== undefined && settled.isError === true;
			// Mirrors the shipped terminal model: a running command, and a settled
			// clean foreground command, render as a terminal; a failed, background or
			// spilled result falls back to the generic IN/OUT card without inventing a
			// process status.
			const terminal = call.running
				? { output: undefined, exitCode: undefined, signal: undefined, running: true }
				: settled !== undefined && !failed && !background
					? { ...parseExitStatus(rawOutput ?? ''), running: false }
					: undefined;
			// A failing command settles as a *completed* call (the exit status is
			// result data, `isError` stays false), so the collapsed row's only failure
			// signal is the parsed status — the same promotion the shipped row makes.
			const terminalFailed =
				terminal !== undefined &&
				terminal.running !== true &&
				((terminal.exitCode !== undefined && terminal.exitCode !== 0) || terminal.signal !== undefined);
			const state = terminalFailed && shown === 'ok' ? 'error' : shown;
			const expandable = call.command !== undefined && (call.running || settled !== undefined);
			const open = disclosure.expanded && expandable;
			const summary =
				call.description ??
				(call.preparing
					? t('row.preparing')
					: formatted !== undefined
						? formatted.split('\n')[0]
						: props.callId);
			const statusLabel =
				state === 'running'
					? t('bash.running')
					: state === 'error' || state === 'stopped'
						? state === 'error'
							? t('bash.failed')
							: t('bash.stopped')
						: null;
			const onKeyDown = (event) => {
				if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
				event.preventDefault();
				disclosure.toggle();
			};
			const leading = open
				? h(ChevronUpIcon)
				: expandable
					? h(
							React.Fragment,
							null,
							h('span', { className: css.iconIdle }, h(BashIcon)),
							h('span', { className: css.chevronHover }, h(ChevronDownIcon)),
						)
					: h(BashIcon);
			const body =
				formatted === undefined
					? null
					: terminal !== undefined
						? h(TerminalSurface, {
								command: formatted,
								cwd,
								home,
								output: terminal.output,
								exitCode: terminal.exitCode,
								signal: terminal.signal,
								running: terminal.running,
								t,
							})
						: h(
								'div',
								{ className: css.ioCard },
								h(
									'div',
									{ className: css.ioSection },
									h('span', { className: css.ioLabel }, t('row.input')),
									h('span', { className: css.ioText }, formatted),
								),
								h('span', { className: css.ioDivider, 'aria-hidden': true }),
								h(
									'div',
									{ className: css.ioSection },
									h('span', { className: css.ioLabel }, t('row.output')),
									h(
										'span',
										{ className: css.ioText, 'data-error': failed ? '' : undefined },
										rawOutput === undefined || rawOutput === '' ? t('terminal.noOutput') : rawOutput,
									),
								),
							);
			return h(
				'div',
				{ className: css.card },
				h(
					'div',
					{
						className: css.root,
						'data-sample': 'bash',
						'data-variant': 'bash',
						'data-state': state,
						'data-expandable': expandable ? '' : undefined,
						role: expandable ? 'button' : undefined,
						tabIndex: expandable ? 0 : undefined,
						'aria-expanded': expandable ? open : undefined,
						onClick: expandable ? disclosure.toggle : undefined,
						onKeyDown: expandable ? onKeyDown : undefined,
					},
					h('span', { className: css.leading }, leading),
					statusLabel !== null ? h('span', { className: css.visuallyHidden }, statusLabel) : null,
					h('span', { className: css.title }, t('tool.title.bash')),
					h('span', { className: css.sep, 'aria-hidden': true }),
					h(
						'span',
						{
							className: `${css.summary}${state === 'error' ? ` ${css.errorSummary}` : ''}${state === 'stopped' ? ` ${css.stoppedSummary}` : ''}`,
						},
						summary,
					),
				),
				open ? h('div', { className: css.bodyWrap }, body) : null,
				open && typeof props.inspect === 'function'
					? h(
							'button',
							{ type: 'button', className: css.inspectButton, onClick: props.inspect },
							h(InspectIcon),
							t('row.inspect'),
						)
					: null,
			);
		}

		/* ------------------------------------------------------------------ *
		 * The shadowed approval detail: the shipped row prints the raw
		 * command under the approval headline.
		 * ------------------------------------------------------------------ */

		/**
		 * Render the command of the Tool call correlated with an approval.
		 * @param {object} props - approval identity and the Chat selector hook.
		 * @returns {object | null} the formatted command, or null without one.
		 */
		function ApprovalCommand(props) {
			const useChat = props.useChat;
			const command =
				typeof useChat === 'function'
					? useChat((snapshot) => {
							for (const node of snapshot.nodes.values()) {
								const root = node.kind === 'tool-call' ? node.data.root : undefined;
								if (root === undefined || root.callId !== props.callId) continue;
								if ('kind' in root || root.phase !== 'start') continue;
								const args = parseArgs(root.argsRaw);
								return typeof args?.command === 'string' ? args.command : undefined;
							}
							return undefined;
						})
					: undefined;
			const formatted = useFormatted(command);
			if (formatted === undefined) return null;
			return h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, formatted);
		}

		/* ------------------------------------------------------------------ *
		 * Styles: copied from the shipped bash row and terminal block, with
		 * this plugin's class names and theme tokens only.
		 * ------------------------------------------------------------------ */

		const CSS = [
			'.bsf_card{flex-direction:column;display:flex}',
			'.bsf_root{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;transition:color .1s;display:flex}',
			'.bsf_root:hover{color:var(--dsw-alias-label-secondary)}',
			'.bsf_root[data-expandable]{cursor:pointer}',
			'.bsf_leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}',
			'.bsf_leading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
			'.bsf_iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}',
			'.bsf_chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}',
			'.bsf_root:hover .bsf_iconIdle{opacity:0}',
			'.bsf_root:hover .bsf_chevronHover{opacity:1}',
			'.bsf_title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}',
			'.bsf_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
			'.bsf_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}',
			'.bsf_errorSummary{color:var(--dsw-alias-state-error-primary)}',
			'.bsf_stoppedSummary{color:var(--dsw-alias-state-warn-label)}',
			'.bsf_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}',
			'.bsf_bodyWrap{flex-direction:column;display:flex}',
			'.bsf_inspectButton{border:.5px solid var(--dsw-alias-border-l4);corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}',
			'.bsf_card:hover .bsf_inspectButton,.bsf_inspectButton:focus-visible{opacity:1}',
			'.bsf_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}',
			'.bsf_ioCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}',
			'.bsf_ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}',
			'.bsf_ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}',
			'.bsf_ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:.5px}',
			'.bsf_ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}',
			'.bsf_ioText[data-error]{color:var(--dsw-alias-state-error-primary)}',
			'.bsf_term{--bsf-terminal-line-height:18px;--bsf-terminal-font:var(--dsw-font-markdown-code-block-small);--bsf-terminal-gutter:30px;position:relative;margin:4px 0 4px 4px;padding-left:var(--bsf-terminal-gutter);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden}',
			'.bsf_termHeader{display:flex;align-items:flex-start;gap:12px;margin-left:calc(-1 * var(--bsf-terminal-gutter));padding:9px 14px 9px var(--bsf-terminal-gutter);max-height:150px;overflow-y:auto}',
			'.bsf_term[data-body] .bsf_termHeader{border-bottom:.5px solid var(--dsw-alias-border-l2)}',
			'.bsf_prompt{display:flex;flex-direction:column;min-width:0;flex:1;font:var(--bsf-terminal-font)}',
			'.bsf_promptLine{position:relative;display:flex;align-items:baseline;gap:8px;min-width:0;line-height:var(--bsf-terminal-line-height)}',
			'.bsf_runStateLabel{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
			'.bsf_termCwd{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.bsf_command{min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:pre;overflow-wrap:anywhere}',
			'.bsf_status{flex:none;position:sticky;top:0;display:inline-flex;align-items:center;height:var(--bsf-terminal-line-height);padding:0 8px;border-radius:999px;corner-shape:round;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}',
			'.bsf_copyButton{flex:none;position:sticky;top:0;background-color:var(--dsw-alias-markdown-code-block);border:none;padding:0;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);line-height:var(--bsf-terminal-line-height)}',
			'.bsf_output{padding:12px 14px 12px 0;font:var(--bsf-terminal-font);overflow-x:auto;overflow-y:auto}',
			'.bsf_line{min-height:var(--bsf-terminal-line-height);white-space:pre;overflow-wrap:anywhere}',
			'.bsf_expand{display:block;width:100%;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left}',
			'.bsf_expand:hover{color:var(--dsw-alias-label-secondary)}',
			'.bsf_empty{padding:12px 14px 12px 0;font:var(--bsf-terminal-font);color:var(--dsw-alias-label-tertiary)}',
			'.bsf_dot{position:relative;display:inline-block;flex:none;width:10px;height:10px}',
			'.bsf_dot::after{content:"";position:absolute;inset:20%;border-radius:50%;corner-shape:round;background:currentColor}',
			'.bsf_dot[data-state="done"]{color:var(--dsw-alias-state-success-primary)}',
			'.bsf_dot[data-state="error"]{color:var(--dsw-alias-state-error-primary)}',
			'.bsf_dot[data-state="ongoing"]{color:var(--dsw-alias-label-tertiary)}',
			'.bsf_promptLine .bsf_dot,.bsf_promptLine .bsf_spinnerDot{position:absolute;left:calc(-1 * var(--bsf-terminal-gutter) + 8px);top:50%;transform:translateY(-50%)}',
			'.bsf_spinnerDot{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.bsf_spinnerMotion{transform-origin:center;animation:bsf-state-dot-spin 1.5s linear infinite}',
			'.bsf_spinnerTrack,.bsf_spinnerArc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}',
			'.bsf_spinnerTrack{opacity:.25}',
			'.bsf_spinnerArc{stroke-dasharray:12 150;animation:bsf-state-dot-dash 1.5s ease-in-out infinite}',
			'@keyframes bsf-state-dot-spin{to{transform:rotate(360deg)}}',
			'@keyframes bsf-state-dot-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}',
			'@media (prefers-reduced-motion:reduce){.bsf_root{transition:none}.bsf_spinnerMotion,.bsf_spinnerArc{animation:none}.bsf_spinnerArc{stroke-dasharray:18 150;stroke-dashoffset:-3}}',
		].join('');

		const css = {
			card: 'bsf_card',
			root: 'bsf_root',
			leading: 'bsf_leading',
			iconIdle: 'bsf_iconIdle',
			chevronHover: 'bsf_chevronHover',
			title: 'bsf_title',
			sep: 'bsf_sep',
			summary: 'bsf_summary',
			errorSummary: 'bsf_errorSummary',
			stoppedSummary: 'bsf_stoppedSummary',
			visuallyHidden: 'bsf_visuallyHidden',
			bodyWrap: 'bsf_bodyWrap',
			inspectButton: 'bsf_inspectButton',
			ioCard: 'bsf_ioCard',
			ioSection: 'bsf_ioSection',
			ioLabel: 'bsf_ioLabel',
			ioDivider: 'bsf_ioDivider',
			ioText: 'bsf_ioText',
			term: 'bsf_term',
			termHeader: 'bsf_termHeader',
			prompt: 'bsf_prompt',
			promptLine: 'bsf_promptLine',
			runStateLabel: 'bsf_runStateLabel',
			termCwd: 'bsf_termCwd',
			command: 'bsf_command',
			status: 'bsf_status',
			copyButton: 'bsf_copyButton',
			output: 'bsf_output',
			line: 'bsf_line',
			expand: 'bsf_expand',
			empty: 'bsf_empty',
			dot: 'bsf_dot',
			spinnerDot: 'bsf_spinnerDot',
			spinnerMotion: 'bsf_spinnerMotion',
			spinnerTrack: 'bsf_spinnerTrack',
			spinnerArc: 'bsf_spinnerArc',
		};

		/** Style tag identity, so a reload replaces rather than duplicates it. */
		const STYLE_TAG = `${NS}/client.css`;

		/**
		 * Append this plugin's stylesheet once.
		 * @returns {() => void} disposer removing the tag.
		 */
		function injectStyles() {
			if (typeof document === 'undefined') return () => {};
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		return {
			inject: ['slots', 'locale'],
			/**
			 * Register the dictionary, the stylesheet, and the two shadowing rows.
			 * @param {object} ctx - the client plugin context.
			 */
			apply(ctx) {
				ctx.effect(() => injectStyles(), `${NS}: client styles`);
				ctx.locale.register(NS, 'en', en);
				ctx.locale.register(NS, 'zh', zh);
				ctx.slots.inject('conversation.approval.detail', () =>
					ctx.slots.register({ name: 'conversation.approval.detail', priority: -1, locale: NS }, ApprovalCommand),
				);
				ctx.slots.inject('tool.call.toolview', () =>
					ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', priority: -1, locale: NS }, BashRow),
				);
			},
		};
	},
});
