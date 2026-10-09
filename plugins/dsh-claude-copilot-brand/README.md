# dsh-claude-copilot-brand

Rebrands the DSH Web **left sidebar** brand row: the OpenAI blossom logomark in
place of the DeepSeek whale, and the name **"Claude Copilot"** in place of the
shipped wordmark.

## What it changes

| Slot | Shipped occupant | This bundle |
|---|---|---|
| `sidebar.brand.mark` | `FishLogo` (the whale) | the OpenAI blossom, `currentColor` |
| `sidebar.brand.name` | `BrandWordmark` artwork | the text "Claude Copilot" |

Both slots are `single`, and a single slot renders its **lowest**-priority live
occupant (`SlotCore.register`: "ascending, default 0, lowest renders"). The
shipped `@deepseek-ai/dsh-client-ui-brand-official` occupant therefore stays
registered at the default priority 0 and this bundle's occupants register at
`priority: -1`, which shadows it. The shipped row is not disabled and no other
row's config is restated.

`sidebar.brand.mark` is the same slot the sidebar's collapsed rail renders
(`SidebarRoot`'s toggle), so the rail shows the OpenAI mark too. Nothing else is
claimed: `conversation.hero.brand.mark` (the blank-session headline artwork) and
every other sidebar slot keep their shipped occupants.

Both components style themselves from what they inherit — `currentColor` and the
sidebar's own `brandName`/`brandMark` seats (18px, 600 weight, 0.04em tracking,
24px line box) — so the row follows the theme in light and dark without naming a
colour, and the plugin imports no Harness Client package.

## Layout

```
package.json      bundle + dsh.client manifest (platform web, immediately, inject sidebar)
cordis.patch.yml  inserts the `claude-copilot-brand` row
index.js          Host half: empty `apply` (nothing to do in the Host process)
client.js         Client half: the two slot occupants (hand-written bundle format)
icon.svg          Plugin-card artwork (the same mark, 36x36, theme-neutral green)
locale/en.json    Plugin-card title/description
```

`client.js` is the browser artifact format the page's module loader expects
(`window.__ModuleLoader__.load({ id, factory })`), which is build output in the
shipped packages (tsdown) and has no TypeScript source here: the Client half is
a bundle, not `src/` code. `index.js` is two lines with no imports, so it needs
no build step either. Everything else follows the usual package layout.

## Install

Installed into the `web` profile as a local bundle; see the profile's
`package.json` / bundle list. Remove it the same way (`plugin_manager`
`remove_bundle`) to restore the shipped branding.

## Limits

- Only the `web` platform: `dsh.client.platform` is `web`, and the sidebar slots
  exist only in the Web UI.
- The mark is a fixed square (`size` × `size`) while the shipped whale is a
  wider-than-tall silhouette, so the logo sits a little larger optically in the
  same 24px seat.
- If a deployment replaces `ui-brand-official` with an occupant at a priority
  below -1, that occupant wins and this bundle's mark/name stop rendering.
