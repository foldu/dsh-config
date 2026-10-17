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
| `plugins/dsh-extra-writable-roots/` | Bundle that replaces the sandbox provider and filesystem backend to add deployment-wide writable roots (`~/.cache`, `~/.cargo`, `/tmp`, and pnpm's store, state, `~/.npm` and runtime lock directories); see its README. |
| `plugins/dsh-claude-copilot-brand/` | Web sidebar brand override: the OpenAI logomark and the name "Claude Copilot" in place of the shipped whale and wordmark; see its README. |
| `plugins/dsh-sops-credentials/` | Credential provider that serves references *and* records from `secrets.sops.yaml`, decrypted in memory at startup; see its README. |
| `.sops.yaml`, `secrets.sops.yaml` | SOPS rules plus the **single** encrypted credential document: API keys at the top level, durable records under `records:`. |
| `bin/` | Bootstrap, secrets sync, and the `sops-run.mjs` child-environment helper. |
| `plugins/AGENTS.md` | Instructions for agents working on plugins here (TypeScript-first). |

A root `AGENTS.md` is deliberately absent: `$DSH_HOME/AGENTS.md` is the
user-global instruction file the harness loads in *every* session on this
machine, so repo-scoped agent rules live in `plugins/AGENTS.md` instead.

## What is deliberately not tracked

`sessions/`, `storages/`, `logs/`, `attachments/`, `cache/`, `llm-deepseek/` and
`.anonymous-user-id` (private runtime state), `.credentials.yaml` (a plaintext
store this setup normally deletes), and every `node_modules/`.

## Restore on a fresh machine

Prerequisites: `dsh`, `pnpm`, `node`, `sops`, and the age identity at
`~/.config/sops/age/keys.txt`. Without that identity no credential resolves:
every key, and the browser-session record, lives in `secrets.sops.yaml`.

```sh
git clone <this repo> ~/.dsh
~/.dsh/bin/bootstrap.sh
```

Then restart the harness. Configuration reloads live, but a newly linked or
moved plugin module only mounts on a restart — which is why bootstrap builds
every local plugin's build output (`lib/`), which is not committed.

## Secrets

`secrets.sops.yaml` is the only credential document. Open it with
`sops secrets.sops.yaml` and keep two shapes in it:

```yaml
GITHUB_TOKEN: ghp_…               # a top-level key is a credential reference
DEEPSEEK_API_KEY: sk-…            # referenced as apiKeyEnv: DEEPSEEK_API_KEY
records:                          # durable records, addressed <scope>/<id>
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: … }
```

`dsh-sops-credentials` decrypts it into memory once at startup and re-decrypts
when the file changes. Nothing decrypted touches the disk: no `.env`, no
`.credentials.yaml`, no snapshot copy. A reference the document defines is
read-only across the GUI (`set`/`unset` refuse it); edit the document instead.

The document is read-only to the harness, which is what keeps "nothing
decrypted on disk" true, but the harness still writes records at runtime (a
sign-in, a rotated grant) into a plaintext `.credentials.yaml`. Promote those
into the document and delete the plaintext copy with:

```sh
bin/secrets-sync.sh
```

The script merges the store into `secrets.sops.yaml` (encrypting in memory via
`sops encrypt` on a pipe), then removes `.credentials.yaml`. Run it after any
sign-in.

Child processes never inherit these values. A command that needs one gets it
explicitly through `bin/sops-run.mjs` — that is how the GitHub MCP row passes
`GITHUB_TOKEN` to `mcp-remote` without the token entering the harness process
or the config file.

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
