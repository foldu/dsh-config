#!/usr/bin/env bash
# Restore this DSH home from the repo. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. There is nothing to decrypt at boot: secrets.sops.yaml is read directly by
#    dsh-sops-credentials, in memory. Decrypting it here only proves which
#    identity can read it, so a machine that does not hold the age key is a
#    warning, not a failure — the harness still boots and every credential
#    simply stays unresolved. See README, "Using this repo somewhere else".
if [ ! -f secrets.sops.yaml ]; then
  echo "warning: secrets.sops.yaml is missing; every credential will be unresolved" >&2
elif sops -d --output-type json secrets.sops.yaml > /dev/null 2>&1; then
  echo "ok: secrets.sops.yaml decrypts with the local age identity"
else
  echo "warning: cannot decrypt secrets.sops.yaml with the local age identity" >&2
  echo "         expected on a machine that does not hold the key;" >&2
  echo "         create a credential document for this machine (README)" >&2
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
for plugin in web-search-kagi bash-shfmt extra-writable-roots claude-copilot-brand coauthor-identity sops-credentials; do
  case "$dump" in
    *"$plugin"*) echo "ok: web profile composes $plugin" ;;
    *) echo "FAIL: web profile does not compose $plugin" >&2; exit 1 ;;
  esac
done

echo "restart the harness to mount anything newly linked"
