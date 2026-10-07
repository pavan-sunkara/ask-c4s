/**
 * External Knowledge Base API client.
 *
 * Designed for a MindTouch-based external KB (defaults to
 * https://kb.example.com — override via env / settings), accessed via Azure AD bearer tokens
 * (same SSO that protects C4C). The MindTouch REST endpoint is:
 *   GET /@api/deki/site/search?q=<query>
 *
 * Response shape is XML (MindTouch default):
 *   <search totalresults="...">
 *     <result>
 *       <id>...</id>
 *       <title>...</title>
 *       <uri>...</uri>
 *       <uri.track>...</uri.track>
 *       <preview>...</preview>     OR <snippet>...</snippet>
 *       <score>0.87</score>
 *       <date.modified>...</date.modified>
 *     </result>
 *     ...
 *   </search>
 *
 * We parse the XML with a small regex-based extractor — no XML library
 * dependency, robust enough for MindTouch's predictable output.
 *
 * Configuration is env-driven so the same code path works for sibling KBs
 * or other Azure-AD-protected MindTouch instances.
 */

import { getAzureAccessToken, isAzureConfigured, isAzureConfiguredAsync } from "../azure-ad/client.js";

// Lazy settings resolver (avoid import cycle)
let getSettingString: ((key: string) => string) | null = null;
async function getSettingsResolver(): Promise<(key: string) => string> {
  if (!getSettingString) {
    const mod = await import("../../settings.js");
    getSettingString = mod.getSettingString;
  }
  return getSettingString!;
}

export type KbSearchResult = {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  modifiedAt?: string;
  id?: string;
};

export type KbSearchResponse = {
  ok: boolean;
  configured: boolean;
  query: string;
  total: number | null;
  results: KbSearchResult[];
  /** Filled when ok=false; explains what to do next. */
  error?: string;
  /** Echo of which base URL + scope was actually used. Aids debugging. */
  used?: {
    baseUrl: string;
    searchPath: string;
    scope: string;
  };
};

function envOrDefault(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : fallback;
}

/**
 * Settings-first KB config. Falls back to env then to documented defaults.
 */
async function readKbConfigAsync() {
  const get = await getSettingsResolver();
  return {
    baseUrl: (
      get("kb.api_base_url").trim() ||
      envOrDefault("KB_API_BASE_URL", "https://kb.example.com")
    ).replace(/\/$/, ""),
    searchPath:
      get("kb.api_search_path").trim() ||
      envOrDefault("KB_API_SEARCH_PATH", "/@api/deki/site/search"),
    scope:
      get("kb.api_scope").trim() ||
      envOrDefault("KB_API_SCOPE", "https://kb.example.com/.default"),
  };
}

/** Sync env-only variant, kept for callers that don't await. */
function readKbConfig() {
  return {
    baseUrl: envOrDefault("KB_API_BASE_URL", "https://kb.example.com").replace(/\/$/, ""),
    searchPath: envOrDefault("KB_API_SEARCH_PATH", "/@api/deki/site/search"),
    scope: envOrDefault("KB_API_SCOPE", "https://kb.example.com/.default"),
  };
}

export function isKbApiConfigured(): boolean {
  return isAzureConfigured();
}

/** Public-safe diagnostic. Async so it can read settings-overridden values. */
export async function kbApiStatus() {
  const cfg = await readKbConfigAsync();
  return {
    configured: await isAzureConfiguredAsync(),
    baseUrl: cfg.baseUrl,
    searchPath: cfg.searchPath,
    scope: cfg.scope,
    azureConfigured: await isAzureConfiguredAsync(),
  };
}

// ---------------------------------------------------------------------------
// Tiny XML extractor — just enough to read MindTouch's search response.
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  return decodeXmlEntities(m[1].replace(/<[^>]+>/g, " ")).trim();
}

function pickAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const m = re.exec(xml);
  return m ? m[1] : "";
}

/**
 * Parse MindTouch's `<search>` XML response into a list of results.
 */
