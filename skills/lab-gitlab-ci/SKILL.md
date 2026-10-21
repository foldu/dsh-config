---
name: lab-gitlab-ci
description: Conventions for lab.home.5kw.li — which GitLab runner tag a job needs (untagged runs plain unprivileged ubuntu, `nix` gets the host nix daemon and store, `buildkit` builds images with rootless buildkit), and that repositories created there must be public. Use when writing or reviewing .gitlab-ci.yml on that GitLab, or creating a repository there.
---

# GitLab on lab.home.5kw.li

| Job needs | `tags:` | What runs |
| --- | --- | --- |
| nix (`nix build`, `nix develop`) | `[nix]` | alpine, privileged, host `/nix/store` read-only, `NIX_REMOTE=daemon` |
| image builds (buildkit) | `[buildkit]` | `moby/buildkit:rootless` — the only allowed image |
| anything else | *(omit `tags:`)* | `ubuntu:latest`, unprivileged, nothing preinstalled |

- Use **exactly one** tag. Tags are AND-ed, so `[nix, buildkit]` matches no runner.
- Tagged jobs have no fallback: `[nix]` only ever runs on the nix runner, and sits `pending` when it's busy.
- Untagged jobs get the ubuntu runner — **no nix there**, so a nix job must be tagged `[nix]`.

Tags live on the runner records in GitLab, not in the `nixos-config` repo.

## New repositories are public

Create them public: `glab repo create <name> --public` (the CLI's default is *internal*), or
`visibility=public` through the API. Never create an internal or private project here.
