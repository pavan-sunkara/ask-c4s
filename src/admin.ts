import { writeAudit, type AuditEntry } from "./cache.js";
import { ASKC4S_USER_AGENT, getTenantHost, getTenantId, invalidateC4cConfig } from "./c4cClient.js";
import { getCurrentSetting, listSettings, resetSetting, setSetting } from "./settings.js";
import {
  decrypt,
  deleteTenant as deleteCatalogTenant,
  listTenants,
  setActiveTenant,
  tenantCatalogSummary,
  upsertTenant,
  type TenantEnvironment,
} from "./secureConfig.js";

export function isAdminEnabled() {
  return String(process.env.ADMIN_ENABLED ?? "").trim().toLowerCase() === "true";
}

function audit(entry: Omit<AuditEntry, "tenantId"> & { tenantId?: string }) {
  writeAudit({
    tenantId: entry.tenantId ?? getTenantId(),
    actor: entry.actor ?? null,
    action: entry.action,
    targetTable: entry.targetTable,
    targetKey: entry.targetKey,
    details: entry.details,
  });
}

export type AdminContext = {
  actor: string | null;
};

/**
 * The admin API: settings and the SAP tenant catalog (users live in
 * usersRoutes.ts). Every call here has already passed the auth funnel and the
 * role check; what remains is validation, the change itself and an audit row.
 */
export type AdminApi = {
  listSettings: (ctx: AdminContext) => Promise<unknown>;
  getSetting: (ctx: AdminContext, key: string) => Promise<unknown>;
  setSetting: (ctx: AdminContext, key: string, value: unknown) => Promise<unknown>;
  resetSetting: (ctx: AdminContext, key: string) => Promise<unknown>;
  /** Probe typed-in credentials before they are saved. */
  testTenantConfig: (
    ctx: AdminContext,
    opts: { baseUrl: string; user: string; password: string },
  ) => Promise<unknown>;
  /** Probe a SAVED tenant with its stored (decrypted) password — the Tenants tab's per-row "Test". */
  testCatalogTenant: (ctx: AdminContext, id: string) => Promise<unknown>;
  listTenantCatalog: (ctx: AdminContext) => Promise<unknown>;
  upsertCatalogTenant: (
    ctx: AdminContext,
    opts: {
      id?: string;
      label: string;
      environment: TenantEnvironment;
      baseUrl: string;
      user: string;
      password?: string;
      notes?: string;
    },
  ) => Promise<unknown>;
  activateCatalogTenant: (ctx: AdminContext, id: string) => Promise<unknown>;
  deleteCatalogTenant: (ctx: AdminContext, id: string) => Promise<unknown>;
};

type ProbeResult = {
  ok: boolean;
  /** HTTP status from SAP, or null when no response came back at all. */
  status: number | null;
  durationMs: number;
  tenantHost: string | null;
  rowCount?: number | null;
  error?: string;
};

/**
 * One GET against the tenant's OData root with the given credentials. Sends the
 * same headers as the real client (User-Agent included — some SAP gateways
 * answer 503 to an unknown UA), so a passing test predicts working lookups.
 */
async function probeC4c(baseUrl: string, user: string, password: string): Promise<ProbeResult> {
  const probeUrl =
    baseUrl.replace(/\/$/, "") + "/ServiceRequestCollection?$top=1&$format=json&$select=ObjectID";
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  let tenantHost: string | null = null;
  try {
    tenantHost = new URL(baseUrl).hostname;
  } catch {
    tenantHost = null;
  }
  const start = Date.now();
  try {
    const resp = await fetch(probeUrl, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": ASKC4S_USER_AGENT,
        Authorization: auth,
      },
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, status: resp.status, durationMs: Date.now() - start, tenantHost, error: text.slice(0, 500) };
    }
    let rowCount: number | null = null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.d?.results)) rowCount = parsed.d.results.length;
    } catch {
      /* not JSON — fine, we already confirmed 200 */
    }
    return { ok: true, status: resp.status, durationMs: Date.now() - start, tenantHost, rowCount };
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - start,
      tenantHost,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateTenantOpts(opts: { baseUrl: string; user: string; password: string }) {
  const baseUrl = opts.baseUrl?.trim();
  const user = opts.user?.trim();
  const password = opts.password;
  if (!baseUrl) throw new Error("baseUrl is required.");
  if (!user) throw new Error("user is required.");
  if (!password) throw new Error("password is required.");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("baseUrl must start with http:// or https://");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  return { baseUrl, user, password };
}

