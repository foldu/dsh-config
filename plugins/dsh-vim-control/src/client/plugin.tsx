/**
 * The Client plugin body: modes, the row cursor, navigation actions, and the
 * badge.
 *
 * Keys are captured on `window` in the capture phase so a NORMAL-mode `j` never
 * reaches the composer, while INSERT mode (or any focus inside a text surface)
 * passes everything through untouched.
 *
 * @module plugin
 */
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react';
import type { ClientContext } from './types';
import { createStore, type RowList, type VimState } from './state';
import { routeNormal, type Action } from './keymap';
import {
  blurActive,
  clearCursor,
  findSubagentTrigger,
  focusComposer,
  hostModalOpen,
  isEditable,
  menuOpen,
  paint,
  rowsOf,
  scrollableAncestor,
} from './dom';

/** Locale namespace owned by this plugin. */
const NS = 'vim.control';

/** Persisted master switch; absent means off. */
const STORAGE_KEY = 'dsh.vim-control.enabled';

/** How long a transient note stays in the chip. */
const HINT_MS = 2600;

/** Delay before reading a popover the shell opens asynchronously. */
const POPOVER_MS = 180;

/** Read the stored switch; a denied store means off. */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the switch; a denied store must not break the toggle. */
function writeStored(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* private mode or a full store: the switch still works for this page */
  }
}

/** Clamp an index into a row count. */
function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * Apply the plugin to the Client context.
 * @param ctx - Client plugin context (slots, locale, layout, workspace).
 */
