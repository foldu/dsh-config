---
description: "Reading-mode toggle for the dsh web GUI: keeps every collapsed disclosure (tool calls, details) expanded as the conversation streams."
kind: "package-reference"
---

# dsh-expand-all

A single button in the session header that turns the conversation into
uninterrupted scrolling text: every collapsed disclosure row — tool calls,
their `Details` sections, and anything else built on the shared
`DisclosureRow` — is expanded, including rows that arrive later while the
agent is still streaming.

## Behavior

- **Off (default).** Nothing is touched; rows keep their own open state.
- **On.** Every collapsed row on screen is opened once, and a
  `MutationObserver` opens new rows as they mount. Turning it off stops the
  observer and leaves everything you already have open exactly as it is — the
  toggle never collapses text you are reading.
- Each row is claimed once per page (`WeakSet`), so collapsing one by hand is
  respected; only rows that appear as new DOM nodes are re-expanded. A turn
  that re-mounts its children therefore opens again on its own.
- The choice persists per browser in `localStorage` under
  `dsh-expand-all`.

## Why it drives the DOM

Disclosure state is Chat's `useDisclosure` React hook, forwarded to each tool
row. No slot exposes it, and replacing the tool renderer would mean
reimplementing every built-in card. The shared primitive does publish a stable
contract instead:

- `[data-disclosure-row]` on the row,
- `aria-expanded` on the row (when the whole row toggles) or on its leading
  button.

This plugin drives exactly those two attributes — no hashed class names, no
another plugin's internals. If the primitive ever stops emitting them, the
button simply does nothing; it cannot corrupt the conversation.

## Limits

- No collapse-all: turning it off is "stop expanding", not "fold everything".
- Expanding while the agent streams keeps growing the transcript; the
  conversation still follows the tail until you scroll up.
- Persistence is per browser profile, not per session or per harness profile.

## Files

- `client.js` — the toggle and its controller, loaded as the Client half.
- `index.js` — the Host half, intentionally empty.
- `cordis.patch.yml` — inserts the one Host row.

## Disable

Remove `dsh-expand-all` from `dsh.profile.bundles` in the profile manifest (or
switch its row off), then restart the harness.
