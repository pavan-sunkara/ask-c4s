/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Tenant-override store — JSON file on disk holding an alternate
 * C4C_BASE_URL / C4C_USER / C4C_PASSWORD set from the admin UI.
 *
 * Why a flat file (not the SQLite settings table):
 *   The settings table is tenant-scoped — every row keyed by getTenantId().
 *   Storing the tenant override inside it creates a chicken-and-egg: switching
 *   tenants would change which override row is read. The flat file lives
 *   above the tenant abstraction and is the single source of truth.
 *
 * Password encryption:
 *   AES-256-GCM with a key from $ADMIN_ENCRYPTION_KEY (hex or passphrase) or
 *   a per-install random key auto-generated at data/.tenant-key (mode 0600).
 *   The threat model is "don't store cleartext on disk / in screenshots / in
 *   logs". Anyone with shell access to the server is already privileged.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const KEY_PATH =
  process.env.ADMIN_TENANT_KEY_PATH ?? join(projectRoot, "data", ".tenant-key");
/** Legacy single-tenant override path. Read-only — auto-migrates to catalog on first read. */
const LEGACY_STORE_PATH =
  process.env.ADMIN_TENANT_STORE_PATH ??
  join(projectRoot, "data", "tenant-override.json");
/** New multi-tenant catalog path. */
const CATALOG_PATH =
  process.env.ADMIN_TENANT_CATALOG_PATH ??
  join(projectRoot, "data", "tenant-catalog.json");

let cachedKey: Buffer | undefined;

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.ADMIN_ENCRYPTION_KEY?.trim();
  if (envKey) {
    // 64 hex chars = 32 bytes — used directly. Anything else is scrypt-derived.
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      cachedKey = Buffer.from(envKey, "hex");
    } else {
      cachedKey = scryptSync(envKey, "askc4s-admin-v1", 32);
    }
    return cachedKey;
  }

  if (existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
    return cachedKey;
  }

  mkdirSync(dirname(KEY_PATH), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    /* Windows may not honour POSIX modes — best-effort */
  }
  cachedKey = key;
  return key;
}

/**
 * AES-256-GCM encrypt with the install-local key. Returns
 * "<iv-b64>:<tag-b64>:<ciphertext-b64>". Decryptable by `decrypt()` below
 * as long as the key file stays put.
 */
export function encrypt(plain: string): string {
  const key = getOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Inverse of `encrypt()`. Throws on tamper / wrong key. */
export function decrypt(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 3) throw new Error("Tenant-override ciphertext malformed.");
  const key = getOrCreateKey();
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ct = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

// ---------------------------------------------------------------------------
// TENANT CATALOG
//
// One Ask C4S server can hold a catalog of N SAP C4C tenants
// (e.g. Sandbox / Dev / QA / Val / Prod) with one marked "active" at a
// time. Per-tenant credentials live here, with the password AES-encrypted.
//
// File: data/tenant-catalog.json (mode 0600, auto-migrated from the legacy
// single-tenant override on first read).
// ---------------------------------------------------------------------------

export type TenantEnvironment =
  | "sandbox"
  | "dev"
  | "qa"
  | "val"
  | "uat"
  | "preprod"
  | "production"
  | "other";

export type TenantCatalogEntry = {
  /** Stable handle the UI + APIs use to refer to this tenant. Lowercase, slug-like. */
  id: string;
  /** Display name in the UI ("Sandbox", "QA Region EU", etc.). */
  label: string;
  /** Type tag — drives colour-coding and the production-write guardrail. */
  environment: TenantEnvironment;
  baseUrl: string;
  user: string;
  passwordEnc: string;
  /** ISO timestamp when added. */
  addedAt: number;
  /** Audit attribution. */
  addedBy: string | null;
  /** Free-text notes admins can put on each tenant. */
  notes?: string;
};

export type TenantCatalog = {
  /** ID of the entry that's currently "active" for this server. */
  activeId: string | null;
  tenants: TenantCatalogEntry[];
};

const EMPTY_CATALOG: TenantCatalog = { activeId: null, tenants: [] };

function readCatalogRaw(): TenantCatalog {
  if (existsSync(CATALOG_PATH)) {
    try {
      const raw = readFileSync(CATALOG_PATH, "utf8");
      const parsed = JSON.parse(raw) as TenantCatalog;
      if (parsed && Array.isArray(parsed.tenants)) return parsed;
    } catch {
      /* fall through to migration */
    }
  }
  // Auto-migrate from legacy single-override format
  if (existsSync(LEGACY_STORE_PATH)) {
    try {
      const raw = readFileSync(LEGACY_STORE_PATH, "utf8");
      const legacy = JSON.parse(raw) as {
        baseUrl?: string;
        user?: string;
        passwordEnc?: string;
        setAt?: number;
        setBy?: string | null;
      };
      if (legacy?.baseUrl && legacy?.user && legacy?.passwordEnc) {
        const migrated: TenantCatalog = {
          activeId: "migrated",
          tenants: [
            {
              id: "migrated",
              label: deriveLabelFromUrl(legacy.baseUrl),
              environment: guessEnvironmentFromUrl(legacy.baseUrl),
              baseUrl: legacy.baseUrl,
              user: legacy.user,
              passwordEnc: legacy.passwordEnc,
              addedAt: legacy.setAt ?? Date.now(),
              addedBy: legacy.setBy ?? "migration",
              notes: "Migrated from single-tenant override format.",
            },
          ],
        };
        writeCatalogRaw(migrated);
        try {
          unlinkSync(LEGACY_STORE_PATH);
        } catch {
          /* leave legacy file in place if delete fails */
        }
        return migrated;
      }
    } catch {
      /* ignore */
    }
  }
  return { ...EMPTY_CATALOG };
}

function writeCatalogRaw(cat: TenantCatalog): void {
  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, JSON.stringify(cat, null, 2), { mode: 0o600 });
  try {
    chmodSync(CATALOG_PATH, 0o600);
  } catch {
    /* best-effort on Windows */
  }
}

function deriveLabelFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const sub = host.split(".")[0];
    return sub || host;
  } catch {
    return "tenant";
  }
}

function guessEnvironmentFromUrl(url: string): TenantEnvironment {
  const lower = url.toLowerCase();
  if (lower.includes("sandbox") || lower.includes("sbx")) return "sandbox";
  if (lower.includes("dev")) return "dev";
  if (lower.includes("qa") || lower.includes("test")) return "qa";
  if (lower.includes("val") || lower.includes("uat")) return "val";
  if (lower.includes("preprod") || lower.includes("staging") || lower.includes("stg"))
    return "preprod";
  if (lower.includes("prod")) return "production";
  return "other";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function listTenants(): TenantCatalog {
  return readCatalogRaw();
}

export function getActiveTenant(): TenantCatalogEntry | null {
  const cat = readCatalogRaw();
  if (!cat.activeId) return null;
  return cat.tenants.find((t) => t.id === cat.activeId) ?? null;
}

export function setActiveTenant(id: string): TenantCatalogEntry {
  const cat = readCatalogRaw();
  const entry = cat.tenants.find((t) => t.id === id);
  if (!entry) throw new Error(`No tenant in catalog with id '${id}'.`);
  cat.activeId = id;
  writeCatalogRaw(cat);
  return entry;
}

export type UpsertTenantInput = {
  /** Existing id to update, or omit to create a new entry. */
  id?: string;
  label: string;
  environment: TenantEnvironment;
  baseUrl: string;
  user: string;
  /** Plaintext password — encrypted at write time. Leave empty when updating to keep existing. */
  password?: string;
  notes?: string;
  setBy: string | null;
};

export function upsertTenant(opts: UpsertTenantInput): TenantCatalogEntry {
  const cat = readCatalogRaw();
  const trimmedLabel = opts.label.trim();
  const trimmedUrl = opts.baseUrl.trim();
  const trimmedUser = opts.user.trim();
  if (!trimmedLabel) throw new Error("label is required.");
  if (!trimmedUrl) throw new Error("baseUrl is required.");
  if (!trimmedUser) throw new Error("user is required.");
  try {
    new URL(trimmedUrl); // validate
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${trimmedUrl}`);
  }

  const isUpdate = Boolean(opts.id);
  let id = opts.id ?? slugify(trimmedLabel) ?? "tenant";
  if (!isUpdate) {
    // Ensure unique id on create
    if (!id) id = "tenant";
    let n = 2;
    const existingIds = new Set(cat.tenants.map((t) => t.id));
    let candidate = id;
    while (existingIds.has(candidate)) {
      candidate = `${id}-${n++}`;
    }
    id = candidate;
  }

  const existing = cat.tenants.find((t) => t.id === id);
  if (isUpdate && !existing) {
    throw new Error(`No tenant in catalog with id '${id}'.`);
  }

  let passwordEnc: string;
  if (opts.password && opts.password.length > 0) {
    passwordEnc = encrypt(opts.password);
  } else if (existing) {
    passwordEnc = existing.passwordEnc;
  } else {
    throw new Error("password is required when creating a new tenant.");
  }

  const entry: TenantCatalogEntry = {
    id,
    label: trimmedLabel,
    environment: opts.environment,
    baseUrl: trimmedUrl,
    user: trimmedUser,
    passwordEnc,
    addedAt: existing?.addedAt ?? Date.now(),
    addedBy: existing?.addedBy ?? opts.setBy,
    notes: opts.notes ?? existing?.notes,
  };

  if (existing) {
    cat.tenants = cat.tenants.map((t) => (t.id === id ? entry : t));
  } else {
    cat.tenants.push(entry);
    // First-ever entry becomes the active one automatically.
    if (!cat.activeId) cat.activeId = id;
  }
  writeCatalogRaw(cat);
  return entry;
}

export function deleteTenant(id: string): boolean {
  const cat = readCatalogRaw();
  const before = cat.tenants.length;
  cat.tenants = cat.tenants.filter((t) => t.id !== id);
  if (cat.tenants.length === before) return false;
  if (cat.activeId === id) {
    cat.activeId = cat.tenants[0]?.id ?? null;
  }
  writeCatalogRaw(cat);
  return true;
}

/** Wipe the whole catalog — falls back to env-based config until tenants are re-added. */
export function clearTenantCatalog(): boolean {
  if (!existsSync(CATALOG_PATH)) return false;
  try {
    unlinkSync(CATALOG_PATH);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// C4C config resolution — used by c4cClient
// ---------------------------------------------------------------------------

export type ResolvedC4cConfig = {
  baseUrl: string;
  user: string;
  password: string;
  source: "catalog" | "env";
  /** When source=catalog, the active entry's metadata. */
  tenantId?: string;
  tenantLabel?: string;
  environment?: TenantEnvironment;
};

/**
 * Resolve the live C4C connection. Active catalog entry first, env fallback.
 */
export function resolvedC4cConfig(): ResolvedC4cConfig | null {
  const active = getActiveTenant();
  if (active) {
    try {
      return {
        baseUrl: active.baseUrl,
        user: active.user,
        password: decrypt(active.passwordEnc),
        source: "catalog",
        tenantId: active.id,
        tenantLabel: active.label,
        environment: active.environment,
      };
    } catch {
      // Decryption failed (e.g. key rotated). Fall through to env so the
      // server doesn't brick itself.
    }
  }
  const baseUrl = process.env.C4C_BASE_URL;
  const user = process.env.C4C_USER;
  const password = process.env.C4C_PASSWORD;
  if (!baseUrl || !user || !password) return null;
  return { baseUrl, user, password, source: "env" };
}

/** Public-safe summary — never includes any decrypted password. */
export type TenantCatalogSummary = {
  source: "catalog" | "env" | "missing";
  activeId: string | null;
  tenants: Array<{
    id: string;
    label: string;
    environment: TenantEnvironment;
    baseUrl: string;
    user: string;
    addedAt: number;
    addedBy: string | null;
    notes?: string;
    isActive: boolean;
  }>;
  env: {
    baseUrl: string | null;
    user: string | null;
    hasPassword: boolean;
  };
};

export function tenantCatalogSummary(): TenantCatalogSummary {
  const cat = readCatalogRaw();
  const envBase = process.env.C4C_BASE_URL ?? null;
  const envUser = process.env.C4C_USER ?? null;
  const hasEnvPw = Boolean(process.env.C4C_PASSWORD);
  const source: TenantCatalogSummary["source"] =
    cat.activeId && cat.tenants.find((t) => t.id === cat.activeId)
      ? "catalog"
      : envBase && envUser && hasEnvPw
        ? "env"
        : "missing";
  return {
    source,
    activeId: cat.activeId,
    tenants: cat.tenants.map((t) => ({
      id: t.id,
      label: t.label,
      environment: t.environment,
      baseUrl: t.baseUrl,
      user: t.user,
      addedAt: t.addedAt,
      addedBy: t.addedBy,
      notes: t.notes,
      isActive: t.id === cat.activeId,
    })),
    env: {
      baseUrl: envBase,
      user: envUser,
      hasPassword: hasEnvPw,
    },
  };
}