export const adminApi: AdminApi = {
  async listSettings(_ctx) {
    return listSettings();
  },
  async getSetting(_ctx, key) {
    return { tenant: getTenantId(), setting: getCurrentSetting(key) };
  },
  async setSetting(ctx, key, value) {
    const before = getCurrentSetting(key);
    const setting = setSetting(key, value);
    audit({
      actor: ctx.actor,
      action: "set_setting",
      targetTable: "settings",
      targetKey: key,
      details: { oldValue: before.value, newValue: setting.value, wasOverride: before.isOverride },
    });
    return { tenant: getTenantId(), setting };
  },
  async resetSetting(ctx, key) {
    const before = getCurrentSetting(key);
    const setting = resetSetting(key);
    audit({
      actor: ctx.actor,
      action: "reset_setting",
      targetTable: "settings",
      targetKey: key,
      details: { oldValue: before.value, defaultValue: setting.value },
    });
    return { tenant: getTenantId(), setting };
  },
  async testTenantConfig(_ctx, opts) {
    const { baseUrl, user, password } = validateTenantOpts(opts);
    return probeC4c(baseUrl, user, password);
  },
  async testCatalogTenant(ctx, id) {
    const key = id?.trim();
    const entry = key ? listTenants().tenants.find((t) => t.id === key) : undefined;
    if (!entry) {
      return { ok: false, notFound: true, error: `No tenant in catalog with id '${id}'.` };
    }
    let password: string;
    try {
      password = decrypt(entry.passwordEnc);
    } catch {
      return {
        ok: false,
        error:
          "The stored password can't be decrypted (was the encryption key replaced?). " +
          "Edit the tenant and enter the password again.",
      };
    }
    const result = await probeC4c(entry.baseUrl, entry.user, password);
    audit({
      actor: ctx.actor,
      action: "test_tenant_catalog",
      targetTable: "tenant_catalog",
      targetKey: entry.id,
      details: { ok: result.ok, status: result.status, label: entry.label, environment: entry.environment },
    });
    return { ...result, tenant: { id: entry.id, label: entry.label, environment: entry.environment } };
  },
  async listTenantCatalog(_ctx) {
    return {
      activeTenant: getTenantId(),
      activeHost: getTenantHost(),
      ...tenantCatalogSummary(),
    };
  },
  async upsertCatalogTenant(ctx, opts) {
    const baseUrl = opts.baseUrl?.trim();
    const user = opts.user?.trim();
    const label = opts.label?.trim();
    if (!label) throw new Error("label is required.");
    if (!baseUrl) throw new Error("baseUrl is required.");
    if (!user) throw new Error("user is required.");
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error("baseUrl must start with http:// or https://");
    }
    if (!opts.id && !opts.password) {
      throw new Error("password is required when adding a new tenant.");
    }
    const entry = upsertTenant({
      id: opts.id,
      label,
      environment: opts.environment,
      baseUrl,
      user,
      password: opts.password,
      notes: opts.notes,
      setBy: ctx.actor,
    });
    invalidateC4cConfig();
    audit({
      actor: ctx.actor,
      action: opts.id ? "update_tenant_catalog" : "add_tenant_catalog",
      targetTable: "tenant_catalog",
      targetKey: entry.id,
      details: {
        label: entry.label,
        environment: entry.environment,
        baseUrl: entry.baseUrl,
        user: entry.user,
        passwordRotated: Boolean(opts.password),
        // password content never logged
      },
    });
    return {
      ok: true,
      tenant: {
        id: entry.id,
        label: entry.label,
        environment: entry.environment,
        baseUrl: entry.baseUrl,
        user: entry.user,
        addedAt: entry.addedAt,
        addedBy: entry.addedBy,
        notes: entry.notes,
      },
    };
  },
  async activateCatalogTenant(ctx, id) {
    if (!id?.trim()) throw new Error("id is required.");
    const before = { tenant: getTenantId(), host: getTenantHost() };
    const entry = setActiveTenant(id.trim());
    invalidateC4cConfig();
    const after = { tenant: getTenantId(), host: getTenantHost() };
    audit({
      actor: ctx.actor,
      action: "activate_tenant",
      targetTable: "tenant_catalog",
      targetKey: id,
      details: {
        from: before,
        to: after,
        environment: entry.environment,
        label: entry.label,
      },
    });
    return {
      ok: true,
      activeTenant: after.tenant,
      activeHost: after.host,
      environment: entry.environment,
      label: entry.label,
    };
  },
  async deleteCatalogTenant(ctx, id) {
    if (!id?.trim()) throw new Error("id is required.");
    const before = { tenant: getTenantId(), host: getTenantHost() };
    const removed = deleteCatalogTenant(id.trim());
    invalidateC4cConfig();
    const after = { tenant: getTenantId(), host: getTenantHost() };
    audit({
      actor: ctx.actor,
      action: "remove_tenant_catalog",
      targetTable: "tenant_catalog",
      targetKey: id,
      details: { removed, from: before, to: after },
    });
    return { ok: removed, activeTenant: after.tenant, activeHost: after.host };
  },
};
