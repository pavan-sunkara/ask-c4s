# Ask C4S — Security & compliance posture

**Status**: Pre-certification draft. This document describes the controls Ask C4S implements today and the gaps that would need to be closed for SOC 2 Type II / GDPR Article 32 conformance.

**Audience**: Customer security teams evaluating Ask C4S, our own engineering team, future auditors.

---

## 1. Architecture posture

Ask C4S is designed for **deployment inside the customer's perimeter** — typically the same VPC / datacentre / on-prem network as their SAP, ServiceNow, or other connected systems. The default deployment model is:

```
┌───────────────────────────────────┐
│ Customer's network (VPC / on-prem)│
│                                   │
│  ┌─────────┐   ┌──────────────┐   │   Outbound HTTPS only when
│  │ FSE     │ ◀ │ C4S shim     │ ─── ─── ─── ▶  AI provider in use
│  │ browser │   │ + MCP tools  │   │       (Anthropic / OpenAI / Azure)
│  └─────────┘   └──────┬───────┘   │
│                       │           │
│                       ▼           │
│                ┌──────────────┐   │
│                │ SAP C4C /    │   │
│                │ ERP / etc.   │   │
│                └──────────────┘   │
└───────────────────────────────────┘
```

**No customer data leaves the perimeter** except deliberate outbound calls the customer authorises — today that's only the chosen LLM provider for the AI Companion. KB lookups (MindTouch) and SAP calls stay east-west inside the customer's network.

---

## 2. Data classification

| Category | Where it lives | Encryption | Notes |
|---|---|---|---|
| SAP credentials (per tenant) | `data/tenant-catalog.json` | **AES-256-GCM** at rest | Key in `data/.tenant-key` (mode 0600) or `$ADMIN_ENCRYPTION_KEY` env var |
| Settings table secrets (API keys, KB tokens) | SQLite `settings` table | **AES-256-GCM** per row, `secret`-typed fields only | Same key derivation as the catalog |
| Internal session tokens | In-process memory only | n/a (ephemeral, 24h TTL) | Destroyed on process restart |
| SAP ticket data, KB hits | SQLite cache | **Plain text** (per design — read replicas of upstream data) | TTL governed by `cache.code_list_ttl_ms` and similar settings |
| Audit log | SQLite `audit` table | **Plain text** | See §5 |
| Customer chat transcripts | **Not persisted** | n/a | Each AI Companion turn is stateless; the conversation lives only in the user's browser session |
| LLM API request payloads | Outbound only | TLS in transit | See §6 for provider posture |

---

## 3. Authentication & authorisation

### 3.1 Protected routes (`/settings`, `/api/admin/*`, `/api/chat`, `/api/integrations/*`)

- Password-based gate at first sign-in (`ASKC4S_INTERNAL_PASSWORD` env var, never committed)
- On success: server issues a **128-bit random hex token** stored in localStorage
- All gated endpoints check `Authorization: Bearer <token>` on every request — frontend gate is a UX layer, server-side check is the actual security boundary
- Token TTL: 24 hours, in-process only — restart invalidates all tokens
- Failed requests return 401, no information leakage about whether the token was wrong vs expired vs unknown

**Known limitation (shared-password mode only)**: one password for everyone — no attribution, no per-person revocation. That is the mode a deployment is in until its first personal account is created; the upgrade is §3.1a.

### 3.1a Personal accounts and roles

Once the first account exists the deployment switches to **personal accounts** and the shared password is refused (unless an operator sets `ASKC4S_ALLOW_SHARED_PASSWORD=true` as break-glass).

