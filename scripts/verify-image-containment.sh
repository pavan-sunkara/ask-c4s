#!/usr/bin/env sh
# =============================================================================
# verify-image-containment.sh — prove the ask-c4s image contains only
# what it should: the compiled server, its production dependencies and the
# three static apps. No source, no other web bundle, no baked-in escape hatch.
#
# WHY: a deployed image is handed to other people. What is NOT in it is the
# guarantee, and this script turns "we remembered" into "CI fails if we didn't".
#
# Run it on every build:
#   docker build -t ask-c4s:ci .
#   ./scripts/verify-image-containment.sh ask-c4s:ci
#
# NOTE: we deliberately do NOT grep for the string "admin". The server
# legitimately serves /api/admin/settings, so its compiled code contains admin
# route strings by design. What must be absent are stray WEB ASSETS.
# =============================================================================
set -eu

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

echo "==> Verifying containment of: $IMAGE"

FAIL=0
report() { echo "    $1"; }

# ---------------------------------------------------------------------------
# 1. No web bundle other than the three static apps.
# ---------------------------------------------------------------------------
FOUND=$(docker run --rm --entrypoint sh "$IMAGE" -c '
  # apps/light-admin, apps/mobile-pwa and apps/shared-ui are EXPECTED: the two
  # UIs plus the shared design system, all hand-written static files with no
  # build step. Anything ELSE carrying an index.html or an assets/ dir is a
  # bundle that has no business in this image.
  find /app \
       -path /app/node_modules -prune -o \
       -path /app/apps/light-admin -prune -o \
       -path /app/apps/mobile-pwa -prune -o \
       -path /app/apps/shared-ui -prune -o \
       \( -name "index.html" -o -name "assets" -type d \) -print 2>/dev/null || true
' || true)

if [ -n "$(printf %s "$FOUND" | tr -d '[:space:]')" ]; then
  echo "==> FAIL: unexpected web assets found in the image:"
  printf %s\\n "$FOUND" | sed 's/^/      /'
  FAIL=1
else
  report "ok: no web bundle outside the three static apps"
fi

# ---------------------------------------------------------------------------
# 2. The local-dev escape hatch must NOT be baked in.
#    An image that ships it would publish the admin API and the SAP proxy to
#    anyone who finds the URL.
# ---------------------------------------------------------------------------
for VAR in ASKC4S_ADMIN_INSECURE; do
  VAL=$(docker run --rm --entrypoint sh "$IMAGE" -c "printf %s \"\${$VAR:-unset}\"")
  if [ "$VAL" = "unset" ]; then
    report "ok: $VAR not baked in"
  else
    echo "==> FAIL: $VAR is baked into the image (='$VAL') — must never ship"
    FAIL=1
  fi
done

# ---------------------------------------------------------------------------
# 3. Source must not ship (compiled output only).
# ---------------------------------------------------------------------------
SRC=$(docker run --rm --entrypoint sh "$IMAGE" -c '[ -e /app/src ] && echo present || echo absent')
if [ "$SRC" = "absent" ]; then
  report "ok: no /app/src in the image"
else
  echo "==> FAIL: /app/src shipped in the image"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "==> CONTAINMENT CHECK FAILED"
  exit 1
fi
echo "==> CONTAINMENT CHECK PASSED"
