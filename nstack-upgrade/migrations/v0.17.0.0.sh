#!/usr/bin/env bash
# Migration: v0.17.0.0 — Remove skill_prefix config, always prefix skills
#
# What changed: skill_prefix is no longer a config option. All skills are
# permanently prefixed with nstack-* (e.g., /nstack-qa, /nstack-ship).
# The --prefix/--no-prefix setup flags and interactive prompt are removed.
#
# What this does:
#   1. Removes skill_prefix from global and local config files
#   2. Runs nstack-relink to clean up any old flat (unprefixed) skill entries
#      and ensure all skills are nstack-* prefixed
#
# Affected: users who had skill_prefix set (either true or false)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Remove skill_prefix from global config
_GLOBAL_CONFIG="${NSTACK_STATE_DIR:-$HOME/.nstack}/config.yaml"
if [ -f "$_GLOBAL_CONFIG" ] && grep -qE '^skill_prefix:' "$_GLOBAL_CONFIG" 2>/dev/null; then
  echo "  [v0.17.0.0] Removing skill_prefix from global config..."
  _TMP="$(mktemp "${_GLOBAL_CONFIG}.XXXXXX")"
  grep -vE '^skill_prefix:' "$_GLOBAL_CONFIG" > "$_TMP" && mv "$_TMP" "$_GLOBAL_CONFIG"
fi

# Remove skill_prefix from local config (if in a git repo)
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$_ROOT" ] && [ -f "$_ROOT/.nstack/config.yaml" ]; then
  _LOCAL_CONFIG="$_ROOT/.nstack/config.yaml"
  if grep -qE '^skill_prefix:' "$_LOCAL_CONFIG" 2>/dev/null; then
    echo "  [v0.17.0.0] Removing skill_prefix from local config..."
    _TMP="$(mktemp "${_LOCAL_CONFIG}.XXXXXX")"
    grep -vE '^skill_prefix:' "$_LOCAL_CONFIG" > "$_TMP" && mv "$_TMP" "$_LOCAL_CONFIG"
  fi
fi

# Relink all skills as nstack-* prefixed (cleans up old flat entries)
if [ -x "$SCRIPT_DIR/bin/nstack-relink" ]; then
  echo "  [v0.17.0.0] Relinking all skills as nstack-*..."
  "$SCRIPT_DIR/bin/nstack-relink" 2>/dev/null || true
fi
