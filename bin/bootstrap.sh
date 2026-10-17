#!/usr/bin/env bash
# Restore this DSH home from the repo. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. There is nothing to decrypt: secrets.sops.yaml is read directly by
#    dsh-sops-credentials, in memory. It needs the age identity at
#    ~/.config/sops/age/keys.txt (or SOPS_AGE_KEY_FILE) and the `sops` binary.
if [ ! -f secrets.sops.yaml ]; then
  echo "FAIL: secrets.sops.yaml is missing; it is the only credential document" >&2
  exit 1
fi
sops -d --output-type json secrets.sops.yaml > /dev/null   || { echo "FAIL: cannot decrypt secrets.sops.yaml (is the age key present?)" >&2; exit 1; }

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
for plugin in web-search-kagi bash-shfmt extra-writable-roots claude-copilot-brand sops-credentials; do
  case "$dump" in
    *"$plugin"*) echo "ok: web profile composes $plugin" ;;
    *) echo "FAIL: web profile does not compose $plugin" >&2; exit 1 ;;
  esac
done

echo "restart the harness to mount anything newly linked"
