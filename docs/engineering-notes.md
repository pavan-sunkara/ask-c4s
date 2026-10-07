# Ask C4S — Working Notes

This file captures the conventions and the hard-won details behind this codebase, so they are not re-litigated. Keep it short and authoritative.

**Repo boundary (2026-10-06):** this repository is the complete Ask C4S product — the shim, the Chrome/Edge extension, the field PWA and the admin page. It depends on no other repository and carries no code for any other product; it is what gets deployed to a customer's own infrastructure (see `deploy/`). Environment variables use the `ASKC4S_` prefix (`ASKC4S_INTERNAL_PASSWORD`, `ASKC4S_ADMIN_INSECURE`, …).

## Reference: the extension is the built baseline — reuse, don't rebuild

**The chrome-extension is the proven product** — its UI/UX AND its shim-connection patterns work, built over weeks. When a flow reaches another door (PWA, ChatGPT, Slack), **PORT it from the extension**: its `render(data)→HTML` functions (`popup.js`) and its `/api/*` call sequences. Do NOT reinvent UI or re-derive how to call the shim. Verified applications of this rule so far: `runPartsInference`→`/api/get_parts_check`, the `/prep-pm` kit-gap step→`/api/get_pm_prep?kitAnalysis=1`, `askc4s.css` shared across doors, the PWA home mirroring the extension's command-box + phase chip grid. This is an explicit product decision: *"don't duplicate efforts."*

**The DOM scrape is the ONLY genuine differentiator — and it's two jobs, one already solved:**
1. **"Which ticket am I on?"** — the extension reads the SAP page URL/DOM. This is the real per-surface gap. Menu: **My Day / assignment list** (built), **barcode/serial scan** (phone camera → serial → tickets), **QR / deep link** (link carries the ticket ID), **geolocation** (installation-point tickets), **user states it** (ChatGPT/Slack). Often more field-native than a page scrape.
2. **Page-context grounding** (product/serial/line-items for the LLM) — **already replaced server-side**: the shim reads the ticket entity straight from SAP (`get_pm_prep`, `get_parts_check`, `lookup`). No scrape needed on any door.

So a new door's only novel work is *which-ticket* + a thin render; everything else is a port.

## Architecture direction: what goes where (server vs client)

**The rule:** *"Would a second front door need it?"* → **shim (server)**. *"Does it need the user's screen, device, or eyeballs?"* → **client**.

**Where we are:** logic is split across TWO runtimes. The extension (`popup.js`, ~22.7k lines, **26 slash-command workflows**) is BIGGER than the shim (`src/`, ~19.2k lines). Three of the six engines (workflow orchestration, prompt composition, KB retrieval) straddle both. That split is why every new surface (PWA, ChatGPT, Slack) costs 6–10 weeks — a new door must re-implement half the brain. **Target: one core (shim) + thin doors.**

**Shim (server) owns:**
- **Workflow orchestration** — the 26 slash-chains become endpoints. The pattern already exists: `/api/get_ticket_summary`, `/api/get_pm_prep`, `/api/get_ticket_activities`. Extend it.
- **Prompt composition + LLM gateway.** Prompts are IP, must stay consistent across surfaces, and let you swap models centrally. **Clients must NOT build prompts** (today `popup.js` does).
- SAP integration + tenant quirks (`serviceOps.ts`); write safety (`runGatedWrite` + self-heal) — **must stay server-side, a client could bypass it**; the 60 MCP tools; RAG (vector `embeddings.ts` + KB); secrets/certs/LLM keys; settings/feature flags; identity (RFC 8693).
- **Geocode + InstallationPoint caches** — MOVE off `chrome.storage`. Server-side they're shared across users (far fewer Nominatim calls, respects rate limits).

**Client (each surface) owns:** rendering; **context/screen awareness** (DOM scrape, URL ticket detection, in-page overlays) — extension-only and **genuinely immovable**, it needs the browser session; interaction state (cart before commit, draft edits); personal prefs; device capabilities (GPS/camera/push — PWA).

**Gray zones — decided:**
- **KB direct mode** (cookie/tab-injection): an extension-only *enhancement*. The **server-side Azure AD path (`search_kb_for_ticket`) is canonical** — mobile/ChatGPT can't use cookies, and it's the least SAP-sanctioned technique. **Do NOT build new features on the cookie path.**
- Order-parts cart: client until commit; the commit stays server-gated. Drafts: generate server-side, edit client-side.
- *"Which ticket am I on?"* is per-surface (extension: URL/DOM · PWA: **My Day** · ChatGPT: user states it). Everything AFTER that answer is server.

**Migration order — do NOT migrate all 26.** Move only the 7 the field-tech PWA needs, in order:
`My Day → /prep-pm → /parts-check → /order-parts → /book-time → /close-out → /nearby`.
Leave desktop-heavy ones (`/interactions`, `/map`, `/kb-resolve`) client-side until there's a reason.

**Why mobile forces this:** field techs use Apple/Android phones + iPads. Chrome on Android and iOS **cannot run extensions** (Apple forces WebKit) — the extension can **never** reach them, and a phone can't run the local shim either. So: **host the shim, then build the PWA.** Desktop agents keep the extension (Chrome/Edge; Windows **and Mac** via Jamf/Intune — the extension has zero OS-specific code, so Mac needs no changes; `npm start` runs on Mac as well).

**Hosting + IP:** vendor-hosting the shim is also what protects the IP — the extension's JS is already readable by anyone who installs it, so **the shim is the only protectable code**, and hosting means the artifact never ships. A private-registry Docker image exposes nothing in that model (the "anyone with the image can read the code" risk only applies if customers self-host).

## Product boundary — one product, one build

This repo is the SAP C4S companion: the shim, the extension, the field PWA and the admin page. There is no edition flag and no hidden console: a route that is not part of this product is deleted, not gated, so nothing on a deployed image can be switched on by an environment variable.

- **Three admin surfaces mount:** `/api/admin/settings`, `/api/admin/users` and the tenant catalog — `/api/admin/tenants` (list / add / edit / activate / remove, plus `POST …/tenants/<id>/test`) and `POST /api/admin/tenant/test` (probe typed-in credentials). The Tenants tab (owner/admin only: `tenants:manage`) is how a deployment gets its SAP connection: `data/tenant-catalog.json`, password AES-encrypted with `data/.tenant-key` (or `ADMIN_ENCRYPTION_KEY`), a catalog tenant beats `C4C_*` in `.env`, switching is live (`invalidateC4cConfig()`, no restart). The probe sends the same headers as the real client, so a green test predicts working lookups. An Audit page is a planned addition: add its route beside the others in `uiServer.ts` (the data functions `listAudit`/`listAuditActions` in `cache.ts` still exist) and the page to `apps/light-admin`.
- **The UIs are deliberately plain static files** — no Vite/React/node_modules, matching the extension's vanilla `popup.js`. That's what keeps the `Dockerfile` a zero-build `COPY`. Don't "upgrade" them to a framework without a real reason.
- `scripts/verify-image-containment.sh` runs in CI as a regression guard: it fails the build if a web bundle other than the three static apps, a baked-in insecure flag, or `/app/src` ever lands in the image.
- **Every setting in `settings.ts` is visible in the admin page.** There is no tier concept: add a spec to the registry and it is editable.

## Auth: `/api/*` DENIES BY DEFAULT — do not add per-route guards

