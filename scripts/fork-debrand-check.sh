#!/usr/bin/env bash
set -euo pipefail

# Fork debrand check: ensure no upstream marketing content leaks into source files.
# Runs on all source files, not a known list — catches new files from upstream.
#
# Exit 0 = clean, Exit 1 = violations found
#
# Usage:
#   bash scripts/fork-debrand-check.sh        # run check
#   bun run debrand:check                      # via package.json alias

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

VIOLATIONS=0

# --- Layer 1: Exact string patterns (high confidence, auto-fail) ---
EXACT_PATTERNS=(
  "shaped by Garry Tan"
  "Garry Tan's"
  "ycombinator.com/apply"
  "personal note from me, Garry"
  "founder signal"
  "builder-profile\.jsonl"
  "YC partner energy"
  "garryslist.org"
  "consider applying to Y Combinator"
  "nstack-builder-profile"
  "resources-shown\.jsonl"
  "gstack-telemetry"
)

# Files/dirs to exclude (historical, attribution, self-referential, or generated)
EXCLUDE_ARGS=(
  --exclude=CHANGELOG.md
  --exclude=LICENSE
  --exclude="fork-debrand-check.sh"
  --exclude-dir=docs/designs
  --exclude-dir=.git
  --exclude-dir=.context
  --exclude-dir=node_modules
  --exclude-dir=browse/dist
  --exclude-dir=design/dist
  --exclude-dir=research/dist
)

for pattern in "${EXACT_PATTERNS[@]}"; do
  matches=$(grep -rl "$pattern" "${EXCLUDE_ARGS[@]}" . 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "VIOLATION: Pattern '$pattern' found in:"
    echo "$matches" | sed 's/^/  /'
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# --- Layer 2: Structural checks (catches refactored content) ---

# Voice section referencing specific individuals
VOICE_NAMES=$(grep -rl "shaped by .* judgment\|Encode how .* thinks" \
  --include="*.ts" --include="*.tmpl" \
  "${EXCLUDE_ARGS[@]}" . 2>/dev/null || true)
if [ -n "$VOICE_NAMES" ]; then
  echo "VIOLATION: Voice section references specific individuals:"
  echo "$VOICE_NAMES" | sed 's/^/  /'
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# YC application/marketing URLs (exclude news.ycombinator.com which is Hacker News)
YC_URLS=$(grep -rn "ycombinator\.com\|y-combinator\.com" \
  --include="*.ts" --include="*.tmpl" --include="*.html" --include="*.md" \
  "${EXCLUDE_ARGS[@]}" . 2>/dev/null | grep -v "news\.ycombinator\.com" || true)
if [ -n "$YC_URLS" ]; then
  echo "VIOLATION: YC URLs found in source files:"
  echo "$YC_URLS" | sed 's/^/  /'
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# Founder/builder tracking infrastructure
TRACKING=$(grep -rl "founder.*tier\|signal.*count\|builder.*journey\|resources.*shown" \
  --include="*.ts" --include="*.tmpl" \
  "${EXCLUDE_ARGS[@]}" . 2>/dev/null || true)
if [ -n "$TRACKING" ]; then
  echo "WARNING: Possible founder tracking infrastructure:"
  echo "$TRACKING" | sed 's/^/  /'
  echo "  (Review manually -- may be false positive)"
fi

# --- Summary ---
if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "FAILED: $VIOLATIONS violation(s) found. Fix before committing."
  exit 1
else
  echo "PASSED: No upstream marketing content detected."
  exit 0
fi
