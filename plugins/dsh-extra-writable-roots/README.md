# dsh-extra-writable-roots

Deployment-wide **extra writable roots** for the DSH file sandbox: paths that
every session may write under `workspace-write`, without a per-call escalation.

Motivating cases: `~/.cache`, which tooling writes regardless of which project
workspace a session runs in, `/tmp`, which bwrap shadows with a private
per-call tmpfs, and pnpm's global store plus its per-login runtime lock
directory, which an in-sandbox `pnpm install` needs. The shipped policy cannot
express any of them — `SandboxExecutionPolicy` carries one `workspaceRoot`, and
`writableRoots()` derives `{workspace, /tmp, os.tmpdir()}` from it. This bundle
adds the missing list, and makes a declared path mean *the host directory* in
every execution world.

## What it does

The sandbox has one policy source and two enforcing halves. `workspaceRoot`
cannot express a second root, so this plugin replaces **both** halves with
copies that add one shared, live allow-list:

| Half | Shipped | Replaced by | How the extra roots are enforced |
|---|---|---|---|
| Process (`ctx.sandbox`) | `@deepseek-ai/dsh-sandbox-local` | `ExtraRootsSandboxProvider` | the wrapped runner argv is widened in its own dialect: a later `--bind` for bwrap (shadowing the earlier read-only bind of `/`), `--rw` grants for the Landlock launcher, an appended `file-write*` allow form for Seatbelt. A path the runner would hide behind its own ephemeral mount — bwrap's `--tmpfs /tmp` — has that mount replaced by the bind, so the declared root is the host directory rather than a per-call throwaway |
| Filesystem (`ctx.fs`) | `@deepseek-ai/dsh-fs-sandbox` | `ExtraRootsFileSystem` | a mutation whose freshly canonicalized target is under an extra root takes the unfenced local implementation, before the shipped workspace/temp containment check |

Both halves read one `WritableRootSet`, so the shell and the `write`/`edit`
tools can never disagree about what is writable. The plugin also contributes a
`sandbox:extra-writable-roots` runtime-context line so the model knows the roots
exist instead of escalating for them.

`cordis.patch.yml` disables the shipped `sandbox` and `fs-sandbox` rows and
inserts this plugin in their place — the documented swap for a capability
backend ("loading it INSTEAD OF `dsh-fs-local` is the whole swap"). It ships an
empty `writablePaths`; the deployment's list belongs in the **profile** patch
(next section). Because one context holds one provider per service, the
replacement owns the shipped rows' configuration surface: `runnerCommand`,
`runnerFailureSignatures`, `probeTimeoutMs`, `cwd`, and `diffBasisMaxBytes` are
composed from the shipped schemas and forwarded verbatim, so nothing configured
on the disabled rows is lost.

## Configuration

Put the override in `profiles/<name>/cordis.patch.yml`. That file is watched by
HMR, so an edit applies to the next confined call; a **bundle's** own patch layer
is only read when the composition is rebuilt, so editing it changes what a fresh
composition (or `dsh --dump-config`) sees while the running plugin keeps the old
list.

```yaml
# profiles/<name>/cordis.patch.yml
- id: extra-writable-roots
  config:
    writablePaths:
      - '~/.cache'
      - '~/.cargo'
      - /tmp
      - /var/tmp/build-cache
    applyInReadOnly: false
    createMissingRoots: false
```

| Field | Default | Meaning |
|---|---|---|
| `writablePaths` | `[]` | Absolute paths, `~/…`, or paths with `$VAR`/`${VAR}` references. Each must exist and be a directory; a relative, missing, or non-directory entry fails the plugin load loudly rather than granting nothing silently — unless `createMissingRoots` is set. An unset or empty variable fails the load with the variable's name, because expanding it to nothing would turn the entry into a different path. Entries are canonicalized (`realpath`) and deduplicated. A declared path is always **the host directory**: if the runner hides it behind a private mount (bwrap's `/tmp` tmpfs), that mount is replaced by a bind of the host path, so the shell and the file tools see one directory and its contents persist across calls. |
| `applyInReadOnly` | `false` | Whether the extra roots also apply under `read-only`. The default keeps that mode's model-visible contract ("cannot modify files") true. |
| `createMissingRoots` | `false` | Whether an entry that does not exist yet is created (`0700`) instead of failing the load. For a directory the tool that owns it creates lazily — pnpm's `$XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>` is created by the first store operation, which on a fresh boot happens *after* this row mounts — failing the load there would take the whole sandbox down, since this plugin is the only provider the composition mounts. Creation never applies to an entry that exists as a non-directory: that still fails loud. |
| `cwd`, `diffBasisMaxBytes` | as `@deepseek-ai/dsh-fs-local` | Forwarded to the replacement filesystem backend. |
| `runnerCommand`, `runnerFailureSignatures`, `probeTimeoutMs` | as `@deepseek-ai/dsh-sandbox-local` | Forwarded to the replacement sandbox provider. |

