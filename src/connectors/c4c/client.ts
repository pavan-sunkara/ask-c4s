import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvedC4cConfig } from "../../secureConfig.js";

// File is at src/connectors/c4c/client.ts (3 levels deep) — walk up to project root.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = resolve(projectRoot, ".env");
// ASKC4S_NO_DOTENV=1 skips reading .env altogether. Off by default (nothing
// changes). scripts/smoke-users.mjs sets it so its throwaway server can't pick
// up real SAP credentials: dotenv leaves an already-set variable alone, but the
// pass below treats a blank one as unset and would refill it.
const skipDotenv = process.env.ASKC4S_NO_DOTENV === "1";
if (!skipDotenv) loadEnv({ path: envPath });

if (!skipDotenv && existsSync(envPath)) {
  const envFile = readFileSync(envPath, "utf8");

  for (const line of envFile.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);

    if (!match || match[1].startsWith("#") || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

type C4cConfig = {
  baseUrl: string;
  user: string;
  password: string;
  source: "catalog" | "env";
  tenantId?: string;
  tenantLabel?: string;
  environment?: string;
};

type ODataQueryValue = string | number | boolean | undefined;

export type ODataQuery = Record<string, ODataQueryValue>;

let cachedConfig: C4cConfig | undefined;

function getConfig(): C4cConfig {
  if (!cachedConfig) {
    const resolved = resolvedC4cConfig();
    if (!resolved) {
      throw new Error(
        "Missing C4C config: add the tenant in /settings → Tenants, or set C4C_BASE_URL / C4C_USER / C4C_PASSWORD in .env.",
      );
    }
    cachedConfig = {
      baseUrl: resolved.baseUrl.replace(/\/$/, ""),
      user: resolved.user,
      password: resolved.password,
      source: resolved.source,
      tenantId: resolved.tenantId,
      tenantLabel: resolved.tenantLabel,
      environment: resolved.environment,
    };
  }
  return cachedConfig;
}

/**
 * Drop the cached config so the next request re-resolves it from
 * secureConfig (file override) or env. Call this after the admin UI
 * writes a new tenant override.
 */
export function invalidateC4cConfig() {
  cachedConfig = undefined;
}

/** Where the active config came from — for admin display. */
export function getC4cConfigSource(): "catalog" | "env" | "missing" {
  try {
    return getConfig().source;
  } catch {
    return "missing";
  }
}

/** Active tenant's environment tag (sandbox/dev/qa/val/uat/preprod/production/other) — for UI badges + write guards. */
export function getActiveTenantEnvironment(): string | null {
  try {
    return getConfig().environment ?? null;
  } catch {
    return null;
  }
}

/** Active tenant's catalog id ("sandbox", "dev", "prod", ...) when source=catalog. */
export function getActiveTenantCatalogId(): string | null {
  try {
    return getConfig().tenantId ?? null;
  } catch {
    return null;
  }
}

/** Active tenant's human label ("Sandbox", "Production EU", ...). */
export function getActiveTenantLabel(): string | null {
  try {
    return getConfig().tenantLabel ?? null;
  } catch {
    return null;
  }
}

function getConfigIfAvailable() {
  try {
    return getConfig();
  } catch {
    return undefined;
  }
}

function authHeader(config: C4cConfig) {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
}

function buildUrl(path: string, query?: ODataQuery) {
  const { baseUrl } = getConfig();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

function redactSensitiveDetails(text: string) {
  const config = getConfigIfAvailable();
  let redacted = text
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/password["'=:\s]+[^"',\s<>&]+/gi, "password=[redacted]");

  for (const secret of [config?.password, config?.user]) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }

  return redacted.slice(0, 3000);
}

/*
 * Some SAP C4C gateways apply User-Agent filtering on the OData layer —
 * a missing or non-browser UA gets a 503 "Currently not available"
 * response even when the tenant is up (the Web UI on the same host
 * keeps working). We send a normal-looking UA so the gateway treats us
 * like a browser; combined with Basic Auth from .env this is enough.
 *
 * Don't lie about being Chrome (some SAP versions probe for browser-
 * specific behaviour); a product token + Mozilla compat has worked across
 * the tenants we've tested, and the token's own name has never mattered.
 */
export const ASKC4S_USER_AGENT =
  "Mozilla/5.0 (compatible; AskC4S/0.27)";

async function c4cRequest(path: string, accept: string, query?: ODataQuery) {
  const config = getConfig();
  const url = buildUrl(path, query);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": ASKC4S_USER_AGENT,
        Authorization: authHeader(config),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAP C4C request failed before a response was received: ${message}`);
  }

  if (!response.ok) {
    const rawBody = await response.text();
    const details = redactSensitiveDetails(rawBody);

    // Temporary diagnostic — log enough to tell whether SAP is genuinely
    // down vs rejecting our auth vs rejecting our network. Strip when
    // the 503-from-shim issue is resolved.
    const wwwAuth = response.headers.get("www-authenticate") ?? "(none)";
    const server = response.headers.get("server") ?? "(none)";
    const xCorrId = response.headers.get("x-correlationid") ?? "(none)";
    const sapMessage = response.headers.get("sap-message") ?? "(none)";
    console.log(
      `[c4c-diag] ${response.status} ${response.statusText} | url=${url} | server=${server} | www-authenticate=${wwwAuth} | x-correlationid=${xCorrId} | sap-message=${sapMessage} | body-first-200=${details.slice(0, 200)}`,
    );

    // SAP returns a full HTML maintenance page (with title "Currently not
    // available") when the tenant is down. Dumping the raw HTML into the UI
    // is unreadable. Detect this case and surface a clean message.
    const looksLikeMaintenance =
      response.status === 503 ||
      /Currently not available|<html[\s>]/i.test(rawBody);
    if (looksLikeMaintenance) {
      const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(rawBody);
      const reason = titleMatch ? titleMatch[1].trim() : "tenant maintenance or downtime";
      throw new Error(
        `SAP tenant unavailable (HTTP ${response.status}). ${reason}. ` +
          `Try again in a few minutes, or click a recent ticket — cached results still load.`,
      );
    }

    // Other non-OK responses — keep the redacted body, but trim it so the
    // UI's red banner stays readable.
    const trimmed = details.length > 280 ? details.slice(0, 280) + "…" : details;
    throw new Error(`SAP C4C request failed with HTTP ${response.status}: ${trimmed}`);
  }

  return response;
}

export function odataStringLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function isSafeODataPath(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
}

export async function c4cGet<T = unknown>(path: string, query?: ODataQuery) {
  const response = await c4cRequest(path, "application/json", query);
  return response.json();
}

function tenantHostBase() {
  const { baseUrl } = getConfig();
  // Strip "/v1/c4codataapi" (or any service suffix) — keep host + /sap/c4c/odata
  return baseUrl.replace(/\/v1\/[^/]+\/?$/, "").replace(/\/$/, "");
}

/**
 * Stable tenant identifier derived from the configured C4C base URL.
 * For "https://mytenant.crm.ondemand.com/..." returns "mytenant".
 * Falls back to the full hostname when the subdomain pattern doesn't match.
 */
export function getTenantId(): string {
  try {
    const { baseUrl } = getConfig();
    const url = new URL(baseUrl);
    const host = url.hostname;
    const subdomain = host.split(".")[0];
    return subdomain || host;
  } catch {
    return "unknown";
  }
}

export function getTenantHost(): string {
  try {
    const { baseUrl } = getConfig();
    return new URL(baseUrl).hostname;
  } catch {
    return "unknown";
  }
}

export async function c4cGetCustom<T = unknown>(serviceName: string, path: string, query?: ODataQuery) {
  // Custom SDK OData services live at /sap/c4c/odata/cust/v1/<serviceName>/...
  const config = getConfig();
  const host = tenantHostBase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${host}/cust/v1/${serviceName}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: authHeader(config) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAP custom service 'cust/v1/${serviceName}' request failed: ${message}`);
  }
  if (!response.ok) {
    const details = redactSensitiveDetails(await response.text());
    throw new Error(`SAP custom service 'cust/v1/${serviceName}' returned HTTP ${response.status}: ${details}`);
  }
  return response.json();
}

export async function c4cGetService<T = unknown>(serviceName: string, path: string, query?: ODataQuery) {
  // serviceName like "cod_skill_wcf.svc" — sibling of the main c4codataapi service.
  const config = getConfig();
  const host = tenantHostBase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${host}/${serviceName}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: authHeader(config),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAP custom service '${serviceName}' request failed: ${message}`);
  }

  if (!response.ok) {
    const details = redactSensitiveDetails(await response.text());
    throw new Error(`SAP custom service '${serviceName}' returned HTTP ${response.status}: ${details}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Write support — CSRF token cache + POST helper
// ---------------------------------------------------------------------------
// SAP C4C OData v2 requires a CSRF dance for every state-changing call:
//   GET <any url> with header  X-CSRF-Token: Fetch
//     → response has         X-CSRF-Token: <token>   +  Set-Cookie: ...
//   POST/PATCH/DELETE  with   X-CSRF-Token: <token>  +  cookie jar
//
// Tokens are tenant-scoped and TTL'd by SAP (~30 min). We cache aggressively
// because the fetch round-trip is ~500-800ms.

type CsrfBundle = { token: string; cookie: string; fetchedAt: number };
let cachedCsrf: CsrfBundle | undefined;
const CSRF_TTL_MS = 25 * 60 * 1000; // 25 min — well under SAP's window

async function fetchCsrf(): Promise<CsrfBundle> {
  if (cachedCsrf && Date.now() - cachedCsrf.fetchedAt < CSRF_TTL_MS) {
    return cachedCsrf;
  }
  const config = getConfig();
  const url = buildUrl("/ServiceRequestCollection", { "$top": 1, "$format": "json" });
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: authHeader(config),
      "X-CSRF-Token": "Fetch",
    },
  });
  const token = resp.headers.get("x-csrf-token");
  const setCookie = resp.headers.get("set-cookie") ?? "";
  if (!token || token.toLowerCase() === "required") {
    throw new Error("SAP did not return a CSRF token (got: " + token + "). Check integration-user permissions for write operations.");
  }
  const cookie = setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  cachedCsrf = { token, cookie, fetchedAt: Date.now() };
  return cachedCsrf;
}

