#!/usr/bin/env bash
# Promote anything in the plaintext credential store into a profile's SOPS
# document, then delete the plaintext copy.
#
# Run after a sign-in (or a provider record the harness wrote) so that every
# credential lives in secrets.<profile>.sops.yaml and nothing decrypted sits on
# disk.
#
#   bin/secrets-sync.sh [profile]     # default: web
set -euo pipefail
cd "$(dirname "$0")/.."
exec node plugins/dsh-sops-credentials/scripts/sync.mjs --profile "${1:-web}"
