/**
 * Client-half smoke test: load `client.js` the way the module loader does, run
 * `apply` against a stand-in slot registry, and render both shadow components
 * through a minimal hook-aware renderer.
 *
 * This is the closest verification available without a browser: it proves the
 * bundle's envelope and `apply` registration shape, and that the row renders a
 * formatted command for preparing, running and settled calls instead of throwing
 * (a throwing entry abdicates to the shipped row, so a crash here would be
 * silent in the GUI).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMAT_PATH } from '../lib/index.js';

/* ------------------------------------------------------------------ *
 * Module-loader and browser stand-ins
 * ------------------------------------------------------------------ */

/** One captured `__ModuleLoader__.load` call. */
let loaded;

globalThis.window = {
	__ModuleLoader__: {
		load(entry) {
			loaded = entry;
		},
	},
};
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
	head: { appendChild() {} },
};

/** Requests the client sent to the Host route. */
const requested = [];

globalThis.fetch = (route, init) => {
	const command = JSON.parse(init.body).command;
	requested.push({ route, command });
	return Promise.resolve({
		ok: true,
		json: () => Promise.resolve({ formatted: command.split('; ').join('\n'), applied: true }),
	});
};

/* ------------------------------------------------------------------ *
 * A minimal hook-aware renderer (React DOM is not available here)
 * ------------------------------------------------------------------ */

/**
 * Build a React stand-in able to render function components with hooks.
 * @returns {object} the stub plus `render` and `unmount`.
 */