- **Accounts**: email + password (scrypt, per-user salt, constant-time compare) or SSO-only. Passwords are never stored or logged in the clear. Minimum 12 characters.
- **Roles, enforced on the server** (never trusted from the client): **owner** (everything), **admin** (settings, SAP connection, users — managers and agents only), **manager** (read-only: SAP data, settings, audit), **agent** (field technician: SAP read **and** write through the write-back gates in §3.2). Real SAP writes need the write permission, so a manager cannot write even through the API directly.
- **Live role checks**: a token carries only the account id. The role and the account's active/disabled status are read from the database on every request, so disabling or demoting someone takes effect on their next call, not when the token expires.
- **Guard rules**: nobody can change their own role or status; admins cannot create or modify owners/admins; the last active owner can never be demoted or disabled.
- **SSO**: Google / Entra ID prove identity, the directory decides access — only people who already have an account can sign in (no auto-provisioning).
- **Brute force**: per-account lockout (5 failures → 15 minutes), per-address throttle, and unknown emails cost the same as real ones so response time doesn't reveal which accounts exist.
- **Temporary passwords**: accounts created or reset by an admin must choose their own password before anything else works; a reset signs the user out everywhere.
- **Recovery**: a host operator can restore access with `node dist/usersCli.js set-owner <email> <temporary-password>` (requires shell access to the server, i.e. the same trust boundary as `.env`).