/** Invalidate the cached CSRF token — call on 403 with X-CSRF-Token: Required. */
export function invalidateCsrf() {
  cachedCsrf = undefined;
}

/**
 * Shared write driver: handles CSRF acquisition, the cookie jar, and the
 * "token expired → fetch fresh → retry once" cycle. Used by c4cPost,
 * c4cPatch, c4cDelete.
 *
 * Method "MERGE" is OData v2's partial-update verb (SAP C4C accepts both
 * MERGE and PATCH for updates; we use MERGE for maximum compatibility).
 */
async function c4cWriteWithMeta<T = unknown>(
  method: "POST" | "MERGE" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
): Promise<{ data: T; location: string | null; status: number }> {
  const config = getConfig();
  const csrf = await fetchCsrf();
  const url = buildUrl(path);
  const buildHeaders = (token: string, cookie: string): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: "application/json",
      Authorization: authHeader(config),
      "X-CSRF-Token": token,
    };
    if (method !== "DELETE") h["Content-Type"] = "application/json";
    if (method === "MERGE" || method === "PATCH") {
      // SAP C4C requires If-Match for entity updates; "*" means
      // "I don't care about the etag — just write".
      h["If-Match"] = "*";
    }
    if (cookie) h["Cookie"] = cookie;
    return h;
  };

  const requestBody = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: buildHeaders(csrf.token, csrf.cookie),
      body: requestBody,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAP C4C ${method} failed before a response was received: ${message}`);
  }

  // Token-expired retry path
  const tokenHint = response.headers.get("x-csrf-token");
  if (response.status === 403 && tokenHint && tokenHint.toLowerCase() === "required") {
    invalidateCsrf();
    const fresh = await fetchCsrf();
    response = await fetch(url, {
      method,
      headers: buildHeaders(fresh.token, fresh.cookie),
      body: requestBody,
    });
  }

  if (!response.ok) {
    const details = redactSensitiveDetails(await response.text());
    throw new Error(`SAP C4C ${method} ${path} returned HTTP ${response.status}: ${details}`);
  }

  // v0.27.74 — capture the Location header. On a successful OData create SAP
  // returns Location: <root>/ServiceRequestItemCollection('<ObjectID>') even
  // when the response BODY is empty/204 — it's the only reliable way to learn
  // the new entity's key in that case (the Book Time post-create Actual-date
  // PATCH needs it).
  const location = response.headers.get("location");
  const status = response.status;
  // 204 No Content (PATCH/DELETE, and POST on some entities) — null data, but
  // still surface the Location header + status to the caller.
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (status === 204 || !ct.includes("json")) {
    return { data: null as T, location, status };
  }
  return { data: (await response.json()) as T, location, status };
}

/** Shared write driver — see c4cWriteWithMeta. Returns just the parsed body. */
async function c4cWrite<T = unknown>(
  method: "POST" | "MERGE" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
): Promise<T> {
  return (await c4cWriteWithMeta<T>(method, path, body)).data;
}

export async function c4cPost<T = unknown>(path: string, body: unknown): Promise<T> {
  return c4cWrite<T>("POST", path, body);
}

/**
 * POST that also returns the Location header + HTTP status. Use when you need
 * the created entity's ObjectID and SAP replied with an empty/204 body (the
 * ObjectID is then only available from the Location header).
 */
export async function c4cPostWithMeta<T = unknown>(
  path: string,
  body: unknown,
): Promise<{ data: T; location: string | null; status: number }> {
  return c4cWriteWithMeta<T>("POST", path, body);
}

/** Partial update via OData v2 MERGE — only the fields in `body` get changed. */
export async function c4cPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  return c4cWrite<T>("MERGE", path, body);
}

export async function c4cDelete<T = unknown>(path: string): Promise<T> {
  return c4cWrite<T>("DELETE", path, undefined);
}

export async function c4cText(path: string, query?: ODataQuery) {
  const response = await c4cRequest(path, "application/xml,text/xml,text/plain", query);
  return response.text();
}

export function formatToolError(error: unknown) {
  if (error instanceof Error) {
    return redactSensitiveDetails(error.message);
  }

  return redactSensitiveDetails(String(error));
}