function createRenderer() {
	const cellsByPath = new Map();
	const cleanups = [];
	let cells = [];
	let index = 0;
	let pending = [];
	let rerender = false;

	const depsChanged = (prev, next) =>
		prev === undefined || next === undefined || prev.length !== next.length || next.some((dep, i) => dep !== prev[i]);

	const React = {
		Fragment: Symbol('react.fragment'),
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
		useState(initial) {
			const cell = (cells[index++] ??= {});
			if (!('value' in cell)) cell.value = typeof initial === 'function' ? initial() : initial;
			return [
				cell.value,
				(next) => {
					cell.value = typeof next === 'function' ? next(cell.value) : next;
					rerender = true;
				},
			];
		},
		useEffect(effect, deps) {
			const cell = (cells[index++] ??= {});
			if (depsChanged(cell.deps, deps)) {
				cell.deps = deps;
				pending.push(effect);
			}
		},
		useCallback(fn, deps) {
			const cell = (cells[index++] ??= {});
			if (depsChanged(cell.deps, deps)) cell.value = fn;
			cell.deps = deps;
			return cell.value;
		},
		useMemo(fn, deps) {
			const cell = (cells[index++] ??= {});
			if (depsChanged(cell.deps, deps)) cell.value = fn();
			cell.deps = deps;
			return cell.value;
		},
	};

	/**
	 * Render one node tree, expanding function components.
	 * @param {unknown} node - element, array, or text.
	 * @param {string} path - instance path used to key hook cells.
	 * @returns {unknown} the host-element tree.
	 */
	function render(node, path) {
		if (node === null || node === undefined || typeof node !== 'object') return node;
		if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}.${i}`));
		const { type, props, children } = node;
		const full = { ...props, children: children.length === 1 ? children[0] : children };
		if (type === React.Fragment) return render(full.children, path);
		if (typeof type === 'function') {
			const key = `${path}<${type.name}>`;
			const savedCells = cells;
			const savedIndex = index;
			cells = cellsByPath.get(key) ?? [];
			cellsByPath.set(key, cells);
			index = 0;
			const out = type(full);
			cells = savedCells;
			index = savedIndex;
			return render(out, key);
		}
		return { type, props: full, children: render(full.children, path) };
	}

	return {
		React,
		/**
		 * Render a component to a settled tree.
		 * @param {Function} component - the component under test.
		 * @param {object} props - its props.
		 * @returns {Promise<unknown>} the host-element tree.
		 */
		async render(component, props) {
			let tree;
			for (let pass = 0; pass < 8; pass += 1) {
				rerender = false;
				pending = [];
				tree = render(React.createElement(component, props), 'root');
				for (const effect of pending) {
					const cleanup = effect();
					if (typeof cleanup === 'function') cleanups.push(cleanup);
				}
				await new Promise((resolve) => setImmediate(resolve));
				if (!rerender) break;
			}
			return tree;
		},
		unmount() {
			for (const cleanup of cleanups.splice(0)) cleanup();
		},
	};
}

/**
 * Collect every string in a rendered tree.
 * @param {unknown} node - rendered tree.
 * @param {string[]} [into] - accumulator.
 * @returns {string[]} the strings found.
 */
function text(node, into = []) {
	if (typeof node === 'string' || typeof node === 'number') into.push(String(node));
	else if (Array.isArray(node)) for (const child of node) text(child, into);
	else if (node !== null && typeof node === 'object' && 'props' in node && node.type !== 'style') text(node.children, into);
	return into;
}

/**
 * Find the first rendered element matching a predicate.
 * @param {unknown} node - rendered tree.
 * @param {(element: object) => boolean} match - predicate.
 * @returns {object | undefined} the element, if any.
 */
function find(node, match) {
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = find(child, match);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	if (node === null || typeof node !== 'object' || !('props' in node)) return undefined;
	if (match(node)) return node;
	return find(node.children, match);
}

/* ------------------------------------------------------------------ *
 * Load the bundle
 * ------------------------------------------------------------------ */

await import('../client.js');

/**
 * Re-load the bundle's factory with one renderer's React and mount it.
 * @param {object} renderer - the renderer supplying the React stub.
 * @returns {{ options: object, component: Function }[]} the captured registrations.
 */
function mount(renderer) {
	const bundle = loaded.factory((id) => {
		if (id === 'react') return renderer.React;
		throw new Error(`client.js required an unexpected module: ${id}`);
	});
	const registrations = [];
	bundle.apply({
		effect: (register) => register(),
		locale: { register: () => {} },
		slots: {
			inject: (_key, callback) => callback(),
			register: (options, component) => registrations.push({ options, component }),
		},
	});
	return registrations;
}

const initial = mount(createRenderer());

test('the bundle registers under its package name', () => {
	assert.equal(loaded.id, 'dsh-bash-shfmt');
});

test('both shadowing entries register above the shipped ones', () => {
	assert.equal(initial.length, 2);
	const toolview = initial.find((entry) => entry.options.name === 'tool.call.toolview');
	const approval = initial.find((entry) => entry.options.name === 'conversation.approval.detail');
	assert.equal(toolview.options.key, 'bash');
	assert.equal(toolview.options.priority, -1);
	assert.equal(toolview.options.locale, 'dsh-bash-shfmt');
	assert.equal(approval.options.priority, -1);
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** A settled bash block with one text result, as the conversation hands it over. */
const settledBlock = (command, output, isError = false) => ({
	kind: 'tool-result',
	call: { callId: 'c1', name: 'bash', argsRaw: JSON.stringify({ command, description: 'List plugins' }) },
	content: [{ type: 'text', text: output }],
	isError,
});

/** A locale seat whose text names the key and its values. */
const t = (key, values) => `${key}${values === undefined ? '' : ` ${Object.values(values).join(',')}`}`;

test('the approval row shows the formatted command', async () => {
	const renderer = createRenderer();
	const approval = mount(renderer).find((entry) => entry.options.name === 'conversation.approval.detail').component;
	const chat = {
		nodes: new Map([
			[
				'c1',
				{
					kind: 'tool-call',
					data: { root: { callId: 'c1', phase: 'start', argsRaw: JSON.stringify({ command: 'cd /tmp; ls -la' }) } },
				},
			],
		]),
	};
	const tree = await renderer.render(approval, { callId: 'c1', useChat: (selector) => selector(chat) });
	// The client posts to the same-origin path of the Host's one route.
	assert.deepEqual(requested.at(-1), { route: FORMAT_PATH.slice(1), command: 'cd /tmp; ls -la' });
	assert.ok(
		text(tree).join('').includes('cd /tmp\nls -la'),
		`expected the formatted command, got ${JSON.stringify(text(tree))}`,
	);
	renderer.unmount();
});

test('the bash row renders the formatted command and its output', async () => {
	const renderer = createRenderer();
	const row = mount(renderer).find((entry) => entry.options.name === 'tool.call.toolview').component;
	const useDisclosure = () => {
		const [expanded, setExpanded] = renderer.React.useState(false);
		return { expanded, toggle: () => setExpanded((value) => !value) };
	};
	const props = {
		phase: 'result',
		block: settledBlock('cd /tmp; ls -la', 'total 0\n[exit code: 2]'),
		callId: 'c1',
		toolName: 'bash',
		cwd: '/home/user/.dsh',
		home: '/home/user',
		useDisclosure,
		inspect: () => {},
		t,
	};
	const collapsed = await renderer.render(row, props);
	// A non-zero exit is result data, so the collapsed row is the only place the
	// failure shows; the shipped row promotes `ok` to `error` for it.
	assert.equal(find(collapsed, (element) => element.props['data-sample'] === 'bash').props['data-state'], 'error');
	// The collapsed summary prefers the call's description.
	assert.ok(text(collapsed).join('|').includes('List plugins'), `collapsed summary: ${JSON.stringify(text(collapsed))}`);

	// Expand the row through the root's own click handler.
	const root = find(collapsed, (element) => typeof element.props.onClick === 'function');
	root.props.onClick();
	const expanded = await renderer.render(row, props);
	const rendered = text(expanded).join('|');
	// Each formatted line is its own terminal prompt row, exactly like the shipped
	// terminal block.
	const promptRows = [];
	const collect = (node) => {
		if (Array.isArray(node)) return node.forEach(collect);
		if (node === null || typeof node !== 'object' || !('props' in node)) return;
		if (node.props.className === 'bsf_promptLine') promptRows.push(node);
		collect(node.children);
	};
	collect(expanded);
	assert.equal(promptRows.length, 2, `expected one prompt row per formatted line: ${rendered}`);
	assert.ok(
		rendered.includes('cd /tmp') && rendered.indexOf('cd /tmp') < rendered.indexOf('ls -la'),
		`expected the formatted command in order, got ${JSON.stringify(text(expanded))}`,
	);
	assert.ok(rendered.includes('total 0'), 'expected the command output');
	assert.ok(rendered.includes('terminal.exitCode 2'), `expected the exit-status pill, got ${JSON.stringify(text(expanded))}`);
	renderer.unmount();
});

test('the bash row renders preparing and failed calls', async () => {
	const renderer = createRenderer();
	const row = mount(renderer).find((entry) => entry.options.name === 'tool.call.toolview').component;

	const preparing = await renderer.render(row, {
		phase: 'preparing',
		block: { callId: 'c1', name: 'bash' },
		callId: 'c1',
		toolName: 'bash',
		useDisclosure: () => ({ expanded: false, toggle: () => {} }),
		t,
	});
	assert.ok(text(preparing).join('|').includes('row.preparing'), `preparing row: ${JSON.stringify(text(preparing))}`);

	const failed = await renderer.render(row, {
		phase: 'result',
		block: settledBlock('exit 1', 'boom\n[exit code: 1]', true),
		callId: 'c2',
		toolName: 'bash',
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		t,
	});
	const failedText = text(failed).join('|');
	assert.ok(failedText.includes('row.output'), `failed call body: ${failedText}`);
	assert.ok(failedText.includes('boom'), 'failed call keeps its output');
	renderer.unmount();
});