export function apply(ctx: ClientContext): void {
  const store = createStore({
    enabled: readStored(),
    mode: 'normal',
    command: '',
    help: false,
    list: 'chat',
    cursor: 0,
    hint: '',
    pending: '',
  });
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'vim-control.locale');

  const t = ctx.locale.bind(NS);
  let hintTimer: number | undefined;

  /**
   * Focus changes caused by our own navigation must not flip to INSERT. The
   * shell focuses a conversation's composer while opening it, so a typed key
   * would otherwise land in the editor instead of the row cursor.
   */
  let suppressInsertUntil = 0;

  /** Show a transient note in the chip. */
  const hint = (text: string): void => {
    window.clearTimeout(hintTimer);
    store.set({ hint: text });
    hintTimer = window.setTimeout(() => store.set({ hint: '' }), HINT_MS);
  };

  /** Keep an imminent focus change from switching to INSERT. */
  const suppressAutoInsert = (): void => {
    suppressInsertUntil = Date.now() + 400;
  };

  /** @returns the list the cursor currently addresses. */
  const activeList = (): RowList => {
    const current = store.get().list;
    if (rowsOf(current).length > 0) return current;
    if (current === 'chat' && rowsOf('sessions').length > 0) return 'sessions';
    if (current === 'sessions' && rowsOf('chat').length > 0) return 'chat';
    if (rowsOf('tree').length > 0) return 'tree';
    return current;
  };

  /** Move the cursor inside the active list. */
  const move = (delta: number, absolute?: number): void => {
    const list = activeList();
    const rows = rowsOf(list);
    if (rows.length === 0) {
      hint(t('hint.noRows'));
      return;
    }
    const state = store.get();
    const index = absolute === undefined ? clamp(state.cursor + delta, rows.length) : clamp(absolute, rows.length);
    store.set({ list, cursor: index });
    // The conversation follows the cursor; the sidebar only nudges into view.
    paint(rows[index] ?? null, list === 'sessions' ? 'nearest' : 'center');
  };

  /** Move the cursor to the chat row closest to the viewport's centre line. */
  const snapCursor = (scroller: HTMLElement): void => {
    const rows = rowsOf('chat');
    if (rows.length === 0) return;
    const box = scroller.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      const visible = rect.bottom > box.top && rect.top < box.bottom;
      const gap = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (visible && gap < distance) {
        distance = gap;
        best = index;
      }
    });
    if (best < 0) return;
    store.set({ list: 'chat', cursor: best });
    paint(rows[best] ?? null, 'nearest');
  };

  /** Page the conversation itself, then settle the cursor on what is visible. */
  const page = (direction: 1 | -1): void => {
    const list = activeList();
    const rows = rowsOf(list);
    const first = rows[0];
    const scroller = first === undefined ? null : scrollableAncestor(first);
    if (list !== 'chat' || scroller === null) {
      move(direction * 10);
      return;
    }
    scroller.scrollBy({ top: direction * Math.round(scroller.clientHeight * 0.8) });
    snapCursor(scroller);
  };

  /** Open the row under the cursor through its own handler. */
  const activate = (): void => {
    const rows = rowsOf(activeList());
    const row = rows[clamp(store.get().cursor, rows.length)];
    if (row === undefined) return;
    const control =
      row.matches('[data-row-key], [role="treeitem"]')
        ? row
        : (row.querySelector<HTMLElement>('[aria-expanded]') ?? row);
    suppressAutoInsert();
    control.click();
    if (row.dataset.rowKey?.startsWith('session:') === true) store.set({ list: 'chat', cursor: 0 });
  };

  /** Select and open one session, or report why it could not. */
  const openSession = (id: string): void => {
    try {
      ctx.uiWorkspace.openSession(id);
    } catch (error) {
      hint(error instanceof Error ? error.message : String(error));
    }
  };

  /** Step through the session sidebar, wrapping at both ends. */
  const cycleSession = (delta: number): void => {
    const rows = rowsOf('sessions');
    if (rows.length === 0) {
      ctx.layout.toggleSidebar();
      hint(t('hint.sidebar'));
      window.setTimeout(() => cycleSession(delta), POPOVER_MS);
      return;
    }
    const selected = rows.findIndex((row) => row.getAttribute('aria-selected') === 'true');
    const base = selected < 0 ? (delta > 0 ? -1 : 0) : selected;
    const index = ((base + delta) % rows.length + rows.length) % rows.length;
    const row = rows[index];
    if (row === undefined) return;
    const id = (row.dataset.rowKey ?? '').slice('session:'.length);
    if (id === '') return;
    paint(row);
    suppressAutoInsert();
    openSession(id);
    // The jump lands in the conversation, so j/k keep working there.
    store.set({ list: 'chat', cursor: 0 });
  };

  /** Focus the open subagent catalog, opening it first when needed. */
  const showSubagents = (direction?: 1 | -1): void => {
    const tree = document.querySelector('[role="tree"]');
    if (tree !== null) {
      const rows = rowsOf('tree');
      const index = direction === -1 ? rows.length - 1 : 0;
      store.set({ list: 'tree', cursor: clamp(index, rows.length) });
      paint(rows[clamp(index, rows.length)] ?? null, 'center');
      return;
    }
    const trigger = findSubagentTrigger();
    if (trigger === null) {
      hint(t('hint.noSubagents'));
      return;
    }
    trigger.click();
    window.setTimeout(() => {
      if (document.querySelector('[role="tree"]') === null) {
        hint(t('hint.noSubagents'));
        return;
      }
      store.set({ list: 'tree', cursor: 0 });
      paint(rowsOf('tree')[0] ?? null, 'center');
    }, POPOVER_MS);
  };

  /** Switch the master switch. */
  const setEnabled = (value: boolean): void => {
    writeStored(value);
    store.set({ enabled: value, mode: 'normal', pending: '', help: false, command: '', hint: '' });
    if (!value) clearCursor();
  };

  /** Run one `:` line. */
  const runCommand = (line: string): void => {
    const raw = line.trim();
    store.set({ command: '', mode: 'normal' });
    if (raw === '') return;
    const parts = raw.split(/\s+/);
    const name = parts[0] ?? '';
    const argument = parts.slice(1).join(' ');
    switch (name) {
      case 'q':
      case 'quit':
        setEnabled(false);
        return;
      case 'vim':
        setEnabled(argument !== 'off');
        return;
      case 'new':
        suppressAutoInsert();
        ctx.uiWorkspace.startSession();
        store.set({ list: 'chat', cursor: 0 });
        return;
      case 'o':
      case 'open':
        if (argument === '') {
          hint(t('hint.usage'));
          return;
        }
        suppressAutoInsert();
        openSession(argument);
        store.set({ list: 'chat', cursor: 0 });
        return;
      case 's':
      case 'sessions':
        ctx.layout.toggleSidebar();
        store.set({ list: 'sessions' });
        return;
      case 'a':
      case 'agents':
        showSubagents();
        return;
      case 'c':
      case 'conv':
        ctx.layout.selectPanel(null);
        store.set({ list: 'chat' });
        return;
      case 'help':
        store.set({ help: true });
        return;
      default:
        hint(t('hint.unknown', { name }));
    }
  };

  /** Perform one routed action. */
  const perform = (name: Action): void => {
    switch (name) {
      case 'next':
        move(1);
        return;
      case 'prev':
        move(-1);
        return;
      case 'first':
        move(0, 0);
        return;
      case 'last':
        move(0, Number.POSITIVE_INFINITY);
        return;
      case 'half-down':
        page(1);
        return;
      case 'half-up':
        page(-1);
        return;
      case 'activate':
        activate();
        return;
      case 'insert':
        // The user asked for the composer: no suppression may blur it.
        suppressInsertUntil = 0;
        if (!focusComposer()) {
          hint(t('hint.noComposer'));
          return;
        }
        store.set({ mode: 'insert' });
        return;
      case 'command':
        store.set({ mode: 'command', command: '' });
        return;
      case 'toggle-help':
        store.set({ help: !store.get().help });
        return;
      case 'escape':
        store.set({ pending: '', help: false });
        return;
      case 'session-next':
        cycleSession(1);
        return;
      case 'session-prev':
        cycleSession(-1);
        return;
      case 'agents':
        showSubagents();
        return;
      case 'agents-next':
        showSubagents(1);
        return;
      case 'agents-prev':
        showSubagents(-1);
        return;
      case 'sidebar':
        ctx.layout.toggleSidebar();
        store.set({ list: 'sessions' });
        return;
      case 'conversation':
        ctx.layout.selectPanel(null);
        store.set({ list: 'chat' });
        return;
      case 'disable':
        setEnabled(false);
        return;
    }
  };

  /** Capture-phase router. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const state = store.get();
    if (!state.enabled) return;

    if (state.mode === 'command') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        store.set({ mode: 'normal', command: '' });
      }
      return;
    }

    if (state.mode === 'insert') {
      // Escape always returns to NORMAL, including from the composer; only a
      // menu or dialog that legitimately owns Escape keeps it.
      if (event.key === 'Escape' && !menuOpen()) {
        event.preventDefault();
        event.stopPropagation();
        blurActive();
        store.set({ mode: 'normal', pending: '' });
      }
      return;
    }

    if (isEditable(event.target) || hostModalOpen()) return;
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      event.target instanceof Element &&
      event.target.closest('[data-vim-control]') !== null
    ) {
      return;
    }

    const route = routeNormal(state, {
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
    if (route.kind === 'none') return;
    event.preventDefault();
    event.stopPropagation();
    if (route.kind === 'pending') {
      store.set({ pending: route.pending });
      return;
    }
    store.set({ pending: '' });
    perform(route.action);
  };

  /** Focusing a text surface means the user is typing, not navigating. */
  const onFocusIn = (event: FocusEvent): void => {
    const state = store.get();
    if (!state.enabled || state.mode !== 'normal') return;
    if (!isEditable(event.target)) return;
    if (Date.now() < suppressInsertUntil) {
      // Focus arrived with a conversation we just opened; navigation keeps it.
      blurActive();
      return;
    }
    store.set({ mode: 'insert', pending: '' });
  };

  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.clearTimeout(hintTimer);
      clearCursor();
    };
  }, 'vim-control.keyboard');

  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-vim-control';
    style.textContent = STYLES;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'vim-control.styles');

  /** Subscribe the chip to the store. */
  const useVim = (): VimState => useSyncExternalStore(store.subscribe, store.get, store.get);

  /** The `:` line; focus lives inside it, so the router ignores typing. */
  function CommandLine(): ReactElement {
    const state = useVim();
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
      input.current?.focus();
    }, []);
    return (
      <div className="dsh-vim-command">
        <span>:</span>
        <input
          ref={input}
          value={state.command}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('chip.command')}
          onChange={(event) => store.set({ command: event.target.value })}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              runCommand(state.command);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              store.set({ command: '', mode: 'normal' });
            }
          }}
        />
      </div>
    );
  }

  /** The localized key list. */
  function Help(): ReactElement {
    const keys: ReadonlyArray<readonly [string, string]> = [
      ['j / k', 'row.jk'],
      ['gg / G', 'row.first'],
      ['Ctrl+d / Ctrl+u', 'row.page'],
      ['Enter', 'row.open'],
      [']c / [c', 'row.conv'],
      [']a / [a', 'row.agent'],
      ['g s', 'row.sidebar'],
      ['g a', 'row.catalog'],
      ['g c', 'row.back'],
      [':', 'row.command'],
      ['?', 'row.help'],
      ['i / Esc', 'row.insert'],
    ];
    return (
      <div className="dsh-vim-panel" role="group" aria-label={t('help.title')}>
        <h2>{t('help.title')}</h2>
        <dl>
          {keys.flatMap(([chord, key]) => [
            <dt key={`${key}-key`}>{chord}</dt>,
            <dd key={`${key}-text`}>{t(key)}</dd>,
          ])}
        </dl>
        <p>{t('help.commands')}</p>
        <p>{t('help.close')}</p>
      </div>
    );
  }

  /** The always-present chip; clicking it flips the master switch. */
  function Chip(): ReactElement {
    const state = useVim();
    const label =
      state.mode === 'command' ? t('chip.command') : state.mode === 'insert' ? t('chip.insert') : t('chip.normal');
    return (
      <div data-vim-control="chip">
        {state.hint === '' ? null : (
          <div className="dsh-vim-panel" role="status">
            {state.hint}
          </div>
        )}
        {state.mode === 'command' ? <CommandLine /> : null}
        {state.help ? <Help /> : null}
        <button
          type="button"
          className="dsh-vim-chip"
          data-on={state.enabled ? 'true' : 'false'}
          aria-pressed={state.enabled}
          title={t('chip.title')}
          onClick={(event) => {
            setEnabled(!state.enabled);
            event.currentTarget.blur();
          }}
        >
          <b>VIM</b>
          <span>{state.enabled ? label : t('chip.off')}</span>
        </button>
      </div>
    );
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'vim-control',
        order: 60,
        label: 'Vim control',
        locale: NS,
      },
      Chip,
    ),
  );
}

