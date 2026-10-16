---
name: lab-gitlab-ci
description: Which GitLab runner tag to use for a job on lab.home.5kw.li — untagged runs plain unprivileged ubuntu, `nix` gets the host nix daemon and store, `buildkit` builds images with rootless buildkit. Use when writing or reviewing .gitlab-ci.yml on this GitLab.
---

# GitLab runner tags (lab.home.5kw.li)

| Job needs | `tags:` | What runs |
| --- | --- | --- |
| nix (`nix build`, `nix develop`) | `[nix]` | alpine, privileged, host `/nix/store` read-only, `NIX_REMOTE=daemon` |
| image builds (buildkit) | `[buildkit]` | `moby/buildkit:rootless` — the only allowed image |
| anything else | *(omit `tags:`)* | `ubuntu:latest`, unprivileged, nothing preinstalled |

- Use **exactly one** tag. Tags are AND-ed, so `[nix, buildkit]` matches no runner.
- Tagged jobs have no fallback: `[nix]` only ever runs on the nix runner, and sits `pending` when it's busy.
- Untagged jobs get the ubuntu runner — **no nix there**, so a nix job must be tagged `[nix]`.

Tags live on the runner records in GitLab, not in the `nixos-config` repo.
