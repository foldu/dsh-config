/**
 * The DOM contract this plugin drives.
 *
 * Every selector below is a data attribute or ARIA role the owning shell
 * package documents and renders, not a hashed CSS class: `data-row-key` on
 * session rows (ui-workspace), `data-chat-flow-key` on chat rows (ui-chat),
 * `role="tree"`/`treeitem` on the subagent catalog (ui-subagent). The only
 * exception is the catalog's trigger button, which carries no data attribute;
 * it is matched by the `_trigger` suffix of its CSS-module class and pinned to
 * the header region that holds it.
 *
 * @module dom
 */
import type { RowList } from './state';

/** Chat row marker owned by ui-chat. */
export const CHAT_ROW = '[data-chat-flow] [data-chat-flow-key]';

/** Session row marker owned by ui-workspace. */
export const SESSION_ROW = '[data-row-key^="session:"]';

/** Subagent catalog row inside the portaled popover. */
export const TREE_ROW = '[role="tree"] [role="treeitem"]';

/** The resident composer editor (Lexical's contenteditable host). */
export const COMPOSER_INPUT = '[data-composer-input]';

/** Popups that own Escape while they are open. */
const MENU_ROLES = '[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"]';

/** Editable surfaces whose keystrokes are text, never navigation. */
const EDITABLE =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Current cursor row, removed on every repaint. */
let painted: Element | null = null;

/**
 * Whether typing at this target is text entry.
 * @param target - DOM event target.
 * @returns true inside an editable control or a contenteditable surface.
 */
export function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

/**
 * Whether a Host modal currently owns the keyboard.
 * @returns true when a dialog is open anywhere in the frame.
 */
export function hostModalOpen(): boolean {
  const dialogs = document.querySelectorAll('[aria-modal="true"], [role="dialog"]');
  return Array.from(dialogs).some((dialog) => dialog.closest('[data-vim-control]') === null);
}

/**
 * Rows of one list, in rendered order.
 * @param list - which list to read.
 * @returns the row elements.
 */
export function rowsOf(list: RowList): HTMLElement[] {
  const selector = list === 'sessions' ? SESSION_ROW : list === 'tree' ? TREE_ROW : CHAT_ROW;
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

/** Drop the cursor marker. */
export function clearCursor(): void {
  painted?.removeAttribute('data-vim-cursor');
  painted = null;
}

/**
 * Mark one row as the cursor and keep it in view.
 * @param row - the row to mark, or null to clear.
 * @param block - how to place the row: `center` follows the cursor through the
 * conversation, `nearest` only nudges a list that is already in view.
 */
export function paint(row: HTMLElement | null, block: ScrollLogicalPosition = 'nearest'): void {
  if (painted !== null && painted !== row) painted.removeAttribute('data-vim-cursor');
  painted = row;
  if (painted === null) return;
  painted.setAttribute('data-vim-cursor', 'true');
  painted.scrollIntoView({ block, inline: 'nearest' });
}

/**
 * Whether a popup or menu currently owns Escape.
 * @returns true for a Host menu, listbox, or dialog outside this plugin's overlay.
 */
export function menuOpen(): boolean {
  const menus = document.querySelectorAll(MENU_ROLES);
  return Array.from(menus).some((menu) => menu.closest('[data-vim-control]') === null);
}

/**
 * Focus the resident composer editor.
 * @returns whether a composer was found and focused.
 */
export function focusComposer(): boolean {
  const input = document.querySelector<HTMLElement>(COMPOSER_INPUT);
  if (input === null) return false;
  input.focus();
  return true;
}

/** Drop focus out of any text surface so navigation keys reach the body. */
export function blurActive(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/**
 * The nearest ancestor that scrolls vertically, when it has overflow.
 * @param node - element inside the wanted scroller.
 * @returns the scroll container, or null when the page itself scrolls.
 */
export function scrollableAncestor(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement;
  while (current !== null) {
    const overflow = getComputedStyle(current).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * The header button that opens the subagent catalog.
 *
 * The trigger is a `<button>` whose CSS-module class ends in `_trigger`; the
 * preference order is an accessible name that says what it opens, then a count,
 * then the first trigger in the document.
 * @returns the trigger, or null when no candidate exists.
 */
export function findSubagentTrigger(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) =>
      button.closest('[data-vim-control]') === null &&
      button.closest('aside, [data-shell-leading]') === null,
  );
  const triggers = buttons.filter(
    (button) => typeof button.className === 'string' && /_trigger\b/.test(button.className),
  );
  if (triggers.length === 0) return null;
  const named = triggers.find((button) => /subagent|agent/i.test(button.getAttribute('aria-label') ?? ''));
  if (named !== undefined) return named;
  const counted = triggers.find((button) => /\d/.test((button.textContent ?? '').trim()));
  return counted ?? triggers[0] ?? null;
}
