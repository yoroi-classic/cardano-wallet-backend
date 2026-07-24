#!/usr/bin/env bash
set -euo pipefail

chart=charts/cardano-wallet-backend

if helm template cardano-wallet-backend "$chart" \
  --set config.provider=dingo >/dev/null 2>&1; then
  echo "unsupported Dingo provider passed chart validation" >&2
  exit 1
fi

if helm template cardano-wallet-backend "$chart" \
  --set-string config.blockfrostUrl=not-a-url >/dev/null 2>&1; then
  echo "malformed Blockfrost URL passed chart validation" >&2
  exit 1
fi

chart_version="$(awk '$1 == "version:" { print $2; exit }' "$chart/Chart.yaml")"
if ! grep -Fq -- "--version $chart_version" "$chart/README.md"; then
  echo "GHCR install example is not pinned to chart version $chart_version" >&2
  exit 1
fi

default_render="$(helm template cardano-wallet-backend "$chart")"
if grep -Fq 'name: BLOCKFROST_' <<<"$default_render"; then
  echo "default provider unexpectedly renders Blockfrost environment variables" >&2
  exit 1
fi

if helm template cardano-wallet-backend "$chart" \
  --set config.provider=blockfrost >/dev/null 2>&1; then
  echo "Blockfrost rendered without the required Secret configuration" >&2
  exit 1
fi

if helm template cardano-wallet-backend "$chart" \
  --set config.provider=blockfrost \
  --set secrets.existingSecret=cardano-wallet-backend-secrets \
  --set-string secrets.blockfrostProjectIdKey= >/dev/null 2>&1; then
  echo "Blockfrost rendered without a Secret key for the project ID" >&2
  exit 1
fi

blockfrost_without_url="$(
  helm template cardano-wallet-backend "$chart" \
    --set config.provider=blockfrost \
    --set secrets.existingSecret=cardano-wallet-backend-secrets
)"
if grep -Fq 'name: BLOCKFROST_URL' <<<"$blockfrost_without_url"; then
  echo "Blockfrost rendered an empty optional URL" >&2
  exit 1
fi

blockfrost_render="$(
  helm template cardano-wallet-backend "$chart" \
    --set config.provider=blockfrost \
    --set config.blockfrostUrl=https://blockfrost.example/api/v0 \
    --set secrets.existingSecret=cardano-wallet-backend-secrets
)"

for expected in \
  'name: BLOCKFROST_PROJECT_ID' \
  'name: "cardano-wallet-backend-secrets"' \
  'key: "BLOCKFROST_PROJECT_ID"' \
  'name: BLOCKFROST_URL' \
  'value: "https://blockfrost.example/api/v0"'; do
  if ! grep -Fq "$expected" <<<"$blockfrost_render"; then
    echo "Blockfrost render is missing: $expected" >&2
    exit 1
  fi
done

if grep -Fq 'value: "BLOCKFROST_PROJECT_ID"' <<<"$blockfrost_render"; then
  echo "Blockfrost project ID rendered as a literal instead of a Secret reference" >&2
  exit 1
fi

echo "Blockfrost Helm wiring contract passed"
