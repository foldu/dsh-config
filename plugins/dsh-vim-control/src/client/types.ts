/**
 * The slice of the Client runtime this plugin uses.
 *
 * These are structural declarations of the Harness Client services the plugin
 * calls, not a copy of their packages: the Client half is bundled for the page
 * and must not import Harness packages. Every member mirrors the live contract
 * reported by `cordis_inspect_query` (`Service.listService`) for
 * `slots`, `locale`, `layout`, and `uiWorkspace`; a renamed method fails the
 * type check here instead of throwing in the browser.
 *
 * @module types
 */

/** One Slot entry registration (the options the shell accepts). */
export interface SlotRegistration {
  /** Live Slot key this entry renders into. */
  readonly name: string;
  /** Entry identity, unique within the Slot. */
  readonly id: string;
  /** Ascending position within a list Slot. */
  readonly order?: number;
  /** Human-readable label used by tooling. */
  readonly label?: string;
  /** Locale namespace the entry renders with. */
  readonly locale?: string;
}

/** Client Slot registry. */
export interface SlotsService {
  /** Register one entry; the returned function removes it. */
  register(options: SlotRegistration, component: (props: unknown) => unknown): () => void;
  /**
   * Run registrations only while the owner declaration exists.
   * @param key - Slot key whose declaration scopes the callback.
   * @param callback - registers entries and returns their combined disposer.
   */
  inject(key: string, callback: () => () => void): () => void;
}

/** Client locale registry. */
export interface LocaleService {
  /** Register one namespace with one dictionary per built-in locale. */
  register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void;
  /** Bind a namespace to a translator. */
  bind(namespace: string): (key: string, params?: Readonly<Record<string, string>>) => string;
}

/** Panel navigation exposed through `ctx.layout`. */
export interface LayoutService {
  /** Toggle the session sidebar. */
  toggleSidebar(): void;
  /** Select a global central panel, or `null` for the conversation. */
  selectPanel(panelId: string | null): void;
}

/** Workspace navigation exposed through `ctx.uiWorkspace`. */
export interface UiWorkspaceService {
  /** Select a Session (or a subagent address) and show its conversation. */
  openSession(target: string): void;
  /** Create or reuse a Session and show it. */
  startSession(workspaceId?: string): void;
}

/** Cordis effect helper available on a Client plugin context. */
export type Effect = (callback: () => void | (() => void), label: string) => void;

/** The Client context this plugin is applied to. */
export interface ClientContext {
  readonly slots: SlotsService;
  readonly locale: LocaleService;
  readonly layout: LayoutService;
  readonly uiWorkspace: UiWorkspaceService;
  readonly effect: Effect;
}
