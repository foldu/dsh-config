---
name: task-runners
description: Use `just` for task running, never a Makefile; use mise tasks instead when the project already has mise. Use when adding, rewriting, or reviewing a task runner (justfile, mise.toml, Makefile) or when a repo needs test/lint/build/run commands.
---

# Task runners

For running named tasks — `test`, `lint`, `build`, `run`, `fmt`, `release` — use `just`.
`make` is almost never what you want, and a Makefile full of `.PHONY` targets is the tell.

## Why not make

Make's model is a file target rebuilt when its prerequisites are newer. Task lists have no files, so
every mechanic gets subverted:

- **"Up to date" lies.** A `test` target is skipped, silently and successfully, whenever a file or
  directory named `test` exists. `.PHONY` fixes it; one forgotten `.PHONY` line is invisible until CI
  runs nothing and reports green.
- **Tabs.** Recipe lines must start with a literal tab. Any reformat that turns it into spaces is a
  `missing separator` error, and the fix reads like superstition.
- **Every line is its own shell.** `cd build && ./run` on one line doesn't carry to the next; variables
  don't carry; `$` must be written `$$`; loops collapse onto one line. `.ONESHELL` helps, then quietly
  changes the semantics of every other recipe.
- **No arguments.** Parameters arrive as `make test FILTER=foo` variable overrides, which collide with
  the environment and with make's own names (`MAKE`, `SHELL`, `CURDIR`).
- **No discovery.** There is no `make --list`; `make help` is a per-repo invention built out of comments
  and `grep`.
- **Parallelism is graph-shaped.** `-j` runs prerequisites concurrently and interleaves their output —
  for independent tasks that is noise, not speed.

Leave a Makefile alone where it really is one: file targets with real prerequisites that produce files
(compiling objects, generated code). Even there, prefer a generator that emits Ninja; don't hand-write
either one just to hold a task list.

## Default: just

A `justfile` at the repo root. Recipes are shell with names and real arguments:

```just
set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

# Run the test suite.
test:
    uv run pytest

# Lint and type-check.
check:
    uv run ruff check .
    uv run mypy .

# Build, then run. The dependency runs first and fails the recipe if it fails.
run: build
    ./build/app --dev

build target="debug":
    cargo build --profile {{ target }}

# A multi-step script: one shell for the whole body.
publish version:
    #!/usr/bin/env bash
    set -euo pipefail
    git tag "v{{ version }}"
    git push origin "v{{ version }}"
```

- `just` alone runs the first recipe; `just --list` is the help, generated from the `#` comment above
  each recipe.
- Arguments and defaults are real: `just build release`, `just build` (defaults to `debug`). Variadic
  recipes (`*args`, `+args`) pass the rest through.
- A recipe runs from the justfile's directory wherever you invoke it; `[no-cd]` opts one out.
- `[private]` (or a leading `_`) hides a helper from `--list`; `[confirm]` prompts before a destructive
  recipe runs.
- `just --fmt` formats the file; `just --fmt --check` belongs in CI.

Lines are separate shells, exactly as in make — `set shell` fixes the interpreter, not the split. For
state that must carry between steps, put them on one line with `&&`, or use a shebang recipe.

Add `just` to the dev shell and the CI image, and have CI call `just check` rather than repeating the
command lines — the point is one definition of each task.

## If mise is already there, use mise tasks

mise can sort of do what just does, and when the project already pins its toolchain with mise, its tasks
are the better home: one config file, and every task runs with the mise toolchain on `PATH`.

```toml
# mise.toml
[tasks.test]
description = "Run the test suite"
depends = ["check"]
run = "uv run pytest"

[tasks.check]
run = "uv run ruff check . && uv run mypy ."

[tasks.build]
description = "Build the wheel"
sources = ["src/**/*.py"]
outputs = ["dist/"]
run = "uv build"
```

- `mise run test`, or `mise tasks` to list. `mise watch build` reruns when `sources` change.
- `depends` orders prerequisites; `depends_post` and `wait_for` cover the other orderings, and a task's
  own `tools` override the project toolchain for that task only.
- Qualified names (`mise run //frontend:test`) address tasks in subdirectories.

It is the younger runner: fewer syntax tricks, and it leans on Tera templates where just has purpose-built
recipe arguments. That is the price of having tools and tasks in one file. Don't add a justfile beside it.

## Choosing

1. A `justfile` exists — add the recipe there.
2. Only mise (`mise.toml`, `.mise.toml`, with `[tools]` and/or `[tasks]`) — write a mise task.
3. Neither — write a `justfile`. Do not write a Makefile.
4. A Makefile exists and its targets are really files — leave it, and call it from a just recipe if a
   task needs it.
5. A Makefile exists and is really a task list — put new work in a `justfile` instead of extending it,
   and port the old targets as you touch them. If something outside the repo still calls `make test`
   (CI config, docs, a container entrypoint), keep a shim that forwards to just:

```make
.PHONY: test lint build
test lint build:
	@just $@
```

## Don't

- Don't add a Makefile for `install`, `test`, `lint`, `fmt`, `run`, `release`, `dev`, or to wrap
  `docker compose` / migrations / a formatter.
- Don't keep two runners live in one repo — convert, or shim and delete.
- Don't rewrite a real build Makefile into a task runner, or a task runner into make.
