#!/usr/bin/env bash
# Migration: v0.18.0.0 — Move project documents from global ~/.nstack/projects/$SLUG/
# to local .nstack/ in each repo, plus seed the durable global learnings archive.
#
# What changed:
#   - Project documents (design docs, test plans, autoplan restore, CEO plans,
#     checkpoints, branch reviews) live in .nstack/{designs,plans,checkpoints}/
#     in the repo, not in ~/.nstack/projects/$SLUG/.
#   - ~/.nstack/projects.yaml is the global project registry (path-keyed).
#   - ~/.nstack/learnings.jsonl is the durable global archive (dual-written
#     when cross_project_learnings=true).
#   - cross_project_learnings default flips from "unset" to "false" (privacy-first).
#   - v0.17.0.0 CHANGELOG claimed design docs migrated, but templates still
#     wrote to legacy global. This migration corrects that mis-ship.
#
# What this does:
#   1. Backs up ~/.nstack/projects/ to ~/.nstack/projects.v0.17-backup/.
#   2. Sets cross_project_learnings=false globally if unset (preserves explicit
#      true/false from prior installs — backward compatible).
#   3. For each ~/.nstack/projects/$SLUG/ entry:
#      a. Resolves all repo paths for $SLUG via the slug-cache (path -> slug).
#      b. If exactly one path exists and is reachable: moves design docs / plans
#         / checkpoints / reviews into that repo's .nstack/ subdirs.
#      c. If multiple paths exist: picks the one with most recent slug-cache
#         mtime as canonical, prints guidance for the others.
#      d. If zero paths exist: leaves artifacts in place; prints orphan note.
#      e. Seeds learnings into ~/.nstack/learnings.jsonl tagged with project
#         + repo_path (one-time, not a substitute for ongoing dual-write).
#   4. Writes a manifest.jsonl recording each move so subsequent runs can skip.
#
# Idempotent: re-running is safe — already-moved files are skipped via manifest.
# Non-fatal: failures are logged and don't block the upgrade.
# Concurrent-safe: holds a flock on ~/.nstack/.migration-v0.18.lock.
#
# Affected: users with data in ~/.nstack/projects/ (effectively everyone on
# pre-v0.18).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK_HELPER="$SCRIPT_DIR/scripts/internal/lock.sh"

NSTACK_HOME="${NSTACK_STATE_DIR:-$HOME/.nstack}"
LEGACY_DIR="$NSTACK_HOME/projects"
BACKUP_DIR="$NSTACK_HOME/projects.v0.17-backup"
SLUG_CACHE="$NSTACK_HOME/slug-cache"
GLOBAL_LEARNINGS="$NSTACK_HOME/learnings.jsonl"
MARKER="$NSTACK_HOME/.v0.18-migrated"
MANIFEST="$NSTACK_HOME/v0.18-migration-manifest.jsonl"
LOCK_FILE="$NSTACK_HOME/.migration-v0.18.lock"

# If marker exists, migration already ran successfully on this machine.
if [ -f "$MARKER" ]; then
  echo "  [v0.18.0.0] Already migrated. Skipping."
  exit 0
fi

# If no legacy dir, nothing to migrate.
if [ ! -d "$LEGACY_DIR" ]; then
  echo "  [v0.18.0.0] No legacy ~/.nstack/projects/ directory. Marking migrated."
  mkdir -p "$NSTACK_HOME"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  exit 0
fi

# Default cross_project_learnings to false globally if unset (privacy-first).
GLOBAL_CONFIG="$NSTACK_HOME/config.yaml"
if [ -f "$GLOBAL_CONFIG" ] && ! grep -qE '^cross_project_learnings:' "$GLOBAL_CONFIG" 2>/dev/null; then
  echo "cross_project_learnings: false" >> "$GLOBAL_CONFIG"
  echo "  [v0.18.0.0] Set cross_project_learnings=false in global config (privacy-first default)."
elif [ ! -f "$GLOBAL_CONFIG" ]; then
  mkdir -p "$NSTACK_HOME"
  echo "cross_project_learnings: false" > "$GLOBAL_CONFIG"
fi