**The rule:** every `/api/*` route requires a Bearer token. The allowlist in `uiServer.ts` (`PUBLIC_API_ROUTES`) is the *only* way out, and adding to it is a deliberate, reviewable act. **Do not "fix" a 401 by adding a route to the allowlist** — make the caller authenticate.

Why an allowlist and not a guard per route: guards *were* per-route, and the route that mattered most was the one nobody remembered to guard. `POST /api/tools/<name>` ran `runNamedTool` with **no token at all**, and that dispatcher reaches the SAP **write** tools (`log_service_item`, `add_service_request_text`, `attach_solution_to_ticket`, `update_ticket_lifecycle`, `update_ticket_priority`). The caller supplies `dryRun:false` + `acknowledgeProduction:true`; the only server-side control is `feature.auto_writeback_enabled`, which is **ON** for this tenant. Hosting the shim would have let **anyone with the URL write to live SAP**. It also mislabelled itself `readOnly: true`. The gate now sits at the top of `handleApi` — the single funnel every `/api/*` request passes through — so a new route is protected the moment it exists.

**Allowlisted (each needs a reason; "the client calls it a lot" is not one):** `GET /api/health` (probes run before credentials exist) · `POST /api/auth/google` + `POST /api/internal/auth` (gating login is a deadlock) · `GET /api/auth/me` + `POST /api/internal/verify` (self-gating — they only echo what the caller already holds) · `POST /api/auth/login` (it *is* the login) · `POST /api/errors` (deliberate public ingest, per-IP rate-limited; `window.onerror` must work pre-login).

**Check the token BEFORE any env-var short-circuit.** `isInternalAuthorized()` used to test `ASKC4S_INTERNAL_PASSWORD` first and `return true` when unset ("no gate configured"). Two separate bugs lived there:
1. Unset password = open — hosting without that one env var silently published the admin API (encrypted secrets, the write gate, table truncation). Now unset = **denied**.
2. `/api/auth/google` issues real tokens **without `ASKC4S_INTERNAL_PASSWORD` ever being set** (SSO-only is a legitimate posture). Testing the password var first rejected those valid tokens outright and would have locked out every SSO user the moment the gate was enforced. **Valid token → authorized, always, checked first.**

- **Local dev opt-out:** `ASKC4S_ADMIN_INSECURE=true`, set by `npm start` (`scripts/dev.mjs`, which also refuses to start a second shim on 3031). Honoured **only when no password is configured**, so a stray flag copied into a production `.env` cannot switch off a gate someone deliberately turned on. The Docker images never set it; bare `npm run web` without it 401s everything — intentional.
- `/api/debug/query` proxies **arbitrary OData reads to the live SAP tenant** with the server's integration credentials. It can't be deleted (the extension needs it for InstallationPoint backfill and `/nearby`), so it takes the same token.

**Clients (all three already authenticate — v0.27.84):**
- **Extension:** already had Google SSO (`chrome.identity` → `/api/auth/google`) and manual-token paste; the token was merely *optional*. `popup.js` wraps `window.fetch` **once, at module scope** (NOT inside `init()` — an `init()` throw silently unwiring a handler is the "Mark as Resolution did nothing" bug) and raises a "Sign in" banner on any `/api/` 401. One interceptor instead of 17 call-site patches, for the same reason the server uses one gate. Non-401 passes through untouched — the response body must stay readable or every caller breaks.
- **PWA** (`apps/mobile-pwa`): password login → token in `localStorage` (not `sessionStorage`: iOS evicts PWA processes and techs would re-login constantly). 401 → clears token → login screen. `renderDay()` bails to `renderLogin()` when there's no token, because callers' `.catch` handlers re-render their own view and would otherwise paint over the login screen and strand the tech with no way back in.
- **Light admin** (`apps/light-admin`): already had login. Unchanged.

**PWA service worker — bump `VERSION` when the shell changes.** `/app.js` is cached, and `install` (the only thing that refetches the shell) fires **only when sw.js's bytes change**. Shipping an app.js fix without touching sw.js pinned installed apps to the old client *forever* — which nearly shipped a PWA with no sign-in screen against a server that now requires a token, an app the tech could not repair because the repair was the thing being cached over. The shell is now **stale-while-revalidate** (still opens instantly offline, but self-heals on the next launch), and sign-out clears only the `-data` caches — the SW keys its API cache on URL alone and never sees the `Authorization` header, so without that a shared iPad would serve the previous tech's tickets from cache. The `-shell` cache is kept: it holds no user data and dropping it would break offline launch.

## Users and roles — personal accounts, enforced in the one gate (v0.27.86)

**What it is:** a user directory (`src/users.ts`, SQLite `users` table) + four roles (`src/access.ts`): **owner · admin · manager · agent**. The admin UI is the Users tab in `apps/light-admin` — plain static, same rule as every Light UI. `src/usersRoutes.ts` holds the HTTP handlers and *receives* uiServer's helpers instead of importing them.

**Two modes, switched by "does the users table have a row?" — do NOT add a flag for it:**
- **legacy** (no users) — byte-for-byte the old behaviour: shared `ASKC4S_INTERNAL_PASSWORD`, SSO under `ASKC4S_AUTH_ALLOWED_DOMAINS`, `ASKC4S_ADMIN_INSECURE` for dev. Tokens here count as owner. Upgrading changes nothing until someone creates an account.
- **directory** (≥1 user) — every token belongs to a user and **the role is read from the DB on every request** (tokens store only `userId`), so disabling or demoting someone bites on their next call. `ASKC4S_ADMIN_INSECURE` is IGNORED (the same rule as when a password is set: a stray dev flag must not switch off a gate someone turned on). Google/Entra SSO admits only people who already have an account — the directory *is* the allowlist, no auto-provisioning. The shared password is refused unless `ASKC4S_ALLOW_SHARED_PASSWORD=true` (break-glass). Disabled accounts still count as "directory active", so the deployment can never fall back to open.

**Where each check lives — don't move them:**
- **Route level:** `requiredPermission()` in `access.ts`, called ONCE in the funnel at the top of `handleApi` — still no per-route guards. It maps only `/api/admin/*`. Everything the extension and PWA call stays open to every signed-in role, including `/api/debug/query` (the map and `/nearby` need it — an owner-only rule there silently breaks them for agents). Don't map a route without checking who calls it.
- **SAP writes:** `sapWriteDenial()` inside `runGatedWrite` (plus the hand-rolled copy in `attachSolutionToTicket`), AFTER the dry-run branch: previews stay open to everyone, a real write needs `sap:write` (agent, admin, owner — NOT manager). The principal reaches that depth through `AsyncLocalStorage` set around `handleApi` (`runWithPrincipal`). Outside a request (stdio MCP) there is no principal and it passes — the same local trust as before. **A new write path MUST go through `runGatedWrite`**, or it bypasses roles.
- **Who may touch whom:** `users.ts`. Admins manage managers and agents only; nobody changes their own role or status; the last active owner can't be demoted or disabled.

**Temporary passwords:** accounts created by an admin, or reset, get `must_change_password`. The funnel answers 403 `password_change_required` to everything except `/api/auth/change-password` and `/logout` until they choose their own. The extension Options page, the PWA and the admin page all handle it. The extension keeps a temporary-password login in memory only — it isn't stored until the password is changed.

