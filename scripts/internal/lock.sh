#!/usr/bin/env bash
# scripts/internal/lock.sh — flock helper for nstack global writes.
#
# Internal helper sourced by bin/nstack-registry, bin/nstack-learnings-log
# (global dual-write path), and the v0.18.0.0 migration script. Not user-facing.
#
# Usage (sourced):
#   source "$REPO_ROOT/scripts/internal/lock.sh"
#   nstack_with_lock /path/to/lock.lck 30 my_command arg1 arg2
#
# Or invoked as a CLI:
#   scripts/internal/lock.sh /path/to/lock.lck 30 my_command arg1 arg2
#
# Args: <lockfile> <timeout-seconds> <command-and-args...>
# Exit 0 on success. Exit 1 on lock timeout. Exit code from command otherwise.
#
# Behavior:
#   - On macOS (no flock(1) by default): falls back to shlock-style mkdir lock
#     with stale-lock detection (>5x timeout means stale, force-break).
#   - On Linux (flock(1) available): uses flock with -w timeout.
#   - On lock acquisition failure with timeout 0: print one-line "already running"
#     message to stderr and exit 1 (caller decides whether to retry).

nstack_with_lock() {
  local lockfile="$1"
  local timeout="$2"
  shift 2

  if [ -z "$lockfile" ] || [ -z "$timeout" ] || [ $# -eq 0 ]; then
    echo "nstack-lock: usage: nstack_with_lock <lockfile> <timeout> <cmd...>" >&2
    return 2
  fi

  mkdir -p "$(dirname "$lockfile")"

  if command -v flock >/dev/null 2>&1; then
    # Linux / Homebrew util-linux: use real flock(1)
    (
      flock -w "$timeout" 9 || {
        echo "nstack-lock: timeout waiting for $lockfile (held by another nstack process)" >&2
        exit 1
      }
      "$@"
    ) 9>"$lockfile"
    return $?
  fi

  # macOS fallback: mkdir-based lock with stale detection.
  # mkdir is atomic. We store our PID inside; stale locks are detected by:
  # (a) elapsed mtime > 5*timeout, or (b) PID file exists but kill -0 fails.
  local lockdir="${lockfile}.d"
  local elapsed=0
  local sleep_unit=1
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Check for staleness
    if [ -d "$lockdir" ]; then
      local pid_file="$lockdir/pid"
      local age_ok=1
      if [ -f "$pid_file" ]; then
        local lock_pid
        lock_pid=$(cat "$pid_file" 2>/dev/null || echo "")
        if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
          # PID is dead — break the lock
          rm -rf "$lockdir" 2>/dev/null
          continue
        fi
      fi
      # Check elapsed mtime
      if [ -d "$lockdir" ]; then
        local lock_age
        lock_age=$(( $(date +%s) - $(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0) ))
        if [ "$lock_age" -gt $(( timeout * 5 )) ]; then
          rm -rf "$lockdir" 2>/dev/null
          continue
        fi
      fi
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "nstack-lock: timeout waiting for $lockfile (held by another nstack process)" >&2
      return 1
    fi
    sleep "$sleep_unit"
    elapsed=$(( elapsed + sleep_unit ))
  done

  # We hold the lock — record PID and run the command
  echo "$$" > "$lockdir/pid"
  local rc=0
  "$@" || rc=$?
  rm -rf "$lockdir" 2>/dev/null || true
  return $rc
}

# CLI invocation
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  nstack_with_lock "$@"
fi
