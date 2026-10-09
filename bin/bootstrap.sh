#!/usr/bin/env bash
# Restore this DSH home from the repo. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Decrypt the harness credential store (the harness reads plaintext).
if [ ! -f .credentials.yaml ]; then
  if [ -f credentials.sops.yaml ]; then
    sops -d credentials.sops.yaml > .credentials.yaml
    chmod 600 .credentials.yaml
    echo "wrote .credentials.yaml from credentials.sops.yaml"
  else
    echo "note: no credentials.sops.yaml; add keys via the GUI or by hand" >&2
  fi
fi

# 2. Build the local plugins: the harness loads lib/index.js, which is not tracked.
for plugin in plugins/*/; do
  [ -f "${plugin}package.json" ] || continue
  echo "building ${plugin}"
  ( cd "$plugin" && pnpm install && pnpm build )
done

# 3. Materialize profile plugin links (link: specs need no network).
for profile in profiles/*/; do
  [ -f "${profile}package.json" ] || continue
  ( cd "$profile" && pnpm install )
done

# 4. Verify the composition sees the plugins.
dump=$(dsh --profile web --dump-config)
for plugin in web-search-kagi bash-shfmt extra-writable-roots claude-copilot-brand; do
  case "$dump" in
    *"$plugin"*) echo "ok: web profile composes $plugin" ;;
    *) echo "FAIL: web profile does not compose $plugin" >&2; exit 1 ;;
  esac
done

echo "restart the harness to mount anything newly linked"