**Sign-in:** `POST /api/auth/login` is public ON PURPOSE (it's the login): per-address throttle, per-account lockout after 5 failures for 15 min, and unknown emails still pay one scrypt so timing doesn't reveal which exist. `/api/auth/providers` reports `directory:true`; every login screen switches on that. `/api/auth/me` also returns `role`, `permissions`, `mode`, `mustChangePassword` — `user` is unchanged because the extension reads it. The extension and the PWA store the same token keys as before, so nothing downstream changed.

**Bootstrap and recovery:** the first owner is created in Settings → Users while in legacy mode (that purges every pre-account token), or from the environment on first boot (`ASKC4S_BOOTSTRAP_OWNER_EMAIL` + `_PASSWORD`). Locked out: `node dist/usersCli.js set-owner <email> <temp-password>` on the host.

**Audit:** user events write `audit_log` rows (`user.create/update/reset_password/change_password`, `auth.login`, `auth.lockout`). Admin routes now take `actor` from the token's email; `X-Admin-Actor` is client-supplied, so it is only the fallback for tokens with no identity.

**Known limits (not done):** tokens are still in memory, so a restart signs everyone out; SAP still sees one shared integration user (RFC 8693, below); no email invites — an admin hands over the temporary password; no SAP-party link on the account yet (whoami still resolves by email).

## UI: one design system for every door — `apps/shared-ui/askc4s.css`

**The rule:** the product's *look* is defined ONCE. Tokens, cards, pills, buttons, inputs, banners, kv rows, markdown, and the **loaders** live in `apps/shared-ui/askc4s.css`, served by the shim at **`/shared/askc4s.css`** to every door. Don't re-define colors/loaders in a door's own CSS — link the shared file and add only that door's SHELL (the PWA's gradient header + bottom nav; the extension's command box). Values were lifted from the extension's `popup.html` so they match by origin, not by hand-copying (which is the trap that drifted the PWA dark while the extension was light).

- **Served to every surface:** `serveStatic` maps `/shared/*` → `apps/shared-ui` BEFORE the static roots. The `Dockerfile` COPYs `apps/shared-ui`.
- **Loaders match:** the shared file carries the extension's `.progress-strip` / `.progress-spinner` (renamed keyframe `c4sSpin`) plus `.spinner` and `.skel`. The PWA's slow states (e.g. Prep for PM) use the progress-strip so they look like the side panel.
- **Token-name collision (know this):** the extension's `--muted` is a *background*; the PWA's `--muted` is *text*. The shared file uses the **PWA naming** (`--muted` = muted text, `--card2` = muted bg) because the PWA + light-admin adopt it now. Adopted by: `apps/mobile-pwa` (shell-only local CSS) and `apps/light-admin` (its `:root` reduced to admin-only extras `--accent-deep`/`--*-bg`; it keeps its own dark-mode block, which the PWA has no equivalent of).
- **Extension — TOKEN layer migrated (provably no-op); component rules still inline.** `popup.html` now links a bundled `chrome-extension/askc4s.css` (a vendored copy — packaged MV3 extensions can't fetch the shim's `/shared` live: CSP + offline; kept in sync by `scripts/sync-shared-ui.sh`, which has a `--check` mode for CI). Its `:root` was replaced with a **compat block** that maps the extension's own token names onto the shared ones — `--surface→var(--card)`, `--foreground→var(--fg)`, `--border→var(--line)`, `--muted→var(--card2)` (the extension's `--muted` is a muted *background*, hence `--card2` not the shared text-`--muted`), `--muted-fg`/`--primary` hardcoded to preserve the exact brand values, `--primary-bright→var(--accent)`, `--primary-deep→var(--violet)`. Every mapping resolves to the **byte-identical** old value (verified), so it's a visual no-op; each `var()` carries a fallback so the popup still renders if the CSS ever fails to load. Net: the extension's palette is now shared-driven. **Still inline:** the ~6k lines of component + per-flow rules. Pruning those (they duplicate the shared primitives) is the next step and needs **Chrome verification** — popup.html is `chrome.*`-driven and can't be rendered headlessly, so it can only be eyeballed as a loaded unpacked extension across all 26 panels.
- **Next level of sharing (not done):** the ~185 `render(data)→HTML` functions in `popup.js` (the slash-command inner pages) can become shared pure functions in `apps/shared-ui/` so an inner page is defined once and both doors call it. Do this per-flow as each screen is ported (the PWA's `paintPmPrep` is the first candidate to fold into a shared `renderPmPrep`).

## Identity: SSO → SAP party (auto), and the Entra minter

**The goal:** a tech opens the app and lands on their day's work — no "who are you?" step. Identity flows: SSO proves the user → the shim resolves that to a SAP `BusinessPartnerID` → My Day loads. Three pieces, all in place:

1. **`GET /api/whoami`** — reads the identity already on the Bearer token (`email`/`name`, set by SSO) and resolves it to a party ID via `EmployeeCollection`: exact `Email eq`, then a `UserID` derived from the email local-part (this tenant's logon convention is `FIRST.LAST`, e.g. `MAROUANE.NAJAR`). Deliberately **narrower** than `/api/resolve_employee` — SSO gives a reliable email, so whoami does NOT touch that endpoint's fragile display-name fuzzy-matching block. `needsIdentity:true` is a **normal** result: admin/service-agent logins have no `EmployeeCollection` row (e.g. Jane Doe), and password tokens carry no email. Never 500s.
2. **PWA `resolveIdentityAndRoute()`** — one IdP-agnostic path used on boot (token present), after login, and after dev sign-in: whoami → partyId? land on My Day : Me-tab manual entry. A relaunch with a persisted token lands straight on My Day, zero interaction — how a live SSO session feels.
3. **Entra OIDC minter** (`src/connectors/entra-oidc/`) — the org SSO front door. Server-side Auth Code + PKCE (shim owns the dance, clients just redirect). Distinct from `connectors/azure-ad` (client-credentials for the KB — different app registration, no user redirect URIs) but the **same directory**, so `ENTRA_OIDC_TENANT_ID` defaults to `AZURE_TENANT_ID`.

**The Entra minter is INERT UNTIL CONFIGURED and NOT verified end-to-end.** `isEntraOidcConfigured()` is false unless `ENTRA_OIDC_TENANT_ID` + `ENTRA_OIDC_CLIENT_ID` are set; until then `/api/auth/oidc/*` returns 503, `/api/auth/providers` reports `oidc:false`, and the PWA shows no "Sign in with Microsoft" button (password fallback only). What IS verified: config gating, PKCE (S256), the authorize-redirect shape, and that `verifyIdToken` rejects garbage / malformed / `alg:none`. What is **NOT**: the live round-trip (code exchange + a real Entra id_token) — that needs the Azure App Registration. **Before enabling: create the app reg, set the env vars, run one live sign-in, confirm the id_token validates.** Do not wire it as any client's default login until that pass is done.

**Enable it:**
- **Azure App Registration:** platform **Web**; redirect URI `https://<shim-host>/api/auth/oidc/callback`; single-tenant; Graph delegated `openid`/`profile`/`email`; a client secret.
- **`.env` (shim-side only, never in a client):** `ENTRA_OIDC_TENANT_ID`, `ENTRA_OIDC_CLIENT_ID`, `ENTRA_OIDC_CLIENT_SECRET` (blank = pure PKCE public client), `ENTRA_OIDC_REDIRECT_URI` (match the app reg exactly), optional `ENTRA_OIDC_ALLOWED_DOMAINS` (comma-sep; empty = any verified account in the tenant).
- Token delivery to the SPA is a **server-rendered bootstrap page** (`sendOidcResult`) that writes the token to `localStorage` then redirects — token in the HTML body, **never** the URL.

**Dev sign-in** (`POST /api/auth/dev-login`) mints an email-bearing token without an IdP so the whole zero-touch flow is demoable before Entra exists. Guarded identically to the API gate's dev opt-out: **404s unless `ASKC4S_ADMIN_INSECURE=true` and no password** — a posture the images never ship, under which the gate is already open, so it grants nothing new. Token `source` type is `"password" | "google" | "entra" | "dev"`.

**Still open (RFC 8693):** even with Entra, the shim calls SAP as **one shared integration user**, so SAP's audit log names that account, not the tech. Front-door identity is solved; carrying it through to SAP is the remaining token-exchange work.

## Tenant policy → clients: `GET /api/client-config`

Rules that decide **what SAP receives** are tenant **policy**, not user preference. The test: *does changing it change what SAP receives?* If yes → server.

They used to live in each operator's `chrome.storage.sync`, so any user could silently alter the SAP transaction with no audit trail, and every new front door would have re-implemented them. Now in `settings.ts` (all `tier:"core"`), served by `/api/client-config`:
`parts.ordering_processing_type_code` (ZRP3) · `parts.inference_include_types` (SRP1,ZRP1) · `booktime.labor_product_id` (11266683) · `booktime.travel_product_id` (11266684) · `kb.direct_url`

- Extension precedence (v0.27.83+): **server policy → legacy local override → hard-coded default**. Defaults are byte-identical to the old hard-coded values, so an older/offline shim changes nothing.
- **Tenant policy now overrides a user's local Options setting** — that's the governance fix, and it is a deliberate behaviour change.
- Still per-user (correctly): `c4s.endpoint`, auto-pulse/kb prefs, chip usage, map radius, UI collapse state.

**Remaining identity gap:** the shim authenticates the *caller* but still calls SAP as **one shared integration user**, so SAP's audit log attributes every write to that account rather than the tech who made it. That's the RFC 8693 token-exchange work — a real gap, but no longer a fail-open one. (`/api/tools/*` **is** gated now — see the auth section above.)

## Workflow: Parts Ordering vs Parts Consumption

**`/order-parts` performs Parts ORDERING, not Parts Consumption.** Two distinct SAP workflows:

| Workflow         | When                                              | processingTypeCode (Thermo Fisher tenant) |
| ---------------- | ------------------------------------------------- | ----------------------------------------- |
| Parts Ordering   | Request parts for a planned repair (future install) | **ZRP3** ← what we use                    |
| Parts Consumption| Log parts already installed (past install)        | SRP1                                      |

**Rules:**
- **Adding/committing parts to a ticket** → `ZRP3` by default (configurable in Options for other tenants, default ZRP3). **Division exception (v0.27.75):** if the ticket's header field `KUTDivision_KUT` is `"MSD"`, the item type is `SRP3` instead. Implemented shim-side in `logServiceItem` (`fetchTicketDivision` reads `KUTDivision_KUT` off `ServiceRequestCollection('<id>')`, cached 60s) and fires ONLY when the incoming code is `ZRP3`, so Book Time (`ZALT`), consumption (`SRP1`), and any explicit override are untouched. Deterministic + logged (`KUTDivision_KUT=MSD → item type ZRP3 → SRP3`); the override sets `opts.processingTypeCode` before `buildBodyFromProbe`, so the dry-run preview, SAP body, and failure diagnostics all show the effective code. Any division-lookup failure keeps `ZRP3` (best-effort, never blocks the commit). `KUTDivision_KUT` is the custom division code (values like `GSS`/`IES`/`MSD`), distinct from the standard `DivisionCode`.
- **Searching past line items for parts INFERENCE** (i.e., `runPartsInference` deciding what to auto-suggest from similar tickets) → filter to CONSUMPTION codes only. Default allowlist `["SRP1", "ZRP1"]`. These represent parts that were actually used. ZRP3 (ordered but not necessarily consumed), ZALT (labor), SRPT (service), REMOTE_DIAGNOSTIC etc. are EXCLUDED. Configurable via Options → "Parts-inference: include processing types" (storage key `c4s.parts-inference-include-types`, comma-separated).
- **Generic catalogue search** (`search_parts` typing in the search box) → no processing-type filter; returns all matches across the catalog.
- The Options page setting for the commit code is labeled "Parts-ordering processing type code" (separate from the inference allowlist above).
- If commits keep failing with `"unknown message type"` while ZRP3 is sent, the cause is almost certainly a **missing required field** in the POST body (e.g., `ItemCategoryCode`, `BusinessTransactionDocumentItemTypeCode`), not a wrong code. Diagnose via shim console (`[log_service_item] FAILURE`).

## Standard fields for order parts

**Order parts uses STANDARD SAP C4C fields only.** Do NOT use `KUT_PRODUCTEXTID_KUT` or any other KUT_* custom extension fields in the order-parts pipeline — they're tenant-specific Key User Tool extensions, not part of the standard parts-ordering workflow.

Standard fields on `ServiceRequestItem` (the line-item entity we POST to):
- `ProductID` — canonical line-item product reference (always present)
- `ProductExternalID` — customer-facing external ID (optional — schema-cache guards it)
- `ProductDescription` — denormalized description (always present)
- `Quantity`, `QuantityUnitCode` — quantity + UoM

Standard fields on `StockLocationItem` (the stock catalog):
- `MaterialID` — canonical stock identifier (substring search)
- `StockLocationID`, `ValuatedUnrestrictedUseStock`, `UnrestrictedUseConsignmentStock`, `BlockedStock`
- `BaseUnitofMeasure`, `BaseUnitofMeasureText`

If you find yourself adding KUT_* fields to any order-parts query (filter, select, or POST body), STOP — that's the wrong path. Use the standard field, and if it's missing on a tenant, let the schema cache in `serviceOps.ts` handle the degradation.

## Tenant: Thermo Fisher (my340573-sso)

- C4C version: Service Cloud **V1** (HTML5 client, `#Nav/0/<base64>` deep-link format)
- KUT fields legitimately used elsewhere (NOT for order parts): `KUT_RPLatitude_KUT`, `KUT_RPLongitude_KUT`, `KUT_AddressName1_KUT`, `KUT_ContractItemDesc_KUT` (for map view / address fallback)
- **Secondary Ticket Type** field: `KUT_Secondary_Ticket_Type` (numeric code, e.g. `"131"`) + `KUT_Secondary_Ticket_TypeText` (label, e.g. `"PM (Contract)"`). Note the **underscores between words** and **no `_KUT` suffix** — non-standard SAP naming. Map filter searches the `*Text` variant with substringof so operators can type readable labels.
- Single-row `ServiceRequestCollection('<objectId>')` returns `{ d: { results: <single-object> } }` — use `unwrapTicketEntity` (7 shapes), NOT `pickEntity` (4 shapes, misses this one).
- Vector search index (`find_similar_tickets`) is sparse on this tenant — always parallel with `get_serial_history` (direct OData by serial) to avoid starvation.
- **OData parser limitations**: two `substringof(...)` clauses joined with `and` → HTTP 500 *"Operands of logical operator 'and' are not valid"* (same family as the long-OR-chain failure). Use ONE substringof server-side + filter the rest client-side. String `eq` comparisons are **case-INSENSITIVE** on this backend (`'JANE Doe'` matches `'Jane Doe'`).
- **Identity / EmployeeCollection** (readable since 2026-06-12 grant): key fields `BusinessPartnerID` (party ID — what `ProcessorPartyID`/`ServicePerformerPartyID` assignments use, `800…`), `EmployeeID` (human-facing employee number), `UserID` (SAP logon, `FIRST.LAST` convention e.g. `MAROUANE.NAJAR`), `BusinessPartnerFormattedName`, `Email` (corporate). **Admin/service-agent logins (e.g. Jane Doe himself) have NO EmployeeCollection row** — that's expected, not a bug; `/api/resolve_employee` returns `{found:false}` and the My Day panel falls back to manual party-ID entry. `ServiceAgentCollection` is RBAM-403 for the integration user.

## /order-parts commit — known-good wiring (DO NOT BREAK)

The `/order-parts` cart commit works end-to-end as of v0.26.81. These are the load-bearing details that took 17 versions to get right. Future maintainers: do not "simplify" any of them.

**Extension → background.js dispatch:**
- `chrome.runtime.sendMessage` MUST use `type: "apply-annotation"` (NOT `kind:`). background.js dispatches on `msg.type`. This bug ate 13 versions of fake debugging.

**background.js → shim response handling:**
- background.js must check for `data.result.blocked === true` and `data.result.dryRun === true` and surface as errors. The `data.result.ok === false` check ALONE misses gate-blocked responses → silent failure where cart clears but no SAP write happens.

**Feature flag:**
- `feature.auto_writeback_enabled` MUST be `true` in `/admin → Settings` (key in `src/settings.ts`). Without it, `runGatedWrite` returns `{ blocked: true }` and the commit never reaches SAP.

**SAP C4C V1 OData POST shape for `ServiceRequestItem` (Thermo Fisher tenant):**
- **Endpoint**: `POST /sap/c4c/odata/v1/c4codataapi/ServiceRequestItemCollection` (direct only — navigation POST via `/ServiceRequestCollection('<id>')/ServiceRequestItemCollection` returns 404, that endpoint isn't exposed).
- **Body construction**: mirror an existing line item via `probeExistingServiceItem(parentObjectId)` → `buildBodyFromProbe(probe, opts)`. Keep null and empty-string values (SAP needs them for message-type classification).
- **MUST exclude from body** (SAP returns `CX_ODATA_ANNOTATION_ERROR: Create not allowed for properties`):
  - `PlannedStartDateTime`, `PlannedEndDateTime` (computed from parent ticket schedule)
  - `ActualStartDateTime`, `ActualEndDateTime` (set by SAP during execution)
  - All `*UUID` suffix fields (derived)
  - All `*Text` suffix fields (text resolutions)
  - All `*StatusCode` lifecycle fields (SAP-managed)
  - `ProductDescription`, `ProductIDExternalKey`, `ProductUUID` (derived from `ProductID`)
  - `ServiceRequestID` (derived from `ParentObjectID`)
  - `ServicePerformerPartyName`, `ServicePerformerPartyUUID` (derived from `ServicePerformerPartyID`)
  - `ObjectID`, `ID`, `ETag`, `ChangeStateID`, `EntityLastChangedOn`, `Creation*`, `LastChange*`, `ItemNumber`, `LineNumber` (identity/audit)
- **Self-healing retry** (`stripCreateNotAllowed`): regex-parses SAP's `Create not allowed for properties: X, Y, Z` errors, drops those keys, retries up to 2 more times. Don't remove — future SAP-managed fields will be auto-discovered this way.
- **Quantity format** (v0.26.94+): `PlannedQuantity = "0.00000000000000"`, `ActualQuantity = qty.toFixed(14)`. On THIS tenant's workflow: ZRP3 (Parts Ordering) stores the order quantity in `ActualQuantity`, and `PlannedQuantity` is 0. A different processing type handles parts consumption. This deviates from standard SAP semantics (where Planned > 0 and Actual = 0 for ATP orders), but the tenant has customized the workflow so the operator-entered quantity goes into Actual. SAP's ATP-lifecycle override (which zeros Actual when Planned > Actual) doesn't fire when Planned = 0.
- **Processing-type field**: `UserServiceTransactionProcessingTypeCode` (NOT `ProcessingTypeCode` or `ItemListProcessingTypeCode`).

**Diagnostic embed pattern** (`v0.26.78+`):
- Failure error message format: `===C4S_DIAG_BEGIN===<json>===C4S_DIAG_END===\nSAP rejected commit. <short>`.
- Embed at START (not end) — `redactSensitiveDetails` trims to 3000 chars; trailing diag gets chopped.
- Panel auto-expands the diag block and exposes a `📋 Copy full diagnostic JSON` button.

**Concurrency** (`v0.26.86+`):
- `commitOrderParts` MUST commit sequentially (`for...await`), never `Promise.all`. SAP locks the parent `ServiceRequest` per-write — parallel POSTs from the same integration user collide with themselves and one gets `"Locking object not possible; object locked by <user>"`.
- Inter-commit pause: 400ms after each success. Lock-error detection regex: `/Locking object not possible|object locked by/i`. On match, sleep 1500ms and retry once.

**Probe selection** (`v0.26.85+`):
- `probeExistingServiceItem` queries `$top=20`, then picks the first row with `UserServiceTransactionProcessingTypeCode` in `{ZRP3, ZRP1, SRP1}` (parts-shaped). Falls back to most-recent only if no parts row exists.
- Why: many tickets have travel/labor (ACTRVL/ACTLAB) as the most-recent line item; mirroring their shape (`UoM "Each"`, labor warranty, ACTRVL description) contaminates the parts POST.

**Service-line contamination heal** (`v0.27.42`):
- On PM-contract tickets with NO prior parts rows, the probe fallback mirrors the PM SERVICE line → POST carries `SchedulingRelevant_KUT` (e.g. `"101"`), service UoM (`ZDP`), `ContractID`/`ContractItemID` → SAP rejects with HTTP 500 **"Schedule line type  is not valid"** (NOTE: double space — SAP interpolates an EMPTY type placeholder; the heal regex is `/Schedule line type[\s\S]{0,30}?is not valid/i`, never a literal single space).
- `logServiceItem`'s retry loop heals in stages, fired ONLY on that exact error: stage 1 drops `SchedulingRelevant_KUT` + `KUT_PlannedDurationHours_KUT` + normalizes UoM to the cart's; stage 2 drops `ContractID`/`ContractItemID` + `RequestedStart/EndDateTime`; **stage 3 (product-history FINDING — NOT a switch)** queries the product's own prior line items tenant-wide, and when the dominant historical processing code differs from the one sent, embeds a `productHistory` block into the failure diagnostic. The panel renders it as an actionable hint. **It does NOT auto-commit under the historical code** — user explicitly rejected the silent flip (*"its Order parts ZRP3 not Consume parts"*): ordering (ZRP3) vs consumption (SRP1) is a business distinction the operator owns.
- Why stage 3 exists: the blank in SAP's message IS a failed schedule-line-type lookup for (product class × processing code). Real case: product 11083446 (DIBA tubing, UoM `ZDP`) — 10/10 historical rows are `SRP1` with `Planned = Actual = qty`; ZRP3 has no schedule-line customizing for that product class on this tenant. EA-unit spares use ZRP3 fine.
- Do NOT remove, do NOT make the strips unconditional, and do NOT re-introduce an automatic processing-code switch — contract linkage and ZRP3 are legitimate when the probe found a real parts row, and code changes are operator decisions. Error-driven diagnostics only.

**Tenant POST-exposure quirks** (`v0.27.40-41`):
- `ServiceRequestTextCollection` is NOT exposed flat at the service root on this tenant — flat POST 404s ("Resource not found for the segment"). Notes must POST via the navigation path `/ServiceRequestCollection('<id>')/ServiceRequestTextCollection`, and the body MUST still include `ParentObjectID` (SAP 500s "ParentObjectID is not provided" without it). The exact MIRROR of line items (flat works, nav 404s). `addServiceRequestText` + `attachSolutionToTicket` try flat first, fall back to nav on segment-not-found.
- "Solutions Used" facet (Solution Center tab) = `ServiceRequestSolutionProposal` nav / `ServiceRequestSolutionProposalCollection` flat. Carries `ExternalKnowledgeBaseArticleID/URI/Description` + `Note` — designed for external KBs (MindTouch). Both writes retry once after 1500ms on SAP edit-lock errors.
- The ticket contact email lives in `KUT_CEMAILS_KUT` (may hold multiple, `;`-separated) — no standard `*EmailAddress` field exists on ServiceRequest here.
- **Product master IS readable since 2026-06-12** (the integration user was granted Products access; previously 403). `ProductCollection` key field is **`ProductID`** — `InternalID`/`ID` do NOT exist in this tenant's Product type (400 "Property not found"). `MaterialCollection` → 404 (doesn't exist). `searchParts` attempt 4 (v0.27.44) queries it after stock + line-item misses; on tenants without the grant the 403 is caught and the attempt no-ops (the v0.27.43 manual add-by-ID escape hatch covers those). The same grant unblocked `InstallationPointCollection` — /map's city/state backfill now actually hits the 🏢 InstallationPoint path instead of falling back to 🌐 reverse-geocode.

**UoM code validation** (`v0.26.85+`):
- `buildBodyFromProbe` validates `QuantityMeasureUnitCode` against `/^[A-Z0-9]{1,4}$/`. Non-conforming values (e.g., `"Each"` instead of `"EA"`) fall back to `"EA"` (or `"HUR"` for labor processingTypes).
- Shim's `searchParts` returns `uom` preferring `BaseUnitofMeasure` (code) over `BaseUnitofMeasureText` (label).

## /book-time — ZALT labour/travel hours (create-then-PATCH actuals)

`/book-time` logs labour + travel hours as **ZALT** ("Actual Labor / Travel") line items via the SAME `log_service_item` path /order-parts uses (probe → build-from-probe → POST → self-heal → lock-retry → gated apply-annotation). Products are configurable, defaulting to this tenant's `11266683` (ACTUAL_LABOR / ONSITE LABOR) and `11266684` (ACTUAL_TRAVEL / TRAVEL TIME); UoM `HUR`; `quantity` IS hours (fractional — uses `floatArg`, not `numberArg`).

- **Hours (quantity) are DERIVED by SAP from `ActualEndDateTime − ActualStartDateTime`** on this tenant's ZALT time entries — they are NOT taken from `ActualQuantity` in the POST body (which lands as 0 on the grid). Confirmed against existing rows: 11:30→12:00 shows 0.5h, 9:00→11:00 shows 2h, 11:00→12:00 shows 1h. **So you MUST set BOTH Actual Start and Actual End** — set only start and the grid shows 0h. The "Finish Work" checkbox is just the grid's visual cue that Actual End is populated (there is NO `FinishWork*` field on `ServiceRequestItem` — don't go looking for one).
- **Booked time goes to `ActualStartDateTime`/`ActualEndDateTime`, NOT Requested\*** (operator: *"It must go to Actual start and Actual End not Requested."*). But **`Actual*` is forbidden on CREATE** — it's in `buildBodyFromProbe`'s `SKIP_EXACT` because SAP returns `CX_ODATA_ANNOTATION_ERROR: Create not allowed for properties: ActualStartDateTime`. So the booked time CANNOT ride in the POST body. (SAP also AUTO-stamps `ActualStartDateTime = creation time` on create — so a created line shows "now" as Actual Start even when the PATCH is skipped; don't be fooled into thinking the write landed.)
- **Pattern (v0.27.72): create, then PATCH the actuals.** `logServiceItem` POSTs the line (mirroring the probe's own valid `RequestedStart/EndDateTime` — do NOT override Requested with the booked time, or you reintroduce the v0.27.71 "End date must be after start date" 500 when start>mirrored-end), resolves the created item's `ObjectID`, then PATCHes `/ServiceRequestItemCollection('<id>')` with `ActualStartDateTime`/`ActualEndDateTime` (`/Date(ms)/` wire-format) — same write `updateServiceItemActuals` does.
- **Resolving the created ObjectID (v0.27.74):** the POST response body comes back EMPTY on this tenant (`SUCCESS … Echoed back: {}`), so `result.d.ObjectID` is null and the PATCH was being silently skipped. The ObjectID is in the **`Location` response header** (`…/ServiceRequestItemCollection('<ObjectID>')`) — `c4cPostWithMeta` (in `connectors/c4c/client.ts`) surfaces `{ data, location, status }` from the shared write driver so `logServiceItem` can read it. Fallbacks: POST-echo body → Location header → re-query (`ParentObjectID eq … and ProductID eq …`, `$orderby=CreationDateTime desc`, `$top=1`; labour vs travel use distinct ProductIDs so this disambiguates). Only if all three fail does it soft-warn.
- Options: `actualStartMs`/`actualEndMs` (epoch ms). End is derived = start + quantity-hours when `actualEndMs` is absent or ≤ start (floored at +1 min). The extension passes `actualEndMs = startMs + hours·3,600,000` explicitly too.
- **Best-effort, not all-or-nothing:** the line is already created before the PATCH. If SAP rejects the Actual-date PATCH (e.g. lifecycle state locks `Actual*`), do NOT throw — attach `result._actualDatesWarning` and let the panel show a soft amber note. Throwing would imply nothing was written and tempt a duplicate re-add. Lock-aware single retry (1500ms) on the PATCH, mirroring the commit lock-retry.
- Dry-run preview augments the `wouldDo` body with annotated `(post-create PATCH) ActualStartDateTime/EndDateTime` keys (a COPY — they never reach the real POST) so the operator sees both writes.
- Commit entries SEQUENTIALLY (SAP locks the parent per write), 400ms inter-write pause — same as `commitOrderParts`.

## Part prices — NOT in C4C OData (ECC pricing scaffold, v0.27.78)

Probed `my340573` exhaustively: **there is no per-product price reachable via the C4C OData API.** Don't re-investigate — the findings:
- `ProductCollection` → only `KUT_CostCategory_KUT` (a cost *category*), no sales price.
- `ServiceRequestItem` → NO amount/price fields at all.
- `InternalPriceDiscountList…` (C4C internal price list) → **empty** on this tenant.
- `CustomerOrderItem` → HAS `NetPriceAmount` (+ `…ExternalPriceComponent` = the ECC pricing result) but **`ProductID` is NOT filterable** (`CX_ODATA_ANNOTN_ERROR_FILTER`), so you can't look up by product.
- `ContractItem` → filterable by `ProductID` and has `NetPriceAmount`, but the PM spares have **0 contract lines**.
- `SalesQuoteItem` → has price fields but **no `ProductID`** on the item.
- There is **no read-only "pricing simulation" OData function**. Confirmed against `$metadata`: c4codataapi exposes **52 FunctionImports, none for external pricing** (only `DepersonalizeSalesQuote`, `SalesQuoteQueryByElements`, `GetServiceRequest*`). The mechanism C4S uses is the named **"Request Sales Document Data from SAP Business Suite"** integration — a **SOAP A2X** call C4C↔ERP whose output is the `…ExternalPriceComponent` data; it's document-scoped (sold-to + sales area + item + qty), not a per-material REST/OData GET. To replicate from the shim you must call that Business Suite SOAP service directly (needs ERP endpoint + WSDL/contract) OR drive a transient C4C sales quote (a write). Wire it in `eccPricing.callEccPricing` once the contract is known.

Conclusion: prices must come from **ECC directly** via the CPI SOAP service. `src/eccPricing.ts` is the connector.
- **Endpoint (v0.27.79):** `https://l5459-iflmap.hcisbp.us2.hana.ondemand.com:443/cxf/COD/ERP/CUSTOMERQUOTEREQUESTEXTERNALSALESDOCUMENTDATAOUT?sap-client=100` — the CPI/iflmap iflow for "Request Sales Document Data from SAP Business Suite". Auth = **client certificate (mutual TLS)**.
- **Transport is REAL + wired:** `postSoap()` builds a `node:https` agent from the client cert (PEM pair or PKCS#12) and POSTs the SOAP body; server trust = system CA (`--use-system-ca`).
- **Two CONTENT drop-ins remain** (need a sample message): `buildSoapRequest()` (the `CustomerQuoteRequestExternalSalesDocumentData` request envelope — returns null until supplied) and `parseSoapPrice()` (net-price/currency out of the response). Until both are filled, lookups return `{priced:false, reason:"soap-request-template-not-wired"}`.
- **Config (`.env`):** `ECC_PRICING_ENABLED`, `ECC_PRICING_URL`, `ECC_PRICING_SOAP_ACTION`, `ECC_PRICING_CLIENT_CERT`/`_KEY` (PEM) **or** `ECC_PRICING_PFX` + `ECC_PRICING_CERT_PASSPHRASE`, `ECC_PRICING_SERVER_CA`, `ECC_PRICING_SALES_ORG/DISTR_CHANNEL/DIVISION/CURRENCY`. Cert + URL live shim-side (env / cert files on disk), **NEVER** in extension `chrome.storage.sync`.
- Shim route `POST /api/get_product_prices` (best-effort, always 200, `{configured, prices}`). Prep-for-PM renders a Price column hydrated from it (`hydratePartPrices` in popup.js); shows `—` + a footnote until configured/wired.

## /interactions email body extraction — known-good wiring (DO NOT BREAK)

The `/interactions` command resolves emails linked to a ticket end-to-end as of v0.26.127. Took 22 iterations to get there (v0.26.106 → v0.26.127). The chain has 5 load-bearing layers. Future maintainers: do not "simplify" any of them.

**Layer 1 — Discover the navigation property name (NOT bare collection name).**

The SAP-standard "Document Flow" linkage from a ticket to its related emails/calls/appts is exposed via the navigation property `ServiceRequestBusinessTransactionDocumentReference` (prefixed with `ServiceRequest`). Bare `BusinessTransactionDocumentReference` 404s on this tenant. v0.26.113's auto-discovery (fetch ticket with no `$select` and walk `__deferred` URIs) confirmed the exact name.

**Layer 2 — UUID is the FK to the linked entity, not just a reformatted ObjectID.**

A `ServiceRequestBusinessTransactionDocumentReference` row carries `ObjectID` (its own ID) and `UUID`. When they differ (compare ObjectID against UUID-with-dashes-removed), UUID is the **linked email's UUID**. Strip dashes + uppercase → that's the email's ObjectID. Fetch `/EMailCollection('<stripped>')`.

When `UUID == ObjectID` (same identifier, just dash-formatted differently), there's no separate linked entity. Strategy 3 correctly skips. Fall through to strategies 4 (ID-filter) and 5 (scalar FK).

**Layer 3 — Resolver MUST run on every email-shaped row, not just one strategy.**

`enrichEmailEntity(emailEnt, objectId, subject, c4cGet)` is the function that fetches body + attachments. v0.26.124 extracted it from inline-Strategy-3 code; v0.26.125 wired it into strategies 1, 2, 3, 4, 5. v0.26.126 added a **final-mile safety net** in the union loop — after `resolveRefRow` returns and the row is added to `allActivities`, any row that looks like an email (`TypeCode === "39"` OR `TypeCodeText`/`DocumentTypeText` matches `/e-?mail/i` OR `__metadata.type` contains `EMail`) AND lacks `_bodyResolvedFrom` AND has an `ObjectID` gets enriched here. Idempotent — guarded by the `_bodyResolvedFrom` marker.

Do NOT remove the safety net. Without it, rows that fall through all 5 strategies as stubs (or are returned directly from non-BTDR attempts) silently skip body resolution.

**Layer 4 — Email body lives in `/EMailCollection('<id>')/EMailNotes` (despite the name).**

`EMailCollection`'s 52 scalar fields do NOT include `Body`/`BodyText`/`Text` etc. The body content lives in the `EMailNotes` child navigation — counterintuitively named (it's labeled "Notes" in the OData schema but contains the actual message body, not user-added notes). Probe order in `bodyPaths`:

1. `EMailNotes` ← the winner on this tenant
2. `EMailContent`, `EMailItem`, `Item`, `Body`, `Text`, `EMailItemAttachmentFolder`, `AttachmentFolder` (covers other tenant shapes)

Inside the response rows, body-extraction tries `BodyText || Body || Text || TextContent || HtmlContent || Content || Note || NoteContent || FormattedText || Description` (note `||` not `??` — empty strings fall through correctly).

**Layer 5 — Body comes back as raw HTML, MUST strip to plain text (v0.26.127).**

SAP returns Outlook-formatted HTML: `<p style="font-family:'verdana,geneva'; font-size:11pt;">Good afternoon&nbsp;</p>` etc. `htmlToPlainText(html)` does the conversion:

- Block-level closing tags (`</p>`, `</div>`, `</h1-6>`, `</li>`, `</tr>`, `</blockquote>`) and `<br>` → newlines (preserves paragraph structure)
- Strip `<style>`, `<script>`, HTML comments, all remaining tags
- Decode 15 named entities + all numeric `&#nnn;`/`&#xNN;` via `String.fromCodePoint`
- Collapse horizontal whitespace, max 2 consecutive newlines

Applied only when body contains HTML-shaped tags. Original HTML preserved on `_bodyHtml` (16KB cap) for future rich-render path. Plain text on `Body` + `BodyText` for timeline + LLM.

**Other load-bearing details:**

- `strip()` preserves `__deferred` URIs into `_navLinks` (don't go back to dropping them — strategy 2's nav-link follow path needs them).
- `?? → ||` in the popup.js normalizer for Subject/Body/Sender chains — SAP returns empty strings for missing fields, not nulls (`MessageFromName: ""` was locking the chain).
- BTDR rows are diagnostic-captured BEFORE `resolveRefRow` mutates them (preserves the original `__metadata` + `__deferred` URIs for the panel's 🪵 raw-row dump).
- Per-email body-resolution log (`emailBodyResolutions`) tracks every email through every body-path attempt — including `status: "no-text-fields"` when rows came back but body field had no content. Used by the panel's 📬 per-email diagnostic block. Don't remove.
- Attachments fetched via `/EMailCollection('<id>')/EMailAttachments`, normalized to `{name, size?, type?}`, surfaced as `_attachments` on the activity row + as a `📎 N` badge + sky-blue chip list in the timeline + appended to the LLM prompt as `Attachments: name1.pdf (PDF), name2.xlsx (Spreadsheet)`.
- LLM per-entry body cap = 4000 chars (was 2000 before v0.26.122). Don't drop below 4000 — longer email threads lose detail.
- `interactions` is in the `isSlowSlash` regex in `ask()` (popup.js) so the progress strip renders during the multi-second fetch. The handler progresses through *"Looking up ticket"* → *"Scanning notes + emails + activities on ticket NNN"* → *"Summarizing N interactions (X notes + Y emails/activities) with LLM"*.

## /map — LOCKED at v0.27.22 (DO NOT BREAK)

The product owner confirmed *"it's working, do not break"* after a 13-version recovery sequence (v0.27.10 → v0.27.22) to make a 5-filter map query work on the Thermo Fisher tenant: status + secondary-type + ZIP+radius + due-on-site + serial wildcard. Future maintainers: do not touch any of the load-bearing layers below.

**v0.27.23 followup** (approved Option B): Max tickets default + cap raised to 200. Silent radius-mode bump (`effectiveTop = Math.max(filters.top, 200)`) REMOVED. `effectiveTop = filters.top` directly. This was a pure UX cleanup — what the operator picks is what runs. Do not re-introduce the silent bump.

**Tenant reality on this SAP C4C V1 instance:**
- `ServiceLocationCity` / `ServiceLocationCityName` / `City` / `CityName` / etc. — **NONE of these exist on `ServiceRequest`**. The service-location address lives EXCLUSIVELY on the `InstallationPoint` entity, joined via `InstallationPointID` on the ticket.
- `OnSiteArrivalDueDateTime` — **declared but not filterable** in OData. `Edm.DateTime` literal, `Edm.DateTimeOffset` literal — both return *"Invalid parametertype used at function 'ge'"*. No SAP-standard alternative (`ServiceExecutionDueDateTime`, `OnSiteDueDateTime`, etc.) exists either.
- `LastChangeDateTime` — IS `Edm.DateTimeOffset`, so it MUST use `datetimeoffset'...Z'` literal. Cannot be swapped to `datetime'...'`.
- `KUT_Secondary_Ticket_Type` (numeric code, e.g. "131") + `KUT_Secondary_Ticket_TypeText` (label, e.g. "PM (Contract)") — non-standard naming (underscores between words, no `_KUT` suffix). Value-help collection at `/ServiceRequestKUT_Secondary_Ticket_TypeCollection` returns 17 canonical codes.
- `KUT_RPLatitude_KUT` / `KUT_RPLongitude_KUT` — lat/lon are populated for most mappable tickets (rooftop coordinates). City/state are NOT.

**The 4 load-bearing recovery layers (don't remove any):**

1. **Smart-strip word-boundary dedup** (v0.27.22) — `c.clause.includes(a)` was too aggressive; after swap to `ServiceLocationCityName` it incorrectly excluded `CityName` and `City` from candidates. Now uses `new RegExp(\`\\b${alt}\\b\`).test(clause)`. Without this, only 4 of 5 city alternatives get tried.

2. **Combinatorial date-literal swap with per-field-name fallback chain** (v0.27.15 + v0.27.17). When SAP returns *"Invalid parametertype"*, bitmask through 2^N (`datetime` ↔ `datetimeoffset`) combinations per clause. When bitmask exhausts, swap to next alternative field name and reset bitmask. `OnSiteArrivalDueDateTime` uses `datetime'...'` literal upfront (its declared type). The `MAX_ATTEMPTS = 16` is needed for the full alternatives chain — do NOT lower it.

3. **InstallationPoint backfill** (v0.27.21). Group rows by `InstallationPointID`, fetch `/InstallationPointCollection?$filter=InstallationPointID eq 'NNN'` via the existing `/api/debug/query` shim passthrough (NO new SAP route), extract city/state/postal/country from the InstallationPoint entity. Cached under `c4s.installation-point-cache` with 90-day TTL. Parallel fetches at concurrency 8. Multiple field-name fallbacks on the InstallationPoint response (`AddressCity` / `City` / `CityName` / `ServiceLocationCity` etc.). The row builder stashes `_ticket: <original entity>` so the backfill can read `InstallationPointID`. Reverse-geocode (v0.27.20) ONLY runs as a fallback when InstallationPointID is missing OR InstallationPoint entity has no address.

4. **Client-side fallback filters** (v0.27.19 due-on-site + v0.27.22 city/ZIP). When the server-side clause exhausts all field-name alternatives and the smart-strip DROPS it, the filter applies CLIENT-SIDE post-fetch:
   - Due-on-site: stash `clientSideDueDateRange = {fromMs, toMs}`, filter rows whose resolved due date (via the row builder's 5-field chain) falls in range.
   - City/ZIP: stash `clientSideCityCriterion = "92592"`, filter rows where the criterion appears (case-insensitive) in any of `city` / `state` / `postalCode` / `country` (all populated by the InstallationPoint backfill). Also narrows `mapState.markers` so the map view matches the table.
   - Both surface INFORMATIONAL status notes (`ℹ ...applied CLIENT-SIDE...`), NOT the old `⚠ DROPPED` warning.

**Other don't-break details:**
- `mapState._allMappableTickets` is the row data source for the table modal — keep `_ticket` reference on each row so backfill can read `InstallationPointID` without re-fetching.
- The InstallationPoint cache is keyed by ID (e.g., `"2921929"`), separate from the geocode cache (which is keyed by `addr:postcode|country=us|postal=...`). Different TTLs (90d vs 30d).
- Secondary Type filter is a `<datalist>` populated dynamically from the 17 SAP values (v0.27.16 removed all hardcoded shortcuts — don't add them back). Option template is `value="Description"` + inner text same as value + `data-code="131"` + `title="Code 131"` (v0.27.18 — Chrome's datalist renders TWO lines if value ≠ inner text, so they MUST match).
- The status select element ID is `map-filter-status-select` (renamed in v0.27.9 to avoid colliding with the status text DIV which has `id="map-filter-status"`).

## Environment quirks

- Corporate MITM HTTPS interception in dev: Node fetch needs `NODE_OPTIONS=--use-system-ca` (Node 22+). `npm start` adds it automatically when the running Node supports the flag.
- Default LLM model: `claude-sonnet-4-5`. Don't use retired Haiku 3 models in test scripts.
- Default port: `127.0.0.1:3031`.
- `npm run test:users` builds (type-check) and runs the users/roles smoke test against a throwaway server; CI does the same.
- `ASKC4S_NO_DOTENV=1` stops the shim reading `.env` at all (`connectors/c4c/client.ts`). Off by default. `scripts/smoke-users.mjs` sets it so its throwaway server can't pick up real SAP credentials — note the loader refills a *blank* variable from `.env`, so blanking alone is not isolation. Test users/roles with `npm run build && node scripts/smoke-users.mjs`.
