/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import Database from "better-sqlite3";
import { resolve, dirname, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTenantId } from "./c4cClient.js";

// Data dir resolution (in priority order):
//   1. DATA_DIR env var  — explicit, used in containers (e.g. /app/data
//      mounted as a Coolify persistent volume). Absolute or relative.
//   2. <projectRoot>/data — original behaviour for local dev.
//
// Either way we mkdir before opening the DB.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envDataDir = process.env.DATA_DIR?.trim();
const cacheDir = envDataDir
  ? (isAbsolute(envDataDir) ? envDataDir : resolve(projectRoot, envDataDir))
  : resolve(projectRoot, "data");
mkdirSync(cacheDir, { recursive: true });
const dbPath = resolve(cacheDir, "companion-cache.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

/**
 * The shared SQLite handle, for a module that owns its own table (users.ts).
 * Everything that is tenant-scoped cache data should keep going through the
 * exported helpers below instead.
 */
export function getCacheDb(): Database.Database {
  return db;
}

// ---------------------------------------------------------------------------
// Schema — every cache row is keyed by (tenant_id, ...) for multi-tenant safety
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    tenant_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    ticket_id TEXT,
    title TEXT,
    customer TEXT,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, object_id)
  );
  CREATE TABLE IF NOT EXISTS history (
    tenant_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, object_id)
  );
  CREATE TABLE IF NOT EXISTS recent (
    tenant_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    ticket_id TEXT,
    title TEXT,
    customer TEXT,
    last_viewed_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, object_id)
  );
  CREATE INDEX IF NOT EXISTS idx_recent_last_viewed ON recent(tenant_id, last_viewed_at DESC);

  CREATE TABLE IF NOT EXISTS code_lists (
    tenant_id   TEXT NOT NULL,
    list_name   TEXT NOT NULL,
    items       TEXT NOT NULL,
    source_url  TEXT,
    fetched_at  INTEGER NOT NULL,
    ttl_ms      INTEGER NOT NULL,
    row_count   INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, list_name)
  );

  CREATE TABLE IF NOT EXISTS settings (
    tenant_id   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    value_type  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, key)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    TEXT NOT NULL,
    actor        TEXT,
    action       TEXT NOT NULL,
    target_table TEXT,
    target_key   TEXT,
    details      TEXT,
    at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_tenant_at ON audit_log(tenant_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(tenant_id, action);

  /*
   * ai_usage — one row per /api/chat call. Powers the "AI Spend" admin
   * tab. Cost is computed from a per-model price table on insert so
   * historical rows stay accurate even if the price table changes.
   */
  CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            INTEGER NOT NULL,
    tenant_id     TEXT NOT NULL,
    actor         TEXT,
    module        TEXT,
    provider      TEXT,
    model         TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    success       INTEGER NOT NULL DEFAULT 1,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_at ON ai_usage(tenant_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_actor      ON ai_usage(tenant_id, actor);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_module     ON ai_usage(tenant_id, module);

  /*
   * ticket_embeddings — dense vectors keyed by (tenant_id, object_id).
   *
   * Vector stored as JSON-encoded float array (sqlite-vec extension would
   * be faster at >10k rows, but parsing JSON + cosine in Node is plenty
   * for the typical 1-5k-cached-tickets scale).
   *
   * Cleared when the underlying ticket is re-fetched + content changes,
   * so embeddings stay in sync with the cached ticket text.
   */
  CREATE TABLE IF NOT EXISTS ticket_embeddings (
    tenant_id    TEXT NOT NULL,
    object_id    TEXT NOT NULL,
    text_hash    TEXT NOT NULL,            -- sha1 of the embedded text; lets us detect drift
    text_preview TEXT NOT NULL,            -- first ~200 chars, for search-result rendering
    vector       TEXT NOT NULL,            -- JSON array of floats
    model        TEXT NOT NULL,            -- e.g. text-embedding-3-small
    dim          INTEGER NOT NULL,         -- dimensions, e.g. 1536
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, object_id)
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_tenant ON ticket_embeddings(tenant_id);

  /*
   * error_log — in-process error capture (Sentry-lite).
   * Populated by /api/errors (client-side errors) + server-side uncaught
   * paths. Tenant-scoped so multi-tenant deployments don't cross-leak.
   * Indexed by recency for the admin "Errors" tab tail view.
   */
  CREATE TABLE IF NOT EXISTS error_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    tenant_id   TEXT NOT NULL,
    source      TEXT NOT NULL,            -- "client" | "server" | "background-task" | …
    severity    TEXT NOT NULL DEFAULT 'error',  -- "info" | "warn" | "error" | "fatal"
    actor       TEXT,
    page        TEXT,                     -- URL path where it happened (client errors)
    message     TEXT NOT NULL,
    stack       TEXT,
    context     TEXT,                     -- JSON blob of additional fields
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_errors_tenant_at ON error_log(tenant_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_errors_severity ON error_log(tenant_id, severity);
`);

// ---------------------------------------------------------------------------
// One-time migration: existing DBs from before tenant support had a single-column
// PK on object_id / list_name. Rebuild each table with the composite (tenant_id, …) PK,
// stamping pre-existing rows with the current tenant.
// ---------------------------------------------------------------------------
type MigrationSpec = {
  name: string;
  schemaCreate: string;   // creates the *_new table with the correct composite PK
  copyColumns: string;    // column list (including tenant_id) used to INSERT … SELECT
  extraIndexes?: string[]; // re-create indexes after rename
};

const MIGRATIONS: MigrationSpec[] = [
  {
    name: "tickets",
    schemaCreate: `CREATE TABLE tickets_new (
      tenant_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      ticket_id TEXT,
      title TEXT,
      customer TEXT,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, object_id)
    )`,
    copyColumns: "tenant_id, object_id, ticket_id, title, customer, payload, fetched_at",
  },
  {
    name: "history",
    schemaCreate: `CREATE TABLE history_new (
      tenant_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, object_id)
    )`,
    copyColumns: "tenant_id, object_id, payload, fetched_at",
  },
  {
    name: "recent",
    schemaCreate: `CREATE TABLE recent_new (
      tenant_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      ticket_id TEXT,
      title TEXT,
      customer TEXT,
      last_viewed_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, object_id)
    )`,
    copyColumns: "tenant_id, object_id, ticket_id, title, customer, last_viewed_at",
    extraIndexes: [
      "CREATE INDEX IF NOT EXISTS idx_recent_last_viewed ON recent(tenant_id, last_viewed_at DESC)",
    ],
  },
  {
    name: "code_lists",
    schemaCreate: `CREATE TABLE code_lists_new (
      tenant_id   TEXT NOT NULL,
      list_name   TEXT NOT NULL,
      items       TEXT NOT NULL,
      source_url  TEXT,
      fetched_at  INTEGER NOT NULL,
      ttl_ms      INTEGER NOT NULL,
      row_count   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, list_name)
    )`,
    copyColumns: "tenant_id, list_name, items, source_url, fetched_at, ttl_ms, row_count",
  },
];

function migrateAddTenantId() {
  const currentTenant = getTenantId();

  for (const spec of MIGRATIONS) {
    // Check current PK composition
    const pkInfo = db
      .prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`)
      .all(spec.name) as Array<{ name: string }>;
    const hasCompositePk = pkInfo.length > 1 && pkInfo[0]?.name === "tenant_id";
    if (hasCompositePk) continue; // already migrated

    const cols = db.prepare(`PRAGMA table_info(${spec.name})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // table doesn't exist yet — CREATE TABLE IF NOT EXISTS above will handle it
    const hasTenantCol = cols.some((c) => c.name === "tenant_id");

    const txn = db.transaction(() => {
      if (!hasTenantCol) {
        db.prepare(`ALTER TABLE ${spec.name} ADD COLUMN tenant_id TEXT`).run();
      }
      const stamped = db
        .prepare(`UPDATE ${spec.name} SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ''`)
        .run(currentTenant);

      db.prepare(spec.schemaCreate).run();
      db.prepare(`INSERT INTO ${spec.name}_new (${spec.copyColumns}) SELECT ${spec.copyColumns} FROM ${spec.name}`).run();
      db.prepare(`DROP TABLE ${spec.name}`).run();
      db.prepare(`ALTER TABLE ${spec.name}_new RENAME TO ${spec.name}`).run();
      for (const idx of spec.extraIndexes ?? []) db.prepare(idx).run();

      console.log(`[cache] migrated ${spec.name} to composite (tenant_id, …) PK; stamped ${stamped.changes} pre-existing rows with tenant_id='${currentTenant}'`);
    });
    txn();
  }
}
migrateAddTenantId();

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Prepared statements — all scoped by tenant_id
// ---------------------------------------------------------------------------

const getTicketStmt = db.prepare(
  `SELECT payload, fetched_at FROM tickets WHERE tenant_id = ? AND object_id = ?`,
);
const upsertTicketStmt = db.prepare(
  `INSERT INTO tickets (tenant_id, object_id, ticket_id, title, customer, payload, fetched_at)
   VALUES (@tenant_id, @object_id, @ticket_id, @title, @customer, @payload, @fetched_at)
   ON CONFLICT(tenant_id, object_id) DO UPDATE SET
     ticket_id = excluded.ticket_id,
     title = excluded.title,
     customer = excluded.customer,
     payload = excluded.payload,
     fetched_at = excluded.fetched_at`,
);

const getHistoryStmt = db.prepare(
  `SELECT payload, fetched_at FROM history WHERE tenant_id = ? AND object_id = ?`,
);
const upsertHistoryStmt = db.prepare(
  `INSERT INTO history (tenant_id, object_id, payload, fetched_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(tenant_id, object_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
);

const touchRecentStmt = db.prepare(
  `INSERT INTO recent (tenant_id, object_id, ticket_id, title, customer, last_viewed_at)
   VALUES (@tenant_id, @object_id, @ticket_id, @title, @customer, @last_viewed_at)
   ON CONFLICT(tenant_id, object_id) DO UPDATE SET
     ticket_id = excluded.ticket_id,
     title = excluded.title,
     customer = excluded.customer,
     last_viewed_at = excluded.last_viewed_at`,
);

const listRecentStmt = db.prepare(
  `SELECT object_id as objectId, ticket_id as ticketId, title, customer, last_viewed_at as lastViewedAt
   FROM recent WHERE tenant_id = ? ORDER BY last_viewed_at DESC LIMIT ?`,
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CacheEntry<T> = {
  fresh: boolean;
  age: number;
  payload: T;
};

export function readTicketCache(objectId: string, ttlMs = DEFAULT_TTL_MS): CacheEntry<unknown> | null {
  const row = getTicketStmt.get(getTenantId(), objectId) as { payload: string; fetched_at: number } | undefined;
  if (!row) return null;
  const age = Date.now() - row.fetched_at;
  return { fresh: age < ttlMs, age, payload: JSON.parse(row.payload) };
}

export function writeTicketCache(opts: {
  objectId: string;
  ticketId: string | null;
  title: string | null;
  customer: string | null;
  payload: unknown;
}) {
  upsertTicketStmt.run({
    tenant_id: getTenantId(),
    object_id: opts.objectId,
    ticket_id: opts.ticketId,
    title: opts.title,
    customer: opts.customer,
    payload: JSON.stringify(opts.payload),
    fetched_at: Date.now(),
  });
}

export function readHistoryCache(objectId: string, ttlMs = DEFAULT_TTL_MS): CacheEntry<unknown> | null {
  const row = getHistoryStmt.get(getTenantId(), objectId) as { payload: string; fetched_at: number } | undefined;
  if (!row) return null;
  const age = Date.now() - row.fetched_at;
  return { fresh: age < ttlMs, age, payload: JSON.parse(row.payload) };
}

export function writeHistoryCache(objectId: string, payload: unknown) {
  upsertHistoryStmt.run(getTenantId(), objectId, JSON.stringify(payload), Date.now());
}

export function touchRecent(opts: {
  objectId: string;
  ticketId: string | null;
  title: string | null;
  customer: string | null;
}) {
  touchRecentStmt.run({
    tenant_id: getTenantId(),
    object_id: opts.objectId,
    ticket_id: opts.ticketId,
    title: opts.title,
    customer: opts.customer,
    last_viewed_at: Date.now(),
  });
}

export type RecentRow = {
  objectId: string;
  ticketId: string | null;
  title: string | null;
  customer: string | null;
  lastViewedAt: number;
};

export function listRecent(limit = 25): RecentRow[] {
  return listRecentStmt.all(getTenantId(), limit) as RecentRow[];
}

export function cachePathInfo() {
  return { dbPath };
}

// ---------------------------------------------------------------------------
// Code lists (slow-changing reference data — Tier 1 caches)
// ---------------------------------------------------------------------------

export type CodeListItem = { code: string; description: string };

const getCodeListStmt = db.prepare(
  `SELECT items, source_url as sourceUrl, fetched_at as fetchedAt, ttl_ms as ttlMs, row_count as rowCount
   FROM code_lists WHERE tenant_id = ? AND list_name = ?`,
);
const upsertCodeListStmt = db.prepare(
  `INSERT INTO code_lists (tenant_id, list_name, items, source_url, fetched_at, ttl_ms, row_count)
   VALUES (@tenant_id, @list_name, @items, @source_url, @fetched_at, @ttl_ms, @row_count)
   ON CONFLICT(tenant_id, list_name) DO UPDATE SET
     items = excluded.items,
     source_url = excluded.source_url,
     fetched_at = excluded.fetched_at,
     ttl_ms = excluded.ttl_ms,
     row_count = excluded.row_count`,
);
const listCodeListsStmt = db.prepare(
  `SELECT list_name as listName, row_count as rowCount, source_url as sourceUrl,
          fetched_at as fetchedAt, ttl_ms as ttlMs
   FROM code_lists WHERE tenant_id = ? ORDER BY list_name`,
);
const deleteCodeListStmt = db.prepare(`DELETE FROM code_lists WHERE tenant_id = ? AND list_name = ?`);

export type CachedCodeList = {
  listName: string;
  items: CodeListItem[];
  sourceUrl: string | null;
  fetchedAt: number;
  ttlMs: number;
  rowCount: number;
  age: number;
  fresh: boolean;
};

export function readCodeList(listName: string): CachedCodeList | null {
  const row = getCodeListStmt.get(getTenantId(), listName) as
    | { items: string; sourceUrl: string | null; fetchedAt: number; ttlMs: number; rowCount: number }
    | undefined;
  if (!row) return null;
  const age = Date.now() - row.fetchedAt;
  return {
    listName,
    items: JSON.parse(row.items) as CodeListItem[],
    sourceUrl: row.sourceUrl,
    fetchedAt: row.fetchedAt,
    ttlMs: row.ttlMs,
    rowCount: row.rowCount,
    age,
    fresh: age < row.ttlMs,
  };
}

export function writeCodeList(opts: {
  listName: string;
  items: CodeListItem[];
  sourceUrl: string | null;
  ttlMs: number;
}) {
  upsertCodeListStmt.run({
    tenant_id: getTenantId(),
    list_name: opts.listName,
    items: JSON.stringify(opts.items),
    source_url: opts.sourceUrl,
    fetched_at: Date.now(),
    ttl_ms: opts.ttlMs,
    row_count: opts.items.length,
  });
}

export function listCodeLists() {
  return listCodeListsStmt.all(getTenantId()) as Array<{
    listName: string;
    rowCount: number;
    sourceUrl: string | null;
    fetchedAt: number;
    ttlMs: number;
  }>;
}

export function deleteCodeList(listName: string) {
  deleteCodeListStmt.run(getTenantId(), listName);
}

// ---------------------------------------------------------------------------
// Settings — tenant-scoped runtime configuration
// ---------------------------------------------------------------------------

export type SettingValueType = "number" | "string" | "boolean" | "secret" | "url" | "enum";

const readSettingStmt = db.prepare(
  `SELECT value, value_type as valueType, updated_at as updatedAt
   FROM settings WHERE tenant_id = ? AND key = ?`,
);
const upsertSettingStmt = db.prepare(
  `INSERT INTO settings (tenant_id, key, value, value_type, updated_at)
   VALUES (@tenant_id, @key, @value, @value_type, @updated_at)
   ON CONFLICT(tenant_id, key) DO UPDATE SET
     value = excluded.value, value_type = excluded.value_type, updated_at = excluded.updated_at`,
);
const deleteSettingStmt = db.prepare(`DELETE FROM settings WHERE tenant_id = ? AND key = ?`);
const listSettingsStmt = db.prepare(
  `SELECT key, value, value_type as valueType, updated_at as updatedAt
   FROM settings WHERE tenant_id = ? ORDER BY key`,
);

export function readSettingRow(
  key: string,
): { value: string; valueType: SettingValueType; updatedAt: number } | null {
  return (readSettingStmt.get(getTenantId(), key) as
    | { value: string; valueType: SettingValueType; updatedAt: number }
    | undefined) ?? null;
}

export function writeSettingRow(opts: { key: string; value: string; valueType: SettingValueType }) {
  upsertSettingStmt.run({
    tenant_id: getTenantId(),
    key: opts.key,
    value: opts.value,
    value_type: opts.valueType,
    updated_at: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Session tokens (shim auth). Persisted so a restart / redeploy doesn't sign
// everyone out. NOT tenant-scoped — a session belongs to a person, not a
// tenant. The raw token is never stored; rows are keyed on its SHA-256, so a
// leaked DB can't be replayed as a live session.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash  TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL,
    source      TEXT NOT NULL,
    user_json   TEXT,
    user_id     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_exp  ON auth_tokens(expires_at);
`);

export type StoredToken = {
  expiresAt: number;
  source: string;
  user?: { email: string; name?: string; picture?: string };
  userId?: string;
};

const putTokenStmt = db.prepare(
  `INSERT OR REPLACE INTO auth_tokens (token_hash, expires_at, source, user_json, user_id)
   VALUES (@hash, @expiresAt, @source, @userJson, @userId)`,
);
export function putAuthToken(hash: string, rec: StoredToken): void {
  putTokenStmt.run({
    hash,
    expiresAt: rec.expiresAt,
    source: rec.source,
    userJson: rec.user ? JSON.stringify(rec.user) : null,
    userId: rec.userId ?? null,
  });
}

const getTokenStmt = db.prepare(
  `SELECT expires_at, source, user_json, user_id FROM auth_tokens WHERE token_hash = ?`,
);
export function getAuthToken(hash: string): StoredToken | null {
  const row = getTokenStmt.get(hash) as
    | { expires_at: number; source: string; user_json: string | null; user_id: string | null }
    | undefined;
  if (!row) return null;
  let user: StoredToken["user"];
  if (row.user_json) {
    try {
      user = JSON.parse(row.user_json);
    } catch {
      user = undefined;
    }
  }
  return { expiresAt: row.expires_at, source: row.source, user, userId: row.user_id ?? undefined };
}

const deleteTokenStmt = db.prepare(`DELETE FROM auth_tokens WHERE token_hash = ?`);
export function deleteAuthToken(hash: string): void {
  deleteTokenStmt.run(hash);
}

const deleteTokensByUserStmt = db.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`);
const deleteTokensByUserExceptStmt = db.prepare(
  `DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?`,
);
export function deleteAuthTokensForUser(userId: string, exceptHash?: string): void {
  if (exceptHash) deleteTokensByUserExceptStmt.run(userId, exceptHash);
  else deleteTokensByUserStmt.run(userId);
}

const deleteAnonTokensStmt = db.prepare(`DELETE FROM auth_tokens WHERE user_id IS NULL`);
export function deleteAnonymousAuthTokens(): void {
  deleteAnonTokensStmt.run();
}

const sweepTokensStmt = db.prepare(`DELETE FROM auth_tokens WHERE expires_at < ?`);
export function sweepExpiredAuthTokens(now = Date.now()): void {
  sweepTokensStmt.run(now);
}

export function deleteSettingRow(key: string) {
  deleteSettingStmt.run(getTenantId(), key);
}

export function listSettingRows() {
  return listSettingsStmt.all(getTenantId()) as Array<{
    key: string;
    value: string;
    valueType: SettingValueType;
    updatedAt: number;
  }>;
}

// ---------------------------------------------------------------------------
// Audit log — every admin mutation gets a row here
// ---------------------------------------------------------------------------

export type AuditEntry = {
  tenantId: string;
  actor: string | null;
  action: string;
  targetTable?: string | null;
  targetKey?: string | null;
  details?: Record<string, unknown> | null;
};

const insertAuditStmt = db.prepare(
  `INSERT INTO audit_log (tenant_id, actor, action, target_table, target_key, details, at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export function writeAudit(entry: AuditEntry) {
  insertAuditStmt.run(
    entry.tenantId,
    entry.actor,
    entry.action,
    entry.targetTable ?? null,
    entry.targetKey ?? null,
    entry.details ? JSON.stringify(entry.details) : null,
    Date.now(),
  );
}

export type AuditRow = {
  id: number;
  tenantId: string;
  actor: string | null;
  action: string;
  targetTable: string | null;
  targetKey: string | null;
  details: Record<string, unknown> | null;
  at: number;
};

export function listAudit(
  tenantId: string,
  opts: { limit?: number; offset?: number; action?: string; targetTable?: string; q?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  let where = "tenant_id = ?";
  const args: any[] = [tenantId];
  if (opts.action) {
    where += " AND action = ?";
    args.push(opts.action);
  }
  if (opts.targetTable) {
    where += " AND target_table = ?";
    args.push(opts.targetTable);
  }
  if (opts.q) {
    where += " AND (actor LIKE ? OR target_key LIKE ? OR details LIKE ?)";
    args.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  }
  const totalRow = db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE ${where}`).get(...args) as { n: number };
  const rows = db
    .prepare(
      `SELECT id, tenant_id as tenantId, actor, action, target_table as targetTable,
              target_key as targetKey, details, at
       FROM audit_log WHERE ${where} ORDER BY at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as Array<Omit<AuditRow, "details"> & { details: string | null }>;
  return {
    rows: rows.map((r) => ({
      ...r,
      details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    })),
    total: totalRow.n,
  };
}

export function listAuditActions(tenantId: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? ORDER BY action`)
    .all(tenantId) as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------------------
// Admin helpers — tenant-scoped DB introspection
// ---------------------------------------------------------------------------

export type CachedTable = "tickets" | "history" | "recent" | "code_lists" | "settings";
export const CACHED_TABLES: CachedTable[] = ["tickets", "history", "recent", "code_lists", "settings"];

const TABLE_COLUMNS: Record<CachedTable, string[]> = {
  tickets: ["tenant_id", "object_id", "ticket_id", "title", "customer", "fetched_at"],
  history: ["tenant_id", "object_id", "fetched_at"],
  recent: ["tenant_id", "object_id", "ticket_id", "title", "customer", "last_viewed_at"],
  code_lists: ["tenant_id", "list_name", "row_count", "source_url", "fetched_at", "ttl_ms"],
  settings: ["tenant_id", "key", "value", "value_type", "updated_at"],
};

const PK_COLUMNS: Record<CachedTable, string> = {
  tickets: "object_id",
  history: "object_id",
  recent: "object_id",
  code_lists: "list_name",
  settings: "key",
};

const PAYLOAD_COLS: Record<CachedTable, string | null> = {
  tickets: "payload",
  history: "payload",
  recent: null,
  code_lists: "items",
  settings: "value",
};

const ORDER_COLS: Record<CachedTable, string> = {
  tickets: "fetched_at",
  history: "fetched_at",
  recent: "last_viewed_at",
  code_lists: "fetched_at",
  settings: "updated_at",
};

export function adminListTables(tenantId: string) {
  return CACHED_TABLES.map((name) => {
    const countRow = db
      .prepare(`SELECT COUNT(*) as n FROM ${name} WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    const totalRow = db.prepare(`SELECT COUNT(*) as n FROM ${name}`).get() as { n: number };
    const payloadCol = PAYLOAD_COLS[name];
    const bytesRow = payloadCol
      ? (db
          .prepare(`SELECT COALESCE(SUM(LENGTH(${payloadCol})),0) as b FROM ${name} WHERE tenant_id = ?`)
          .get(tenantId) as { b: number } | undefined)
      : undefined;
    return {
      name,
      tenantRows: countRow.n,
      totalRows: totalRow.n,
      payloadBytes: bytesRow?.b ?? 0,
      columns: TABLE_COLUMNS[name],
      primaryKey: PK_COLUMNS[name],
    };
  });
}

export function adminListTableRows(
  tableName: CachedTable,
  tenantId: string,
  opts: { limit?: number; offset?: number; q?: string } = {},
) {
  const cols = TABLE_COLUMNS[tableName];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? "").trim();
  const filterCols = cols.filter((c) => !["fetched_at", "ttl_ms", "row_count", "last_viewed_at"].includes(c));
  let where = "tenant_id = ?";
  const args: any[] = [tenantId];
  if (q) {
    const ors = filterCols.map((c) => `${c} LIKE ?`).join(" OR ");
    where += ` AND (${ors})`;
    for (let i = 0; i < filterCols.length; i++) args.push(`%${q}%`);
  }
  const orderCol = ORDER_COLS[tableName];
  const totalRow = db.prepare(`SELECT COUNT(*) as n FROM ${tableName} WHERE ${where}`).get(...args) as { n: number };
  const rows = db
    .prepare(
      `SELECT ${cols.join(", ")} FROM ${tableName} WHERE ${where} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);
  return { rows, total: totalRow.n, columns: cols, primaryKey: PK_COLUMNS[tableName] };
}

export function adminGetRow(tableName: CachedTable, tenantId: string, key: string) {
  const pk = PK_COLUMNS[tableName];
  return db.prepare(`SELECT * FROM ${tableName} WHERE tenant_id = ? AND ${pk} = ?`).get(tenantId, key);
}

export function adminDeleteRow(tableName: CachedTable, tenantId: string, key: string) {
  const pk = PK_COLUMNS[tableName];
  return db.prepare(`DELETE FROM ${tableName} WHERE tenant_id = ? AND ${pk} = ?`).run(tenantId, key).changes;
}

export function adminTruncateTable(tableName: CachedTable, tenantId: string) {
  return db.prepare(`DELETE FROM ${tableName} WHERE tenant_id = ?`).run(tenantId).changes;
}

export function adminTenantList() {
  const rows: string[] = [];
  for (const t of CACHED_TABLES) {
    const r = db.prepare(`SELECT DISTINCT tenant_id FROM ${t}`).all() as Array<{ tenant_id: string }>;
    for (const x of r) if (x.tenant_id) rows.push(x.tenant_id);
  }
  return Array.from(new Set(rows)).sort();
}

export function adminDbStats() {
  const fileSize = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as
    | { size: number }
    | undefined;
  return {
    dbPath,
    fileSize: fileSize?.size ?? 0,
    walMode: String(db.pragma("journal_mode", { simple: true })),
    tables: CACHED_TABLES,
    tenants: adminTenantList(),
  };
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// ai_usage — per-call AI provider spend tracking
// ---------------------------------------------------------------------------

/**
 * Per-1K-token USD prices for the AI providers we instrument. Used at
 * insert time so historical rows stay accurate even if prices change.
 * If a model isn't listed, cost is logged as 0 (we still record tokens).
 *
 * Note these are the publicly published list prices as of 2025. Update
 * when Anthropic/OpenAI/etc revise theirs.
 */
const MODEL_PRICES_USD_PER_K_TOKEN: Record<string, { in: number; out: number }> = {
  // Anthropic Claude family
  "claude-opus-4-1": { in: 0.015, out: 0.075 },
  "claude-sonnet-4-5": { in: 0.003, out: 0.015 },
  "claude-haiku-4-5": { in: 0.0008, out: 0.004 },
  // OpenAI (for when the OpenAI provider lands)
  "gpt-4o": { in: 0.0025, out: 0.01 },
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  // Azure OpenAI mirrors OpenAI pricing
};

function estimateCostUsd(model: string, inTok: number, outTok: number): number {
  const p = MODEL_PRICES_USD_PER_K_TOKEN[model];
  if (!p) return 0;
  return (inTok / 1000) * p.in + (outTok / 1000) * p.out;
}

export type AiUsageEntry = {
  tenantId: string;
  actor?: string | null;
  module?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  success?: boolean;
  error?: string | null;
};

export function logAiUsage(entry: AiUsageEntry) {
  const inTok = entry.inputTokens ?? 0;
  const outTok = entry.outputTokens ?? 0;
  const model = entry.model ?? "";
  const cost = estimateCostUsd(model, inTok, outTok);
  db.prepare(
    `INSERT INTO ai_usage
      (at, tenant_id, actor, module, provider, model,
       input_tokens, output_tokens, cost_usd, success, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    entry.tenantId,
    entry.actor ?? null,
    entry.module ?? null,
    entry.provider ?? null,
    model || null,
    inTok,
    outTok,
    cost,
    entry.success === false ? 0 : 1,
    entry.error ?? null,
  );
}

export type AiUsageWindow = "day" | "week" | "month" | "all";

function windowStart(window: AiUsageWindow): number {
  if (window === "all") return 0;
  const now = Date.now();
  const day = 86_400_000;
  return now - (window === "day" ? day : window === "week" ? 7 * day : 30 * day);
}

export function aiUsageSummary(tenantId: string, window: AiUsageWindow = "month") {
  const since = windowStart(window);
  const overall = db
    .prepare(
      `SELECT COUNT(*) as calls,
              SUM(input_tokens)  as in_tokens,
              SUM(output_tokens) as out_tokens,
              SUM(cost_usd)      as cost_usd,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
         FROM ai_usage
        WHERE tenant_id = ? AND at >= ?`,
    )
    .get(tenantId, since) as
    | {
        calls: number;
        in_tokens: number | null;
        out_tokens: number | null;
        cost_usd: number | null;
        failures: number;
      }
    | undefined;
  const byModel = db
    .prepare(
      `SELECT model,
              COUNT(*) as calls,
              SUM(input_tokens) as in_tokens,
              SUM(output_tokens) as out_tokens,
              SUM(cost_usd) as cost_usd
         FROM ai_usage
        WHERE tenant_id = ? AND at >= ? AND model IS NOT NULL
        GROUP BY model
        ORDER BY cost_usd DESC`,
    )
    .all(tenantId, since) as any[];
  const byActor = db
    .prepare(
      `SELECT COALESCE(actor, '(unknown)') as actor,
              COUNT(*) as calls,
              SUM(input_tokens + output_tokens) as tokens,
              SUM(cost_usd) as cost_usd
         FROM ai_usage
        WHERE tenant_id = ? AND at >= ?
        GROUP BY actor
        ORDER BY cost_usd DESC
        LIMIT 25`,
    )
    .all(tenantId, since) as any[];
  const byModule = db
    .prepare(
      `SELECT COALESCE(module, '(unset)') as module,
              COUNT(*) as calls,
              SUM(input_tokens + output_tokens) as tokens,
              SUM(cost_usd) as cost_usd
         FROM ai_usage
        WHERE tenant_id = ? AND at >= ?
        GROUP BY module
        ORDER BY cost_usd DESC`,
    )
    .all(tenantId, since) as any[];
  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch') as day,
              COUNT(*) as calls,
              SUM(input_tokens + output_tokens) as tokens,
              SUM(cost_usd) as cost_usd
         FROM ai_usage
        WHERE tenant_id = ? AND at >= ?
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(tenantId, since) as any[];

  return {
    window,
    since,
    overall: {
      calls: overall?.calls ?? 0,
      inputTokens: overall?.in_tokens ?? 0,
      outputTokens: overall?.out_tokens ?? 0,
      totalTokens: (overall?.in_tokens ?? 0) + (overall?.out_tokens ?? 0),
      costUsd: overall?.cost_usd ?? 0,
      failures: overall?.failures ?? 0,
    },
    byModel,
    byActor,
    byModule,
    byDay,
  };
}

export type AiUsageRow = {
  id: number;
  at: number;
  actor: string | null;
  module: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  success: boolean;
  error: string | null;
};

// ---------------------------------------------------------------------------
// error_log — in-process error capture (admin "Errors" tab)
// ---------------------------------------------------------------------------

export type ErrorEntry = {
  tenantId: string;
  source: string;
  severity?: "info" | "warn" | "error" | "fatal";
  actor?: string | null;
  page?: string | null;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  userAgent?: string | null;
};

export function logError(entry: ErrorEntry) {
  try {
    db.prepare(
      `INSERT INTO error_log
        (at, tenant_id, source, severity, actor, page, message, stack, context, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      entry.tenantId,
      entry.source,
      entry.severity ?? "error",
      entry.actor ?? null,
      entry.page ?? null,
      entry.message.slice(0, 2000),
      entry.stack ? entry.stack.slice(0, 5000) : null,
      entry.context ? JSON.stringify(entry.context).slice(0, 4000) : null,
      entry.userAgent ? entry.userAgent.slice(0, 500) : null,
    );
  } catch {
    /* never let logging break the caller */
  }
}

export type ErrorRow = {
  id: number;
  at: number;
  source: string;
  severity: string;
  actor: string | null;
  page: string | null;
  message: string;
  stack: string | null;
  context: string | null;
  userAgent: string | null;
};

export function listErrorLog(
  tenantId: string,
  opts: { severity?: string; source?: string; q?: string; limit?: number } = {},
): { total: number; rows: ErrorRow[] } {
  const params: any[] = [tenantId];
  const where: string[] = ["tenant_id = ?"];
  if (opts.severity) {
    where.push("severity = ?");
    params.push(opts.severity);
  }
  if (opts.source) {
    where.push("source = ?");
    params.push(opts.source);
  }
  if (opts.q && opts.q.trim()) {
    where.push("(message LIKE ? OR stack LIKE ? OR page LIKE ?)");
    const pat = `%${opts.q.trim()}%`;
    params.push(pat, pat, pat);
  }
  const whereSql = where.join(" AND ");
  const total =
    (db.prepare(`SELECT COUNT(*) as n FROM error_log WHERE ${whereSql}`).get(...params) as { n: number })?.n ??
    0;
  const rows = db
    .prepare(
      `SELECT id, at, source, severity, actor, page, message, stack, context, user_agent
         FROM error_log
        WHERE ${whereSql}
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(...params, opts.limit ?? 200) as any[];
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      at: r.at,
      source: r.source,
      severity: r.severity,
      actor: r.actor,
      page: r.page,
      message: r.message,
      stack: r.stack,
      context: r.context,
      userAgent: r.user_agent,
    })),
  };
}

export function errorLogSummary(tenantId: string, hoursAhead = 24) {
  const since = Date.now() - hoursAhead * 3_600_000;
  const bySeverity = db
    .prepare(
      `SELECT severity, COUNT(*) as n
         FROM error_log
        WHERE tenant_id = ? AND at >= ?
        GROUP BY severity`,
    )
    .all(tenantId, since) as Array<{ severity: string; n: number }>;
  const bySource = db
    .prepare(
      `SELECT source, COUNT(*) as n
         FROM error_log
        WHERE tenant_id = ? AND at >= ?
        GROUP BY source
        ORDER BY n DESC
        LIMIT 10`,
    )
    .all(tenantId, since) as Array<{ source: string; n: number }>;
  return { since, hoursAhead, bySeverity, bySource };
}

// ---------------------------------------------------------------------------
// ticket_embeddings — semantic search over cached tickets
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export type StoreEmbeddingOpts = {
  tenantId: string;
  objectId: string;
  text: string;
  vector: number[];
  model: string;
};

/** Stable hash so we know when the underlying text drifted from what we embedded. */
export function embedTextHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function storeTicketEmbedding(opts: StoreEmbeddingOpts) {
  const hash = embedTextHash(opts.text);
  db.prepare(
    `INSERT OR REPLACE INTO ticket_embeddings
      (tenant_id, object_id, text_hash, text_preview, vector, model, dim, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.tenantId,
    opts.objectId,
    hash,
    opts.text.slice(0, 200),
    JSON.stringify(opts.vector),
    opts.model,
    opts.vector.length,
    Date.now(),
  );
}

/** Returns true if the cached embedding hash matches the current text — skip re-embed. */
export function hasFreshEmbedding(tenantId: string, objectId: string, text: string): boolean {
  const row = db
    .prepare(`SELECT text_hash FROM ticket_embeddings WHERE tenant_id = ? AND object_id = ?`)
    .get(tenantId, objectId) as { text_hash: string } | undefined;
  if (!row) return false;
  return row.text_hash === embedTextHash(text);
}

/** Pull every embedding for a tenant — fine up to ~10k rows. */
export function loadTenantEmbeddings(tenantId: string): Array<{
  objectId: string;
  vector: number[];
  textPreview: string;
}> {
  const rows = db
    .prepare(
      `SELECT object_id, vector, text_preview
         FROM ticket_embeddings
        WHERE tenant_id = ?`,
    )
    .all(tenantId) as Array<{ object_id: string; vector: string; text_preview: string }>;
  return rows.map((r) => ({
    objectId: r.object_id,
    vector: JSON.parse(r.vector) as number[],
    textPreview: r.text_preview,
  }));
}

export function countTenantEmbeddings(tenantId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM ticket_embeddings WHERE tenant_id = ?`)
    .get(tenantId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Cosine similarity between two equal-length number vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}

export function aiUsageRecent(tenantId: string, limit = 50): AiUsageRow[] {
  const rows = db
    .prepare(
      `SELECT id, at, actor, module, provider, model,
              input_tokens, output_tokens, cost_usd, success, error
         FROM ai_usage
        WHERE tenant_id = ?
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(tenantId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    module: r.module,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    success: r.success === 1,
    error: r.error,
  }));
}
