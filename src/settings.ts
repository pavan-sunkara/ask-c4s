/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import {
  deleteSettingRow,
  listSettingRows,
  readSettingRow,
  writeSettingRow,
  type SettingValueType,
} from "./cache.js";
import { getTenantId } from "./c4cClient.js";
import { decrypt, encrypt } from "./secureConfig.js";

export type SettingCategory =
  | "cache"
  | "behavior"
  | "ai"
  | "limits"
  | "kb"
  | "auth"
  | "ui";

export type SettingSpec = {
  key: string;
  label: string;
  description: string;
  category: SettingCategory;
  type: SettingValueType;
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  unit?: string;
  /** For type=enum, the allowed values shown as a dropdown. */
  options?: readonly string[];
  /** For type=secret/url/string, a free-form placeholder. */
  placeholder?: string;
  /**
   * Optional env-var name. If the setting is unset locally, the resolver will
   * fall back to `process.env[envFallback]` (raw value, never the encrypted
   * one) before returning the registry default. Lets ops bootstrap via .env
   * then transition to admin-managed values.
   */
  envFallback?: string;
};

// ---------------------------------------------------------------------------
// Registry — single source of truth for editable runtime settings.
// Adding a setting here makes it editable from the admin Settings tab.
// ---------------------------------------------------------------------------
export const SETTINGS_REGISTRY: SettingSpec[] = [
  // ----- Cache TTLs -----
  {
    key: "cache.ticket_ttl_ms",
    label: "Ticket cache TTL",
    description: "How long to trust cached get_ticket payloads before re-fetching from SAP.",
    category: "cache",
    type: "number",
    defaultValue: 5 * 60 * 1000,
    min: 0,
    max: 24 * 60 * 60 * 1000,
    unit: "ms",
  },
  {
    key: "cache.history_ttl_ms",
    label: "Service history cache TTL",
    description: "TTL for cached get_service_history results.",
    category: "cache",
    type: "number",
    defaultValue: 5 * 60 * 1000,
    min: 0,
    max: 24 * 60 * 60 * 1000,
    unit: "ms",
  },
  {
    key: "cache.code_list_ttl_ms",
    label: "Code list cache TTL",
    description: "TTL for status/priority/division code lists (Tier 1 reference data).",
    category: "cache",
    type: "number",
    defaultValue: 24 * 60 * 60 * 1000,
    min: 60_000,
    max: 7 * 24 * 60 * 60 * 1000,
    unit: "ms",
  },
  {
    key: "cache.skill_master_ttl_ms",
    label: "Skill catalogue TTL",
    description: "TTL for the SAP skill master (cod_skill_wcf.svc/cod_skill_tts).",
    category: "cache",
    type: "number",
    defaultValue: 4 * 60 * 60 * 1000,
    min: 60_000,
    max: 7 * 24 * 60 * 60 * 1000,
    unit: "ms",
  },

  // ----- Limits / safety -----
  {
    key: "limits.skill_keyword_top",
    label: "Skill keyword top",
    description: "Max rows per keyword when querying ZSDK_EmployeeSkillsRoot.",
    category: "limits",
    type: "number",
    defaultValue: 200,
    min: 10,
    max: 1000,
  },
  {
    key: "limits.search_top",
    label: "search_tickets default top",
    description: "Default max rows returned by search_tickets when not specified.",
    category: "limits",
    type: "number",
    defaultValue: 10,
    min: 1,
    max: 100,
  },

  // ----- Feature flags -----
  {
    key: "feature.auto_writeback_enabled",
    label: "Auto-mode write-back",
    description: "Master switch for AI Companion Auto-mode write-back to SAP. Off by default until write tools land.",
    category: "behavior",
    type: "boolean",
    defaultValue: false,
  },

  // ============================================================================
  // Tenant business rules — served to every client via GET /api/client-config.
  //
  // These previously lived in each user's chrome.storage.sync (Options page),
  // which meant (a) any user could change what SAP actually receives, with no
  // admin control and no audit trail, and (b) a second front door (mobile PWA,
  // ChatGPT) would have had to re-implement them. They are tenant POLICY, not
  // user preference: the test is "does changing it change what SAP receives?"
  //
  // Defaults below exactly match the values the extension hard-coded, so
  // migrating changes no behaviour for the Thermo Fisher tenant.
  // ============================================================================
  {
    key: "parts.ordering_processing_type_code",
    label: "Parts-ordering processing type code",
    description:
      "Item type used when /order-parts commits parts to a ticket. ZRP3 = Parts ORDERING (request parts for a planned repair) — NOT Parts Consumption (SRP1), which logs parts already installed. Changing this changes the SAP business transaction; see docs/engineering-notes.md.",
    category: "behavior",
    type: "string",
    defaultValue: "ZRP3",
    placeholder: "ZRP3",
  },
  {
    key: "parts.inference_include_types",
    label: "Parts-inference: include processing types",
    description:
      "Comma-separated allowlist of CONSUMPTION codes searched when inferring which parts a repair needs from similar past tickets. Defaults to SRP1,ZRP1 — parts actually used. Deliberately excludes ZRP3 (ordered, not necessarily consumed), ZALT (labour) and SRPT (service).",
    category: "behavior",
    type: "string",
    defaultValue: "SRP1,ZRP1",
    placeholder: "SRP1,ZRP1",
  },
  {
    key: "booktime.labor_product_id",
    label: "Book Time — labour product ID",
    description:
      "ProductID logged for on-site labour hours by /book-time (ZALT). Tenant-specific: 11266683 = ACTUAL_LABOR / ONSITE LABOR on my340573.",
    category: "behavior",
    type: "string",
    defaultValue: "11266683",
    placeholder: "11266683",
  },
  {
    key: "booktime.travel_product_id",
    label: "Book Time — travel product ID",
    description:
      "ProductID logged for travel hours by /book-time (ZALT). Tenant-specific: 11266684 = ACTUAL_TRAVEL / TRAVEL TIME on my340573.",
    category: "behavior",
    type: "string",
    defaultValue: "11266684",
    placeholder: "11266684",
  },
  {
    key: "kb.direct_url",
    label: "KB direct-mode URL (extension only)",
    description:
      "MindTouch base URL the extension's KB direct mode hits using the operator's own browser session cookies. Extension-only by necessity — mobile/ChatGPT cannot send cookies, so the server-side Azure AD path (kb.api_base_url + search_kb_for_ticket) stays canonical. Leave blank to disable direct mode.",
    category: "kb",
    type: "url",
    defaultValue: "",
    placeholder: "https://knowledge1.example.com",
  },

  // ============================================================================
  // External Knowledge Base (MindTouch — override default URL for your tenant)
  // ============================================================================
  {
    key: "kb.api_base_url",
    label: "KB API base URL",
    description: "Root URL of the external knowledge base. Used by both the API search (when AAD is configured) and the link-out search tiles.",
    category: "kb",
    type: "url",
    defaultValue: "https://kb.example.com",
    placeholder: "https://kb.example.com",
    envFallback: "KB_API_BASE_URL",
  },
  {
    key: "kb.api_search_path",
    label: "KB API search path",
    description: "MindTouch REST search endpoint. Default is /@api/deki/site/search.",
    category: "kb",
    type: "string",
    defaultValue: "/@api/deki/site/search",
    placeholder: "/@api/deki/site/search",
    envFallback: "KB_API_SEARCH_PATH",
  },
  {
    key: "kb.api_scope",
    label: "KB API Azure scope",
    description: "OAuth scope for the KB API. Typically <kb-app-id-uri>/.default published by your Azure AD admin.",
    category: "kb",
    type: "string",
    defaultValue: "https://kb.example.com/.default",
    placeholder: "api://<kb-app-id>/.default",
    envFallback: "KB_API_SCOPE",
  },
  {
    key: "kb.ui_browse_url",
    label: "KB browse URL (link-out)",
    description: "URL the Knowledge tab's link-out search tiles point at. Usually the same as the API base URL, but can differ if the user-facing KB lives under a different hostname.",
    category: "kb",
    type: "url",
    defaultValue: "https://kb.example.com/",
    placeholder: "https://kb.example.com/",
  },
  {
    key: "kb.ui_search_path",
    label: "KB browse search path (link-out)",
    description: "Search-URL pattern for the link-out tiles. Use {q} as the query placeholder.",
    category: "kb",
    type: "string",
    defaultValue: "Special:Search?search={q}",
    placeholder: "Special:Search?search={q}",
  },

  // ============================================================================
  // Azure AD / Entra ID — for KB API and future C4C OAuth
  // ============================================================================
  {
    key: "auth.azure_tenant_id",
    label: "Azure tenant ID",
    description: "Entra tenant GUID (or verified domain). From the App registration overview page.",
    category: "auth",
    type: "string",
    defaultValue: "",
    placeholder: "00000000-0000-0000-0000-000000000000",
    envFallback: "AZURE_TENANT_ID",
  },
  {
    key: "auth.azure_client_id",
    label: "Azure client (app) ID",
    description: "Entra Application (client) ID from the app registration.",
    category: "auth",
    type: "string",
    defaultValue: "",
    placeholder: "00000000-0000-0000-0000-000000000000",
    envFallback: "AZURE_CLIENT_ID",
  },
  {
    key: "auth.azure_client_secret",
    label: "Azure client secret",
    description: "Client secret value from Entra → Certificates & secrets. Encrypted at rest.",
    category: "auth",
    type: "secret",
    defaultValue: "",
    placeholder: "client secret value (encrypted on save)",
    envFallback: "AZURE_CLIENT_SECRET",
  },
  {
    key: "auth.azure_authority",
    label: "Azure authority",
    description: "Login endpoint. Override only for sovereign / government clouds.",
    category: "auth",
    type: "url",
    defaultValue: "https://login.microsoftonline.com",
    placeholder: "https://login.microsoftonline.com",
    envFallback: "AZURE_AUTHORITY",
  },

  // ============================================================================
  // AI providers — keys + URLs + model selection. All keys encrypted.
  // ============================================================================
  {
    key: "ai.provider",
    label: "Active AI provider",
    description: "Which provider /api/chat should route to.",
    category: "ai",
    type: "enum",
    defaultValue: "anthropic",
    options: ["anthropic", "openai", "azure", "gemini", "ollama"] as const,
    envFallback: "AI_PROVIDER",
  },

  // Anthropic
  {
    key: "ai.anthropic.api_key",
    label: "Anthropic API key",
    description: "Claude API key (sk-ant-...). Encrypted at rest.",
    category: "ai",
    type: "secret",
    defaultValue: "",
    placeholder: "sk-ant-api03-...",
    envFallback: "ANTHROPIC_API_KEY",
  },
  {
    key: "ai.anthropic.model",
    label: "Anthropic model",
    description: "Default Claude model name.",
    category: "ai",
    type: "string",
    defaultValue: "claude-sonnet-4-5",
    placeholder: "claude-sonnet-4-5",
    envFallback: "ANTHROPIC_MODEL",
  },

  // OpenAI
  {
    key: "ai.openai.api_key",
    label: "OpenAI API key",
    description: "OpenAI Platform API key (sk-proj-... / sk-...). Encrypted at rest.",
    category: "ai",
    type: "secret",
    defaultValue: "",
    placeholder: "sk-proj-...",
    envFallback: "OPENAI_API_KEY",
  },
  {
    key: "ai.openai.base_url",
    label: "OpenAI base URL",
    description: "OpenAI-compatible endpoint. Override for proxies or self-hosted gateways.",
    category: "ai",
    type: "url",
    defaultValue: "https://api.openai.com/v1",
    placeholder: "https://api.openai.com/v1",
    envFallback: "OPENAI_BASE_URL",
  },
  {
    key: "ai.openai.model",
    label: "OpenAI model",
    description: "Default OpenAI model deployment.",
    category: "ai",
    type: "string",
    defaultValue: "gpt-4o-mini",
    placeholder: "gpt-4o-mini",
    envFallback: "OPENAI_MODEL",
  },

  // Azure OpenAI
  {
    key: "ai.azure_openai.api_key",
    label: "Azure OpenAI API key",
    description: "Azure OpenAI resource key from the Azure portal. Encrypted at rest.",
    category: "ai",
    type: "secret",
    defaultValue: "",
    placeholder: "Azure OpenAI key",
    envFallback: "AZURE_OPENAI_API_KEY",
  },
  {
    key: "ai.azure_openai.endpoint",
    label: "Azure OpenAI endpoint",
    description: "Resource endpoint, e.g. https://<your-resource>.openai.azure.com",
    category: "ai",
    type: "url",
    defaultValue: "",
    placeholder: "https://<your-resource>.openai.azure.com",
    envFallback: "AZURE_OPENAI_ENDPOINT",
  },
  {
    key: "ai.azure_openai.deployment",
    label: "Azure OpenAI deployment",
    description: "Deployment name (not the model — the deployment label you chose in Azure).",
    category: "ai",
    type: "string",
    defaultValue: "gpt-4o-mini",
    placeholder: "gpt-4o-mini",
    envFallback: "AZURE_OPENAI_DEPLOYMENT",
  },
  {
    key: "ai.azure_openai.api_version",
    label: "Azure OpenAI API version",
    description: "Azure OpenAI API version string.",
    category: "ai",
    type: "string",
    defaultValue: "2024-10-21",
    placeholder: "2024-10-21",
    envFallback: "AZURE_OPENAI_API_VERSION",
  },

  // Gemini
  {
    key: "ai.gemini.api_key",
    label: "Gemini API key",
    description: "Google AI Studio key. Encrypted at rest.",
    category: "ai",
    type: "secret",
    defaultValue: "",
    placeholder: "AIza...",
    envFallback: "GOOGLE_API_KEY",
  },
  {
    key: "ai.gemini.model",
    label: "Gemini model",
    description: "Default Gemini model name.",
    category: "ai",
    type: "string",
    defaultValue: "gemini-1.5-flash",
    placeholder: "gemini-1.5-flash",
    envFallback: "GEMINI_MODEL",
  },

  // Ollama (local)
  {
    key: "ai.ollama.base_url",
    label: "Ollama base URL",
    description: "Local Ollama instance — no key required.",
    category: "ai",
    type: "url",
    defaultValue: "http://127.0.0.1:11434",
    placeholder: "http://127.0.0.1:11434",
    envFallback: "OLLAMA_BASE_URL",
  },
  {
    key: "ai.ollama.model",
    label: "Ollama model",
    description: "Local model tag.",
    category: "ai",
    type: "string",
    defaultValue: "llama3.1",
    placeholder: "llama3.1",
    envFallback: "OLLAMA_MODEL",
  },

];

