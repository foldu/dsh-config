# dsh-bash-shfmt

Show bash commands **formatted with `shfmt`** in the DeepSeek Harness Web GUI.

A model writes commands as code golf — `cd /w/app && ls | head; echo done` — and
the GUI prints that text verbatim, to a human who has to decide whether to
approve it. This package runs [`shfmt`](https://github.com/mvdan/sh) over the
command and shows the readable rewrite in the two places a bash command is
displayed:

| Seat | Shipped behaviour | With this plugin |
| --- | --- | --- |
| Approval prompt detail (`conversation.approval.detail`) | raw `args.command` | `shfmt`-formatted command |
| Bash tool row (`tool.call.toolview`, key `bash`) | raw command in the terminal card | `shfmt`-formatted command in a terminal card |

It is the DSH counterpart of the `renderCall`/`promptBash` formatting in
`~/.pi/agent`'s guard extension, and uses the same `shfmt` flags.

## Why it is a Host + Client pair

A browser cannot run `shfmt`, and the Web client renders a bash tool call from
the raw `tool/call` arguments in the session log. So:

- the **Host half** owns the `shfmt` process behind one exact same-origin route,
  `POST /bash-shfmt/format`, behind the connection's Host/Origin fence and
  browser authentication;
- the **Client half** asks that route for a command's display text and shadows
  the two seats above, because the shipped rows read the raw arguments
  themselves.

Nothing here rewrites the session log, the model-visible call, or the executed
command. **Formatting is display-only:** the worst case of a missing `shfmt`, a
parse error, a timeout, or a refusing Host is that the original command is shown,
exactly as it is today.

## Behaviour and limits

`shfmt` is not a line-wrapping pretty-printer: it normalises a command that is
already well-formed shell and preserves most of the author's line structure.

- Statements separated by `;` are split onto their own lines; indentation and
  spacing are normalised; `--simplify` applies its safe rewrites.
- A single `&&`/`|` chain on one line stays on one line.
- A command `shfmt` cannot parse is returned unchanged (`applied: false`).
- `--simplify` *can* change behaviour (that is what the flag means). Drop it from
  `args` if the display transform must be inert; upstream `shfmt` defaults are
  otherwise used.

Deliberate differences from the shipped bash row, because a plain-JS client
plugin may not import Harness Client packages and this package inlines the parts
it needs:

- **ANSI colour in output is stripped**, not rendered (`\e[…m` sequences are
  removed). The shipped terminal block renders them.
- **The running row does not shimmer.** The run-state dot inside the card still
  shows the ongoing spinner.
- The row, its class structure and its CSS are copied from the shipped bash row
  and terminal block with renamed classes and theme tokens; the inspect button,
  the copy control, the exit-status pill, the head/tail output cap, and the
  icon-to-chevron hover swap are reproduced.

## Config

Set on the plugin's row — see `cordis.patch.yml` for the defaults. Every field is
volatile: a change is committed into the running plugin instead of remounting it.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` answers every request with the original command. |
| `binary` | `shfmt` | Executable name or path, resolved through the Host `PATH`. |
| `args` | `--language-dialect bash --simplify --binary-next-line` | Arguments preceding the command on stdin. |
| `timeoutMs` | `5000` | Hard per-invocation ceiling. |
| `maxBodyBytes` | `65536` | Longest accepted request body. |
| `cacheSize` | `512` | Distinct commands whose formatting is reused. |

A patch replaces a row's whole `config`, and every field above already defaults
to the value in `cordis.patch.yml`, so an override only needs the fields it
changes. HMR watches the *profile* patch layer rather than a bundle's own patch,
so put live-editable values in `profiles/<name>/cordis.patch.yml`:

```yaml
- id: bash-shfmt
  config:
    args:
      - --language-dialect
      - bash
      - --binary-next-line
```

The route is registered with the plugin, so it only exists while the plugin is
mounted. Without `shfmt` on the Host `PATH` the plugin still mounts and every
request falls back to the original text; the missing binary is re-probed every
30 s, so installing `shfmt` needs no restart.

## Install

This package is a bundle: select it in the profile that runs the web app and
link it from the repo checkout. In `$DSH_HOME`:

```sh
# 1. Build it: the harness loads lib/index.js, which is not committed.
cd plugins/dsh-bash-shfmt && pnpm install && pnpm build

# 2. Link it into the profile (`link:` needs no network).
cd ../../profiles/web && pnpm install
```

`profiles/web/package.json` then carries both halves:

```json
{
  "dependencies": { "dsh-bash-shfmt": "link:../../plugins/dsh-bash-shfmt" },
  "dsh": { "profile": { "bundles": ["dsh-bash-shfmt"] } }
}
```

`bin/bootstrap.sh` runs both steps for every local plugin on a fresh clone.

A newly linked plugin module is resolved at launch, so **restart the harness**
after adding or moving this package. Once mounted, later edits reload live
through the `hmr` row's `../../plugins` watch root — but only after
`pnpm build`.

## Verify

```sh
pnpm typecheck
pnpm test          # formatter fallbacks/cache + the route's request contract
dsh --profile web --dump-config | grep -A2 bash-shfmt
```

In the running GUI, the live registration is visible through the Cordis
inspector: `tool.call.toolview` should list this package's entry for key `bash`
at priority `-1` above the shipped `bash-toolview-sample`, and
`conversation.approval.detail` an entry above the shipped one.

## License

MIT
