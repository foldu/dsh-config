# DSH home

Version-controlled DeepSeek Harness home (`$DSH_HOME`). Tracks the harness
*configuration* and the local plugins, not the runtime state.

## What's tracked

| Path | What it is |
| --- | --- |
| `profiles/<name>/cordis.patch.yml` | The profile's own patch layer — the file to edit. |
| `profiles/<name>/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml}` | Profile manifest and its plugin dependencies. |
| `skills/<name>/SKILL.md` | User-global agent skills, scanned at `$DSH_HOME/skills` (rank 400, ahead of `~/.agents/skills`). |
| `plugins/dsh-web-search-kagi/` | Kagi Search API v1 provider for `ctx.web` (TypeScript; see its README). |
| `plugins/dsh-bash-shfmt/` | Web GUI decoration that shows bash commands reformatted with `shfmt` in the approval prompt and the bash tool row; see its README. |
| `plugins/dsh-extra-writable-roots/` | Bundle that replaces the sandbox provider and filesystem backend to add deployment-wide writable roots (e.g. `~/.cache`); see its README. |
| `plugins/dsh-claude-copilot-brand/` | Web sidebar brand override: the OpenAI logomark and the name "Claude Copilot" in place of the shipped whale and wordmark; see its README. |
| `.sops.yaml`, `secrets.sops.yaml` | SOPS rules plus encrypted standalone secrets (e.g. `github_token` for the MCP row). |
| `credentials.sops.yaml` | Encrypted copy of the harness credential store. |
| `bin/` | Bootstrap and secrets helpers. |
| `plugins/AGENTS.md` | Instructions for agents working on plugins here (TypeScript-first). |

A root `AGENTS.md` is deliberately absent: `$DSH_HOME/AGENTS.md` is the
user-global instruction file the harness loads in *every* session on this
machine, so repo-scoped agent rules live in `plugins/AGENTS.md` instead.

## What is deliberately not tracked

`sessions/`, `storages/`, `logs/`, `attachments/`, `cache/`, `llm-deepseek/` and
`.anonymous-user-id` (private runtime state), `.credentials.yaml` (the decrypted
credential store), and every `node_modules/`.

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
every local plugin's build output (`lib/`), which is not committed.

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

`dsh plugin add` — and the harness's own plugin manager — writes a `link:` spec
with an *absolute* path, which rule 2 then rejects. Rewrite it to
`../../plugins/<name>` (the form every entry here uses) before committing; that
is what keeps a clone working when it lives at a different path.
