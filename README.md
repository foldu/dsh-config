# DSH home

Version-controlled DeepSeek Harness home (`$DSH_HOME`). Tracks the harness
*configuration* and the local plugins, not the runtime state.

## What's tracked

| Path | What it is |
| --- | --- |
| `profiles/<name>/cordis.patch.yml` | The profile's own patch layer — the file to edit. `web` is the home profile; `work` is the same bundle set with a different model list. |
| `profiles/<name>/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml}` | Profile manifest and its plugin dependencies. |
| `bundles/dsh-config-core/` | The rows every profile shares — search provider, credential document, GitHub and REA MCP servers, sandbox roots, co-author table, theme. A pure patch bundle: bundle layers apply before a profile's own patch, so a profile overrides its rows by id. |
| `skills/<name>/SKILL.md` | User-global agent skills, scanned at `$DSH_HOME/skills` (rank 400, ahead of `~/.agents/skills`). |
| `plugins/dsh-web-search-kagi/` | Kagi Search API v1 provider for `ctx.web` (TypeScript; see its README). |
| `plugins/dsh-bash-shfmt/` | Web GUI decoration that shows bash commands reformatted with `shfmt` in the approval prompt and the bash tool row; see its README. |
| `plugins/dsh-extra-writable-roots/` | Bundle that replaces the sandbox provider and filesystem backend to add deployment-wide writable roots (`~/.cache`, `~/.cargo`, `/tmp`, and pnpm's store, state, `~/.npm` and runtime lock directories); see its README. |
| `plugins/dsh-claude-copilot-brand/` | Web sidebar brand override: the OpenAI logomark and the name "Claude Copilot" in place of the shipped whale and wordmark; see its README. |
| `plugins/dsh-coauthor-identity/` | Tells the model selected in the composer who it is and the `Co-authored-by:` trailer to append to git commits; see its README. |
| `plugins/dsh-sops-credentials/` | Credential provider that serves references *and* records from a SOPS document, decrypted in memory at startup; see its README. |
| `.sops.yaml`, `secrets.<profile>.sops.yaml` | SOPS rules plus one encrypted credential document per profile — `secrets.web.sops.yaml` for `web`, `secrets.work.sops.yaml` for `work`: API keys at the top level, durable records under `records:`. Published as ciphertext on purpose. Each document has its own recipient in `.sops.yaml`, so the two are readable by different identities even though both look for the key in `~/.config/sops/age/keys.txt`. |
| `bin/` | Bootstrap, secrets sync, plugin version sync (`update-plugins.mjs`), and the `sops-run.mjs` child-environment helper. |
| `plugins/AGENTS.md` | Instructions for agents working on plugins here (TypeScript-first). |

A root `AGENTS.md` is deliberately absent: `$DSH_HOME/AGENTS.md` is the
user-global instruction file the harness loads in *every* session on this
machine, so repo-scoped agent rules live in `plugins/AGENTS.md` instead.

## What is deliberately not tracked

`sessions/`, `storages/`, `logs/`, `attachments/`, `cache/`, `llm-deepseek/` and
`.anonymous-user-id` (private runtime state), `.credentials.yaml` (a plaintext
store this setup normally deletes), every `node_modules/`, the optional home
overlay `cordis.patch.yml` (see below), and `skills/lab-gitlab-ci/`, which
documents one specific GitLab and currently stays local.

## Machine-local overlay

The loader applies layers in this order: each bundle, then the profile's
`cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml` (the home layer), then any
`--patch` CLI overlay. The home layer is untracked and gitignored: it is the
escape hatch for a row that must exist on one machine and nowhere else, and it
applies to *every* profile on that machine.

Nothing uses it at the moment — the GitLab row it used to hold now lives in
`profiles/web/` — so the file is absent. A clone without it composes fine, and
nothing in the tracked config depends on it. If you do add one, remember it
outranks every profile, so gate anything profile-specific:

```yaml
# $DSH_HOME/cordis.patch.yml — untracked
- insert:
    - id: some-row
      name: "@deepseek-ai/dsh-some-plugin"
      disabled: !!js "ctx.get('profileContext')?.name !== 'web'"
      config: { … }
```

## Home-context tools

Two rows are deliberately narrower than the shared bundle:

| Row | Where | Reaches |
| --- | --- | --- |
| REA (`mcp-rea`) | `profiles/web/cordis.patch.yml` | home profile only |
| GitLab (`mcp-gitlab`) | `profiles/web/cordis.patch.yml` | home profile only |

Both are ordinary tracked rows in the home profile, so `dsh work` gets the
GitHub MCP and the shipped tools, no reverse-engineering and no lab GitLab.

## Restore on a fresh machine

Prerequisites: `dsh`, `pnpm`, `node`, `sops`. Both profiles look for the age
identity at `~/.config/sops/age/keys.txt`, but the two documents are encrypted
to different recipients, so a credential resolves only for the profile whose
identity is in that file. Without it the harness still boots and that profile's
credentials stay unresolved — see the next section.

```sh
git clone <this repo> ~/.dsh
~/.dsh/bin/bootstrap.sh
```

Then restart the harness. Configuration reloads live, but a newly linked or
moved plugin module only mounts on a restart — which is why bootstrap builds
every local plugin's build output (`lib/`), which is not committed.

## Using this repo somewhere else

On a machine that is not the one it was written for — a work laptop, a fresh
box — three things differ, all of them by design:

1. **The age identity is absent**, so `secrets.web.sops.yaml` cannot be
   decrypted here. That is what makes it safe to publish: the ciphertext is
   public, the key is not. Leave that file alone — it belongs to the machine
   that owns its key, and editing it here would put *this* machine's keys into a
   tracked file. The `work` profile expects a different document, and
   `.sops.yaml` routes it to a different recipient:

   ```sh
   age-keygen -o ~/.config/sops/age/keys.txt   # this machine's identity
   age-keygen -y ~/.config/sops/age/keys.txt   # its public key

   # put that public key in .sops.yaml's work rule (it holds a placeholder),
   # then create the document; later `sops secrets.work.sops.yaml` edits reuse
   # the recipients recorded in the file
   printf 'OPENROUTER_API_KEY: ""\n' >/tmp/seed.yml
   sops --encrypt --input-type yaml --filename-override secrets.work.sops.yaml \
     /tmp/seed.yml > secrets.work.sops.yaml
   sops secrets.work.sops.yaml
   ```

   No profile edit is needed: the `work` profile's patch names the document, and
   the GitHub bridge aliases the same path, so the provider and `sops-run.mjs`
   cannot disagree about which key to use.

   `bin/bootstrap.sh work` warns rather than fails when the document cannot be
   read, so the rest of the restore still completes.

2. **The home layer is absent**, so internal-host rows are absent too. Add
   whatever this machine needs in `$DSH_HOME/cordis.patch.yml`.

3. **Internal-only skills are absent** — nothing describing a private instance
   is published.

Everything else — profiles, plugins, skills, credential plumbing, the
`Co-authored-by:` trailer table — is generic and composes unchanged.

## Publishing

The tracked tree is meant to be publishable to a public remote. The invariants
that keep it that way:

- No plaintext credential has ever been committed. `secrets.<profile>.sops.yaml`
  is ciphertext; never commit the age identity, `.credentials.yaml`, or a
  decrypted export. `.githooks/pre-commit` blocks the obvious cases.
- Internal hostnames are fine to publish (the GitLab row names one); keys are
  not. The optional home layer stays gitignored anyway, for rows that must not
  exist on another machine at all.
- `bin/bootstrap.sh` passes from a clean clone.

```sh
git config core.hooksPath .githooks      # once per clone
git remote add public git@github.com:<you>/dsh-config.git
git push public master
```

## Updating after a harness upgrade

The local plugins pin their `@deepseek-ai/dsh-*` peers exactly, because the
harness refuses to load a plugin whose peer range does not satisfy the running
version. A harness upgrade therefore needs every plugin manifest and lockfile
refreshed. Do that with:

```sh
bin/update-plugins.mjs
```

The script derives the target versions from the installed harness itself (the
running `dsh` version plus the harness's cordis/schemastery ranges), rewrites
every `@deepseek-ai/dsh-*` dependency in `plugins/*/package.json`, runs
`pnpm install` for the changed plugins, rebuilds them, and composes each profile
to check for remaining incompatibilities. It skips installs and builds when
nothing changed, so it is safe to re-run.

```sh
bin/update-plugins.mjs --check       # exit 1 if any manifest is stale
bin/update-plugins.mjs --no-build    # only rewrite manifests and lockfiles
```

A manifest bump only clears the compatibility gate; if a plugin actually uses a
changed harness API, the rebuild fails and the source needs a real fix. pnpm's
global `minimumReleaseAge` would otherwise reject a harness published minutes
ago, so the script exempts the `@deepseek-ai/*` scope for these installs
(`--allow-fresh` disables the age gate for the whole install instead). If
automatic harness discovery fails, pass
`--dsh-package /path/to/@deepseek-ai/dsh/package.json`.

## Secrets

Each profile has its own credential document, named by the profile:
`secrets.web.sops.yaml` for `web`, `secrets.work.sops.yaml` for `work`. The
profile's patch inserts the provider row with that path, so which keys a session
can see is a property of the profile you launched — not of a file that happens
to exist. Open one with `sops secrets.web.sops.yaml` and keep two shapes in it:

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
bin/secrets-sync.sh          # the web profile's document
bin/secrets-sync.sh work     # a named profile's document
```

The script merges the store into that profile's document (encrypting in memory
via `sops encrypt` on a pipe), then removes `.credentials.yaml`. Run it after
any sign-in, against the profile you were running.

Exactly one document is mounted per session, and the profile picks it. The
provider does not merge documents, which is deliberate: a reference has exactly
one source, so it can never resolve to a value from a document you did not
expect.

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
