/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Azure AD / Entra ID authentication helper.
 *
 * Uses the OAuth 2.0 client-credentials flow ("service principal" / "app
 * registration with a secret") to acquire bearer tokens for downstream APIs.
 * Tokens are cached in-memory until ~60s before expiry.
 *
 * Required env vars (all in the root .env, gitignored):
 *   AZURE_TENANT_ID      — your Entra tenant GUID (or the verified domain)
 *   AZURE_CLIENT_ID      — the app-registration client/application ID
 *   AZURE_CLIENT_SECRET  — a client secret (NEVER commit; rotate in Entra)
 *
 * Optional:
 *   AZURE_AUTHORITY      — default https://login.microsoftonline.com
 *
 * Why we DON'T use MSAL Node here:
 *   Client-credentials is a 1-call POST. MSAL adds ~2MB of deps + a multi-cloud
 *   abstraction we don't need. If/when we add user-delegated auth (on-behalf-of)
 *   or interactive sign-in, swap this for MSAL Node.
 */

type CachedToken = {
  token: string;
  expiresAt: number; // unix ms
};

const tokenCache = new Map<string, CachedToken>();

export type AzureAdConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  authority: string;
};

export type AzureAdConfigStatus = {
  configured: boolean;
  tenantId: string | null;
  clientId: string | null;
  authority: string | null;
  /** True when secret is set (we never expose the value itself). */
  hasSecret: boolean;
};

/**
 * Settings take precedence over env. Settings are read lazily to avoid an
 * import cycle (settings.ts uses parseValue which doesn't pull this module).
 * We import the resolver dynamically once at first call.
 */
let getSettingString: ((key: string) => string) | null = null;
async function getSettingsResolver(): Promise<(key: string) => string> {
  if (!getSettingString) {
    // Dynamic import to break the cycle: settings.ts → secureConfig.ts → ok
    const mod = await import("../../settings.js");
    getSettingString = mod.getSettingString;
  }
  return getSettingString!;
}

function readConfigFromEnv(): AzureAdConfig | null {
  const tenantId = process.env.AZURE_TENANT_ID?.trim();
  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  const clientSecret = process.env.AZURE_CLIENT_SECRET?.trim();
  const authority = (process.env.AZURE_AUTHORITY?.trim() || "https://login.microsoftonline.com").replace(/\/$/, "");
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, authority };
}

/**
 * Read the active Azure AD config. Settings (encrypted) take priority over
 * env vars. Falls back to env when individual settings keys are unset so
 * partial configuration (e.g. admin set the secret but not the tenant)
 * still works alongside env-bootstrapped values.
 */
async function readConfigAsync(): Promise<AzureAdConfig | null> {
  const get = await getSettingsResolver();
  const tenantId =
    get("auth.azure_tenant_id").trim() || process.env.AZURE_TENANT_ID?.trim() || "";
  const clientId =
    get("auth.azure_client_id").trim() || process.env.AZURE_CLIENT_ID?.trim() || "";
  const clientSecret =
    get("auth.azure_client_secret").trim() || process.env.AZURE_CLIENT_SECRET?.trim() || "";
  const authority = (
    get("auth.azure_authority").trim() ||
    process.env.AZURE_AUTHORITY?.trim() ||
    "https://login.microsoftonline.com"
  ).replace(/\/$/, "");
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, authority };
}

function readConfig(): AzureAdConfig | null {
  // Synchronous version for status checks. Uses env-only because the settings
  // resolver is async; the live token-acquisition path uses readConfigAsync.
  return readConfigFromEnv();
}

/**
 * Synchronous (env-only) configured check — good enough for "should we
 * call the API at all" gating. The runtime token acquisition uses the
 * settings-aware async variant.
 */
export function isAzureConfigured(): boolean {
  if (readConfigFromEnv() !== null) return true;
  // Settings might have a value too — but the sync path can't peek without
  // a dynamic import. The async variant below is authoritative.
  return false;
}

/** Settings-aware check. Used by /api/tools/get_kb_api_status. */
export async function isAzureConfiguredAsync(): Promise<boolean> {
  return (await readConfigAsync()) !== null;
}

/** Public-safe status snapshot — for admin UI. Never includes the secret. */
export async function azureConfigStatus(): Promise<AzureAdConfigStatus> {
  const cfg = await readConfigAsync();
  const get = await getSettingsResolver();
  return {
    configured: cfg !== null,
    tenantId: cfg?.tenantId ?? get("auth.azure_tenant_id").trim() ?? process.env.AZURE_TENANT_ID?.trim() ?? null,
    clientId: cfg?.clientId ?? get("auth.azure_client_id").trim() ?? process.env.AZURE_CLIENT_ID?.trim() ?? null,
    authority:
      cfg?.authority ??
      (get("auth.azure_authority").trim() ||
        process.env.AZURE_AUTHORITY?.trim() ||
        "https://login.microsoftonline.com"
      ).replace(/\/$/, ""),
    hasSecret: Boolean(cfg?.clientSecret),
  };
}

/**
 * Acquire an access token for the given scope. Cached in-memory.
 *
 * @param scope The resource scope. For Azure-AD-protected SaaS apps this is
 *              typically `<app-id-uri>/.default` (e.g. for MindTouch behind
 *              Entra: `api://<kb-app-id>/.default`).
 *
 * Throws when Azure AD is not configured, or when the token endpoint rejects.
 */
export async function getAzureAccessToken(scope: string): Promise<string> {
  const cfg = await readConfigAsync();
  if (!cfg) {
    throw new Error(
      "Azure AD is not configured. Set tenant/client/secret in Admin → Settings, or AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in root .env.",
    );
  }
  const cacheKey = `${cfg.tenantId}|${cfg.clientId}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const tokenUrl = `${cfg.authority}/${cfg.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope,
    grant_type: "client_credentials",
  });

  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Azure AD token endpoint unreachable: ${message}`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    // Redact obvious secrets from the error before propagating
    const redacted = text
      .replace(/(client[_-]?secret[=:"\s]+)([^"&,\s}]+)/gi, "$1[REDACTED]")
      .slice(0, 600);
    throw new Error(`Azure AD token request failed (HTTP ${resp.status}): ${redacted}`);
  }

  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    throw new Error(
      `Azure AD error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`,
    );
  }
  if (!data.access_token) {
    throw new Error("Azure AD response missing access_token");
  }
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return data.access_token;
}

/** Drop cached tokens — e.g. after rotating the secret. */
export function clearAzureTokenCache() {
  tokenCache.clear();
}
