#!/usr/bin/env bash
# Refresh the encrypted snapshot of the harness credential store.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .credentials.yaml ]; then
  echo "no .credentials.yaml to encrypt" >&2
  exit 1
fi

cp .credentials.yaml credentials.sops.yaml
sops -e -i credentials.sops.yaml
echo "encrypted credentials.sops.yaml — commit it"
