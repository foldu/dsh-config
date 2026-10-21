#!/usr/bin/env bash
# Restore this DSH home from the repo. Safe to re-run.
#
#   bin/bootstrap.sh [profile]     # default: web
#
# The profile only chooses which credential document to check; every plugin and
# every profile is still built and linked.
set -euo pipefail
cd "$(dirname "$0")/.."

profile=${1:-web}

# 1. There is nothing to decrypt at boot: the profile's credential document is
#    read directly by dsh-sops-credentials, in memory. Decrypting it here only
#    proves which identity can read it, so a machine that does not hold the age
#    key is a warning, not a failure — the harness still boots and every
#    credential simply stays unresolved. See README, "Using this repo somewhere
#    else".
document="secrets.${profile}.sops.yaml"
if [ ! -f "$document" ]; then
  echo "warning: $document is missing; every credential will be unresolved" >&2
elif sops -d --output-type json "$document" > /dev/null 2>&1; then
  echo "ok: $document decrypts with the local age identity"
else
  echo "warning: cannot decrypt $document with the local age identity" >&2
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

# 4. Verify every profile that uses the shared bundle composes it, plus its own
#    rows. Profiles without the bundle (headless) are not expected to.
for profile in profiles/*/; do
  [ -f "${profile}package.json" ] || continue
  grep -q 'dsh-config-core' "${profile}package.json" || continue
  name=$(basename "$profile")
  dump=$(dsh --profile "$name" --dump-config)
  for plugin in web-search-kagi bash-shfmt extra-writable-roots claude-copilot-brand coauthor-identity sops-credentials; do
    case "$dump" in
      *"$plugin"*) : ;;
      *) echo "FAIL: $name profile does not compose $plugin" >&2; exit 1 ;;
    esac
  done
  echo "ok: $name profile composes the shared rows"
done

echo "restart the harness to mount anything newly linked"
