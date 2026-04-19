#!/usr/bin/env bash
# Creates .env with a freshly-generated GATEKEEPER_SECRET if one doesn't
# already exist. Idempotent — safe to rerun.
#
# Usage: npm run bootstrap
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
EXAMPLE_FILE="$(dirname "$0")/../.env.example"

if [[ -f "$ENV_FILE" ]] && grep -qE '^GATEKEEPER_SECRET=.{32,}' "$ENV_FILE"; then
  echo "✓ .env already has GATEKEEPER_SECRET set (≥32 chars). Nothing to do."
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found on PATH. Install it or generate a 32+ char secret manually." >&2
  exit 1
fi

SECRET=$(openssl rand -base64 48 | tr -d '=+/' | head -c 48)

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  # Replace the placeholder secret in the copy
  # BSD sed (macOS) needs '', GNU sed doesn't. Use portable pattern.
  tmp=$(mktemp)
  sed "s|^GATEKEEPER_SECRET=.*|GATEKEEPER_SECRET=${SECRET}|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "✓ Created .env from .env.example with a fresh GATEKEEPER_SECRET (${#SECRET} chars)."
else
  # .env exists but doesn't have a strong secret — append
  echo "" >> "$ENV_FILE"
  echo "# Auto-generated $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$ENV_FILE"
  echo "GATEKEEPER_SECRET=${SECRET}" >> "$ENV_FILE"
  echo "✓ Appended fresh GATEKEEPER_SECRET to existing .env (${#SECRET} chars)."
fi

echo "  Next: docker compose up"
