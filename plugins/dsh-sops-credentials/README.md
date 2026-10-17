---
description: "SOPS-backed credential references for the DeepSeek Harness: an age-encrypted document decrypted in memory at startup, layered over the shipped file store."
kind: "package-reference"
---

# dsh-sops-credentials

Credential references (`apiKeyEnv`, `credentialRef(...)`) and durable records
(OAuth grants, signing secrets) resolve from one age-encrypted SOPS document
instead of a plaintext `.env` or an API key pasted into the GUI. The document is
decrypted **once at startup** and re-decrypted in place when it changes; nothing
decrypted is written to disk by this plugin.

## Why

`@deepseek-ai/dsh-credentials-local` is a fine writable store, but a key you
store there sits in plaintext in `$DSH_HOME/.credentials.yaml`. Keeping the same
keys in `secrets.sops.yaml` gives you one encrypted source of truth that lives in
the repo, while the harness still resolves them per request.

## Layering

Most trusted first, matching the shipped store's doctrine:

```text
inherited process environment   (read-only, wins — a per-run override)
> sops document                 (read-only, this plugin)
> $DSH_HOME/.credentials.yaml   (provider-managed, writable)
> <invocation cwd>/.env         (read-only fallback)
> $DSH_HOME/.env                (read-only fallback)
```

A reference the document defines is reported as `source: 'sops'` and
non-writable: `set`/`unset` refuse it rather than write a value the document
would shadow. A record the document defines is likewise read-only, with one
deliberate subtlety: `modifyRecord` still runs the caller's mutation, because a
caller that creates a record only when none exists returns `undefined` and must
keep working (`client-connection` initializes the browser-session secret that
way). A caller that actually replaces the value is refused.

## Configuration

```yaml
- id: credentials-local        # replace the shipped row in place, or
  disabled: true               # disable it and insert this one
- name: dsh-sops-credentials
  config:
    sopsFile: /home/you/.dsh/secrets.sops.yaml
    # ageKeyFile: /home/you/.config/sops/age/keys.txt
    # sopsBinary: sops
    # sopsWatch: true
    # sopsDebounceMs: 250
    # timeoutMs: 15000
    # required: false          # true fails the mount instead of warning
```

| Field | Default | Meaning |
|---|---|---|
| `sopsFile` | required | The encrypted document to read |
| `sopsBinary` | `sops` | SOPS executable |
| `sopsWatch` | `true` | Re-decrypt when the file changes |
| `sopsDebounceMs` | `250` | Write-settle window for the watcher |
| `ageKeyFile` | SOPS discovery | Passed as `SOPS_AGE_KEY_FILE` |
| `timeoutMs` | `15000` | Bound on one decryption run |
| `required` | `false` | Throw on a failed startup decryption |

The local store's own fields (`path`, `dshHome`, `watch`, `debounceMs`) are
accepted unchanged.

## Document shape

Every top-level string whose name is a credential reference (a POSIX shell
identifier, e.g. `OPENROUTER_API_KEY`) becomes a reference. A top-level
`records` map carries durable records addressed `<scope>/<id>`. Malformed
entries are skipped and named in a startup warning — a value never reaches a
diagnostic. The `sops` metadata block is ignored.

```yaml
DEEPSEEK_API_KEY: sk-…
OPENROUTER_API_KEY: sk-or-v1-…
KAGI_SEARCH_API_KEY: …
records:
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: … }
```

## Security notes

- `sops -d` runs with the document path only in its argument list, and the
  decrypted text arrives over a pipe. No temp file, no environment copy.
- The document is held in this process's memory for the process lifetime; any
  memory dump is a disclosure, exactly as with an environment variable.
- Child processes never inherit these values from the harness: they are not
  written to `process.env`. A child that needs one gets it explicitly (see
  `bin/sops-run.mjs`, used by the GitHub MCP row).
- An age key on the same machine is the actual boundary; this plugin only keeps
  the *values* off disk.

## One document, and the plaintext the harness still writes

The harness writes records at runtime (a sign-in, a rotated grant) into a
plaintext `.credentials.yaml`; this provider never writes the SOPS file, because
re-encrypting on every token refresh would need the age key and a write lock in
the request path. Promote those writes and delete the plaintext copy with
`scripts/sync.mjs` (`bin/secrets-sync.sh` at the repo root), which merges them
into the document and removes the store.

References in the plaintext store are never needed: the document's value wins,
and `set`/`unset` refuse a name the document defines, so a duplicate cannot
quietly appear.
