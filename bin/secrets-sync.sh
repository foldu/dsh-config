#!/usr/bin/env bash
# Promote anything in the plaintext credential store into the single SOPS
# document, then delete the plaintext copy.
#
# Run after a sign-in (or a provider record the harness wrote) so that every
# credential lives in secrets.sops.yaml and nothing decrypted sits on disk.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node plugins/dsh-sops-credentials/scripts/sync.mjs "$@"