All four own fields are volatile: editing them applies to the next confined
call. A live edit that stops resolving grants nothing until it resolves again,
so a configuration mistake can only narrow the sandbox.

A concrete case for `$VAR` plus `createMissingRoots` — the writable paths pnpm
needs for its global store, which the shipped policy cannot express because
they are outside every workspace:

```yaml
    writablePaths:
      - '$XDG_RUNTIME_DIR/pnpm-store-operation-locks-1000'  # store lock files
      - '~/.local/share/pnpm'                               # content-addressable store
      - '~/.local/state/pnpm'                               # pnpm-state.json
      - '~/.npm'                                            # npx cache
    createMissingRoots: true
```


## Semantics and limits

- **The roots are part of `workspace-write`, not an escalation.** Nothing asks
  for approval, and the model is told not to request `sandbox_permissions` for
  them.
- **`read-only` still denies.** Unless `applyInReadOnly` is set, the extra roots
  are not granted in `read-only`, matching the text the policy layer already
  shows the model.
- **These roots are a deliberate hole.** A writable root is exactly as
  sensitive as the workspace: `~/.ssh` or `~/.config` would hand a session the
  user's credentials. Keep the list to caches and build outputs. A package store
  (`~/.local/share/pnpm`, `~/.cargo`) is a cache a confined command can poison,
  so grant one only when the tool that owns it actually runs inside the sandbox.
- **A persisted `/tmp` is the host `/tmp`.** Declaring `/tmp` trades the
  runner's private per-call tmpfs for the real directory. That is what makes
  temp files persist, but it also means a confined command can read and modify
  every other process's temp files (sockets, locks, and anything else a local
  service leaves in `/tmp`). The filesystem tools already had host `/tmp` in
  their shipped writable set, so this change aligns bash with what was already
  granted rather than adding a new capability — but it does remove the
  throwaway-tmpfs isolation, so drop `/tmp` from `writablePaths` if you want
  that back.
- **The `/tmp` promotion removes the private mount; it does not rely on mount
  ordering.** Current bubblewrap resolves a `--bind` source before applying a
  later `--tmpfs`, so naively appending `--bind /tmp /tmp` happens to reach the
  host directory too. Do not simplify `dropEphemeralMounts` away on that basis:
  if a future bwrap resolves sources at mount time, the same argv would bind the
  empty private tmpfs onto itself and silently revert `/tmp` to per-call
  ephemerality — a failure that looks like success.
- **Windows ACL runner is not widened.** That runner receives exactly one
  workspace and one temp root and cannot express another; the provider logs one
  warning per process and leaves the grant as shipped (the filesystem backend
  still honours the roots). bwrap, Landlock, and Seatbelt are widened.
- **This tracks shipped internals.** The plugin subclasses
  `LocalSandboxProvider` and `SandboxedFileSystem` and recognizes runner argv
  dialects. A DSH upgrade that changes a runner's profile spelling or a
  backend's method shape requires updating this plugin; the `applyInReadOnly`
  and dialect behavior are covered by `test/`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # builds lib/ first, then runs the .mjs tests
```

`lib/` is build output and is what the harness loads; it is not hand-written.

With `hmr.root` pointed at `$DSH_HOME/plugins` (see the profile patch), `pnpm
build` reloads this plugin in place — no harness restart. Two cautions, both
observed rather than theoretical:

- **Do not trigger the reload from inside a long-lived confined call.** Changing
  a file under `lib/` while a bash/fs call is still running makes that call the
  reload's in-flight consumer: it stalls or is aborted, and the UI can freeze
  until teardown settles. Edit, then let the call return; verify in a separate
  call.
- **The reload is a full remount.** `ctx.sandbox` and `ctx.fs` are disposed and
  re-registered, so a call that lands inside the swap fails. HMR restores the
  previous generation if the replacement cannot be activated, so a bad build
  costs a failed reload rather than a dead sandbox.

A quick way to confirm the running generation is the one on disk: with `/tmp`
declared, `grep ' /tmp ' /proc/self/mountinfo` shows two mounts (the read-only
recursive bind plus the writable host bind) once `dropEphemeralMounts` is
running, and three while an older generation — which leaves the runner's
private tmpfs mounted underneath — is still loaded.
