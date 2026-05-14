#!/bin/bash
#
# wakit deploy script
# Deploys core edge functions and conditionally deploys enabled plugins.
# Reads wakit.config.json to determine which plugins to deploy.
#
# Usage:
#   bash scripts/deploy.sh                  # deploy core + enabled plugins
#   bash scripts/deploy.sh --all            # deploy everything (core + all plugins)
#   bash scripts/deploy.sh --core-only      # deploy only core functions
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/wakit.config.json"

# Core functions — always deployed
CORE_FUNCTIONS=(
  whatsapp-webhook
  whatsapp-dispatcher
  whatsapp-management
  agent-client
  media-preprocessor
  mcp
  api
)

# All plugin functions — for --all flag
ALL_PLUGIN_FUNCTIONS=(
  stripe-checkout
  stripe-webhook
  stripe-portal
  migrate-twilio
)

deploy_function() {
  local fn="$1"
  echo "  → Deploying $fn..."
  supabase functions deploy "$fn" --no-verify-jwt || echo "  ✗ Failed to deploy $fn"
}

echo "=== wakit deploy ==="
echo ""

# Deploy core functions
echo "Core functions:"
for fn in "${CORE_FUNCTIONS[@]}"; do
  deploy_function "$fn"
done

echo ""

# Handle flags
if [[ "${1:-}" == "--core-only" ]]; then
  echo "Skipping plugins (--core-only)"
  echo ""
  echo "=== Done ==="
  exit 0
fi

if [[ "${1:-}" == "--all" ]]; then
  echo "Plugin functions (--all):"
  for fn in "${ALL_PLUGIN_FUNCTIONS[@]}"; do
    deploy_function "$fn"
  done
  echo ""
  echo "=== Done ==="
  exit 0
fi

# Deploy enabled plugins from wakit.config.json
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "No wakit.config.json found — skipping plugins"
  echo ""
  echo "=== Done ==="
  exit 0
fi

if ! command -v jq &>/dev/null; then
  echo "Warning: jq not installed — cannot read wakit.config.json, skipping plugins"
  echo ""
  echo "=== Done ==="
  exit 0
fi

PLUGIN_FUNCTIONS=$(jq -r '.plugins | to_entries[] | select(.value.enabled == true) | .value.functions[]' "$CONFIG_FILE" 2>/dev/null)

if [[ -z "$PLUGIN_FUNCTIONS" ]]; then
  echo "No plugins enabled in wakit.config.json"
else
  echo "Plugin functions:"
  while IFS= read -r fn; do
    deploy_function "$fn"
  done <<< "$PLUGIN_FUNCTIONS"
fi

echo ""
echo "=== Done ==="
