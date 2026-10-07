# `connectors/` — one folder per source system

Each connector owns the **read path** (and, for C4C, the gated write path) for one external system. Modules in `modules/<domain>/` import connector clients and feed their output through `object-model/` mappers.

## What a connector owes

1. **`client.ts`** — typed read methods. HTTP / RFC / SQL / file-read lives here. CSRF, auth, retries, redaction.
2. **`mappers/`** — translators from native rows to `object-model/` types. One file per canonical entity.
3. **`README.md`** — lists which entities are wired, which are blocked by tenant authorization, which return 404 in your tenant. Honesty about gaps is the point.

## What a connector does NOT do

- Register MCP tools — that's `modules/<domain>/`
- Make business decisions — that's `modules/<domain>/`
- Cache anything globally — use the shared SQLite cache in `src/cache.ts`

## Folders

- `c4c/` — SAP Service Cloud V1. The real, implemented connector.
- `azure-ad/` — Azure AD client-credentials, used to call the external knowledge base.
- `entra-oidc/` — Entra ID user sign-in (OIDC). Inert until configured; not yet verified end to end.
- `knowledge-mindtouch/` — the external MindTouch-shaped knowledge base.

Connectors for other systems (SAP ERP / S4, Salesforce, Dynamics, ServiceNow, …) were scaffolds in the platform repository and are not part of Ask C4S.

## Authentication

- HTTP Basic, OAuth client-credentials, mTLS, RFC userid/password, etc. — each connector owns its own auth shape
- Secrets always come from `.env` or the encrypted `settings` table — **never** hardcoded
- Tokens cached in-memory only; never serialized to disk