# Source lock helper
if [ -f "$LOCK_HELPER" ]; then
  # shellcheck disable=SC1090
  source "$LOCK_HELPER"
else
  nstack_with_lock() { local _lf="$1" _to="$2"; shift 2; "$@"; }
fi

# Backup size check: ~100MB threshold. Print warning if larger.
LEGACY_SIZE_MB=$(du -sm "$LEGACY_DIR" 2>/dev/null | awk '{print $1}')
if [ -n "${LEGACY_SIZE_MB:-}" ] && [ "$LEGACY_SIZE_MB" -gt 100 ]; then
  echo "  [v0.18.0.0] Backup size: ~${LEGACY_SIZE_MB} MB. Backing up to $BACKUP_DIR..."
fi

_run_migration() {
  # Backup (idempotent — skip if backup already exists)
  if [ ! -d "$BACKUP_DIR" ]; then
    cp -a "$LEGACY_DIR" "$BACKUP_DIR" 2>/dev/null || {
      echo "  [v0.18.0.0] WARN: backup failed. Continuing with in-place migration." >&2
    }
  fi

  # Build slug -> [paths] reverse map from slug-cache.
  # Slug-cache is path -> slug; we write a temp file `slug\tmtime\tpath` and
  # sort by (slug, mtime DESC) to find the canonical path for each slug.
  # macOS ships bash 3.2 (no associative arrays), so use sortable text instead.
  REVERSE_MAP=$(mktemp "${TMPDIR:-/tmp}/nstack-reverse-map.XXXXXX")
  # RETURN trap fires on function exit; EXIT trap fires on Ctrl-C / kill.
  # The lock helper itself releases the flock on return, so this only handles temp file cleanup.
  trap 'rm -f "$REVERSE_MAP" "$REVERSE_MAP.sorted" 2>/dev/null || true' RETURN EXIT
  if [ -d "$SLUG_CACHE" ]; then
    for cache_file in "$SLUG_CACHE"/*; do
      [ -f "$cache_file" ] || continue
      slug=$(cat "$cache_file" 2>/dev/null || true)
      [ -z "$slug" ] && continue
      encoded_path=$(basename "$cache_file")
      decoded_path=$(printf '%s' "$encoded_path" | sed 's|_|/|g')
      mtime=$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || echo 0)
      printf '%s\t%s\t%s\n' "$slug" "$mtime" "$decoded_path" >> "$REVERSE_MAP"
    done
  fi
  # Sort by slug ASC, mtime DESC. The first row per slug is the canonical path.
  if [ -s "$REVERSE_MAP" ]; then
    LC_ALL=C sort -t$'\t' -k1,1 -k2,2nr "$REVERSE_MAP" > "$REVERSE_MAP.sorted"
  else
    : > "$REVERSE_MAP.sorted"
  fi

  _slug_to_latest_path() {
    # First row per slug after the sort is the canonical path
    awk -F'\t' -v slug="$1" '$1==slug { print $3; exit }' "$REVERSE_MAP.sorted"
  }
  _slug_path_count() {
    awk -F'\t' -v slug="$1" '$1==slug { c++ } END { print c+0 }' "$REVERSE_MAP.sorted"
  }

  total_moved=0
  total_orphaned=0
  total_skipped=0
  total_seeded=0

  for legacy_slug_dir in "$LEGACY_DIR"/*; do
    [ -d "$legacy_slug_dir" ] || continue
    slug=$(basename "$legacy_slug_dir")
    target_path=$(_slug_to_latest_path "$slug")

    if [ -z "$target_path" ]; then
      total_orphaned=$((total_orphaned+1))
      echo "  [v0.18.0.0] ORPHAN: ~/.nstack/projects/$slug (no slug-cache entry). Leaving in place." >&2
      continue
    fi
    if [ ! -d "$target_path" ]; then
      total_orphaned=$((total_orphaned+1))
      echo "  [v0.18.0.0] ORPHAN: $slug -> $target_path (path missing). Leaving in place." >&2
      continue
    fi
    if ! git -C "$target_path" rev-parse --show-toplevel >/dev/null 2>&1; then
      total_orphaned=$((total_orphaned+1))
      echo "  [v0.18.0.0] ORPHAN: $slug -> $target_path (not a git repo). Leaving in place." >&2
      continue
    fi

    # Multi-worktree warning: if multiple paths share this slug, note which one we chose
    n_paths=$(_slug_path_count "$slug")
    if [ "$n_paths" -gt 1 ]; then
      echo "  [v0.18.0.0] $slug has $n_paths worktrees; using most-recent: $target_path"
    fi

    nstack_dir="$target_path/.nstack"
    mkdir -p "$nstack_dir/designs" "$nstack_dir/plans/ceo" "$nstack_dir/checkpoints" "$nstack_dir/evals"

    # Move artifacts by category
    moved_count=0
    # Design docs (*-design-*.md, vision/spike docs, autoplan-restore)
    for f in "$legacy_slug_dir"/*-design-*.md "$legacy_slug_dir"/*-design.md; do
      [ -f "$f" ] || continue
      target="$nstack_dir/designs/$(basename "$f")"
      if [ ! -f "$target" ]; then
        mv "$f" "$target"
        printf '{"src":"%s","dest":"%s","ts":"%s"}\n' "$f" "$target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
        moved_count=$((moved_count+1))
      fi
    done
    # Test plans
    for f in "$legacy_slug_dir"/*-test-plan-*.md "$legacy_slug_dir"/*-autoplan-*.md; do
      [ -f "$f" ] || continue
      target="$nstack_dir/plans/$(basename "$f")"
      if [ ! -f "$target" ]; then
        mv "$f" "$target"
        printf '{"src":"%s","dest":"%s","ts":"%s"}\n' "$f" "$target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
        moved_count=$((moved_count+1))
      fi
    done
    # CEO handoffs
    for f in "$legacy_slug_dir"/*-ceo-handoff-*.md; do
      [ -f "$f" ] || continue
      target="$nstack_dir/plans/$(basename "$f")"
      if [ ! -f "$target" ]; then
        mv "$f" "$target"
        printf '{"src":"%s","dest":"%s","ts":"%s"}\n' "$f" "$target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
        moved_count=$((moved_count+1))
      fi
    done
    # CEO plans subdir
    if [ -d "$legacy_slug_dir/ceo-plans" ]; then
      for f in "$legacy_slug_dir/ceo-plans"/*.md; do
        [ -f "$f" ] || continue
        target="$nstack_dir/plans/ceo/$(basename "$f")"
        if [ ! -f "$target" ]; then
          mv "$f" "$target"
          printf '{"src":"%s","dest":"%s","ts":"%s"}\n' "$f" "$target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
          moved_count=$((moved_count+1))
        fi
      done
      # archive subdir
      if [ -d "$legacy_slug_dir/ceo-plans/archive" ]; then
        mkdir -p "$nstack_dir/plans/ceo/archive"
        for f in "$legacy_slug_dir/ceo-plans/archive"/*.md; do
          [ -f "$f" ] || continue
          target="$nstack_dir/plans/ceo/archive/$(basename "$f")"
          [ -f "$target" ] || { mv "$f" "$target" && moved_count=$((moved_count+1)); }
        done
        rmdir "$legacy_slug_dir/ceo-plans/archive" 2>/dev/null || true
      fi
      rmdir "$legacy_slug_dir/ceo-plans" 2>/dev/null || true
    fi
    # Checkpoints
    if [ -d "$legacy_slug_dir/checkpoints" ]; then
      for f in "$legacy_slug_dir/checkpoints"/*.md; do
        [ -f "$f" ] || continue
        target="$nstack_dir/checkpoints/$(basename "$f")"
        [ -f "$target" ] || { mv "$f" "$target" && moved_count=$((moved_count+1)); }
      done
      rmdir "$legacy_slug_dir/checkpoints" 2>/dev/null || true
    fi
    # Evals
    if [ -d "$legacy_slug_dir/evals" ]; then
      for f in "$legacy_slug_dir/evals"/*; do
        [ -f "$f" ] || continue
        target="$nstack_dir/evals/$(basename "$f")"
        [ -f "$target" ] || { mv "$f" "$target" && moved_count=$((moved_count+1)); }
      done
      rmdir "$legacy_slug_dir/evals" 2>/dev/null || true
    fi
    # Reviews jsonls (any file matching *-reviews.jsonl)
    for f in "$legacy_slug_dir"/*-reviews.jsonl; do
      [ -f "$f" ] || continue
      target="$nstack_dir/$(basename "$f")"
      if [ ! -f "$target" ]; then
        mv "$f" "$target"
        moved_count=$((moved_count+1))
      fi
    done
    # Health history
    if [ -f "$legacy_slug_dir/health-history.jsonl" ]; then
      target="$nstack_dir/health-history.jsonl"
      [ -f "$target" ] || { mv "$legacy_slug_dir/health-history.jsonl" "$target"; moved_count=$((moved_count+1)); }
    fi
    # Land-deploy state
    if [ -f "$legacy_slug_dir/land-deploy-confirmed" ]; then
      target="$nstack_dir/land-deploy-confirmed"
      [ -f "$target" ] || { mv "$legacy_slug_dir/land-deploy-confirmed" "$target"; moved_count=$((moved_count+1)); }
    fi
    # Learnings: SEED into global archive (don't move; legacy global stays
    # untouched as backup). The local .nstack/learnings.jsonl already exists
    # in v0.17 (preamble-resolver migration).
    if [ -f "$legacy_slug_dir/learnings.jsonl" ]; then
      if [ -n "${BUN_BIN:-$(command -v bun 2>/dev/null)}" ] || [ -x "$HOME/.bun/bin/bun" ]; then
        BUN_BIN="${BUN_BIN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
        # Pass paths via env vars (NOT string interpolation) to prevent shell injection
        # if a slug or path contains apostrophes, backslashes, or newlines. The bun
        # script reads everything via process.env. The script prints the count of seeded
        # lines on stdout so we can increment total_seeded only on success.
        seed_count=$(REPO_PATH="$target_path" PROJECT="$slug" SRC="$legacy_slug_dir/learnings.jsonl" DST="$GLOBAL_LEARNINGS" "$BUN_BIN" -e '
          const fs = require("fs");
          const src = process.env.SRC;
          const dst = process.env.DST;
          const project = process.env.PROJECT;
          const repo_path = process.env.REPO_PATH;
          if (!fs.existsSync(src)) { console.log(0); process.exit(0); }
          const out = [];
          for (const line of fs.readFileSync(src, "utf-8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              j.project = j.project || project;
              j.repo_path = j.repo_path || repo_path;
              out.push(JSON.stringify(j));
            } catch {}
          }
          if (out.length) fs.appendFileSync(dst, out.join("\n") + "\n");
          console.log(out.length);
        ' 2>/dev/null) || seed_count=0
        # Only count actual seeded lines (bun prints the count); empty/error → 0
        case "$seed_count" in
          ''|*[!0-9]*) seed_count=0 ;;
        esac
        total_seeded=$((total_seeded+seed_count))
      fi
    fi

    if [ "$moved_count" -gt 0 ]; then
      total_moved=$((total_moved+moved_count))
      echo "  [v0.18.0.0] $slug -> $target_path/.nstack/: moved $moved_count file(s)"
    else
      total_skipped=$((total_skipped+1))
    fi

    # Try to remove the empty legacy slug dir (best-effort; leave behind if non-empty)
    rmdir "$legacy_slug_dir" 2>/dev/null || true
  done

  # Try to remove the now-empty legacy projects dir (best-effort)
  rmdir "$LEGACY_DIR" 2>/dev/null || true

  echo "  [v0.18.0.0] Migration summary: $total_moved files moved, $total_orphaned slugs orphaned, $total_skipped slugs nothing-to-move, $total_seeded learnings seeded to global archive."
  echo "  [v0.18.0.0] Backup at: $BACKUP_DIR (delete when satisfied)."

  # Mark complete
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
}

# Hold the migration lock so concurrent /nstack-upgrade runs serialize.
nstack_with_lock "$LOCK_FILE" 60 _run_migration || {
  echo "  [v0.18.0.0] Migration lock unavailable; another session is migrating. Try again later." >&2
  exit 0
}