const REGISTRY_BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

function parseValue(raw: string, type: SettingValueType): number | string | boolean {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "secret") {
    // Stored value is the AES ciphertext; decrypt on read.
    try {
      return raw ? decrypt(raw) : "";
    } catch {
      // Key rotated or tampered — surface as empty so callers fall back.
      return "";
    }
  }
  return raw;
}

function serializeValue(value: number | string | boolean, type: SettingValueType): string {
  if (type === "number") return String(value);
  if (type === "boolean") return String(Boolean(value));
  if (type === "secret") {
    const plain = String(value ?? "");
    return plain ? encrypt(plain) : "";
  }
  return String(value);
}

/** True for setting types whose plaintext value must never be returned to a UI consumer. */
function isSecretType(type: SettingValueType): boolean {
  return type === "secret";
}

export function getSettingSpec(key: string): SettingSpec | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export function getSetting(key: string): number | string | boolean {
  const spec = REGISTRY_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown setting '${key}'.`);
  const row = readSettingRow(key);
  if (row) {
    try {
      const parsed = parseValue(row.value, row.valueType);
      // Secret rows that fail to decrypt return "" — fall through to env.
      if (parsed === "" && spec.envFallback) {
        // try env next
      } else {
        return parsed;
      }
    } catch {
      // fall through to env fallback
    }
  }
  if (spec.envFallback) {
    const envVal = process.env[spec.envFallback];
    if (envVal !== undefined && envVal !== "") {
      try {
        // Env values are always strings — re-parse against the target type,
        // but skip secret-decryption (env values are plaintext).
        if (spec.type === "secret") return envVal;
        return parseValue(envVal, spec.type);
      } catch {
        /* fall through to default */
      }
    }
  }
  return spec.defaultValue;
}

export function getSettingNumber(key: string): number {
  const v = getSetting(key);
  return typeof v === "number" ? v : Number(v);
}

export function getSettingBoolean(key: string): boolean {
  const v = getSetting(key);
  return typeof v === "boolean" ? v : v === "true";
}

/** Convenience for string/url/secret/enum settings. Returns "" when unset. */
export function getSettingString(key: string): string {
  const v = getSetting(key);
  return typeof v === "string" ? v : String(v ?? "");
}

export function setSetting(key: string, rawValue: unknown) {
  const spec = REGISTRY_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown setting '${key}'.`);
  let value: number | string | boolean;
  if (spec.type === "number") {
    value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`'${key}' must be a number.`);
    if (spec.min !== undefined && value < spec.min) throw new Error(`'${key}' must be >= ${spec.min}.`);
    if (spec.max !== undefined && value > spec.max) throw new Error(`'${key}' must be <= ${spec.max}.`);
  } else if (spec.type === "boolean") {
    value = rawValue === true || rawValue === "true" || rawValue === 1;
  } else if (spec.type === "enum") {
    value = String(rawValue ?? "").trim();
    if (spec.options && spec.options.length > 0 && !spec.options.includes(value)) {
      throw new Error(`'${key}' must be one of: ${spec.options.join(", ")}`);
    }
  } else if (spec.type === "url") {
    value = String(rawValue ?? "").trim();
    if (value !== "") {
      try {
        // eslint-disable-next-line no-new
        new URL(value.startsWith("/") ? `http://placeholder${value}` : value);
      } catch {
        throw new Error(`'${key}' must be a valid URL (or empty to reset).`);
      }
    }
  } else {
    // string or secret
    value = String(rawValue ?? "");
  }
  writeSettingRow({ key, value: serializeValue(value, spec.type), valueType: spec.type });
  return getCurrentSetting(key);
}