/** Theme-token styling for the badge, panels, and cursor. */
const STYLES = `
[data-vim-cursor]{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary,#3b6cff);border-radius:6px}
[data-vim-control]{position:fixed;right:12px;bottom:10px;z-index:80;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;font:12px/1.4 system-ui,sans-serif}
[data-vim-control] *{box-sizing:border-box}
.dsh-vim-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#0002);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-secondary,#666);cursor:pointer;opacity:.55;transition:opacity .12s ease}
.dsh-vim-chip:hover,.dsh-vim-chip:focus-visible{opacity:1}
.dsh-vim-chip[data-on="true"]{opacity:1;border-color:var(--dsw-alias-brand-primary,#3b6cff);color:var(--dsw-alias-label-primary,#111)}
.dsh-vim-chip b{font-weight:600;letter-spacing:.04em;font-size:11px}
.dsh-vim-chip span{font-size:11px;opacity:.85}
.dsh-vim-panel{pointer-events:auto;width:340px;max-height:60vh;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#0003);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 8px 24px #0003}
.dsh-vim-panel h2{margin:0 0 6px;font-size:12px;font-weight:600}
.dsh-vim-panel dl{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:0;font-size:11px}
.dsh-vim-panel dt{font-family:ui-monospace,monospace;color:var(--dsw-alias-label-primary,#111);white-space:nowrap}
.dsh-vim-panel dd{margin:0;color:var(--dsw-alias-label-secondary,#666)}
.dsh-vim-panel p{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.dsh-vim-command{pointer-events:auto;display:flex;align-items:center;gap:6px;width:340px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#0003);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111)}
.dsh-vim-command input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:12px/1.6 ui-monospace,monospace}
.dsh-vim-command span{font:12px/1.6 ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#666)}
`;

