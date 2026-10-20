# dsh-coauthor-identity

Tells the model selected in the Web GUI's composer who it is running as, and
which `Co-authored-by:` trailer to append when it creates a git commit.

The composer's model picker is the source of truth: the plugin reads the
Agent's live `provider`/`model` selection at every prompt assembly, looks the
pair up in a configured identity map, and contributes one system-prompt section.
An unlisted selection contributes no text — the plugin never guesses a model,
vendor, or address.

## What the model sees

For a selection mapped to `GLM-5.3 <noreply@z.ai>`, the section renders:

```text
You are running as the model selected in this session's UI: GLM-5.3 (provider "openrouter", model "z-ai/glm-5.3").

When you create a git commit, end the commit message with this trailer so the model is credited as co-author:

Co-authored-by: GLM-5.3 <noreply@z.ai>

Use exactly this name and email, add the trailer once, and place it in the final paragraph after a blank line. Do not credit a different model, vendor, or address.
```

The section sits at order `9100`, after first-party tool guidance and before
structured output, so a mid-session model switch rewrites less of the reusable
prompt prefix.

## Configuration

The row is inserted by this bundle's patch with an empty map, so it does
nothing until the deployment supplies identities. Configure them in the
profile's patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), which HMR
watches:

```yaml
- id: coauthor-identity
  config:
    coAuthors:
      # Exact `provider/model` the picker selects (`deepseek-official` is the
      # API-key route; `deepseek-account` is the sign-in route).
      "deepseek-official/deepseek-flash":
        name: DeepSeek-V4.1-Flash
        email: noreply@deepseek.com
      # A bare model id matches any provider.
      "z-ai/glm-5.3":
        name: GLM-5.3
        email: noreply@z.ai
      # Last resort for any other selection.
      "*":
        name: AI Agent
        email: noreply@example.com
```

Resolution is exact and ordered: `provider/model`, then the bare `model`, then
`*`. The first usable entry wins; a blank name or address, or one containing
`<`, `>`, or a line break, is skipped rather than emitted as a broken trailer.
Omitting `*` is the safe default: a newly added model then gets no section
instead of a trailer crediting the wrong vendor.

`provider` and `model` are the values the model picker stores on the Agent, so
a provider-qualified key must match the UI selection exactly. A bare model id
is the portable choice for one model reachable through several routes (for
example `deepseek-flash` through `deepseek-official` or `deepseek-account`).
Run `dsh --profile web --dump-config` to see the composed row and the
`agent-default-model` route.

## Install

The package is linked from the profile, like the other local plugins:

```sh
cd plugins/dsh-coauthor-identity && pnpm install && pnpm build
cd profiles/web && pnpm install
```

Then restart the harness: a newly linked module is resolved at boot, so a
running GUI does not pick it up from `cordis.patch.yml` alone. Later edits to
the identity map apply to the next assembly without a restart.

## Verify

```sh
cd plugins/dsh-coauthor-identity
pnpm typecheck
pnpm test
dsh --profile web --dump-config
```

Unit tests cover key precedence, unusable entries, and the rendered trailer.
The mounted section is observable only through a model request's system prompt:
after a restart, a new session's persisted prompt should contain
`Co-authored-by:`. Until then the running composition is unverified.

## Limits

- One identity per `provider/model`; there is no per-session or per-subagent
  override, and subagents that inherit the parent model see the parent's
  identity.
- The plugin instructs; it does not enforce. A model can still commit without
  the trailer, and commits the model does not create are untouched.
- Addresses are configured, not discovered: the model catalog has display names
  but no co-author addresses, so `noreply@…` values are deployment choices.
