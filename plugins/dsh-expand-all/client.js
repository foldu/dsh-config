/**
 * Client half of the reading-mode toggle.
 *
 * The conversation's disclosure state is a React hook owned by Chat
 * (`useDisclosure`), forwarded through tool rows — there is no slot that sets it
 * for every row. What the shared disclosure primitive does expose is stable DOM
 * contract: every row carries `data-disclosure-row`, and the row itself or its
 * leading button carries `aria-expanded`. This plugin drives that contract:
 * while the toggle is on, every collapsed row is clicked once, and a
 * MutationObserver does the same for rows that arrive later (streaming calls,
 * a turn that re-mounts).
 *
 * Design rules kept deliberately:
 *  - A row is claimed once (`WeakSet`), so collapsing one by hand is never
 *    fought; only rows that appear as new DOM nodes are expanded again.
 *  - Turning the toggle off stops the observer and changes nothing else — it
 *    never collapses text you are reading.
 *  - No hashed class names, no other plugin's internals: only the primitive's
 *    documented data attributes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-expand-all',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** localStorage key holding the last toggle position. */
    const STORAGE_KEY = 'dsh-expand-all';

    /** Rows already claimed by this page's controller. */
    const claimed = new WeakSet();

    /** Whether the controller is currently expanding new rows. */
    let enabled = false;

    /** Live observer while enabled. */
    let observer = null;

    /** Set while a requested animation frame is pending. */
    let scheduled = false;

    /** Read the persisted preference; absent means off. */
    function readStored() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    }

    /** Persist the preference; a denied store must not break the toggle. */
    function writeStored(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
      } catch {
        /* private mode or a full store: the toggle still works for this page */
      }
    }

    /**
     * Whether one row is currently collapsed.
     * @param {Element} row - a `[data-disclosure-row]` element.
     * @returns {boolean} true when the row or its leading button is collapsed.
     */
    function isCollapsed(row) {
      if (row.getAttribute('aria-expanded') === 'false') return true;
      return row.querySelector('button[aria-expanded="false"]') !== null;
    }

    /**
     * Click every collapsed row this controller has not claimed yet.
     * @param {ParentNode} root - subtree to scan.
     * @returns {number} how many rows were opened.
     */
    function expandCollapsed(root) {
      let opened = 0;
      for (const row of root.querySelectorAll('[data-disclosure-row]')) {
        if (claimed.has(row) || !isCollapsed(row)) continue;
        claimed.add(row);
        const target =
          row.getAttribute('aria-expanded') === 'false'
            ? row
            : row.querySelector('button[aria-expanded="false"]');
        if (target === null) continue;
        target.click();
        opened += 1;
      }
      return opened;
    }

    /** Expand what is on screen now, then again after the next paint. */
    function expandSoon() {
      if (!enabled || scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        if (enabled) expandCollapsed(document);
      });
    }

    /** Start auto-expanding; idempotent. */
    function start() {
      if (observer !== null) return;
      enabled = true;
      expandCollapsed(document);
      observer = new MutationObserver(expandSoon);
      observer.observe(document.body, { childList: true, subtree: true });
    }

    /** Stop auto-expanding; idempotent, and leaves the page as it is. */
    function stop() {
      enabled = false;
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
    }

    /**
     * The header toggle: an icon button whose pressed state is the mode.
     * Inherits colour and font from the header; the icon is decorative because
     * the button carries the accessible name.
     * @returns {import('react').ReactElement} the toggle.
     */
    function ExpandAllToggle() {
      const [on, setOn] = React.useState(readStored);

      React.useEffect(() => {
        if (on) start();
        else stop();
        return () => stop();
      }, [on]);

      const label = on
        ? 'Stop expanding new actions'
        : 'Expand every action';

      const toggle = () => {
        setOn((previous) => {
          const next = !previous;
          writeStored(next);
          return next;
        });
      };

      return h(
        React.Fragment,
        null,
        h('style', null, [
          '[data-dsh-expand-all]{display:inline-flex;align-items:center;justify-content:center;',
          'width:28px;height:28px;padding:0;border:0;border-radius:6px;',
          'background:transparent;color:inherit;cursor:pointer;opacity:.72;',
          'transition:opacity .12s ease,background-color .12s ease}',
          '[data-dsh-expand-all]:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
          '[data-dsh-expand-all]:focus-visible{outline:2px solid currentColor;outline-offset:1px;opacity:1}',
          '[data-dsh-expand-all="on"]{opacity:1}',
        ].join('')),
        h(
          'button',
          {
            type: 'button',
            'data-dsh-expand-all': on ? 'on' : 'off',
            'aria-pressed': on,
            'aria-label': label,
            title: label,
            onClick: toggle,
          },
          h(
            'svg',
            {
              width: 16,
              height: 16,
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              focusable: false,
            },
            on
              ? [
                  // Arrows inward: pressing returns to the collapsed default.
                  h('path', { key: 'nw', d: 'M6.5 6.5 2.5 2.5M2.5 2.5v3M2.5 2.5h3' }),
                  h('path', { key: 'se', d: 'M9.5 9.5l4 4M13.5 13.5v-3M13.5 13.5h-3' }),
                ]
              : [
                  // Arrows outward: pressing expands every action.
                  h('path', { key: 'nw', d: 'M2.5 2.5l4 4M6.5 6.5v-3M6.5 6.5h-3' }),
                  h('path', { key: 'se', d: 'M13.5 13.5l-4-4M9.5 9.5v3M9.5 9.5h3' }),
                ],
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => () => stop(), 'dsh-expand-all.controller');
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'expand-all',
              order: 10,
              label: 'Expand all actions',
            },
            ExpandAllToggle,
          ),
        );
      },
    };
  },
});
