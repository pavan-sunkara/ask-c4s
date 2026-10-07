# Ask C4S

The SAP C4C (Service Cloud V1) companion for field-service teams: ask about a ticket, prep a PM visit, check parts, book time — from a Chrome/Edge extension, a field PWA, or an AI assistant (MCP).

This repository is the complete product: everything needed to build, deploy and use Ask C4S is here.

## What's in here

| Piece | Where | Notes |
|---|---|---|
| **Shim** — HTTP API + 60 MCP tools | [`src/`](src) | SAP C4C connector, gated writes, RAG, LLM gateway. Node 20+ / TypeScript. |
| **Chrome/Edge extension** | [`chrome-extension/`](chrome-extension) | MV3. This folder is exactly the shippable package. |
| **Field PWA** | [`apps/mobile-pwa`](apps/mobile-pwa) | Served at `/`. Installable, offline-capable. |
| **Admin page** — settings, SAP tenants and users | [`apps/light-admin`](apps/light-admin) | Served at `/settings`. |
| **Shared design system** | [`apps/shared-ui`](apps/shared-ui) | One stylesheet for every surface (`/shared/askc4s.css`). |
| **Image** | [`Dockerfile`](Dockerfile) | Publishes `ghcr.io/<owner>/ask-c4s-server`. |
| Architecture decks and diagrams | [`docs/architecture`](docs/architecture), [`docs/collateral`](docs/collateral) | Kept out of the extension package on purpose. |

## Run it locally

```bash
npm ci
cp .env.example .env        # `copy` in cmd.exe. The SAP connection goes in the admin page (below); C4C_* here is only a fallback
```

```bash
npm start                   # compiles, starts the shim on 127.0.0.1:3031, opens Chrome with the extension loaded into its own profile
npm start -- --no-chrome    # shim only
npm run stop                # stops it
```

`npm start` never starts a second shim: if one is already running on 3031 it says so (and `npm start -- --replace` swaps it). Ctrl+C stops the shim and closes the dev browser. Windows, macOS and Linux. The extension is loaded through Chrome's DevTools pipe (`Extensions.loadUnpacked`), because Google Chrome 137+ ignores `--load-extension`.

- Field app: <http://127.0.0.1:3031/>
- Admin page: <http://127.0.0.1:3031/settings>

**Connect your SAP tenant:** admin page → **Tenants** → enter the OData base URL (`https://<tenant>.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi`), the integration user and its password → **Test connection** → **Add tenant**. The first tenant becomes active at once; no restart. Passwords are encrypted at rest (key in `data/.tenant-key`), and a catalog tenant always wins over `C4C_*` in `.env`.

Server only, no browser: `npm run web`. The **stdio MCP server** for Claude Desktop is `npm run mcp` (`npm run mcp:inspect` opens it in the MCP inspector); it is not what the extension talks to.

## Accounts and roles

Until the first account exists the shim behaves as a single shared-password deployment. Create the first **owner** in the admin page (Users tab), or provision it on first boot with `ASKC4S_BOOTSTRAP_OWNER_EMAIL` + `ASKC4S_BOOTSTRAP_OWNER_PASSWORD`. From then on everyone signs in with a personal account.

| Role | Can |
|---|---|
| Owner | Everything |
| Admin | Settings, SAP tenants, users (managers and agents); SAP writes |
| Manager | Read-only |
| Agent | Uses the extension and PWA, including SAP writes; no admin |

Roles are enforced on the server, per request. Details, and why each check lives where it does, are in [`docs/engineering-notes.md`](docs/engineering-notes.md) → *Users and roles*. Locked out? `node dist/usersCli.js set-owner <email> <temporary-password>` on the host.

## Test

```bash
npm run test:users
```

Builds (which type-checks), then starts its own throwaway server — random port, scratch data, no `.env`, no SAP — and runs the sign-in, roles, write-gate, revocation and lockout checks. CI runs the same on every push.

## Deploy

**On AWS EC2:** [`deploy/README.md`](deploy/README.md) is the step-by-step — one instance, Docker Compose, Caddy for automatic HTTPS, the image CI publishes. By hand:

```bash
docker build -t ask-c4s-server .
docker run -p 3030:3030 \
  -e ASKC4S_BOOTSTRAP_OWNER_EMAIL=you@company.com \
  -e ASKC4S_BOOTSTRAP_OWNER_PASSWORD=<temporary, 12+ characters> \
  -v askc4s-data:/app/data \
  ask-c4s-server
```

Mount `/app/data` (SQLite and the encrypted tenant catalog live there). Put TLS in front of it. The image contains compiled JavaScript and static files only — no TypeScript source — and CI refuses to publish one that doesn't pass `scripts/verify-image-containment.sh`.

## More

- Security posture: [`docs/security/posture.md`](docs/security/posture.md)
- Conventions and the "don't break this" notes: [`docs/engineering-notes.md`](docs/engineering-notes.md)
- SAP draft-button integration: [`docs/integrations/c4c-pdi-draft-button.md`](docs/integrations/c4c-pdi-draft-button.md)