export function parseMindTouchSearchXml(xml: string, baseUrl: string): { total: number | null; results: KbSearchResult[] } {
  const totalStr = pickAttr(xml, "search", "totalresults") || pickAttr(xml, "search", "total");
  const total = totalStr ? Number(totalStr) : null;
  const results: KbSearchResult[] = [];
  const resultRe = /<result\b[^>]*>([\s\S]*?)<\/result>/g;
  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(xml)) !== null) {
    const block = m[1];
    const id = pickTag(block, "id");
    const title = pickTag(block, "title");
    const rawUri = pickTag(block, "uri") || pickTag(block, "uri.track");
    const snippet = pickTag(block, "preview") || pickTag(block, "snippet") || pickTag(block, "description");
    const scoreText = pickTag(block, "score");
    const modifiedAt = pickTag(block, "date.modified");
    const score = scoreText ? Number(scoreText) : undefined;
    if (!title && !rawUri) continue;

    let url = rawUri;
    if (url && !/^https?:\/\//i.test(url)) {
      url = baseUrl.replace(/\/$/, "") + (url.startsWith("/") ? url : `/${url}`);
    }

    results.push({
      title: title || "(no title)",
      url,
      snippet,
      score: Number.isFinite(score as number) ? (score as number) : undefined,
      modifiedAt: modifiedAt || undefined,
      id: id || undefined,
    });
  }
  return { total: Number.isFinite(total as number) ? total : null, results };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type KbSearchOptions = {
  query: string;
  top?: number;
};

/**
 * Perform a KB search. Returns `{ok: false, configured: false, ...}` with a
 * helpful error when Azure AD isn't set up yet — callers should fall back to
 * a link-out UX in that case.
 */
export async function searchKb({ query, top = 10 }: KbSearchOptions): Promise<KbSearchResponse> {
  const q = (query ?? "").trim();
  const cfg = await readKbConfigAsync();
  const azureReady = await isAzureConfiguredAsync();
  const limit = Math.min(Math.max(top, 1), 50);

  if (!q) {
    return {
      ok: false,
      configured: azureReady,
      query: q,
      total: null,
      results: [],
      error: "Query is empty.",
      used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
    };
  }

  if (!azureReady) {
    return {
      ok: false,
      configured: false,
      query: q,
      total: null,
      results: [],
      error:
        "KB API not configured. Set Azure AD tenant/client/secret in Admin → Settings (or AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in root .env), then restart if env-only. UI falls back to a search-link experience until then.",
      used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
    };
  }

  let token: string;
  try {
    token = await getAzureAccessToken(cfg.scope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      configured: true,
      query: q,
      total: null,
      results: [],
      error: `Azure AD token acquisition failed: ${message}`,
      used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
    };
  }

  const url = new URL(cfg.baseUrl + cfg.searchPath);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        Accept: "application/xml, text/xml;q=0.9, application/json;q=0.5",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      configured: true,
      query: q,
      total: null,
      results: [],
      error: `KB request failed before response: ${message}`,
      used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
    };
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      configured: true,
      query: q,
      total: null,
      results: [],
      error: `KB returned HTTP ${resp.status}: ${bodyText.slice(0, 400)}`,
      used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
    };
  }

  // MindTouch returns XML by default. Some endpoints can return JSON if
  // asked; we accept both.
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const data = JSON.parse(bodyText);
      const arr = Array.isArray(data?.search?.result)
        ? data.search.result
        : Array.isArray(data?.results)
          ? data.results
          : [];
      const results: KbSearchResult[] = arr.map((r: any) => ({
        title: String(r.title ?? r.name ?? "(no title)"),
        url: String(r.uri ?? r.url ?? ""),
        snippet: String(r.preview ?? r.snippet ?? r.description ?? ""),
        score: r.score != null ? Number(r.score) : undefined,
        modifiedAt: r["date.modified"] ?? r.modifiedAt,
        id: r.id ? String(r.id) : undefined,
      })).slice(0, limit);
      return {
        ok: true,
        configured: true,
        query: q,
        total: typeof data?.search?.["@totalresults"] === "string" ? Number(data.search["@totalresults"]) : null,
        results,
        used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        configured: true,
        query: q,
        total: null,
        results: [],
        error: `KB JSON parse failed: ${message}`,
        used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
      };
    }
  }

  const parsed = parseMindTouchSearchXml(bodyText, cfg.baseUrl);
  return {
    ok: true,
    configured: true,
    query: q,
    total: parsed.total,
    results: parsed.results.slice(0, limit),
    used: { baseUrl: cfg.baseUrl, searchPath: cfg.searchPath, scope: cfg.scope },
  };
}
