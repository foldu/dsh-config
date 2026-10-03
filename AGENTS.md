# AGENTS.md

Instructions for coding agents working in this DSH home (`$DSH_HOME`).

This file is both this repo's project instructions and the user-global
`$DSH_HOME/AGENTS.md`, so it loads in every session on this machine. Everything
below is scoped to this repo and the plugins it carries — other projects here
follow their own conventions, and these rules must not be carried into them.

## Use TypeScript

Write plugin and harness code in TypeScript, not JavaScript.

- Source lives in `src/*.ts`. Never hand-write `lib/`.
- `lib/` is `tsc` output, gitignored, and is what the harness actually loads.
  Run `pnpm build` before anything can use your change.
- Mirror the shipped `@deepseek-ai/dsh-*` layout: `src/` compiles to
  `lib/*.js` plus emitted `lib/types/*.d.ts` (`declarationDir` in
  `tsconfig.json`).
- Type plugin config as the DSH pair: a `Config` interface whose fields are
  `Volatile<T>` from `@deepseek-ai/cordis`, alongside the schemastery
  `export const Config = z.object({...})` of the same name. Do not invent a
  parallel type or hand-maintain a `.d.ts`.
- Keep `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax` enabled, and narrow `unknown` at boundaries rather
  than casting.
- Hand-written JavaScript is acceptable only where no build step belongs — a
  small helper script, for instance. Tests stay `.mjs` deliberately: they
  exercise the built `lib/`, not the sources.
- A new plugin is a real package: `package.json`, `tsconfig.json`, `src/`,
  `test/`, README, plus a `link:` dependency from the profile.
- Reference implementation: `plugins/dsh-web-search-kagi`.

## Working in this repo

- `plugins/<name>/` are local packages; `profiles/<name>/` are profile
  manifests and patch layers; `bin/` holds helpers.
- Configure a profile in `profiles/<name>/cordis.patch.yml`. Never edit
  `cordis.yml` — the launcher regenerates it.
- Verify with `pnpm typecheck`, `pnpm test`, and
  `dsh --profile <name> --dump-config`.
- On a fresh clone, run `bin/bootstrap.sh`: build output is not committed, so
  the plugin has no `lib/` until it runs.

## Restart semantics

Config changes reload live through the patch layer. A newly installed or
relocated plugin module does not — the launcher fixes its module resolution at
boot. Ask the user to restart the harness after adding or moving one.

## Secrets

- `.credentials.yaml` is plaintext and gitignored. Never commit it, print its
  values, or paste them into logs or commit messages.
- Encrypted secrets live in `*.sops.yaml` (age). Refresh the credential
  snapshot with `bin/secrets-encrypt.sh` after the harness changes a key.
- `.githooks/pre-commit` blocks the decrypted store, absolute `link:` specs and
  likely plaintext tokens; enable it once per clone with
  `git config core.hooksPath .githooks`.
