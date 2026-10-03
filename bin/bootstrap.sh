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

# 2. Build the local plugin: the harness loads lib/index.js, which is not tracked.
if [ -d plugins/dsh-web-search-kagi ]; then
  ( cd plugins/dsh-web-search-kagi && pnpm install && pnpm build )
fi

# 3. Materialize profile plugin links (link: specs need no network).
for profile in profiles/*/; do
  [ -f "${profile}package.json" ] || continue
  ( cd "$profile" && pnpm install )
done

# 4. Verify the composition sees the plugin.
dump=$(dsh --profile web --dump-config)
case "$dump" in
  *web-search-kagi*) echo "ok: web profile composes the kagi provider" ;;
  *) echo "FAIL: web profile does not compose web-search-kagi" >&2; exit 1 ;;
esac

echo "restart the harness to mount anything newly linked"
