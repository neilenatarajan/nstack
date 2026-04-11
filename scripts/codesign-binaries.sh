#!/usr/bin/env bash
# Ad-hoc codesign Bun-compiled binaries for macOS.
#
# Bun's --compile produces Mach-O binaries with an invalid LC_CODE_SIGNATURE.
# macOS 26+ (Tahoe) AppleSystemPolicy kills these with SIGKILL (exit 137).
# Fix: strip the broken signature, then re-sign with ad-hoc identity.
#
# On non-macOS platforms this script is a no-op.

[ "$(uname -s)" = "Darwin" ] || exit 0
command -v codesign >/dev/null 2>&1 || exit 0

# Must run from repo root (package.json scripts do this by default)
cd "$(dirname "$0")/.." || exit 1

BINARIES=(
  browse/dist/browse
  browse/dist/find-browse
  design/dist/design
  research/dist/research-tools
  bin/nstack-global-discover
)

failed=0
for bin in "${BINARIES[@]}"; do
  if [ ! -f "$bin" ]; then
    echo "[codesign] warning: binary not found: $bin" >&2
    continue
  fi
  # Strip Bun's broken signature, then ad-hoc sign
  if codesign --remove-signature "$bin" && codesign --sign - "$bin"; then
    # Verify the signature actually took effect
    if codesign --verify --strict "$bin" 2>/dev/null; then
      echo "[codesign] signed: $bin"
    else
      echo "[codesign] error: signature verification failed for $bin" >&2
      failed=1
    fi
  else
    echo "[codesign] error: failed to sign $bin" >&2
    failed=1
  fi
done

exit $failed
