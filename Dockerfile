# =============================================================================
# Ask C4S — ask-c4s-server
#
# The SAP C4S companion. Ships:
#   • the shim: 60 MCP tools, SAP C4C connector, gated writes, RAG
#   • the admin page (/settings): settings, SAP tenants and users
#   • the field PWA (/) and the shared design system (/shared)
# Served to: the Chrome/Edge extension and the field PWA.
#
# Compiled JavaScript, production dependencies and the three static apps —
# nothing else. Verified by: scripts/verify-image-containment.sh (run in CI).
#
# Build:  docker build -t ask-c4s-server:dev .
# Run:    docker run --rm -p 3030:3030 -e HOST=0.0.0.0 \
#                    -e ASKC4S_BOOTSTRAP_OWNER_EMAIL=<you@company.com> \
#                    -e ASKC4S_BOOTSTRAP_OWNER_PASSWORD=<temporary-12+ chars> \
#                    -v askc4s-data:/app/data ask-c4s-server:dev
#         (the owner signs in at /settings and must change the password)
# =============================================================================

# ---- Stage 1: builder ----------------------------------------------------
FROM node:20-alpine AS builder

# better-sqlite3 compiles native bindings during npm ci.
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Server deps only — no web-app build tooling is ever installed in this image.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Source + build config.
COPY tsconfig.json ./
COPY src ./src

# Compile the shim. No Vite build — the UIs are plain static files.
RUN npx tsc -p tsconfig.json

# Trim to production deps for the runtime stage.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----------------------------------------------------
FROM node:20-alpine AS runtime

RUN apk add --no-cache libc6-compat \
    && addgroup -S askc4s && adduser -S askc4s -G askc4s

WORKDIR /app

# ADMIN_ENABLED=true mounts /api/admin/* (settings, tenants, users). Safe to
# default on: every admin call still needs a signed-in owner or admin, and a
# deployment with no account and no ASKC4S_INTERNAL_PASSWORD denies everything.
#
# ASKC4S_ADMIN_INSECURE is deliberately NOT set: the admin + debug gates fail
# closed, so deploying without an account or ASKC4S_INTERNAL_PASSWORD denies
# /api/admin/* and /api/debug/* instead of publishing SAP data to anyone who
# finds the URL.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ADMIN_ENABLED=true \
    SERVICE_OPS_UI_PORT=3030 \
    DATA_DIR=/app/data

# Compiled shim + production deps only. No src/.
COPY --from=builder --chown=askc4s:askc4s /app/dist ./dist
COPY --from=builder --chown=askc4s:askc4s /app/node_modules ./node_modules
COPY --from=builder --chown=askc4s:askc4s /app/package.json ./package.json

# The two UIs plus the shared design system. All plain static files — no Vite,
# no node_modules — which is what keeps this image small and the build a
# straight COPY.
#   apps/mobile-pwa  → "/"             field-tech PWA (installable, offline)
#   apps/light-admin → "/settings"     core settings
#   apps/shared-ui   → "/shared/*"     one design system both UIs link
# No other web app is here and none should be; CI proves it.
COPY --chown=askc4s:askc4s apps/mobile-pwa ./apps/mobile-pwa
COPY --chown=askc4s:askc4s apps/light-admin ./apps/light-admin
COPY --chown=askc4s:askc4s apps/shared-ui ./apps/shared-ui

# SQLite DB + encryption key survive redeploys via a mounted volume.
RUN mkdir -p /app/data && chown -R askc4s:askc4s /app/data

USER askc4s

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${SERVICE_OPS_UI_PORT}/api/health || exit 1

CMD ["node", "dist/uiServer.js"]
