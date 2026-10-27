---
name: nixpkgs
description: Pin nixpkgs in flake.nix to the nixos.org channel tarball (`https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst`) instead of `github:NixOS/nixpkgs` or a registry shortcut. Use when writing or reviewing `flake.nix` inputs, `flake.lock`, or flake update tooling.
---

# Pinning nixpkgs

A nixpkgs input is the nixos.org channel tarball:

```nix
inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";
```

It is an ordinary flake input: `legacyPackages`, `lib`, `follows`, overlays and `nix flake update` all
behave the same. The channel URL redirects to an immutable release, and the lock records that release, so
pinning is unaffected — while the download is ~20 % smaller than GitHub's and not rate-limited. The NixOS
channel also ships `programs.sqlite`, which turns `command-not-found` on by itself.

## Migrating

1. Replace **every** nixpkgs-typed input, not just `nixpkgs` — a second input for overlays or home-manager
   needs it too.
2. `nix flake update nixpkgs` (or `nix flake lock`), then commit `flake.lock`.
3. Confirm it resolved to a release, not the channel alias:

   ```sh
   nix flake metadata --json | jq -r '.locks.nodes.nixpkgs.locked.url'
   # https://releases.nixos.org/nixos/unstable/nixos-26.11pre1100280.3ec636362e18/nixexprs.tar.zst
   ```

4. `nix flake check` and build.

The lock keeps both URLs, which is the point:

```json
"nixpkgs": {
  "locked": {
    "lastModified": 1792773339,
    "narHash": "sha256-17eNBI5Khe4JZaRkL5hRGPWf8MZ6qv+bWAr4V8YeKBw=",
    "rev": "3ec636362e1816bc2f0888fa0fa2c69f1bc9e504",
    "type": "tarball",
    "url": "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1100280.3ec636362e18/nixexprs.tar.zst"
  },
  "original": {
    "type": "tarball",
    "url": "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst"
  }
}
```

`original` is what `nix flake update` follows; `locked` is the immutable release, nixpkgs commit in `rev`.

## Pinning an exact revision

`locked.url` is the thing to quote in a bug report and to hand `--override-input`. Pick a revision from
<https://releases.nixos.org/> that Hydra already built, so nothing gets rebuilt locally:

```sh
nix flake update --override-input nixpkgs \
  "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1100280.3ec636362e18/nixexprs.tar.zst"
```

## Don't

- **Registry shortcuts** — `inputs.nixpkgs.url = "nixpkgs/nixos-unstable"` or plain `"nixpkgs"` resolve
  through the flake registry, so the input's identity lives in the host's config rather than `flake.nix`.
  `nix flake update` becomes host-dependent and the input can sit on an old commit forever because the
  registry pin never moves. On the command line the registry is fine: `nix shell nixpkgs#jq`.
- **`github:NixOS/nixpkgs/<branch>`** — bigger download, rate limits, and it keeps the build tied to the forge.