export function resetSetting(key: string) {
  const spec = REGISTRY_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown setting '${key}'.`);
  deleteSettingRow(key);
  return getCurrentSetting(key);
}

export type SettingView = {
  spec: SettingSpec;
  /** For secrets, this is "" (never the plaintext). Use `isSet` to know if a value is stored. */
  value: number | string | boolean;
  defaultValue: number | string | boolean;
  /** True if there's a tenant-scoped override row in the DB. */
  isOverride: boolean;
  /** True if the effective value comes from a row OR a non-empty env fallback. */
  isSet: boolean;
  /** Where the effective value resolved from. */
  source: "override" | "env" | "default";
  /** Last 4 chars when secret + set; else null. Lets admin confirm what's there without leaking. */
  secretHint: string | null;
  updatedAt: number | null;
};

function buildView(spec: SettingSpec): SettingView {
  const row = readSettingRow(spec.key);
  let value: number | string | boolean = spec.defaultValue;
  let source: SettingView["source"] = "default";
  let isSet = false;
  let secretHint: string | null = null;

  if (row) {
    try {
      const parsed = parseValue(row.value, row.valueType);
      // Secrets that fail to decrypt fall through to env (parsed === "")
      if (spec.type === "secret") {
        const plain = typeof parsed === "string" ? parsed : String(parsed ?? "");
        if (plain !== "") {
          source = "override";
          isSet = true;
          secretHint = plain.length >= 4 ? plain.slice(-4) : "•".repeat(plain.length);
          value = ""; // never return plaintext from listSettings/getCurrentSetting
        }
      } else {
        source = "override";
        isSet = !(typeof parsed === "string" && parsed === "");
        value = parsed;
      }
    } catch {
      /* fall through to env */
    }
  }

  if (source === "default" && spec.envFallback) {
    const envVal = process.env[spec.envFallback];
    if (envVal !== undefined && envVal !== "") {
      source = "env";
      if (spec.type === "secret") {
        isSet = true;
        secretHint = envVal.length >= 4 ? envVal.slice(-4) : "•".repeat(envVal.length);
        value = "";
      } else {
        try {
          value = parseValue(envVal, spec.type);
        } catch {
          value = envVal;
        }
        isSet = true;
      }
    }
  }

  // For non-secret unset settings, fall back to spec default
  if (source === "default" && spec.type !== "secret") {
    value = spec.defaultValue;
  }

  return {
    spec,
    value,
    defaultValue: spec.defaultValue,
    isOverride: source === "override",
    isSet,
    source,
    secretHint,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function getCurrentSetting(key: string): SettingView {
  const spec = REGISTRY_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown setting '${key}'.`);
  return buildView(spec);
}

/** Every setting with its current value — what the admin Settings tab renders. */
export function listSettings(): { tenant: string; settings: SettingView[] } {
  return { tenant: getTenantId(), settings: SETTINGS_REGISTRY.map(buildView) };
}
