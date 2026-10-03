# DSH home

Version-controlled DeepSeek Harness home (`$DSH_HOME`). Tracks the harness
*configuration* and the local plugins, not the runtime state.

## What's tracked

| Path | What it is |
| --- | --- |
| `profiles/<name>/cordis.patch.yml` | The profile's own patch layer — the file to edit. |
| `profiles/<name>/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml}` | Profile manifest and its plugin dependencies. |
| `plugins/dsh-web-search-kagi/` | Kagi Search API v1 provider for `ctx.web` (TypeScript; see its README). |
| `.sops.yaml`, `secrets.sops.yaml` | SOPS rules plus encrypted standalone secrets (e.g. `github_token` for the MCP row). |
| `credentials.sops.yaml` | Encrypted copy of the harness credential store. |
| `bin/` | Bootstrap and secrets helpers. |
| `AGENTS.md` | Instructions for coding agents (TypeScript-first). |

## What is deliberately not tracked

`sessions/`, `storages/`, `logs/` and `.anonymous-user-id` (private runtime
state), `.credentials.yaml` (the decrypted credential store), and every
`node_modules/`.

## Restore on a fresh machine

Prerequisites: `dsh`, `pnpm`, `node`, `sops`, and the age identity at
`~/.config/sops/age/keys.txt`. Without that identity neither the credential
store nor the `github_token`-backed MCP row can be decrypted.

```sh
git clone <this repo> ~/.dsh
~/.dsh/bin/bootstrap.sh
```

Then restart the harness. Configuration reloads live, but a newly linked or
moved plugin module only mounts on a restart — which is why bootstrap builds
`plugins/dsh-web-search-kagi/lib/` (build output is not committed).

## Secrets

`.credentials.yaml` is the plaintext working copy the harness reads and writes,
and it is gitignored. After the harness adds or changes a credential, refresh
the encrypted snapshot:

```sh
bin/secrets-encrypt.sh
```

`secrets.sops.yaml` holds standalone secrets referenced from profile patches,
such as `github_token` for the hosted GitHub MCP server.

## Hooks

`.githooks/pre-commit` refuses to commit `.credentials.yaml`, refuses absolute
`link:` specs in profile manifests, and blocks likely plaintext tokens. Enable
it once per clone:

```sh
git config core.hooksPath .githooks
```