/** Localized copy for every visible string. */
const DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'chip.off': 'Vim off',
    'chip.normal': 'Normal',
    'chip.insert': 'Insert',
    'chip.command': 'Command',
    'chip.title': 'Vim control: navigation keys for conversations, rows, and subagents',
    'help.title': 'Vim control',
    'help.commands': 'Commands: :o <id> open session, :new new session, :s sidebar, :a subagents, :c conversation, :q off',
    'help.close': 'Esc closes this help',
    'hint.noRows': 'no rows here',
    'hint.noComposer': 'no composer in this panel',
    'hint.sidebar': 'opening the session sidebar',
    'hint.noSubagents': 'no subagent list in this conversation',
    'hint.unknown': 'unknown command :{name}',
    'hint.usage': 'usage: :o <session-id>',
    'row.jk': 'next / previous row',
    'row.first': 'first / last row',
    'row.page': 'half a page down / up',
    'row.open': 'open the row under the cursor',
    'row.conv': 'next / previous conversation',
    'row.agent': 'next / previous subagent',
    'row.sidebar': 'toggle the session sidebar',
    'row.catalog': 'open the subagent list',
    'row.back': 'back to the conversation',
    'row.command': 'command line',
    'row.help': 'this help',
    'row.insert': 'leave / re-enter normal mode',
  },
  zh: {
    'chip.off': 'Vim 关闭',
    'chip.normal': '普通',
    'chip.insert': '插入',
    'chip.command': '命令',
    'chip.title': 'Vim 控制：用键盘浏览会话、行和子代理',
    'help.title': 'Vim 控制',
    'help.commands': '命令：:o <id> 打开会话，:new 新会话，:s 侧栏，:a 子代理，:c 会话，:q 关闭',
    'help.close': 'Esc 关闭本帮助',
    'hint.noRows': '这里没有可移动的行',
    'hint.noComposer': '当前面板没有输入框',
    'hint.sidebar': '正在打开会话侧栏',
    'hint.noSubagents': '当前会话没有子代理列表',
    'hint.unknown': '未知命令 :{name}',
    'hint.usage': '用法：:o <会话 id>',
    'row.jk': '下一行 / 上一行',
    'row.first': '第一行 / 最后一行',
    'row.page': '向下 / 向上翻半页',
    'row.open': '打开光标所在行',
    'row.conv': '下一个 / 上一个会话',
    'row.agent': '下一个 / 上一个子代理',
    'row.sidebar': '开关会话侧栏',
    'row.catalog': '打开子代理列表',
    'row.back': '回到会话',
    'row.command': '命令行',
    'row.help': '本帮助',
    'row.insert': '退出 / 重新进入普通模式',
  },
};
