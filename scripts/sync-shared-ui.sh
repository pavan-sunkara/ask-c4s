#!/usr/bin/env sh
# Sync the shared design system into the Chrome extension package.
#
# The canonical file is apps/shared-ui/askc4s.css (served by the shim at
# /shared/askc4s.css to the PWA + light-admin). A packaged MV3 extension can't
# fetch that live — CSP blocks external stylesheets and the popup must work
# offline — so it ships a bundled copy at chrome-extension/askc4s.css.
#
# Run this whenever the canonical file changes so the extension doesn't drift.
# CI could also run it with --check to fail if the copy is stale.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/shared-ui/askc4s.css"
DST="$ROOT/chrome-extension/askc4s.css"

if [ "$1" = "--check" ]; then
  if cmp -s "$SRC" "$DST"; then
    echo "ok: chrome-extension/askc4s.css is in sync with apps/shared-ui/askc4s.css"
    exit 0
  fi
  echo "STALE: chrome-extension/askc4s.css differs from apps/shared-ui/askc4s.css"
  echo "Run: sh scripts/sync-shared-ui.sh"
  exit 1
fi

cp "$SRC" "$DST"
echo "synced apps/shared-ui/askc4s.css -> chrome-extension/askc4s.css"