**Remaining limits**: no built-in MFA (use the identity provider's via SSO); sessions are in-memory, so a restart signs everyone out; SAP is still called as one shared integration user (§7, CC6.1).

### 3.2 SAP write-back safety (three-gate chain)

Every write to SAP (note add, status update, KB attach, etc.) passes three independent gates server-side:

1. **`dryRun=true` by default** — every write tool returns the would-be POST body unless the caller explicitly opts in
2. **Server feature flag** — writes are disabled entirely unless `writes.enabled` is true in the settings table (per-tenant)
3. **Production acknowledgement** — when the active tenant's `environment` is `production`, the caller must additionally pass `acknowledgeProduction=true`

The frontend `WriteBackActions` panel always shows the dry-run preview before any live POST; the user confirms explicitly via a "Confirm & write" button.

### 3.3 Tenant isolation

- Every SQLite query is keyed by `tenant_id`, derived from the active tenant catalog entry
- A user with one tenant's credentials cannot query another tenant's cached data, settings, or audit log
- Tenant override (admin sees a different tenant's data) is read-only and bannered prominently

---

## 4. Encryption

### 4.1 At rest

| Data | Algorithm | Key source |
|---|---|---|
| Tenant catalog (SAP creds) | AES-256-GCM | `$ADMIN_ENCRYPTION_KEY` env var (hex or scrypt-derived) OR auto-generated `data/.tenant-key` (mode 0600) |
| Settings `secret` fields | AES-256-GCM | Same as tenant catalog |
| Authentication tag | GCM 128-bit MAC | Verified on every decrypt |

Encryption is implemented in `src/secureConfig.ts` using Node's built-in `crypto` module (no third-party crypto libraries).

### 4.2 In transit

| Channel | Encryption | Notes |
|---|---|---|
| Browser ↔ Ask C4S shim | TLS via reverse-proxy (admin's responsibility) | The shim itself binds to `127.0.0.1` — TLS termination at nginx / Caddy / Cloudflare |
| Ask C4S ↔ SAP C4C | TLS 1.2+ (enforced by SAP) | Cert pinning not yet implemented |
| Ask C4S ↔ Anthropic / OpenAI / Azure | TLS 1.2+ | Standard HTTPS, no pinning |
| Ask C4S ↔ Knowledge MindTouch | TLS 1.2+ + Azure AD bearer | OAuth client-credentials |

### 4.3 Key rotation

- **AES key**: rotation requires re-encrypting the tenant catalog. Procedure documented in `docs/operations/key-rotation.md` (to be written).
- **Internal session tokens**: rotated on every shim restart (no action required).
- **SAP credentials**: customer's responsibility per SAP password policy.
- **AI provider keys**: rotate in Admin → Settings; takes effect on next request.

---

## 5. Audit logging

Every mutating operation, every admin action, and every authentication event is recorded in the `audit` SQLite table.

### 5.1 What's captured

| Event | Fields recorded |
|---|---|
| Admin action (`/api/admin/*`) | timestamp, actor (the signed-in account's email; the client-supplied `X-Admin-Actor` header is used only for tokens that carry no identity), tenant, endpoint, method, sanitised params |
| User management (`user.create`, `user.update`, `user.reset_password`, `user.change_password`) | timestamp, actor, target account, what changed (role/status from→to; never a password) |
| Sign-in (`auth.login`, `auth.login_sso`, `auth.lockout`) | timestamp, account |
| Write-back (SAP mutation) | timestamp, actor, ticket ObjectID, tool name, dry-run flag, production-ack flag, result |
| Internal auth success/failure | timestamp, IP, success/failure (password value never logged) |
| Tenant catalog change | timestamp, actor, before/after diff (passwords redacted) |
| AI chat invocation | timestamp, actor, model, input tokens, output tokens (message content **not** stored) |

### 5.2 What's NOT captured

- Raw SAP read responses (would balloon storage; customer can replay via cache)
- AI chat message content (privacy posture; customer can re-issue if needed)
- Bearer tokens or passwords (sanitised at log time)

### 5.3 Retention

- Default: indefinite (admin manually prunes)
- Configurable via `audit.retention_days` setting — when set, a daily job prunes entries older than the limit

### 5.4 Tamper-resistance

**Known gap**: the audit table is plain SQLite — a privileged user on the host can edit it. For SOC 2 Type II conformance, audit log integrity would need:
- Hash-chained entries (each row's hash references the prior row's hash)
- OR external streaming to an append-only store (S3 Object Lock, Datadog audit, etc.)

Roadmap item, not yet implemented.

---

## 6. Third-party data flow

### 6.1 LLM provider (chosen by customer)

The AI Companion sends a context block + user message to the configured provider (Anthropic by default). The context block includes:

- Ticket subject, status, priority
- Customer name + serial / product
- Last 3 ticket notes (text, type)

**It does NOT include**:
- Account financial data
- Other customers' tickets
- API keys, passwords, internal IDs (ObjectIDs only)
- Free-form user PII unless the customer pasted it into a note

### 6.2 Provider posture summary

| Provider | Training data policy | Data retention | EU residency option |
|---|---|---|---|
| Anthropic Claude (default) | No training on API traffic (per Anthropic ToS) | 30 days for trust & safety | Yes (Anthropic EU endpoint) |
| OpenAI API | No training on API traffic (with default settings) | 30 days unless zero-retention agreement | Yes (Azure OpenAI EU regions) |
| Azure OpenAI | No training (per Microsoft contract) | 30 days; can be zeroed | Yes (per Azure region) |
| Self-hosted (Ollama) | n/a | Customer's own infra | n/a |

For GDPR-strict customers: **switch the AI provider setting to Ollama** (self-hosted) or Azure OpenAI in an EU region. Both are env-var swaps; no code change.

### 6.3 Disabling AI entirely

Set `ai.provider = "disabled"` in Admin → Settings (or remove the provider keys). The AI Companion still works for canned-intent answers (no LLM call); only free-form fallback is disabled.

---

## 7. SOC 2 Trust Service Criteria — gap analysis

This is an honest assessment of what's in place vs what would need to be built for SOC 2 Type II.

| TSC | Sub-criterion | Status | Notes |
|---|---|---|---|
| Security | CC6.1 Logical access | **Partial** | Personal accounts with four server-enforced roles, SSO restricted to existing accounts, lockout and forced password change (§3.1a). Remaining: built-in MFA (delegated to the IdP via SSO), persistent sessions / idle timeout, and SAP is still called as one shared integration user (RFC 8693 token exchange not built). |
| Security | CC6.6 Encryption | **In place** | AES-256-GCM at rest, TLS in transit |
| Security | CC6.7 Vulnerability mgmt | **Gap** | No automated dependency scanning. Manual `npm audit` only. |
| Security | CC6.8 Malicious software | **N/A** | Server-side: Node.js sandbox. No file upload from browser. |
| Availability | A1.2 Backups | **Gap** | SQLite must be backed up by the customer's operational team. No built-in replication. |
| Confidentiality | C1.1 Identifying confidential information | **In place** | Settings registry marks fields `secret` explicitly |
| Confidentiality | C1.2 Disposing of confidential information | **Gap** | Tenant deletion removes the catalog entry but does not purge cache / audit / settings rows |
| Processing Integrity | PI1.1 Data validation | **Partial** | Zod validation on every MCP tool's input; OData filter sanitisation. Output schemas not validated. |
| Privacy | P3.1 Personal information collection | **In place** | No PII collected by Ask C4S; all PII is pass-through from SAP |
| Privacy | P5.1 Access to PI by subject | **N/A** | Ask C4S has no PI of its own; subject access is via SAP |

---

## 8. GDPR Article 32 conformance

> *"Taking into account the state of the art, the costs of implementation… [the controller] shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk."*

| Article 32 measure | Ask C4S posture |
|---|---|
| (a) Pseudonymisation and encryption of personal data | Encryption at rest for credentials. Operational PII (in tickets) is passed through, not stored. |
| (b) Ongoing confidentiality, integrity, availability, and resilience | Tenant isolation in place. Resilience depends on the customer's hosting environment. |
| (c) Ability to restore availability and access to personal data in a timely manner | Depends on customer's backup posture. Not enforced by Ask C4S. |
| (d) A process for regularly testing, assessing and evaluating | Customer's responsibility. Ask C4S provides audit-log visibility as input to that process. |

### 8.1 Data subject rights (Article 15–22)

Ask C4S does not store personal data independent of SAP. When a customer fulfils a data subject access / erasure request in SAP, the corresponding cached row in Ask C4S is the responsibility of the Ask C4S admin:

1. **Access**: query the cache (the SQLite file on the server's data volume) — surfaces every cached row
2. **Rectification**: invalidate the cache for the ticket; next read pulls fresh from SAP
3. **Erasure**: same as rectification; cache is read-replica, source-of-truth deletion is SAP
4. **Portability**: SAP is the system of record; export from there

**Documented limitation**: until §8.2 is built, erasure of a row from the SAP-side does not automatically erase from the Ask C4S cache. The customer's GDPR procedure must include a Ask C4S cache invalidation step.

### 8.2 Roadmap for automated GDPR support

- Hash-based identifier for personal-data rows so cache invalidation can target without re-reading content
- Daily reconciliation job comparing cache vs SAP for deleted rows
- Standard "right to erasure" admin button on each cached row

---

## 9. Operational controls

### 9.1 Access control

- Server-side `.env` file holds master secrets — accessible only to OS user running the Ask C4S process
- Admin UI requires the bearer token (§3.1)
- No code paths that print secrets to stdout or logs (verified by grep at release time)

### 9.2 Logging hygiene

- No raw passwords / API keys logged
- Bearer tokens redacted at log time (first 8 chars + `…`)
- Audit log is plain text but content is pre-sanitised (see §5.2)

### 9.3 Updates & patching

- Customer's responsibility to keep the Ask C4S version current
- We publish releases with changelog highlighting security fixes
- `npm audit` clean on every release (build process check)

---

## 10. Open gaps (prioritised)

| Gap | Severity | Effort | Status |
|---|---|---|---|
| SSO / OIDC instead of shared password | High | 1 week | Scaffolded via Azure AD connector |
| Hash-chained audit log | High | 3 days | Roadmap |
| Automated GDPR erasure | High | 1 week | Roadmap |
| Dependency vulnerability scanning | Medium | 1 day | npm audit + GitHub Dependabot |
| TLS cert pinning for SAP outbound | Medium | 2 days | Roadmap |
| Backups for SQLite | Medium | Customer's responsibility | Documented in ops guide |
| Tamper-resistant audit (external stream) | Medium | 1 week | Roadmap |
| Role-based access control in the admin page | Medium | — | Done (owner · admin · manager · agent) |
| Output schema validation | Low | 3 days | Roadmap |

---

## 11. Contacts

- **Security questions**: open an issue at the project repo, label `security`
- **Vulnerability disclosure**: email security@example.com — replace with the operator's own contact (TLS-only)
- **Customer DPAs**: contact sales

---

## 12. Document history

| Version | Date | Change |
|---|---|---|
| 0.1 (draft) | 2026-05-18 | Initial posture document |
