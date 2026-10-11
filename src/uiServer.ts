/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { formatToolError, odataStringLiteral } from "./c4cClient.js";
import {
  getAccount,
  getAccountContacts,
  getAccountOpenTickets,
  getEmployeeSkills,
  getMyTeamTickets,
  getMyTickets,
  getSerialHistory,
  getServiceHistory,
  getServiceMetadata,
  getSlaAtRisk,
  getTicket,
  addAccountContact,
  addServiceRequestText,
  attachSolutionToTicket,
  assignProcessor,
  assignTeam,
  attachKbArticle,
  createAppointment,
  createFollowupTask,
  escalateTicket,
  getCommunicationStream,
  getContract,
  getContractItems,
  getContractsForAccount,
  getDurationStats,
  getFirstTimeFixRate,
  getIssueCategoryTree,
  getMttrByProduct,
  getPartAvailability,
  getKbApiStatus,
  getRecurringIssues,
  getRepeatVisitRate,
  getResolutionHints,
  getSurveyResponses,
  getTeamRoster,
  getTicketItems,
  getTicketKbArticles,
  getTicketNotes,
  getWorkloadDistribution,
  logPhoneCall,
  logServiceItem,
  searchChats,
  searchCustomerOrders,
  searchEmails,
  searchKbArticles,
  searchOpportunities,
  searchOrgUnits,
  searchPhoneCalls,
  searchSalesQuotes,
  searchTasks,
  updateServiceItemActuals,
  updateTicketDescription,
  updateTicketLifecycle,
  updateTicketPriority,
  searchKbForTicket,
  searchParts,
  searchAppointments,
  searchEmployees,
  searchTickets,
} from "./serviceOps.js";
import {
  deleteAnonymousAuthTokens,
  deleteAuthToken,
  deleteAuthTokensForUser,
  getAuthToken,
  listRecent,
  putAuthToken,
  readHistoryCache,
  readTicketCache,
  sweepExpiredAuthTokens,
  touchRecent,
  writeHistoryCache,
  writeTicketCache,
} from "./cache.js";
import {
  getCodeList,
  listAvailableCodeLists,
  purgeCodeList,
  refreshAllCodeLists,
} from "./codeLists.js";
import { adminApi, isAdminEnabled } from "./admin.js";
import { getSettingNumber } from "./settings.js";
import { recordCall, type CallOutcome } from "./toolMetrics.js";
import { getToolInfo } from "./toolRegistry.js";
import { can, permissionsOf, requiredPermission, runWithPrincipal, type Principal } from "./access.js";
import {
  bootstrapOwnerFromEnv,
  directoryActive,
  getActiveUserLite,
  getUserById,
  resolveSsoUser,
  setSessionRevoker,
} from "./users.js";
import { handleAdminUsers, handleAuthRoutes, type AuthHooks } from "./usersRoutes.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Ask C4S surfaces — all plain static files, no build step:
//   mobile-pwa  → "/"          the field tech's home (installable PWA)
//   light-admin → "/settings"  the admin page (settings + users)
//   shared-ui   → "/shared/*"  the design system every surface links
const lightAdminDir = join(projectRoot, "apps", "light-admin");
const mobilePwaDir = join(projectRoot, "apps", "mobile-pwa");
const sharedUiDir = join(projectRoot, "apps", "shared-ui");

// Static root for "/": a STATIC_DIR override if it exists, otherwise the field PWA.
const staticDirEnv = process.env.STATIC_DIR;
const staticDir = staticDirEnv && existsSync(staticDirEnv) ? staticDirEnv : mobilePwaDir;
const staticDirSource =
  staticDir === mobilePwaDir ? "apps/mobile-pwa (Ask C4S field PWA) + /settings" : staticDir;

const requestedPort = Number(process.env.SERVICE_OPS_UI_PORT ?? process.env.PORT ?? 3030);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml"
};

const toolDefinitions = [
  {
    name: "search_tickets",
    title: "Search Tickets",
    description: "Search SAP Service Cloud service tickets.",
    template: {
      top: 5,
      skip: 0,
      statusCode: "",
      odataFilter: "",
      orderBy: ""
    },
    fields: [
      { name: "top", label: "Top (max rows)", type: "number", min: 1, max: 100, default: 5 },
      { name: "skip", label: "Skip", type: "number", min: 0, default: 0 },
      { name: "statusCode", label: "Status code", type: "text", placeholder: "e.g. 1, 2, 3, 4" },
      { name: "odataFilter", label: "OData $filter", type: "textarea", placeholder: "LastChangeDateTime gt datetimeoffset'2024-01-01T00:00:00Z'" },
      { name: "orderBy", label: "Order by", type: "text", placeholder: "LastChangeDateTime desc" }
    ]
  },
  {
    name: "get_ticket",
    title: "Get Ticket",
    description: "Get one SAP Service Cloud ticket by ObjectID.",
    template: {
      objectId: "",
      expand: [],
      includeMetadata: false
    },
    fields: [
      { name: "objectId", label: "Object ID", type: "objectId", required: true, placeholder: "Pick from search results or paste an ObjectID" },
      { name: "expand", label: "Expand (comma separated)", type: "csv", placeholder: "ServiceRequestTextCollection,ServiceRequestAttachmentFolder" },
      { name: "includeMetadata", label: "Include metadata summary", type: "boolean", default: false }
    ]
  },
  {
    name: "get_service_metadata",
    title: "Get Service Metadata",
    description: "Read and summarize SAP C4C OData metadata.",
    template: {
      mode: "summary",
      entitySet: "",
      refresh: false
    },
    fields: [
      { name: "mode", label: "Mode", type: "select", options: ["summary", "raw"], default: "summary" },
      { name: "entitySet", label: "Entity set", type: "text", placeholder: "ServiceRequestCollection" },
      { name: "refresh", label: "Refresh cache", type: "boolean", default: false }
    ]
  },
  {
    name: "get_service_history",
    title: "Get Service History",
    description: "Read metadata-discovered service history for a ticket ObjectID.",
    template: {
      objectId: "",
      navigationProperty: "",
      top: 10,
      candidateLimit: 5,
      includeDiscovery: true,
      refreshMetadata: false
    },
    fields: [
      { name: "objectId", label: "Object ID", type: "objectId", required: true, placeholder: "Pick from search results or paste an ObjectID" },
      { name: "navigationProperty", label: "Navigation property", type: "text", placeholder: "Auto-discover if blank" },
      { name: "top", label: "Top per nav", type: "number", min: 1, max: 50, default: 10 },
      { name: "candidateLimit", label: "Candidate limit", type: "number", min: 1, max: 10, default: 5 },
      { name: "includeDiscovery", label: "Include discovery info", type: "boolean", default: true },
      { name: "refreshMetadata", label: "Refresh metadata", type: "boolean", default: false }
    ]
  },
  {
    name: "get_employee_skills",
    title: "Get Employee Skills",
    description: "Technicians from EmployeeCollection + product expertise derived from recent tickets.",
    template: {
      top: 20,
      ticketSampleSize: 100,
      productHint: ""
    },
    fields: [
      { name: "top", label: "Max technicians", type: "number", min: 1, max: 50, default: 20 },
      { name: "ticketSampleSize", label: "Ticket sample size", type: "number", min: 10, max: 200, default: 100 },
      { name: "productHint", label: "Product / serial hint", type: "text", placeholder: "Optional — rank by best match" }
    ]
  },
  {
    name: "get_account_open_tickets",
    title: "Get Account Open Tickets",
    description: "Tickets for a customer (Buyer Party ID). Defaults to open only.",
    template: { buyerPartyId: "", top: 25, includeClosed: false, orderBy: "LastChangeDateTime desc" },
    fields: [
      { name: "buyerPartyId", label: "Buyer Party ID", type: "text", required: true, placeholder: "1000001" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 },
      { name: "includeClosed", label: "Include closed tickets", type: "boolean", default: false },
      { name: "orderBy", label: "Order by", type: "text", placeholder: "LastChangeDateTime desc" }
    ]
  },
  {
    name: "get_serial_history",
    title: "Get Serial History",
    description: "Past tickets for a specific equipment serial — cross-customer equipment history.",
    template: { serialId: "", top: 25, includeClosed: true, orderBy: "LastChangeDateTime desc" },
    fields: [
      { name: "serialId", label: "Serial ID", type: "text", required: true, placeholder: "SN0000001" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 },
      { name: "includeClosed", label: "Include closed tickets", type: "boolean", default: true },
      { name: "orderBy", label: "Order by", type: "text", placeholder: "LastChangeDateTime desc" }
    ]
  },
  {
    name: "get_ticket_notes",
    title: "Get Ticket Notes",
    description: "Notes / text bodies attached to a ticket, grouped by type.",
    template: { objectId: "", top: 50 },
    fields: [
      { name: "objectId", label: "ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "top", label: "Top", type: "number", min: 1, max: 200, default: 50 }
    ]
  },
  {
    name: "get_ticket_items",
    title: "Get Ticket Items",
    description: "Per-ticket line items: labor (hours planned vs actual), parts consumed, billing requests. Grouped by processing type with rollups.",
    template: { objectId: "", top: 50 },
    fields: [
      { name: "objectId", label: "ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "top", label: "Top items", type: "number", min: 1, max: 200, default: 50 }
    ]
  },
  {
    name: "search_kb_articles",
    title: "Search KB Articles",
    description: "Free-text search the external KB via Azure AD. Returns ok=false with setup guidance when AAD isn't configured.",
    template: { query: "", top: 10 },
    fields: [
      { name: "query", label: "Query", type: "text", required: true, placeholder: "pump pressure flow" },
      { name: "top", label: "Top results", type: "number", min: 1, max: 50, default: 10 }
    ]
  },
  {
    name: "search_kb_for_ticket",
    title: "Search KB for Ticket",
    description: "Derive smart queries from a ticket and fan out KB search. Dedupes + ranks across queries.",
    template: { objectId: "", topPerQuery: 6 },
    fields: [
      { name: "objectId", label: "Ticket ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "topPerQuery", label: "Top per query", type: "number", min: 1, max: 20, default: 6 }
    ]
  },
  {
    name: "get_kb_api_status",
    title: "Get KB API Status",
    description: "Public-safe diagnostic — is Azure AD configured? Which base URL + scope are in use?",
    template: {},
    fields: []
  },
  {
    name: "get_resolution_hints",
    title: "Get Resolution Hints",
    description: "Aggregates symptom keywords, past tickets on the same serial (with their notes), and same-product closures — input to KB resolution suggestions.",
    template: { objectId: "", pastTicketsTop: 5 },
    fields: [
      { name: "objectId", label: "ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "pastTicketsTop", label: "Past tickets per source", type: "number", min: 1, max: 20, default: 5 }
    ]
  },
  {
    name: "get_ticket_kb_articles",
    title: "Get Ticket KB Articles",
    description: "Knowledge-base articles / solution proposals linked to a ticket. Returns populated-vs-empty split.",
    template: { objectId: "", top: 25 },
    fields: [
      { name: "objectId", label: "ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 }
    ]
  },
  {
    name: "search_parts",
    title: "Search Parts",
    description: "List parts with stock anywhere — grouped by MaterialID with aggregate qty across locations.",
    template: { query: "", top: 25 },
    fields: [
      { name: "query", label: "Material ID / external ID substring", type: "text", placeholder: "MAT-001 or EXT-PROD-001" },
      { name: "top", label: "Top distinct parts", type: "number", min: 1, max: 100, default: 25 }
    ]
  },
  {
    name: "get_part_availability",
    title: "Get Part Availability",
    description: "Per-location stock for a specific MaterialID. Totals usable/blocked/consignment.",
    template: { materialId: "", top: 50 },
    fields: [
      { name: "materialId", label: "Material ID", type: "text", required: true, placeholder: "MAT-001" },
      { name: "top", label: "Top rows", type: "number", min: 1, max: 200, default: 50 }
    ]
  },
  {
    name: "get_duration_stats",
    title: "Get Duration Stats",
    description: "Planned-vs-actual hours: p10/median/p90 + overshoot ratio across closed tickets.",
    template: { productId: "", buyerPartyId: "", sampleSize: 100 },
    fields: [
      { name: "productId", label: "Product ID", type: "text", placeholder: "MAT-002" },
      { name: "buyerPartyId", label: "Buyer Party ID", type: "text", placeholder: "1000001" },
      { name: "sampleSize", label: "Sample size", type: "number", min: 10, max: 500, default: 100 }
    ]
  },
  {
    name: "attach_kb_article",
    title: "Attach KB Article (write)",
    description: "POST a SolutionProposal row to SAP. Dry-run by default; real POST also requires feature.auto_writeback_enabled.",
    template: { objectId: "", articleId: "", articleUri: "", description: "", note: "", dryRun: true },
    fields: [
      { name: "objectId", label: "Ticket ObjectID", type: "text", required: true, placeholder: "AAAA1111BBBB2222CCCC3333DDDD4444" },
      { name: "articleId", label: "External KB article ID", type: "text", placeholder: "KB-2143" },
      { name: "articleUri", label: "KB article URL", type: "text", placeholder: "https://kb.example/article/2143" },
      { name: "description", label: "Description", type: "text" },
      { name: "note", label: "Note", type: "text" },
      { name: "dryRun", label: "Dry-run (preview only)", type: "boolean", default: true }
    ]
  },
  {
    name: "get_account",
    title: "Get Account",
    description: "Customer master record by AccountID.",
    template: { accountId: "" },
    fields: [
      { name: "accountId", label: "Account ID", type: "text", required: true, placeholder: "1000001" }
    ]
  },
  {
    name: "get_sla_at_risk",
    title: "Get SLA-at-risk Tickets",
    description: "Tickets at risk of breaching SLA within N hours.",
    template: { hoursAhead: 24, top: 50 },
    fields: [
      { name: "hoursAhead", label: "Hours ahead", type: "number", min: 1, max: 168, default: 24 },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 50 }
    ]
  },
  {
    name: "search_employees",
    title: "Search Employees",
    description: "Search SAP employees by name or region.",
    template: { query: "", region: "", top: 25 },
    fields: [
      { name: "query", label: "Name search", type: "text", placeholder: "free-text" },
      { name: "region", label: "Region code", type: "text" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 }
    ]
  },
  {
    name: "get_my_tickets",
    title: "Get My Tickets (Agent scope)",
    description: "Tickets assigned to a specific processor.",
    template: { processorPartyId: "", top: 25, includeClosed: false },
    fields: [
      { name: "processorPartyId", label: "Processor Party ID", type: "text", placeholder: "8000019150" },
      { name: "processorPartyUuid", label: "or Processor UUID", type: "text", placeholder: "00163E53-..." },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 },
      { name: "includeClosed", label: "Include closed", type: "boolean", default: false }
    ]
  },
  {
    name: "get_my_team_tickets",
    title: "Get My Team Tickets (Manager scope)",
    description: "Tickets routed to a service execution team. Includes per-processor breakdown.",
    template: { teamPartyId: "", top: 50, includeClosed: false },
    fields: [
      { name: "teamPartyId", label: "Team Party ID", type: "text", placeholder: "RG_2900_GC/MS_IOMS" },
      { name: "teamPartyUuid", label: "or Team UUID", type: "text" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 50 },
      { name: "includeClosed", label: "Include closed", type: "boolean", default: false }
    ]
  },
  {
    name: "get_account_contacts",
    title: "Get Account Contacts",
    description: "Contacts at a customer account.",
    template: { accountId: "", top: 25 },
    fields: [
      { name: "accountId", label: "Account ID", type: "text", required: true, placeholder: "1000001" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 }
    ]
  },
  {
    name: "search_appointments",
    title: "Search Appointments",
    description: "Find calendar appointments. Filter by owner (tech) or account.",
    template: { ownerPartyId: "", accountPartyId: "", top: 25 },
    fields: [
      { name: "ownerPartyId", label: "Owner Party ID (tech)", type: "text" },
      { name: "accountPartyId", label: "Account Party ID", type: "text" },
      { name: "top", label: "Top", type: "number", min: 1, max: 100, default: 25 }
    ]
  },
  {
    name: "list_code_lists",
    title: "List Code Lists",
    description: "All known SAP code lists + their local-cache status.",
    template: {},
    fields: []
  },
  {
    name: "get_code_list",
    title: "Get Code List",
    description: "Read a named code list (cached locally). Pass refresh=true to bypass cache.",
    template: { name: "lifecycle_status", refresh: false },
    fields: [
      { name: "name", label: "Code list name", type: "text", required: true, placeholder: "e.g. lifecycle_status, service_priority, skill_master" },
      { name: "refresh", label: "Force refresh from SAP", type: "boolean", default: false }
    ]
  }
];

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

/**
 * Deliver an OIDC sign-in result to the SPA. On success, a tiny server-rendered
 * page writes the internal token into the same localStorage key the PWA reads,
 * then redirects to "/". The token rides in the HTML body — NOT the URL, which
 * would be logged, cached, and land in browser history. On failure, an error
 * page with a link back to sign in.
 *
 * The token is JSON-encoded (json-in-a-script-string) so it can't break out of
 * the string context; it is always a server-minted hex string, never user input.
 */
function sendOidcResult(response: ServerResponse, token: string | null, error: string | null) {
  if (token) {
    const tokenJson = JSON.stringify(token);
    const html =
      "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>Signing you in…</title></head><body style=\"font-family:system-ui;padding:24px;color:#334155\">" +
      "<p>Signing you in…</p><script>try{localStorage.setItem('askc4s.field.token'," + tokenJson + ");}" +
      "catch(e){}location.replace('/');</script></body></html>";
    sendText(response, 200, html, "text/html; charset=utf-8");
    return;
  }
  const safe = String(error ?? "Sign-in failed.").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
  const html =
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Sign-in failed</title></head><body style=\"font-family:system-ui;padding:24px;color:#334155\">" +
    "<h2>Couldn't sign you in</h2><p>" + safe + "</p>" +
    "<p><a href=\"/\">← Back to Ask C4S</a></p></body></html>";
  sendText(response, 200, html, "text/html; charset=utf-8");
}

function numberParam(url: URL, name: string, fallback: number, min: number, max: number) {
  const raw = url.searchParams.get(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function booleanParam(url: URL, name: string, fallback = false) {
  const raw = url.searchParams.get(name);
  if (!raw) {
    return fallback;
  }

  return raw === "true" || raw === "1";
}

function optionalParam(url: URL, name: string) {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function splitCsv(value?: string) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function routeParts(pathname: string) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > 65536) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal route soft auth — issues 24h random hex tokens after a successful
// password match. Tokens are kept in-process; restart invalidates them all.
// ---------------------------------------------------------------------------
const INTERNAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
type TokenRecord = {
  expiresAt: number;
  /**
   * Provider that issued the underlying identity.
   *   password — shared-secret admin gate (no user identity)
   *   google   — Google OAuth via the extension's chrome.identity
   *   entra    — Microsoft Entra ID (Azure AD) OIDC — the org SSO path
   *   dev      — local dev only, mints an identity without an IdP; reachable
   *              ONLY when ASKC4S_ADMIN_INSECURE=true (never in the images)
   *   directory — email + password against the user directory (src/users.ts)
   */
  source: "password" | "google" | "entra" | "dev" | "directory";
  /** Optional user identity attached to the token (set by SSO/dev flows). */
  user?: { email: string; name?: string; picture?: string };
  /**
   * The directory account this token belongs to. Absent on tokens minted before
   * any account existed (shared password, SSO in legacy mode). The ROLE is never
   * stored here — it is read from the database on every request, so a demotion
   * or disable takes effect immediately instead of when the token expires.
   */
  userId?: string;
};
// Session tokens live in the DB (src/cache.ts) so a restart / redeploy doesn't
// sign everyone out. Rows are keyed on the SHA-256 of the token, never the raw
// value, so a leaked DB can't be replayed as a live session.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Short-lived PKCE/state store for the Entra OIDC redirect flow. Keyed by the
// `state` param; holds the code_verifier between /start and /callback. In-memory
// is fine: the window is ~10 min and a restart just means the tech signs in
// again. Entries are swept lazily.
const oidcFlows = new Map<string, { verifier: string; createdAt: number; redirectUri: string }>();
const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;
function sweepOidcFlows() {
  const now = Date.now();
  for (const [k, v] of oidcFlows) if (now - v.createdAt > OIDC_FLOW_TTL_MS) oidcFlows.delete(k);
}

function issueInternalToken(opts: Omit<TokenRecord, "expiresAt"> = { source: "password" }): string {
  // 32 hex chars = 128 bits of entropy. crypto.randomUUID is fine here.
  const token =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  putAuthToken(hashToken(token), {
    expiresAt: Date.now() + INTERNAL_TOKEN_TTL_MS,
    source: opts.source,
    user: opts.user,
    userId: opts.userId,
  });
  sweepExpiredAuthTokens();
  return token;
}

function verifyInternalToken(token: string): TokenRecord | null {
  const hash = hashToken(token);
  const stored = getAuthToken(hash);
  if (!stored) return null;
  if (stored.expiresAt < Date.now()) {
    deleteAuthToken(hash);
    return null;
  }
  const rec: TokenRecord = {
    expiresAt: stored.expiresAt,
    source: stored.source as TokenRecord["source"],
    user: stored.user,
    userId: stored.userId,
  };
  if (rec.userId) {
    // A directory token is only as good as its account: disabled or deleted
    // accounts lose access on the very next request. Name/email are refreshed
    // from the database so an edit shows up without signing in again.
    const account = getActiveUserLite(rec.userId);
    if (!account) {
      deleteAuthToken(hash);
      return null;
    }
    rec.user = { email: account.email, name: account.name ?? undefined, picture: rec.user?.picture };
  }
  return rec;
}

function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function clientIpOf(request: IncomingMessage): string {
  // x-forwarded-for is honoured behind a reverse proxy / load balancer (Traefik, ALB, nginx).
  return (
    (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ||
    request.socket.remoteAddress ||
    "unknown"
  );
}

/** Kill every token a directory user holds (optionally sparing the current one). */
function revokeTokensForUser(userId: string, exceptToken?: string): void {
  deleteAuthTokensForUser(userId, exceptToken ? hashToken(exceptToken) : undefined);
}

/**
 * Drop every token that isn't tied to an account. Run once the first account
 * exists: from then on the shared-password / pre-directory tokens must not
 * outlive the switch to personal sign-in.
 */
function purgeAnonymousTokens(): void {
  deleteAnonymousAuthTokens();
}

setSessionRevoker((userId) => revokeTokensForUser(userId));

const authHooks: AuthHooks = {
  issueToken: (userId) => {
    const account = getUserById(userId);
    return issueInternalToken({
      source: "directory",
      userId,
      user: account ? { email: account.email, name: account.name ?? undefined } : undefined,
    });
  },
  ttlSec: Math.floor(INTERNAL_TOKEN_TTL_MS / 1000),
  revokeToken: (token) => {
    deleteAuthToken(hashToken(token));
  },
  revokeUserTokens: revokeTokensForUser,
  bearerOf,
  clientIp: clientIpOf,
  directoryCreated: purgeAnonymousTokens,
};

/**
 * True when the incoming request carries a valid `Authorization: Bearer <token>`
 * header. Used to gate /api/admin/* on the server side so curl users can't
 * bypass the sign-in page.
 *
 * If ASKC4S_INTERNAL_PASSWORD is not set, we treat the system as "no auth wall
 * configured" and allow access — same posture as the password endpoint, so
 * dev environments without the env var keep working.
 */
/**
 * Explicit opt-out of the admin gate, for local development only.
 *
 * This exists because the gate now FAILS CLOSED (see isInternalAuthorized).
 * `npm start` (scripts/dev.mjs) sets it; the Docker images deliberately never do, so a
 * deployed image without ASKC4S_INTERNAL_PASSWORD refuses admin access rather
 * than silently exposing it.
 */
function adminInsecureAllowed(): boolean {
  // Once personal accounts exist the gate has been deliberately turned on, so a
  // stray dev flag can't switch it off — the same rule that applies to the
  // password (see getPrincipal).
  if (directoryActive()) return false;
  return String(process.env.ASKC4S_ADMIN_INSECURE ?? "").trim().toLowerCase() === "true";
}

/**
 * Who is calling, or null when nobody valid is.
 *
 * This is the single answer to "is this request authenticated, and as what".
 * isInternalAuthorized() below is just `getPrincipal(...) !== null`, and the
 * funnel in handleApi uses the principal's role for the permission check.
 */
function getPrincipal(request: IncomingMessage): Principal | null {
  // A valid Bearer token always authorizes, whichever endpoint minted it
  // (personal login, shared-password login OR SSO).
  //
  // This MUST be tested BEFORE any env-var short-circuit. /api/auth/google
  // issues real tokens without ASKC4S_INTERNAL_PASSWORD ever being set, so a
  // deployment can legitimately run SSO-only. The previous ordering checked
  // the password var first and would have rejected those tokens outright —
  // locking out every SSO user the moment the gate started being enforced.
  const token = bearerOf(request);
  const rec = token ? verifyInternalToken(token) : null;
  if (rec) {
    if (rec.userId) {
      const account = getActiveUserLite(rec.userId);
      if (!account) return null;
      return {
        role: account.role,
        source: "directory",
        userId: account.id,
        email: account.email,
        name: account.name ?? undefined,
        mustChangePassword: account.mustChangePassword,
      };
    }
    // Minted before any account existed (shared password, SSO in legacy mode):
    // keeps today's full access. Purged the moment the first account is created.
    return { role: "owner", source: rec.source, email: rec.user?.email, name: rec.user?.name };
  }

  // No valid token.
  //
  // FAIL CLOSED. An unset ASKC4S_INTERNAL_PASSWORD used to mean "no gate
  // configured → allow", which was harmless on localhost but meant hosting the
  // shim with one env var missing silently published the admin API — encrypted
  // secrets, the auto_writeback write gate, table truncation.
  //
  // ASKC4S_ADMIN_INSECURE=true is the explicit developer opt-out, and it is
  // honoured ONLY when no password is configured and no account exists. That
  // way a stray insecure flag copied into a production .env cannot switch off a
  // gate somebody deliberately turned on.
  if (process.env.ASKC4S_INTERNAL_PASSWORD) return null;
  return adminInsecureAllowed() ? { role: "owner", source: "insecure" } : null;
}

function isInternalAuthorized(request: IncomingMessage): boolean {
  return getPrincipal(request) !== null;
}

/**
 * The ONLY /api/* routes reachable without a Bearer token. Everything else is
 * denied by default (see the gate at the top of handleApi).
 *
 * Each entry needs a reason to be here. "The client calls it a lot" is not a
 * reason — the extension, the PWA and the settings page all authenticate.
 */
const PUBLIC_API_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // Container/load-balancer probes run before any credential exists.
  { method: "GET", path: "/api/health" },
  // The login endpoints themselves — gating these would be a deadlock.
  { method: "POST", path: "/api/auth/google" },
  { method: "POST", path: "/api/internal/auth" },
  // Personal-account sign-in (email + password). Throttled per address and
  // locked per account inside verifyLogin; 409s until the first account exists.
  { method: "POST", path: "/api/auth/login" },
  // Local-dev IdP-less login. Self-guards on ASKC4S_ADMIN_INSECURE and 404s
  // otherwise (see the handler), so allowlisting it exposes nothing in prod.
  { method: "POST", path: "/api/auth/dev-login" },
  // Entra OIDC sign-in flow (pre-auth by definition). /providers only reports
  // which options exist; /start + /callback ARE the login. All inert until
  // ENTRA_OIDC_* is configured.
  { method: "GET", path: "/api/auth/providers" },
  { method: "GET", path: "/api/auth/oidc/start" },
  { method: "GET", path: "/api/auth/oidc/callback" },
  // Self-gating: both READ the supplied token and return nothing without one,
  // so they disclose only what the caller already holds.
  { method: "GET", path: "/api/auth/me" },
  { method: "POST", path: "/api/internal/verify" },
  // Deliberate public ingest, already rate-limited per-IP and size-capped.
  // window.onerror must work pre-login.
  { method: "POST", path: "/api/errors" },
];

function isPublicApiRoute(method: string, pathname: string): boolean {
  return PUBLIC_API_ROUTES.some(
    (route) => route.method === method.toUpperCase() && route.path === pathname,
  );
}

/** The only routes a directory user with a temporary password may call. */
const MUST_CHANGE_ALLOWED: ReadonlySet<string> = new Set([
  "/api/auth/change-password",
  "/api/auth/logout",
]);

/**
 * Tools on the /api/tools/<name> dispatcher that WRITE to SAP. Used only to
 * label the response honestly; the gate above is what actually protects them.
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "add_service_request_text",
  "attach_solution_to_ticket",
  "log_service_item",
  "update_ticket_lifecycle",
  "update_ticket_priority",
]);

/** Returns the user identity attached to the request's Bearer token, if any. */
function getCurrentUser(request: IncomingMessage):
  | { email: string; name?: string; picture?: string; source: string }
  | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(header.trim());
  if (!match) return null;
  const rec = verifyInternalToken(match[1]);
  if (!rec || !rec.user) return null;
  return { ...rec.user, source: rec.source };
}

function optionalStringArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number) {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }

  return parsed;
}

// v0.27.69 — like numberArg but accepts fractional values. Needed for
// log_service_item quantity: labour/travel hours are commonly 0.5, 1.5,
// 2.25, etc., and ZALT lines store fractional ActualQuantity.
function floatArg(args: Record<string, unknown>, name: string, fallback: number) {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }
  return parsed;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback = false) {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return value === true || value === "true" || value === 1;
}

function arrayArg(args: Record<string, unknown>, name: string) {
  const value = args[name];

  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  return typeof value === "string" ? splitCsv(value) : [];
}

function firstString(entity: Record<string, unknown> | undefined, keys: string[]) {
  if (!entity) return "";
  for (const key of keys) {
    const value = entity[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function extractEntity(payload: any): Record<string, unknown> {
  if (payload?.d) {
    const inner = payload.d;
    if (inner.results && !Array.isArray(inner.results) && typeof inner.results === "object") {
      return inner.results;
    }
    if (!Array.isArray(inner.results)) return inner;
  }
  return payload ?? {};
}

function recentMetaFromTicket(payload: any) {
  const entity = extractEntity(payload);
  return {
    ticketId: firstString(entity, ["ID", "ServiceRequestID"]) || null,
    title: firstString(entity, ["Name", "SubjectName", "Subject", "Description"]) || null,
    customer: firstString(entity, ["BuyerPartyName", "AccountPartyName", "ProductRecipientPartyName"]) || null,
  };
}

async function cachedGetTicket(args: Record<string, unknown>) {
  const objectId = optionalStringArg(args, "objectId");
  if (!objectId) throw new Error("objectId is required.");

  const refresh = booleanArg(args, "refresh");
  if (!refresh) {
    const cached = readTicketCache(objectId, getSettingNumber("cache.ticket_ttl_ms"));
    if (cached?.fresh) {
      const meta = recentMetaFromTicket(cached.payload);
      touchRecent({ objectId, ...meta });
      return { ...((cached.payload as object) ?? {}), __cache: { hit: true, age: cached.age } };
    }
  }

  const result = await getTicket({
    objectId,
    expand: arrayArg(args, "expand"),
    includeMetadata: booleanArg(args, "includeMetadata"),
  });

  const meta = recentMetaFromTicket(result);
  writeTicketCache({ objectId, ...meta, payload: result });
  touchRecent({ objectId, ...meta });
  return result;
}

async function cachedGetServiceHistory(args: Record<string, unknown>) {
  const objectId = optionalStringArg(args, "objectId");
  if (!objectId) throw new Error("objectId is required.");

  const refresh = booleanArg(args, "refresh");
  if (!refresh) {
    const cached = readHistoryCache(objectId, getSettingNumber("cache.history_ttl_ms"));
    if (cached?.fresh) {
      return { ...((cached.payload as object) ?? {}), __cache: { hit: true, age: cached.age } };
    }
  }

  const result = await getServiceHistory({
    objectId,
    navigationProperty: optionalStringArg(args, "navigationProperty"),
    top: numberArg(args, "top", 20),
    candidateLimit: numberArg(args, "candidateLimit", 5),
    includeDiscovery: booleanArg(args, "includeDiscovery", true),
    refreshMetadata: booleanArg(args, "refreshMetadata"),
  });

  writeHistoryCache(objectId, result);
  return result;
}

async function resolveTicketIdentifier(input: string) {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return { objectId: trimmed, source: "objectId" as const };
  }
  const result: any = await searchTickets({
    top: 1,
    odataFilter: `ID eq ${odataStringLiteral(trimmed)}`,
  });
  const row = result?.d?.results?.[0];
  if (!row?.ObjectID) {
    // Try a fuzzy lookup to give the caller something actionable.
    let suggestion = "";
    try {
      const fuzzy: any = await searchTickets({
        top: 3,
        odataFilter: `substringof('${trimmed.slice(0, 4).replace(/'/g, "''")}',ID)`,
      });
      const ids = (fuzzy?.d?.results ?? []).map((r: any) => r?.ID).filter(Boolean);
      if (ids.length) {
        suggestion = ` Similar IDs visible to this integration user: ${ids.join(", ")}.`;
      } else {
        const highest: any = await searchTickets({ top: 1, orderBy: "ID desc" });
        const max = highest?.d?.results?.[0]?.ID;
        if (max) suggestion = ` Highest ticket ID visible: ${max}. The ID may not exist in this tenant or be outside this user's permission scope.`;
      }
    } catch {
      /* best-effort suggestion */
    }
    throw new Error(`No ticket found with ID '${trimmed}'.${suggestion}`);
  }
  return { objectId: String(row.ObjectID), source: "ticketId" as const, ticketRow: row };
}

function classifyOutcome(toolName: string, result: unknown): CallOutcome {
  const info = getToolInfo(toolName);
  if (info?.storage === "meta") return "cache";
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown> & { source?: string };
    if ((r as any).__cache?.hit === true) return "cache";
    if (r.source === "cache") return "cache";
    if (r.source === "sap") return "sap";
  }
  return "sap";
}

async function withMetrics<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordCall(toolName, Date.now() - start, classifyOutcome(toolName, result));
    return result;
  } catch (err) {
    recordCall(toolName, Date.now() - start, "error");
    throw err;
  }
}

async function runNamedToolInner(toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "search_tickets":
      return searchTickets({
        top: numberArg(args, "top", 10),
        skip: numberArg(args, "skip", 0),
        statusCode: optionalStringArg(args, "statusCode"),
        odataFilter: optionalStringArg(args, "odataFilter"),
        orderBy: optionalStringArg(args, "orderBy")
      });
    case "get_ticket":
      return cachedGetTicket(args);
    case "get_service_metadata": {
      const requestedMode = optionalStringArg(args, "mode");
      return getServiceMetadata({
        mode: requestedMode === "raw" ? "raw" : "summary",
        entitySet: optionalStringArg(args, "entitySet"),
        refresh: booleanArg(args, "refresh")
      });
    }
    case "get_service_history":
      return cachedGetServiceHistory(args);
    case "get_employee_skills":
      return getEmployeeSkills({
        top: numberArg(args, "top", 20),
        ticketSampleSize: numberArg(args, "ticketSampleSize", 100),
        productHint: optionalStringArg(args, "productHint"),
      });
    case "get_account_open_tickets": {
      const buyerPartyId = optionalStringArg(args, "buyerPartyId");
      if (!buyerPartyId) throw new Error("buyerPartyId is required.");
      return getAccountOpenTickets({
        buyerPartyId,
        top: numberArg(args, "top", 25),
        includeClosed: booleanArg(args, "includeClosed"),
        orderBy: optionalStringArg(args, "orderBy"),
      });
    }
    case "get_serial_history": {
      const serialId = optionalStringArg(args, "serialId");
      if (!serialId) throw new Error("serialId is required.");
      return getSerialHistory({
        serialId,
        top: numberArg(args, "top", 25),
        includeClosed: booleanArg(args, "includeClosed", true),
        orderBy: optionalStringArg(args, "orderBy"),
      });
    }
    case "get_ticket_notes": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return getTicketNotes({ objectId, top: numberArg(args, "top", 50) });
    }
    case "get_ticket_kb_articles": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return getTicketKbArticles({ objectId, top: numberArg(args, "top", 25) });
    }
    case "get_ticket_items": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return getTicketItems({ objectId, top: numberArg(args, "top", 50) });
    }
    case "get_resolution_hints": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return getResolutionHints({
        objectId,
        pastTicketsTop: numberArg(args, "pastTicketsTop", 5),
      });
    }
    case "search_kb_articles": {
      const query = optionalStringArg(args, "query");
      if (!query) throw new Error("query is required.");
      return searchKbArticles({ query, top: numberArg(args, "top", 10) });
    }
    case "search_kb_for_ticket": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      const queriesArg = (args as any)?.queries;
      const queries = Array.isArray(queriesArg)
        ? queriesArg.map((q: unknown) => String(q)).filter((q) => q.length > 0)
        : undefined;
      return searchKbForTicket({
        objectId,
        queries,
        topPerQuery: numberArg(args, "topPerQuery", 6),
      });
    }
    case "get_kb_api_status":
      return getKbApiStatus();
    case "find_similar_tickets": {
      // Semantic search over locally-embedded tickets.
      // Args: { query: string, top?: number, excludeObjectId?: string }
      const query = optionalStringArg(args, "query");
      if (!query) throw new Error("query is required.");
      const { findSimilarTickets } = await import("./embeddings.js");
      return findSimilarTickets({
        query,
        top: numberArg(args, "top", 5),
        excludeObjectId: optionalStringArg(args, "excludeObjectId"),
      });
    }
    case "embeddings_status": {
      // Quick health check: is embedding generation configured? How many
      // tickets are indexed for the active tenant?
      const { embeddingsConfigured } = await import("./embeddings.js");
      const { countTenantEmbeddings } = await import("./cache.js");
      const { getTenantId } = await import("./c4cClient.js");
      const tenantId = getTenantId() || "default";
      return {
        configured: embeddingsConfigured(),
        tenantId,
        indexedCount: countTenantEmbeddings(tenantId),
      };
    }
    case "search_parts":
      return searchParts({
        query: optionalStringArg(args, "query"),
        top: numberArg(args, "top", 25),
      });
    case "get_part_availability": {
      const materialId = optionalStringArg(args, "materialId");
      if (!materialId) throw new Error("materialId is required.");
      return getPartAvailability({ materialId, top: numberArg(args, "top", 50) });
    }
    case "get_duration_stats":
      return getDurationStats({
        productId: optionalStringArg(args, "productId"),
        buyerPartyId: optionalStringArg(args, "buyerPartyId"),
        sampleSize: numberArg(args, "sampleSize", 100),
      });
    case "attach_kb_article": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return attachKbArticle({
        objectId,
        articleId: optionalStringArg(args, "articleId"),
        articleUri: optionalStringArg(args, "articleUri"),
        description: optionalStringArg(args, "description"),
        note: optionalStringArg(args, "note"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "get_account": {
      const accountId = optionalStringArg(args, "accountId");
      if (!accountId) throw new Error("accountId is required.");
      return getAccount({ accountId });
    }
    case "get_sla_at_risk":
      return getSlaAtRisk({
        hoursAhead: numberArg(args, "hoursAhead", 24),
        top: numberArg(args, "top", 50),
      });
    case "search_employees":
      return searchEmployees({
        query: optionalStringArg(args, "query"),
        region: optionalStringArg(args, "region"),
        top: numberArg(args, "top", 25),
      });
    case "get_my_tickets":
      return getMyTickets({
        processorPartyId: optionalStringArg(args, "processorPartyId"),
        processorPartyUuid: optionalStringArg(args, "processorPartyUuid"),
        top: numberArg(args, "top", 25),
        includeClosed: booleanArg(args, "includeClosed"),
        orderBy: optionalStringArg(args, "orderBy"),
      });
    case "get_my_team_tickets":
      return getMyTeamTickets({
        teamPartyId: optionalStringArg(args, "teamPartyId"),
        teamPartyUuid: optionalStringArg(args, "teamPartyUuid"),
        top: numberArg(args, "top", 50),
        includeClosed: booleanArg(args, "includeClosed"),
        orderBy: optionalStringArg(args, "orderBy"),
      });
    case "get_account_contacts": {
      const accountId = optionalStringArg(args, "accountId");
      if (!accountId) throw new Error("accountId is required.");
      return getAccountContacts({ accountId, top: numberArg(args, "top", 25) });
    }
    case "search_appointments":
      return searchAppointments({
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        top: numberArg(args, "top", 25),
        orderBy: optionalStringArg(args, "orderBy"),
      });
    case "list_code_lists":
      return { lists: listAvailableCodeLists() };
    case "get_code_list": {
      const name = optionalStringArg(args, "name");
      if (!name) throw new Error("name is required.");
      return getCodeList(name, { refresh: booleanArg(args, "refresh") });
    }
    // ---- Tier 1 activity reads ----
    case "search_tasks":
      return searchTasks({
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        status: optionalStringArg(args, "status"),
        top: numberArg(args, "top", 25),
      });
    case "search_phone_calls":
      return searchPhoneCalls({
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        top: numberArg(args, "top", 25),
      });
    case "search_emails":
      return searchEmails({
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        top: numberArg(args, "top", 25),
        includeBody: Boolean((args as any)?.includeBody),
      });
    case "search_chats":
      return searchChats({
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        top: numberArg(args, "top", 25),
      });
    case "get_communication_stream": {
      const accountPartyId = optionalStringArg(args, "accountPartyId");
      if (!accountPartyId) throw new Error("accountPartyId is required.");
      return getCommunicationStream({
        accountPartyId,
        topPerType: numberArg(args, "topPerType", 10),
      });
    }
    case "get_contract": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return getContract({ objectId });
    }
    case "get_contracts_for_account": {
      const buyerPartyId = optionalStringArg(args, "buyerPartyId");
      if (!buyerPartyId) throw new Error("buyerPartyId is required.");
      return getContractsForAccount({ buyerPartyId, top: numberArg(args, "top", 25) });
    }
    case "get_contract_items": {
      const contractObjectId = optionalStringArg(args, "contractObjectId");
      if (!contractObjectId) throw new Error("contractObjectId is required.");
      return getContractItems({ contractObjectId, top: numberArg(args, "top", 50) });
    }
    case "search_sales_quotes":
      return searchSalesQuotes({
        buyerPartyId: optionalStringArg(args, "buyerPartyId"),
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        top: numberArg(args, "top", 25),
      });
    case "search_customer_orders":
      return searchCustomerOrders({
        buyerPartyId: optionalStringArg(args, "buyerPartyId"),
        top: numberArg(args, "top", 25),
      });
    case "search_opportunities":
      return searchOpportunities({
        buyerPartyId: optionalStringArg(args, "buyerPartyId"),
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        top: numberArg(args, "top", 25),
      });
    case "search_org_units":
      return searchOrgUnits({
        query: optionalStringArg(args, "query"),
        top: numberArg(args, "top", 50),
      });
    case "get_team_roster": {
      const orgUnitId = optionalStringArg(args, "orgUnitId");
      if (!orgUnitId) throw new Error("orgUnitId is required.");
      return getTeamRoster({ orgUnitId, top: numberArg(args, "top", 100) });
    }
    case "get_survey_responses":
      return getSurveyResponses({
        ticketObjectId: optionalStringArg(args, "ticketObjectId"),
        top: numberArg(args, "top", 25),
      });
    case "get_issue_category_tree":
      return getIssueCategoryTree({ top: numberArg(args, "top", 50) });

    // ---- Tier 2 writes (all gated by runGatedWrite) ----
    case "update_ticket_description": {
      const objectId = optionalStringArg(args, "objectId");
      const description = optionalStringArg(args, "description");
      if (!objectId || !description) throw new Error("objectId and description are required.");
      return updateTicketDescription({
        objectId,
        description,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "update_ticket_priority": {
      const objectId = optionalStringArg(args, "objectId");
      const servicePriorityCode = optionalStringArg(args, "servicePriorityCode");
      if (!objectId || !servicePriorityCode) throw new Error("objectId and servicePriorityCode are required.");
      return updateTicketPriority({
        objectId,
        servicePriorityCode,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "update_ticket_lifecycle": {
      const objectId = optionalStringArg(args, "objectId");
      const lifecycleStatusCode = optionalStringArg(args, "lifecycleStatusCode");
      if (!objectId || !lifecycleStatusCode) throw new Error("objectId and lifecycleStatusCode are required.");
      return updateTicketLifecycle({
        objectId,
        lifecycleStatusCode,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "escalate_ticket": {
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return escalateTicket({
        objectId,
        reason: optionalStringArg(args, "reason"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "assign_processor": {
      const objectId = optionalStringArg(args, "objectId");
      const processorPartyUuid = optionalStringArg(args, "processorPartyUuid");
      if (!objectId || !processorPartyUuid) throw new Error("objectId and processorPartyUuid are required.");
      return assignProcessor({
        objectId,
        processorPartyUuid,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "assign_team": {
      const objectId = optionalStringArg(args, "objectId");
      const teamPartyId = optionalStringArg(args, "teamPartyId");
      if (!objectId || !teamPartyId) throw new Error("objectId and teamPartyId are required.");
      return assignTeam({
        objectId,
        teamPartyId,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "add_service_request_text": {
      const objectId = optionalStringArg(args, "objectId");
      const text = optionalStringArg(args, "text");
      if (!objectId || !text) throw new Error("objectId and text are required.");
      return addServiceRequestText({
        objectId,
        text,
        typeCode: optionalStringArg(args, "typeCode"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "attach_solution_to_ticket": {
      // v0.27.40 — write a row into the ticket's "Solutions Used" facet
      // (ServiceRequestSolutionProposalCollection) referencing an
      // external KB article. Used by the /kb-resolve "Mark as
      // resolution" button alongside the TypeCode-10022 note.
      const objectId = optionalStringArg(args, "objectId");
      if (!objectId) throw new Error("objectId is required.");
      return attachSolutionToTicket({
        objectId,
        articleId: optionalStringArg(args, "articleId"),
        articleUri: optionalStringArg(args, "articleUri"),
        articleDescription: optionalStringArg(args, "articleDescription"),
        note: optionalStringArg(args, "note"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "log_service_item": {
      const objectId = optionalStringArg(args, "objectId");
      const processingTypeCode = optionalStringArg(args, "processingTypeCode") as any;
      const productId = optionalStringArg(args, "productId");
      if (!objectId || !processingTypeCode || !productId) {
        throw new Error("objectId, processingTypeCode and productId are required.");
      }
      return logServiceItem({
        objectId,
        processingTypeCode,
        productId,
        // v0.27.69 — floatArg (was numberArg): hours/qty can be fractional.
        quantity: floatArg(args, "quantity", 1),
        uomCode: optionalStringArg(args, "uomCode"),
        warrantyCode: optionalStringArg(args, "warrantyCode"),
        servicePerformerPartyId: optionalStringArg(args, "servicePerformerPartyId"),
        // v0.27.42 — SRP1 consumption quantity shape (Planned = Actual),
        // used by the explicit "Retry as <code>" flow in the panel.
        plannedEqualsActual: booleanArg(args, "plannedEqualsActual", false),
        // v0.27.72 — Book Time: start/end as epoch ms → post-create PATCH of
        // ActualStart/EndDateTime (the columns the operator reads). SAP forbids
        // Actual* on create, so logServiceItem creates then PATCHes.
        actualStartMs: (args as any)?.actualStartMs,
        actualEndMs: (args as any)?.actualEndMs,
        // v0.27.69 — Requested* still honored if a caller sends them.
        requestedStartMs: (args as any)?.requestedStartMs,
        requestedEndMs: (args as any)?.requestedEndMs,
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "update_service_item_actuals": {
      const itemObjectId = optionalStringArg(args, "itemObjectId");
      if (!itemObjectId) throw new Error("itemObjectId is required.");
      const aq = (args as any).actualQuantity;
      return updateServiceItemActuals({
        itemObjectId,
        actualQuantity: typeof aq === "number" ? aq : aq != null ? Number(aq) : undefined,
        actualStartDateTime: optionalStringArg(args, "actualStartDateTime"),
        actualEndDateTime: optionalStringArg(args, "actualEndDateTime"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "create_followup_task": {
      const subject = optionalStringArg(args, "subject");
      if (!subject) throw new Error("subject is required.");
      return createFollowupTask({
        subject,
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        dueDateTime: optionalStringArg(args, "dueDateTime"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "create_appointment": {
      const subject = optionalStringArg(args, "subject");
      const startDateTime = optionalStringArg(args, "startDateTime");
      const endDateTime = optionalStringArg(args, "endDateTime");
      if (!subject || !startDateTime || !endDateTime) {
        throw new Error("subject, startDateTime, endDateTime are required.");
      }
      return createAppointment({
        subject,
        startDateTime,
        endDateTime,
        ownerPartyId: optionalStringArg(args, "ownerPartyId"),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        location: optionalStringArg(args, "location"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "log_phone_call": {
      const subject = optionalStringArg(args, "subject");
      const startDateTime = optionalStringArg(args, "startDateTime");
      if (!subject || !startDateTime) throw new Error("subject and startDateTime are required.");
      return logPhoneCall({
        subject,
        startDateTime,
        endDateTime: optionalStringArg(args, "endDateTime"),
        initiatorCode: (optionalStringArg(args, "initiatorCode") as "1" | "2" | undefined),
        accountPartyId: optionalStringArg(args, "accountPartyId"),
        contactPartyId: optionalStringArg(args, "contactPartyId"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }
    case "add_account_contact": {
      const accountId = optionalStringArg(args, "accountId");
      const firstName = optionalStringArg(args, "firstName");
      const lastName = optionalStringArg(args, "lastName");
      if (!accountId || !firstName || !lastName) {
        throw new Error("accountId, firstName, lastName are required.");
      }
      return addAccountContact({
        accountId,
        firstName,
        lastName,
        email: optionalStringArg(args, "email"),
        phone: optionalStringArg(args, "phone"),
        jobTitle: optionalStringArg(args, "jobTitle"),
        dryRun: booleanArg(args, "dryRun", true),
        acknowledgeProduction: booleanArg(args, "acknowledgeProduction", false),
      });
    }

    // ---- Tier 3 analytics ----
    case "get_first_time_fix_rate":
      return getFirstTimeFixRate({
        productId: optionalStringArg(args, "productId"),
        sampleSize: numberArg(args, "sampleSize", 100),
      });
    case "get_repeat_visit_rate":
      return getRepeatVisitRate({
        productId: optionalStringArg(args, "productId"),
        windowDays: numberArg(args, "windowDays", 90),
        sampleSize: numberArg(args, "sampleSize", 300),
      });
    case "get_mttr_by_product": {
      const productId = optionalStringArg(args, "productId");
      if (!productId) throw new Error("productId is required.");
      return getMttrByProduct({ productId, sampleSize: numberArg(args, "sampleSize", 100) });
    }
    case "get_workload_distribution":
      return getWorkloadDistribution({
        teamPartyId: optionalStringArg(args, "teamPartyId"),
        sampleSize: numberArg(args, "sampleSize", 200),
      });
    case "get_recurring_issues":
      return getRecurringIssues({
        productId: optionalStringArg(args, "productId"),
        sampleSize: numberArg(args, "sampleSize", 300),
      });

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function runNamedTool(toolName: string, args: Record<string, unknown>) {
  return withMetrics(toolName, () => runNamedToolInner(toolName, args));
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  try {
    const parts = routeParts(url.pathname);

    // -----------------------------------------------------------------------
    // AUTH GATE — deny by default.
    //
    // Every /api/* request funnels through here, so this is the one place that
    // can guarantee coverage. It is written as an allowlist ON PURPOSE: the
    // previous design guarded routes one-by-one, and the route that mattered
    // most was the one nobody remembered to guard. POST /api/tools/<name> ran
    // `runNamedTool` with no token at all, and that surface includes the SAP
    // WRITE tools (log_service_item, add_service_request_text,
    // attach_solution_to_ticket, update_ticket_lifecycle,
    // update_ticket_priority). The caller supplies dryRun:false and
    // acknowledgeProduction:true, and feature.auto_writeback_enabled is a
    // server-side flag that is ON for this tenant — so hosting the shim would
    // have let anyone with the URL write to the customer's live SAP.
    //
    // With an allowlist, a new route is protected the moment it is added and
    // exposing one becomes a deliberate, reviewable act.
    // -----------------------------------------------------------------------
    const publicRoute = isPublicApiRoute(request.method ?? "GET", url.pathname);
    const principal = publicRoute ? null : getPrincipal(request);
    if (!publicRoute && !principal) {
      sendJson(response, 401, {
        ok: false,
        error:
          `Unauthorized. ${url.pathname} requires a Bearer token. ` +
          `Sign in (extension: Options → Sign in; PWA/settings: the login screen) ` +
          `or set ASKC4S_ADMIN_INSECURE=true for local development.`,
      });
      return;
    }

    // ROLES — the one route-level permission check, in the same funnel for the
    // same reason as the allowlist above: a check that lives in each route is a
    // check somebody forgets. SAP writes are role-checked where they converge
    // (the shared write gate), not here.
    if (principal) {
      // A temporary password is only good for choosing a real one.
      if (principal.mustChangePassword && !MUST_CHANGE_ALLOWED.has(url.pathname)) {
        sendJson(response, 403, {
          ok: false,
          code: "password_change_required",
          error: "Set a new password before continuing (Options → Account in the extension, or the sign-in screen).",
        });
        return;
      }
      const need = requiredPermission(request.method ?? "GET", url.pathname);
      if (need && !can(principal.role, need)) {
        sendJson(response, 403, {
          ok: false,
          error: `Forbidden. Your role (${principal.role}) can't do this (${need}). Ask an owner or admin.`,
        });
        return;
      }
    }

    if (url.pathname === "/api/tools" && request.method === "GET") {
      sendJson(response, 200, { tools: toolDefinitions });
      return;
    }

    if (parts[0] === "api" && parts[1] === "tools" && parts[2] && request.method === "POST") {
      const args = await readJsonBody(request);
      sendJson(response, 200, {
        tool: parts[2],
        // NOT read-only: this dispatcher reaches the SAP write tools too. The
        // field used to be hard-coded `true`, which was simply false and made
        // the route look harmless in logs and to anyone reading this handler.
        readOnly: !WRITE_TOOL_NAMES.has(parts[2]),
        result: await runNamedTool(parts[2], args)
      });
      return;
    }

    if (url.pathname === "/api/recent" && request.method === "GET") {
      const limit = numberParam(url, "limit", 25, 1, 100);
      sendJson(response, 200, { items: listRecent(limit) });
      return;
    }

    if (url.pathname === "/api/code-lists" && request.method === "GET") {
      sendJson(response, 200, { lists: listAvailableCodeLists() });
      return;
    }

    if (parts[0] === "api" && parts[1] === "code-lists" && parts[2] && !parts[3] && request.method === "GET") {
      const refresh = booleanParam(url, "refresh");
      sendJson(response, 200, await getCodeList(parts[2], { refresh }));
      return;
    }

    if (url.pathname === "/api/code-lists/refresh" && request.method === "POST") {
      const body = await readJsonBody(request).catch(() => ({}));
      const targetName = optionalStringArg(body, "name") ?? optionalParam(url, "name");
      if (targetName) {
        sendJson(response, 200, await getCodeList(targetName, { refresh: true }));
      } else {
        sendJson(response, 200, { results: await refreshAllCodeLists() });
      }
      return;
    }

    if (parts[0] === "api" && parts[1] === "code-lists" && parts[2] && request.method === "DELETE") {
      purgeCodeList(parts[2]);
      sendJson(response, 200, { ok: true, purged: parts[2] });
      return;
    }

    // -----------------------------------------------------------------------
    // /api/admin/* — gated by ADMIN_ENABLED=true + a valid bearer token (a
    // personal account's, or the shared password's before accounts exist).
    // The role check for each admin route already ran in the funnel above.
    // -----------------------------------------------------------------------
    if (parts[0] === "api" && parts[1] === "admin") {
      if (!isAdminEnabled()) {
        sendJson(response, 403, {
          error: "Admin disabled. Set ADMIN_ENABLED=true on the server to enable /api/admin/*",
        });
        return;
      }
      if (!isInternalAuthorized(request)) {
        sendJson(response, 401, {
          error:
            "Unauthorized. /api/admin/* requires a valid token. Sign in at /settings, or POST the shared password to /api/internal/auth and pass the returned token as `Authorization: Bearer <token>`.",
        });
        return;
      }

      // ---------------------------------------------------------------------
      // The admin surface: settings, users and the SAP tenant catalog (plus
      // the connection probe the Tenants tab uses). Nothing else mounts under
      // /api/admin — there is no console hidden behind a flag.
      // ---------------------------------------------------------------------
      if (parts[2] === "users") {
        await handleAdminUsers(
          { request, response, url, parts, principal, sendJson, readJson: readJsonBody },
          authHooks,
        );
        return;
      }

      const actor = request.headers["x-admin-actor"];
      const ctx = {
        // The identity comes from the token, not the header: X-Admin-Actor is
        // client-supplied, so it's only a fallback for tokens with no identity
        // (shared password / local dev).
        actor: principal?.email ?? (typeof actor === "string" ? actor : null),
      };

      if (url.pathname === "/api/admin/settings" && request.method === "GET") {
        sendJson(response, 200, await adminApi.listSettings(ctx));
        return;
      }
      if (parts[2] === "settings" && parts[3] && !parts[4] && request.method === "GET") {
        sendJson(response, 200, await adminApi.getSetting(ctx, parts[3]));
        return;
      }
      if (parts[2] === "settings" && parts[3] && !parts[4] && request.method === "PUT") {
        const body = await readJsonBody(request);
        const rawValue = (body as any)?.value;
        sendJson(response, 200, await adminApi.setSetting(ctx, parts[3], rawValue));
        return;
      }
      if (parts[2] === "settings" && parts[3] && !parts[4] && request.method === "DELETE") {
        sendJson(response, 200, await adminApi.resetSetting(ctx, parts[3]));
        return;
      }

      // Probe typed-in credentials — the Tenants tab's "Test connection" before a save.
      if (url.pathname === "/api/admin/tenant/test" && request.method === "POST") {
        const body = (await readJsonBody(request)) as any;
        sendJson(
          response,
          200,
          await adminApi.testTenantConfig(ctx, {
            baseUrl: String(body?.baseUrl ?? ""),
            user: String(body?.user ?? ""),
            password: String(body?.password ?? ""),
          }),
        );
        return;
      }

      // Tenant catalog
      if (url.pathname === "/api/admin/tenants" && request.method === "GET") {
        sendJson(response, 200, await adminApi.listTenantCatalog(ctx));
        return;
      }
      if (url.pathname === "/api/admin/tenants" && request.method === "POST") {
        const body = (await readJsonBody(request)) as any;
        sendJson(
          response,
          200,
          await adminApi.upsertCatalogTenant(ctx, {
            label: String(body?.label ?? ""),
            environment: String(body?.environment ?? "other") as any,
            baseUrl: String(body?.baseUrl ?? ""),
            user: String(body?.user ?? ""),
            password: body?.password ? String(body.password) : undefined,
            notes: body?.notes ? String(body.notes) : undefined,
          }),
        );
        return;
      }
      if (parts[2] === "tenants" && parts[3] && !parts[4] && request.method === "PATCH") {
        const body = (await readJsonBody(request)) as any;
        sendJson(
          response,
          200,
          await adminApi.upsertCatalogTenant(ctx, {
            id: parts[3],
            label: String(body?.label ?? ""),
            environment: String(body?.environment ?? "other") as any,
            baseUrl: String(body?.baseUrl ?? ""),
            user: String(body?.user ?? ""),
            password: body?.password ? String(body.password) : undefined,
            notes: body?.notes ? String(body.notes) : undefined,
          }),
        );
        return;
      }
      if (parts[2] === "tenants" && parts[3] && parts[4] === "test" && request.method === "POST") {
        const result = (await adminApi.testCatalogTenant(ctx, parts[3])) as { notFound?: boolean };
        sendJson(response, result.notFound ? 404 : 200, result);
        return;
      }
      if (parts[2] === "tenants" && parts[3] && parts[4] === "activate" && request.method === "POST") {
        sendJson(response, 200, await adminApi.activateCatalogTenant(ctx, parts[3]));
        return;
      }
      if (parts[2] === "tenants" && parts[3] && !parts[4] && request.method === "DELETE") {
        sendJson(response, 200, await adminApi.deleteCatalogTenant(ctx, parts[3]));
        return;
      }

      sendJson(response, 404, { error: "Admin route not found." });
      return;
    }

    if (url.pathname === "/api/resolve-id" && request.method === "POST") {
      const body = await readJsonBody(request);
      const input = optionalStringArg(body, "input") ?? optionalStringArg(body, "ticketId") ?? optionalStringArg(body, "objectId");
      if (!input) {
        sendJson(response, 400, { error: "input is required (ticket ID or ObjectID)." });
        return;
      }
      sendJson(response, 200, await resolveTicketIdentifier(input));
      return;
    }

    if (url.pathname === "/api/lookup" && request.method === "POST") {
      const body = await readJsonBody(request);
      const input = optionalStringArg(body, "input") ?? optionalStringArg(body, "ticketId") ?? optionalStringArg(body, "objectId");
      if (!input) {
        sendJson(response, 400, { error: "input is required (ticket ID or ObjectID)." });
        return;
      }
      const refresh = booleanArg(body, "refresh");
      const resolved = await resolveTicketIdentifier(input);
      const [ticket, history] = await Promise.all([
        withMetrics("get_ticket", () =>
          cachedGetTicket({ objectId: resolved.objectId, refresh }),
        ),
        withMetrics("get_service_history", () =>
          cachedGetServiceHistory({ objectId: resolved.objectId, refresh }),
        ),
      ]);
      sendJson(response, 200, {
        resolved,
        ticket,
        history,
      });
      /*
       * Fire-and-forget: embed the freshly-fetched ticket so the RAG
       * panel ("Similar tickets") has something to search against.
       * Composite text = title + product + customer + recent note bodies.
       * Skipped when OPENAI_API_KEY isn't configured.
       */
      void (async () => {
        try {
          const { ensureTicketEmbedding } = await import("./embeddings.js");
          const t: any = ticket?.ticket ?? ticket;
          const title = String(t?.Name ?? t?.title ?? "").trim();
          const product = String(t?.ProductID ?? t?.product ?? "").trim();
          const customer = String(t?.BuyerPartyName ?? t?.customer ?? "").trim();
          const status = String(
            t?.ServiceRequestUserLifeCycleStatusCodeText ?? t?.status ?? "",
          ).trim();
          const noteText: string[] = [];
          // history can be either the canonical-shape envelope { history: [...] }
          // or a thin cache-wrapper without the `history` key — cast to any so
          // we don't need to thread two type variants through this hot path.
          const groups: any[] = (history as any)?.history ?? [];
          for (const g of groups) {
            if (g?.navigationProperty !== "ServiceRequestText") continue;
            const rows: any[] = g?.data?.d?.results ?? [];
            for (const r of rows.slice(0, 3)) {
              if (typeof r?.Text === "string") noteText.push(r.Text.slice(0, 400));
            }
          }
          const composite = [
            title && `Title: ${title}`,
            product && `Product: ${product}`,
            customer && `Customer: ${customer}`,
            status && `Status: ${status}`,
            noteText.length > 0 && `Notes:\n${noteText.join("\n")}`,
          ]
            .filter(Boolean)
            .join("\n");
          if (composite) {
            await ensureTicketEmbedding({
              objectId: resolved.objectId,
              text: composite,
            });
          }
        } catch (err) {
          // Embeddings are best-effort — never fail the user-visible lookup
          // because of an embedding-side error.
          console.warn("[embeddings] auto-embed failed:", err instanceof Error ? err.message : err);
        }
      })();
      return;
    }

    /**
     * /api/inspect_line_items — v0.26.71 diagnostic endpoint.
     *
     * Returns the most recent existing ServiceRequestItem on a ticket
     * with its raw field shape (minus __metadata). Used by the
     * /order-parts panel's "🔬 Show schema" button so operators can see
     * the field names + values without scrolling the shim console.
     */
    if (url.pathname === "/api/inspect_line_items" && request.method === "GET") {
      const objectId = url.searchParams.get("objectId")?.trim();
      if (!objectId) {
        sendJson(response, 400, { error: "objectId query param is required." });
        return;
      }
      // v0.26.83 — optional top param. Defaults to 3 (back-compat for
      // the v0.26.71 diagnostic panel). The inference path uses top=30
      // so it sees most/all line items on each similar ticket.
      const topRaw = url.searchParams.get("top");
      const top = topRaw ? Math.min(Math.max(parseInt(topRaw, 10) || 3, 1), 100) : 3;
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        const result: any = await c4cGet("/ServiceRequestItemCollection", {
          "$format": "json",
          "$top": top,
          "$orderby": "ID desc",
          "$filter": `ParentObjectID eq '${objectId.replace(/'/g, "''")}'`,
        });
        const rows: any[] = result?.d?.results ?? [];
        const strip = (r: any) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k === "__metadata") continue;
            if (v && typeof v === "object" && "__deferred" in (v as Record<string, unknown>)) continue;
            out[k] = v;
          }
          return out;
        };
        const items = rows.map(strip);
        sendJson(response, 200, {
          ok: true,
          objectId,
          count: items.length,
          fieldNames: items[0] ? Object.keys(items[0]).sort() : [],
          items,
        });
      } catch (e: any) {
        sendJson(response, 500, {
          ok: false,
          error: e?.message ?? String(e),
        });
      }
      return;
    }

    /**
     * /api/get_ticket_activities — v0.26.106. Fetches email + phone +
     * appointment activities linked to a service request. SAP C4C
     * exposes these under several different navigation/collection
     * names depending on tenant config; we try paths in priority
     * order and return the first non-empty result, along with a
     * `tried` array so the operator can see which path won (or none).
     *
     * Used by /interactions to surface the emails / phone calls /
     * appointments that don't appear in ServiceRequestTextCollection
     * (notes only).
     */
    if (url.pathname === "/api/get_ticket_activities" && request.method === "GET") {
      const objectId = url.searchParams.get("objectId")?.trim();
      // v0.26.107 — also accept ticketId so we can filter Email/Activity
      // entities by the human-readable ID on tenants where the FK isn't
      // the ObjectID (UUID).
      const ticketId = url.searchParams.get("ticketId")?.trim() || "";
      // v0.26.112 — also accept accountPartyId for customer-scoped
      // fallback. On Thermo Fisher's tenant, EMailCollection.TicketID is
      // never populated, but MainAccountPartyID always is — so pulling
      // emails by customer then post-filtering by Subject substring
      // catches the emails actually linked to this ticket.
      const accountPartyId = url.searchParams.get("accountPartyId")?.trim() || "";
      if (!objectId) {
        sendJson(response, 400, { error: "objectId query param is required" });
        return;
      }
      const oid = objectId.replace(/'/g, "''");
      const tid = ticketId.replace(/'/g, "''");
      const acct = accountPartyId.replace(/'/g, "''");
      // v0.26.117 — strip preserves __deferred URIs into a `_navLinks`
      // map so downstream resolvers can use them as fallback FKs when
      // the FK isn't exposed as a scalar field. Same as before for
      // __metadata (always drop) and inline objects.
      const strip = (r: any) => {
        const out: Record<string, unknown> = {};
        const navLinks: Record<string, string> = {};
        for (const [k, v] of Object.entries(r || {})) {
          if (k === "__metadata") continue;
          if (v && typeof v === "object" && "__deferred" in (v as Record<string, unknown>)) {
            const uri = (v as any).__deferred?.uri;
            if (typeof uri === "string") navLinks[k] = uri;
            continue;
          }
          // Inline-expanded relations come as plain objects (or {results: []}).
          // Keep them as-is so $expand returns linked entities.
          out[k] = v;
        }
        if (Object.keys(navLinks).length > 0) out._navLinks = navLinks;
        return out;
      };
      // v0.26.107 — UNION strategy instead of "first non-empty wins":
      // emails and phone-calls live in different collections, so a tenant
      // could have 2 emails in EMailCollection AND 3 calls in
      // ActivityCollection. Stopping after the first non-empty would miss
      // the second half. We now fire EVERY attempt, dedupe by ObjectID,
      // and return the union.
      const attempts: Array<{
        path: string;
        query: Record<string, string | number>;
        label: string;
        needsTicketId?: boolean;
        needsAccountPartyId?: boolean;
        postFilter?: (rows: any[]) => any[];
      }> = [
        {
          label: "ServiceRequest navigation → Activities",
          path: `/ServiceRequestCollection('${oid}')/Activities`,
          query: { "$format": "json", "$top": 100 },
        },
        {
          label: "ServiceRequest navigation → ServiceRequestActivities",
          path: `/ServiceRequestCollection('${oid}')/ServiceRequestActivities`,
          query: { "$format": "json", "$top": 100 },
        },
        {
          label: "ServiceRequest navigation → EmailActivities",
          path: `/ServiceRequestCollection('${oid}')/EmailActivities`,
          query: { "$format": "json", "$top": 100 },
        },
        {
          label: "ServiceRequest navigation → PhoneCallActivities",
          path: `/ServiceRequestCollection('${oid}')/PhoneCallActivities`,
          query: { "$format": "json", "$top": 100 },
        },
        {
          label: "ServiceRequest navigation → AppointmentActivities",
          path: `/ServiceRequestCollection('${oid}')/AppointmentActivities`,
          query: { "$format": "json", "$top": 100 },
        },
        {
          label: "ServiceRequest navigation → BusinessTransactionDocumentReference",
          path: `/ServiceRequestCollection('${oid}')/BusinessTransactionDocumentReference`,
          query: { "$format": "json", "$top": 100 },
        },
        // v0.26.114 — DISCOVERED via navigation auto-probe in v0.26.113.
        // The reporter's tenant exposes these EXACT navigation property
        // names on ServiceRequest (NB: all are PREFIXED with
        // "ServiceRequest", which is why v0.26.113's bare-name probes
        // 404'd). ServiceRequestBusinessTransactionDocumentReference is
        // SAP's canonical link to all related transaction documents
        // (emails, follow-ups, sub-tickets, notifications, etc.) — the
        // primary winner for "show me the emails on this ticket".
        // v0.26.116 — REMOVED the 🔗 probes for ServiceRequestHistorical
        // Version, ServiceRequestSolutionProposal,
        // ServiceRequestServiceReferenceObject, and
        // ServiceRequestAttachmentFolder. They return rows (the
        // ticket's own state snapshots, KB solutions, contract refs,
        // and attachments respectively) but NONE of them are
        // interactions in the operator's mental model. They polluted
        // the timeline with field dumps like "ParentObjectID: 0AFFC..."
        // that nobody finds useful. The Document-Flow probe is the
        // only one that links to actual customer-touching entities.
        {
          label: "⭐⭐ ServiceRequest → ServiceRequestBusinessTransactionDocumentReference",
          path: `/ServiceRequestCollection('${oid}')/ServiceRequestBusinessTransactionDocumentReference`,
          query: { "$format": "json", "$top": 100 },
        },
        // v0.26.117 — try $expand to inline the linked email entity.
        // SAP might expose the FK only as a navigation property (not a
        // scalar field), in which case $expand returns the linked
        // entity's content directly in the response.
        {
          label: "⭐⭐⭐ ServiceRequestBusinessTransactionDocumentReference ($expand=BusinessTransactionDocument)",
          path: `/ServiceRequestCollection('${oid}')/ServiceRequestBusinessTransactionDocumentReference`,
          query: { "$format": "json", "$top": 100, "$expand": "BusinessTransactionDocument" },
        },
        {
          label: "⭐⭐⭐ ServiceRequestBusinessTransactionDocumentReference ($expand=ItemBusinessTransactionDocument)",
          path: `/ServiceRequestCollection('${oid}')/ServiceRequestBusinessTransactionDocumentReference`,
          query: { "$format": "json", "$top": 100, "$expand": "ItemBusinessTransactionDocument" },
        },
        {
          label: "EMailCollection filtered by ServiceRequestObjectID",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ServiceRequestObjectID eq '${oid}'`, "$orderby": "CreationDateTime desc" },
        },
        {
          label: "EMailCollection filtered by ReferenceObjectID",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ReferenceObjectID eq '${oid}'`, "$orderby": "CreationDateTime desc" },
        },
        {
          label: "EMailCollection filtered by MainReferenceObjectID",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `MainReferenceObjectID eq '${oid}'`, "$orderby": "CreationDateTime desc" },
        },
        // v0.26.107 — ticketId-keyed variants (human-readable ID)
        {
          label: "EMailCollection filtered by ServiceRequestID (ticketId)",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ServiceRequestID eq '${tid}'`, "$orderby": "CreationDateTime desc" },
          needsTicketId: true,
        },
        {
          label: "EMailCollection filtered by ReferenceID (ticketId)",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ReferenceID eq '${tid}'`, "$orderby": "CreationDateTime desc" },
          needsTicketId: true,
        },
        // v0.26.109 — schema-discovery confirmed Thermo Fisher's tenant
        // exposes `TicketID` as the FK on EMailCollection. Try the same
        // field name on all four collections since they share the same
        // convention by hypothesis. ⭐ These are the most likely winners.
        // v0.26.110 — TicketID might be typed as Edm.Int32 (number) in
        // SAP's metadata. Try BOTH quoted (string) and unquoted (numeric)
        // forms. Also try matching by subject substring since SAP's
        // email-to-ticket routing puts [REFID: <ticketId>] in the
        // reply chain — emails routed by that convention may not have
        // TicketID populated but DO have the ID in their subject.
        {
          label: "⭐ EMailCollection filtered by TicketID eq '<id>' (string)",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `TicketID eq '${tid}'`, "$orderby": "DateTime desc" },
          needsTicketId: true,
        },
        {
          label: "⭐ EMailCollection filtered by TicketID eq <id> (numeric)",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `TicketID eq ${tid}`, "$orderby": "DateTime desc" },
          needsTicketId: true,
        },
        {
          label: "⭐ EMailCollection filtered by Subject substring (REFID convention)",
          path: "/EMailCollection",
          query: { "$format": "json", "$top": 100, "$filter": `substringof('${tid}',Subject)`, "$orderby": "DateTime desc" },
          needsTicketId: true,
        },
        {
          label: "⭐ ActivityCollection filtered by TicketID eq '<id>' (string)",
          path: "/ActivityCollection",
          query: { "$format": "json", "$top": 100, "$filter": `TicketID eq '${tid}'` },
          needsTicketId: true,
        },
        {
          label: "⭐ PhoneCallCollection filtered by TicketID eq '<id>' (string)",
          path: "/PhoneCallCollection",
          query: { "$format": "json", "$top": 100, "$filter": `TicketID eq '${tid}'` },
          needsTicketId: true,
        },
        {
          label: "⭐ AppointmentCollection filtered by TicketID eq '<id>' (string)",
          path: "/AppointmentCollection",
          query: { "$format": "json", "$top": 100, "$filter": `TicketID eq '${tid}'` },
          needsTicketId: true,
        },
        // v0.26.112 — Most reliable path on tenants where TicketID isn't
        // populated. Pull all emails for the customer; post-filter by
        // Subject substring of the ticket ID (covers the SAP "[REFID:nnn]"
        // convention and any other format where the ticket ID appears in
        // the email subject).
        {
          label: "🎯 EMailCollection by MainAccountPartyID + Subject post-filter",
          path: "/EMailCollection",
          query: {
            "$format": "json",
            "$top": 200,
            "$filter": `MainAccountPartyID eq '${acct}'`,
            "$orderby": "DateTime desc",
          },
          needsTicketId: true,
          needsAccountPartyId: true,
          postFilter: (rows: any[]) => {
            const needle = String(ticketId).trim();
            if (!needle) return [];
            // Match subject substring. SAP routes replies with
            // "[REFID: nnnnn]" or sometimes just "nnnnn" in the subject.
            return rows.filter((r) => {
              const subj = String(r?.Subject ?? "").trim();
              return subj.includes(needle);
            });
          },
        },
        {
          label: "ActivityCollection filtered by ParentObjectID",
          path: "/ActivityCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ParentObjectID eq '${oid}'` },
        },
        {
          label: "ActivityCollection filtered by ServiceRequestObjectID",
          path: "/ActivityCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ServiceRequestObjectID eq '${oid}'` },
        },
        {
          label: "ActivityCollection filtered by MainReferenceObjectID",
          path: "/ActivityCollection",
          query: { "$format": "json", "$top": 100, "$filter": `MainReferenceObjectID eq '${oid}'` },
        },
        {
          label: "ActivityCollection filtered by ReferenceObjectID",
          path: "/ActivityCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ReferenceObjectID eq '${oid}'` },
        },
        // Phone-call + appointment specific collections
        {
          label: "PhoneCallCollection filtered by ServiceRequestObjectID",
          path: "/PhoneCallCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ServiceRequestObjectID eq '${oid}'` },
        },
        {
          label: "AppointmentCollection filtered by ServiceRequestObjectID",
          path: "/AppointmentCollection",
          query: { "$format": "json", "$top": 100, "$filter": `ServiceRequestObjectID eq '${oid}'` },
        },
      ];
      const tried: Array<{ label: string; status: string; count?: number; error?: string; path?: string }> = [];
      const allActivities: any[] = [];
      const seenIds = new Set<string>();
      const winningLabels: string[] = [];
      // v0.26.118 — capture the FIRST raw row from the BTDR path BEFORE
      // strip() processes it. This preserves __deferred URIs + ALL field
      // names (ObjectID, ID, UUID — everything the fallback display
      // hides). Used purely for diagnostic: the operator can see the
      // ground-truth shape of what SAP returned.
      let firstBtdrRawRow: any = null;
      // v0.26.125 — capture ALL BTDR raw rows (capped at 10) so we can
      // see the per-row differences (e.g., Predecessor vs Successor,
      // different UUID-vs-ObjectID patterns) when only some emails get
      // their bodies resolved.
      let allBtdrRawRows: any[] = [];
      // v0.26.120 — capture the first RESOLVED email entity (full raw
      // OData response, with __deferred URIs visible). Lets us see
      // which child paths exist for body content if our common-path
      // probing missed.
      let firstResolvedEmailRaw: any = null;
      // v0.26.123 — per-email body-resolution log. One entry per
      // EMail entity the resolver processed. Shows which body path
      // won (if any), plus a raw sample from EMailNotes when the
      // body came back empty (so we can see the actual shape).
      const emailBodyResolutions: Array<{
        emailObjectId: string;
        subject?: string;
        wonPath?: string;
        bodyChars?: number;
        attempts: Array<{ path: string; status: string; count?: number; error?: string }>;
        // Raw sample of the first row from EMailNotes when bodyChars=0.
        // Lets us see whether body is there but under a different field.
        emailNotesRawSample?: any;
      }> = [];
      // v0.26.114 — when ServiceRequestBusinessTransactionDocumentReference
      // returns reference-stub rows (BusinessTransactionDocumentID +
      // TypeCode), we need to follow up to fetch the actual entity body
      // for each. This helper does that resolution.
      // v0.26.115 — wider TypeCode coverage.
      // v0.26.117 — check inline-expanded relations first; then check
      // _navLinks (preserved __deferred URIs) for paths that point to
      // EMail/PhoneCall/etc. collections; then fall back to looking
      // for scalar FK fields.
      // v0.26.127 — strip HTML to plain text. SAP's EMailNotes returns
      // the email body as a raw HTML string (Outlook-style with inline
      // <p style="..."> tags + &nbsp; entities). We want a clean,
      // readable plain-text body for the timeline preview, the LLM
      // prompt, and the operator's eyeballs. Original HTML is kept on
      // `_bodyHtml` for any future rich-render path.
      const htmlToPlainText = (html: string): string => {
        let s = String(html);
        // Block-level tags → newlines (preserve paragraph structure).
        s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
        s = s.replace(/<br\s*\/?>/gi, "\n");
        // Strip all remaining tags (including <style>/<script> blocks).
        s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
        s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
        s = s.replace(/<!--[\s\S]*?-->/g, "");
        s = s.replace(/<[^>]+>/g, "");
        // Common named entities.
        const ents: Record<string, string> = {
          "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
          "&quot;": '"', "&apos;": "'", "&#39;": "'",
          "&hellip;": "…", "&ndash;": "–", "&mdash;": "—",
          "&copy;": "©", "&reg;": "®", "&trade;": "™",
          "&lsquo;": "'", "&rsquo;": "'", "&ldquo;": "“", "&rdquo;": "”",
          "&bull;": "•", "&middot;": "·",
        };
        for (const [e, v] of Object.entries(ents)) {
          s = s.replace(new RegExp(e, "gi"), v);
        }
        // Numeric entities.
        s = s.replace(/&#(\d+);/g, (_, n: string) => {
          try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; }
        });
        s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => {
          try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
        });
        // Collapse runs of horizontal whitespace; preserve newlines.
        s = s.replace(/[ \t]+/g, " ");
        s = s.replace(/ ?\n ?/g, "\n");
        s = s.replace(/\n{3,}/g, "\n\n");
        return s.trim();
      };

      // v0.26.124 — extracted body + attachments fetcher. Runs AFTER any
      // strategy resolves an EMail entity, so the body-fetch path is
      // independent of which strategy (inline $expand / navLinks /
      // UUID-strip / ID-filter / scalar FK) produced the entity.
      // Previously this logic lived only inside the UUID-strip strategy,
      // so emails resolved via $expand or navLinks silently skipped
      // the body fetch.
      const enrichEmailEntity = async (
        emailEnt: any,
        emailObjectIdForChildPaths: string,
        rowSubject: string,
        c4cGet: any,
      ): Promise<any> => {
        let bodyContent = "";
        let bodyHtml = "";
        let bodyResolvedFrom: string | null = null;
        const perEmailAttempts: Array<{ path: string; status: string; count?: number; error?: string }> = [];
        let emailNotesRawSample: any = null;
        const bodyPaths = [
          `/EMailCollection('${emailObjectIdForChildPaths}')/EMailNotes`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/EMailContent`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/EMailItem`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/Item`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/Body`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/Text`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/EMailItemAttachmentFolder`,
          `/EMailCollection('${emailObjectIdForChildPaths}')/AttachmentFolder`,
        ];
        for (const bp of bodyPaths) {
          try {
            const br: any = await c4cGet(bp, { "$format": "json" });
            const brows: any[] = br?.d?.results ?? (br?.d ? [br.d] : []);
            if (!brows || brows.length === 0) {
              perEmailAttempts.push({ path: bp, status: "empty", count: 0 });
              continue;
            }
            const chunks: string[] = [];
            for (const brow of brows) {
              const txt = String(
                brow?.BodyText || brow?.Body || brow?.Text ||
                brow?.TextContent || brow?.HtmlContent ||
                brow?.Content || brow?.Note || brow?.NoteContent ||
                brow?.FormattedText || brow?.Description || ""
              ).trim();
              if (txt) chunks.push(txt);
            }
            if (chunks.length > 0) {
              // v0.26.127 — body often comes back as raw HTML. Strip
              // to plain text for timeline + LLM consumption. Keep the
              // original HTML attached on `_bodyHtml` for any future
              // rich-render path.
              const rawBody = chunks.join("\n\n");
              const looksLikeHtml = /<(?:p|div|br|span|h[1-6]|table|tr|td|ul|ol|li|a|img|b|i|strong|em)\b/i.test(rawBody);
              if (looksLikeHtml) {
                bodyContent = htmlToPlainText(rawBody).slice(0, 8000);
                bodyHtml = rawBody.slice(0, 16000);
              } else {
                bodyContent = rawBody.slice(0, 8000);
              }
              bodyResolvedFrom = bp;
              perEmailAttempts.push({ path: bp, status: "ok", count: brows.length });
              break;
            }
            perEmailAttempts.push({
              path: bp,
              status: "no-text-fields",
              count: brows.length,
              error: `${brows.length} row(s) returned but no body-shaped field had text`,
            });
            if (/EMailNotes/i.test(bp) && !emailNotesRawSample) {
              try { emailNotesRawSample = JSON.parse(JSON.stringify(brows[0])); } catch { emailNotesRawSample = brows[0]; }
            }
          } catch (e: any) {
            perEmailAttempts.push({ path: bp, status: "error", error: String(e?.message ?? e).slice(0, 200) });
          }
        }
        // Attachments (best-effort, non-fatal).
        let attachments: Array<{ name: string; size?: number; type?: string }> = [];
        try {
          const ar: any = await c4cGet(
            `/EMailCollection('${emailObjectIdForChildPaths}')/EMailAttachments`,
            { "$format": "json", "$top": 50 }
          );
          const arows: any[] = ar?.d?.results ?? [];
          attachments = arows.map((a: any) => {
            const name = String(
              a?.DocumentName || a?.FileName || a?.Name || a?.Title ||
              a?.AttachmentName || "(unnamed)"
            ).trim();
            const sizeRaw = a?.DocumentSize ?? a?.FileSize ?? a?.Size;
            const size = typeof sizeRaw === "number" ? sizeRaw :
                         typeof sizeRaw === "string" && sizeRaw ? Number(sizeRaw) :
                         undefined;
            const type = String(
              a?.TypeCodeText || a?.MimeType || a?.ContentType ||
              a?.DocumentType || ""
            ).trim() || undefined;
            return { name, ...(size != null && !Number.isNaN(size) ? { size } : {}), ...(type ? { type } : {}) };
          }).filter((a) => (a.name && a.name !== "(unnamed)") || (a as any).size);
        } catch {/* non-fatal */}
        // Capture diagnostic for this email.
        emailBodyResolutions.push({
          emailObjectId: emailObjectIdForChildPaths,
          subject: String(emailEnt?.Subject || rowSubject || "").slice(0, 200),
          wonPath: bodyResolvedFrom ?? undefined,
          bodyChars: bodyContent.length,
          attempts: perEmailAttempts,
          emailNotesRawSample,
        });
        return {
          ...emailEnt,
          ...(bodyContent
            ? { Body: bodyContent, BodyText: bodyContent, _bodyResolvedFrom: bodyResolvedFrom }
            : {}),
          ...(bodyHtml ? { _bodyHtml: bodyHtml } : {}),
          ...(attachments.length > 0 ? { _attachments: attachments } : {}),
        };
      };

      const resolveRefRow = async (row: any, c4cGet: any): Promise<any> => {
        // v0.26.119 — type detection moved to the top so all
        // resolution strategies can use `collection`.
        const refType = String(
          row?.BusinessTransactionDocumentTypeCode ??
          row?.TypeCode ??
          row?.BusinessTransactionDocumentReferenceTypeCode ??
          ""
        );
        const refTypeText = String(
          row?.BusinessTransactionDocumentTypeCodeText ??
          row?.TypeCodeText ??
          row?.BusinessTransactionDocumentReferenceTypeCodeText ??
          ""
        );
        const isEmail = /email|e-?mail/i.test(refTypeText) || refType === "39";
        const isPhone = /phone|call/i.test(refTypeText) || refType === "12";
        const isAppt = /appointment|meeting/i.test(refTypeText) || refType === "13";
        const isTask = /task/i.test(refTypeText) || refType === "4";
        const isSubTicket = /service\s*request|ticket|case/i.test(refTypeText) || refType === "1";
        const collection = isEmail ? "EMailCollection" :
                           isPhone ? "PhoneCallCollection" :
                           isAppt  ? "AppointmentCollection" :
                           isTask  ? "TaskCollection" :
                           isSubTicket ? "ServiceRequestCollection" :
                                     null;
        const stubAnnotation = {
          _stubType: refType || refTypeText || "ref",
          _stubTypeText: refTypeText || (refType ? `TypeCode ${refType}` : "Reference"),
        };
        // (1) Inline-expanded entity from $expand. If SAP returned the
        // linked email/call/appt as a nested object, use that directly.
        const expandableKeys = [
          "BusinessTransactionDocument",
          "ItemBusinessTransactionDocument",
          "Email", "EMail", "PhoneCall", "Appointment", "Task",
        ];
        for (const key of expandableKeys) {
          const candidate = row?.[key];
          if (candidate && typeof candidate === "object" && !("__deferred" in candidate)) {
            const inlineEnt = (candidate as any).results?.[0] ?? candidate;
            if (inlineEnt && typeof inlineEnt === "object" && Object.keys(inlineEnt).length > 0) {
              // v0.26.124 — enrich with body+attachments if email.
              const enrichedEnt = (isEmail && (inlineEnt.ObjectID || row?.UUID))
                ? await enrichEmailEntity(
                    inlineEnt,
                    String(inlineEnt.ObjectID || String(row?.UUID || "").replace(/-/g, "").toUpperCase()),
                    String(row?.Subject || ""),
                    c4cGet,
                  )
                : inlineEnt;
              return {
                ...row,
                ...enrichedEnt,
                _resolvedFrom: `inline:${key}`,
                ...stubAnnotation,
              };
            }
          }
        }
        // (2) Try _navLinks URIs (preserved from __deferred). Match the
        // first one whose URI mentions an Email/PhoneCall/etc. collection.
        const navLinks: Record<string, string> | undefined = row?._navLinks;
        if (navLinks && typeof navLinks === "object") {
          for (const [navName, uri] of Object.entries(navLinks)) {
            if (typeof uri !== "string") continue;
            const m = /\/([A-Za-z]+Collection)\('([^']+)'\)/.exec(uri);
            if (!m) continue;
            const [, collection, id] = m;
            // Only follow links that look like activity collections.
            if (!/Email|Phone|Appointment|Task|ServiceRequest/i.test(collection)) continue;
            try {
              const r: any = await c4cGet(`/${collection}('${id.replace(/'/g, "''")}')`, { "$format": "json" });
              const ent: any = r?.d?.results ?? r?.d ?? r;
              if (ent && typeof ent === "object") {
                // v0.26.124 — enrich with body+attachments if email.
                const enrichedEnt = (isEmail && (ent.ObjectID || id))
                  ? await enrichEmailEntity(ent, String(ent.ObjectID || id), String(row?.Subject || ""), c4cGet)
                  : ent;
                return {
                  ...row,
                  ...enrichedEnt,
                  _resolvedFrom: `navLink:${navName}→${collection}`,
                  ...stubAnnotation,
                };
              }
            } catch (e: any) {
              // try next link
              continue;
            }
          }
        }
        // (3) v0.26.119 — the BTDR row's `UUID` field on Thermo Fisher's
        // tenant is the LINKED email's UUID (NOT the row's own UUID,
        // which can be derived from ObjectID). Compare row.ObjectID
        // (which __metadata.uri confirms is the row's own ID) with
        // row.UUID: if they differ (after dash normalization), UUID is
        // the FK to the linked entity. Convert UUID to ObjectID by
        // stripping dashes + uppercasing, then fetch.
        const rowOwnObjectId = String(row?.ObjectID ?? "").toUpperCase();
        const rowUuid = String(row?.UUID ?? "").toUpperCase();
        const linkedObjectIdFromUuid = rowUuid.replace(/-/g, "");
        if (
          linkedObjectIdFromUuid &&
          linkedObjectIdFromUuid !== rowOwnObjectId &&
          /^[A-F0-9]{32}$/.test(linkedObjectIdFromUuid) &&
          collection
        ) {
          try {
            const r: any = await c4cGet(
              `/${collection}('${linkedObjectIdFromUuid}')`,
              { "$format": "json" }
            );
            const ent: any = r?.d?.results ?? r?.d ?? r;
            // v0.26.120 — capture raw email entity (with __deferred URIs)
            // for the diagnostic so we can see what child paths exist.
            if (collection === "EMailCollection" && !firstResolvedEmailRaw && ent) {
              try {
                firstResolvedEmailRaw = JSON.parse(JSON.stringify(ent));
              } catch {
                firstResolvedEmailRaw = ent;
              }
            }
            if (ent && typeof ent === "object" && Object.keys(ent).length > 0) {
              // v0.26.124 — body+attachments enrichment runs for every
              // strategy via the helper (not just here). For non-email
              // collections (PhoneCall/Appointment/Task etc.), no body
              // fetch is performed — the entity ships as-is.
              if (collection === "EMailCollection") {
                const enrichedEnt = await enrichEmailEntity(
                  ent,
                  linkedObjectIdFromUuid,
                  String(row?.Subject || ""),
                  c4cGet,
                );
                return {
                  ...row,
                  ...enrichedEnt,
                  _resolvedFrom: `${collection}(uuid-strip)`,
                  ...stubAnnotation,
                };
              }
              return {
                ...row,
                ...ent,
                _resolvedFrom: `${collection}(uuid-strip)`,
                ...stubAnnotation,
              };
            }
          } catch {
            // try next strategy
          }
        }
        // (4) v0.26.119 — try filtering target collection by user-visible
        // ID (row.ID). On this tenant ID = "11297929" looks like an
        // SAP email-message ID. If the row's UUID-as-ObjectID path didn't
        // work, this catches tenants where the FK is by user ID instead.
        const rowUserId = String(row?.ID ?? "").trim();
        if (rowUserId && rowUserId !== rowOwnObjectId && collection) {
          try {
            const r: any = await c4cGet(
              `/${collection}`,
              {
                "$format": "json",
                "$top": 1,
                "$filter": `ID eq '${rowUserId.replace(/'/g, "''")}'`,
              }
            );
            const rows2: any[] = r?.d?.results ?? [];
            if (rows2.length > 0 && typeof rows2[0] === "object") {
              const ent2: any = rows2[0];
              // v0.26.125 — enrich with body+attachments if email.
              const enrichedEnt = (isEmail && ent2?.ObjectID)
                ? await enrichEmailEntity(ent2, String(ent2.ObjectID), String(row?.Subject || ""), c4cGet)
                : ent2;
              return {
                ...row,
                ...enrichedEnt,
                _resolvedFrom: `${collection}(id-filter)`,
                ...stubAnnotation,
              };
            }
          } catch {
            // try next strategy
          }
        }
        // (5) Fall back to scalar FK fields (original v0.26.114 behavior).
        // `refType`, `refTypeText`, `collection`, `stubAnnotation` are
        // declared at the top of the resolver (v0.26.119).
        const refId = row?.BusinessTransactionDocumentID ?? row?.ReferenceID ?? row?.ItemID ?? row?.ID;
        if (!refId || !collection) return { ...row, ...stubAnnotation };
        try {
          const r: any = await c4cGet(
            `/${collection}('${String(refId).replace(/'/g, "''")}')`,
            { "$format": "json" }
          );
          const ent: any = r?.d?.results ?? r?.d ?? r;
          // v0.26.125 — enrich with body+attachments if email.
          const enrichedEnt = (isEmail && ent?.ObjectID)
            ? await enrichEmailEntity(ent, String(ent.ObjectID), String(row?.Subject || ""), c4cGet)
            : ent;
          return { ...row, ...enrichedEnt, _resolvedFrom: collection, ...stubAnnotation };
        } catch (e: any) {
          return {
            ...row,
            ...stubAnnotation,
            _resolveError: String(e?.message ?? e).slice(0, 200),
          };
        }
      };

      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        for (const attempt of attempts) {
          if (attempt.needsTicketId && !tid) {
            tried.push({ label: attempt.label, status: "skipped", count: 0, error: "no ticketId provided" });
            continue;
          }
          // v0.26.112 — skip account-scoped attempts when accountPartyId
          // wasn't passed (would otherwise filter by empty string and
          // either error or return 0 rows from random unrelated emails).
          if (attempt.needsAccountPartyId && !acct) {
            tried.push({ label: attempt.label, status: "skipped", count: 0, error: "no accountPartyId provided" });
            continue;
          }
          try {
            const result: any = await c4cGet(attempt.path, attempt.query);
            let rows: any[] = result?.d?.results ?? [];
            const rawCount = rows.length;
            // v0.26.112 — apply optional post-filter (e.g., subject
            // substring on customer-scoped email pulls).
            if (typeof attempt.postFilter === "function" && rows.length > 0) {
              rows = attempt.postFilter(rows);
            }
            if (rows.length > 0) {
              // v0.26.118 — capture the first BTDR raw row before
              // resolveRefRow mutates it. Preserves __metadata,
              // __deferred URIs, and every field including those the
              // fallback display hides (ObjectID, ID, UUID, etc.).
              // v0.26.125 — also capture up to 10 rows so we can see
              // per-row differences (e.g., Predecessor vs Successor).
              if (
                /BusinessTransactionDocumentReference/i.test(attempt.path) &&
                allBtdrRawRows.length === 0
              ) {
                try {
                  allBtdrRawRows = JSON.parse(JSON.stringify(rows.slice(0, 10)));
                  firstBtdrRawRow = allBtdrRawRows[0] ?? null;
                } catch {
                  allBtdrRawRows = rows.slice(0, 10);
                  firstBtdrRawRow = rows[0];
                }
              }
              // v0.26.114 — if this is the BusinessTransactionDocument
              // Reference path, resolve each reference-stub to its full
              // entity (email body / phone-call details / etc.). The
              // reference rows alone carry only the link metadata —
              // the real content is on the linked entity.
              if (/BusinessTransactionDocumentReference/i.test(attempt.path)) {
                rows = await Promise.all(rows.map((r) => resolveRefRow(r, c4cGet)));
              }
              let addedCount = 0;
              for (const row of rows) {
                const id = String((row as any).ObjectID ?? (row as any).ID ?? `${attempt.label}::${addedCount}`);
                if (!seenIds.has(id)) {
                  seenIds.add(id);
                  let stripped = strip(row);
                  // v0.26.126 — final-mile enrichment safety net.
                  // If the row looks like an email (TypeCode=39 OR
                  // E-Mail OR has Subject + DocumentTypeText "E-Mail")
                  // AND it doesn't already have a resolved body marker
                  // (`_bodyResolvedFrom`), AND it has an ObjectID,
                  // run enrichEmailEntity here. Catches emails that
                  // slipped through resolveRefRow's strategies as stubs
                  // (no UUID-strip match, ID-filter errored, etc.).
                  // Idempotent — won't re-fetch if already enriched.
                  const looksLikeEmail =
                    (stripped as any)._bodyResolvedFrom == null &&
                    (stripped as any).ObjectID &&
                    (
                      String((stripped as any).TypeCode || "") === "39" ||
                      /e-?mail/i.test(String((stripped as any).TypeCodeText || "")) ||
                      /e-?mail/i.test(String((stripped as any).DocumentTypeText || "")) ||
                      /e-?mail/i.test(String((row as any)?.__metadata?.type || ""))
                    );
                  if (looksLikeEmail) {
                    try {
                      const enriched = await enrichEmailEntity(
                        stripped,
                        String((stripped as any).ObjectID),
                        String((stripped as any).Subject || ""),
                        c4cGet,
                      );
                      stripped = enriched;
                    } catch (e: any) {
                      (stripped as any)._enrichmentSafetyNetError = String(e?.message ?? e).slice(0, 200);
                    }
                  }
                  (stripped as any)._fromPath = attempt.label;
                  allActivities.push(stripped);
                  addedCount++;
                }
              }
              winningLabels.push(attempt.label);
              // For post-filtered attempts, surface both counts so the
              // operator can see how many we pulled vs how many matched.
              const countDetail = (typeof attempt.postFilter === "function")
                ? `${rows.length} match(es) of ${rawCount} pulled`
                : undefined;
              tried.push({
                label: attempt.label,
                status: "ok",
                count: rows.length,
                path: attempt.path,
                ...(countDetail ? { error: countDetail } : {}),
              });
            } else {
              const emptyDetail = (typeof attempt.postFilter === "function" && rawCount > 0)
                ? `0 matched (post-filter); ${rawCount} pulled`
                : undefined;
              tried.push({
                label: attempt.label,
                status: "empty",
                count: 0,
                path: attempt.path,
                ...(emptyDetail ? { error: emptyDetail } : {}),
              });
            }
          } catch (e: any) {
            const msg = String(e?.message ?? e).slice(0, 240);
            tried.push({ label: attempt.label, status: "error", error: msg, path: attempt.path });
          }
        }
        // v0.26.113 — navigation discovery. Fetch the ticket entity
        // without $select and surface every __deferred navigation link.
        // SAP returns one per child relationship — directly tells us
        // which navigation properties this tenant's ServiceRequest
        // entity exposes (so we know which paths to probe in v0.26.114+).
        let navigationProperties: { name: string; uri?: string }[] = [];
        try {
          const tEntity: any = await c4cGet(`/ServiceRequestCollection('${oid}')`, { "$format": "json" });
          const ent: any = tEntity?.d ?? tEntity;
          // Single-row response can be {d: {results: <obj>}} or {d: <obj>}
          const ticketObj: any = ent?.results ?? ent;
          if (ticketObj && typeof ticketObj === "object") {
            for (const [key, value] of Object.entries(ticketObj)) {
              if (
                value &&
                typeof value === "object" &&
                "__deferred" in (value as Record<string, unknown>)
              ) {
                const def = (value as any).__deferred;
                navigationProperties.push({ name: key, uri: def?.uri });
              }
            }
          }
        } catch {
          // ok — best-effort discovery
        }
        // v0.26.108 — schema discovery fallback. When every filter
        // failed (likely because we don't know the FK field name on this
        // tenant), probe each collection with no filter ($top=1) and
        // surface the actual property names. This lets the operator (or
        // next code revision) identify the right filter field by
        // inspection rather than guesswork.
        let schemaProbe: {
          collection: string;
          path: string;
          status: string;
          fields?: string[];
          sample?: Record<string, unknown>;
          error?: string;
        }[] = [];
        if (allActivities.length === 0) {
          const probeTargets: Array<{ collection: string; path: string }> = [
            { collection: "EMailCollection", path: "/EMailCollection" },
            { collection: "ActivityCollection", path: "/ActivityCollection" },
            { collection: "PhoneCallCollection", path: "/PhoneCallCollection" },
            { collection: "AppointmentCollection", path: "/AppointmentCollection" },
          ];
          for (const t of probeTargets) {
            try {
              const r: any = await c4cGet(t.path, { "$format": "json", "$top": 1 });
              const rows: any[] = r?.d?.results ?? [];
              if (rows.length > 0) {
                const sample = strip(rows[0]);
                const fields = Object.keys(sample).sort();
                // v0.26.109 — broader FK heuristic. Any field name ending
                // in "ID" (capital), or matching ticket/service-request/
                // reference/parent/main-account patterns. Excludes the
                // entity's own ObjectID/ID since those aren't FKs.
                const likelyFk = fields.filter((k) => {
                  if (k === "ObjectID" || k === "ID" || k === "UUID") return false;
                  if (/^(Creation|LastChange|Created|LastUpdated)/.test(k)) return false; // audit fields
                  return /ID$/.test(k) || /service\s*request|reference|parent|ticket|main(?:account|contact)/i.test(k);
                });
                schemaProbe.push({
                  collection: t.collection,
                  path: t.path,
                  status: "ok",
                  fields,
                  // Trim sample to the likely-FK fields so it's readable
                  sample: Object.fromEntries(
                    Object.entries(sample).filter(([k]) => likelyFk.includes(k))
                  ) as Record<string, unknown>,
                });
              } else {
                schemaProbe.push({ collection: t.collection, path: t.path, status: "empty" });
              }
            } catch (e: any) {
              schemaProbe.push({
                collection: t.collection,
                path: t.path,
                status: "error",
                error: String(e?.message ?? e).slice(0, 300),
              });
            }
          }
        }
        sendJson(response, 200, {
          ok: true,
          objectId,
          ticketId: ticketId || null,
          count: allActivities.length,
          winningLabel: winningLabels[0] || null,
          winningLabels,
          activities: allActivities,
          tried,
          schemaProbe,
          navigationProperties,
          firstBtdrRawRow,
          allBtdrRawRows,
          firstResolvedEmailRaw,
          emailBodyResolutions,
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/get_ticket_summary — v0.27.0. Consolidated summary endpoint
     * for the /ticket-summary slash command. Pulls SLA + line items +
     * appointment visits + interaction counts in one HTTP call so the
     * extension's panel renders fast.
     *
     * Does NOT duplicate /interactions logic — that command stays
     * independent. This endpoint focuses on operational facts that
     * /interactions doesn't surface (visits, labour hours, parts
     * consumed, SLA adherence). The extension may separately call
     * /api/get_ticket_activities + /api/tools/get_ticket_notes for
     * the LLM interaction-summary blurb in the panel.
     *
     * Processing-type codes (Thermo Fisher tenant):
     *   ACTLAB → labour hours (sum ActualQuantity)
     *   ACTRVL → travel hours
     *   ZRP1 / SRP1 → parts consumed
     *   ZRP3 → parts ordered (not consumed yet)
     */
    if (url.pathname === "/api/get_ticket_summary" && request.method === "GET") {
      const objectId = url.searchParams.get("objectId")?.trim();
      const ticketId = url.searchParams.get("ticketId")?.trim() || "";
      if (!objectId) {
        sendJson(response, 400, { error: "objectId query param is required" });
        return;
      }
      const oid = objectId.replace(/'/g, "''");
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");

        // --- (1) Ticket entity for SLA + dates + customer + status ---
        let ticketEntity: any = null;
        try {
          const r: any = await c4cGet(`/ServiceRequestCollection('${oid}')`, { "$format": "json" });
          ticketEntity = r?.d?.results ?? r?.d ?? null;
        } catch { /* non-fatal */ }

        // --- (2) Line items: labour + travel + parts ---
        let lineItems: any[] = [];
        try {
          const r: any = await c4cGet("/ServiceRequestItemCollection", {
            "$format": "json",
            "$top": 100,
            "$filter": `ParentObjectID eq '${oid}'`,
            "$orderby": "ID asc",
          });
          lineItems = r?.d?.results ?? [];
        } catch { /* non-fatal */ }

        const parseQty = (v: any): number => {
          if (v == null) return 0;
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        // v0.27.1 — multi-field detection for processing-type code +
        // quantity, plus description-based fallback. Tenant variance:
        // on Thermo Fisher we see Description starting with "ACTLAB -"
        // or "ACTRVL -" even when the dedicated code field is empty,
        // and Product External ID is sometimes "ACTUAL_LABOR" /
        // "ACTUAL_TRAVEL". We check ALL of these signals.
        // v0.27.65 — labour/travel detection widened for the Thermo Fisher
        // tenant, which logs BOTH labour and travel under one processing
        // code, **ZALT** ("Actual Labor / Travel"), and distinguishes them
        // only in the Description ("ONSITE LABOR" vs "TRAVEL"). The old
        // detector only knew the canonical ACTLAB/ACTRVL codes, so every
        // ZALT line fell through to "other" and EFFORT summed to 0h.
        // Strategy: code field for the canonical codes, then the
        // Description/CodeText keywords (which carry the human meaning),
        // then the ZALT fallback. Travel is checked before labour because
        // the ZALT code text literally reads "Actual Labor / Travel".
        const detectKind = (li: any): "labour" | "travel" | "parts" | "other" => {
          const code = (
            String(li?.UserServiceTransactionProcessingTypeCode || "") + "|" +
            String(li?.ProcessingTypeCode || "") + "|" +
            String(li?.ItemListProcessingTypeCode || "") + "|" +
            String(li?.ServiceTransactionItemProcessingTypeCode || "") + "|" +
            String(li?.ProductExternalID || "")
          ).toUpperCase();
          const desc = (
            String(li?.Description || "") + " " + String(li?.ProductDescription || "")
          ).toUpperCase();
          const codeText = (
            String(li?.UserServiceTransactionProcessingTypeCodeText || "") + " " +
            String(li?.ProcessingTypeCodeText || "")
          ).toUpperCase();
          // Travel first (its keyword is the discriminator on combined codes).
          if (/\bACTRVL\b|ACTUAL_TRAVEL|ACTRAV/.test(code) || /\bTRAVEL\b/.test(desc)) return "travel";
          // Labour — canonical code OR a LABO(U)R keyword in the description.
          if (/\bACTLAB\b|ACTUAL_LABOR|ACTUAL_LABOUR/.test(code) || /\bLABO(?:U)?R\b/.test(desc)) return "labour";
          // ZALT = combined "Actual Labor / Travel" on this tenant. If the
          // description didn't already split it, use the code text: TRAVEL
          // (and not LABOR) → travel, otherwise treat as labour.
          if (/\bZALT\b/.test(code) || /LABOR|LABOUR|TRAVEL/.test(codeText)) {
            return /TRAVEL/.test(codeText) && !/LABOR|LABOUR/.test(codeText) ? "travel" : "labour";
          }
          if (/\bZRP1\b|\bSRP1\b/.test(code)) return "parts";
          return "other";
        };
        const detectQty = (li: any): number => {
          // Prefer ActualQuantity (set after work is completed);
          // fall back to PlannedQuantity for cases where labor is
          // scheduled but not yet stamped actual; finally fall back
          // to Quantity / BillableQuantity / Duration.
          const candidates = [
            li?.ActualQuantity,
            li?.PlannedQuantity,
            li?.Quantity,
            li?.BillableQuantity,
            li?.Duration,
          ];
          for (const c of candidates) {
            const n = parseQty(c);
            if (n > 0) return n;
          }
          return 0;
        };
        let actualHoursLabour = 0;
        let actualHoursTravel = 0;
        const partsConsumed: Array<{ materialId: string; name: string; quantity: number; uom: string; processingTypeCode: string }> = [];
        // v0.27.1 — collect detection diagnostics so the operator can
        // see why labour/travel/parts came out zero on tenants where
        // the field naming differs.
        const kindCounts: Record<string, number> = { labour: 0, travel: 0, parts: 0, other: 0 };
        const sampleByKind: Record<string, any> = {};
        for (const li of lineItems) {
          const kind = detectKind(li);
          const qty = detectQty(li);
          kindCounts[kind] = (kindCounts[kind] || 0) + 1;
          if (!sampleByKind[kind]) {
            // Capture one example per detected kind for the diagnostic
            sampleByKind[kind] = {
              ProcessingTypeCode: li?.UserServiceTransactionProcessingTypeCode || li?.ProcessingTypeCode || null,
              ProductExternalID: li?.ProductExternalID || null,
              ProductID: li?.ProductID || null,
              Description: String(li?.Description || li?.ProductDescription || "").slice(0, 80),
              ActualQuantity: li?.ActualQuantity ?? null,
              PlannedQuantity: li?.PlannedQuantity ?? null,
              detectedQty: qty,
            };
          }
          if (kind === "labour") {
            actualHoursLabour += qty;
          } else if (kind === "travel") {
            actualHoursTravel += qty;
          } else if (kind === "parts") {
            partsConsumed.push({
              materialId: String(li?.ProductID || li?.MaterialID || ""),
              name: String(li?.ProductDescription || li?.Description || "(unnamed)").slice(0, 120),
              quantity: qty,
              uom: String(li?.QuantityMeasureUnitCode || li?.QuantityUnitCode || ""),
              processingTypeCode: String(li?.UserServiceTransactionProcessingTypeCode || li?.ProcessingTypeCode || ""),
            });
          }
        }

        // --- (3) Activities via BTDR: find visits (appointments) ---
        // Reuses the resolveRefRow pattern from /api/get_ticket_activities
        // but only for appointment-type refs (TypeCode 13). Keeps this
        // endpoint independent of /interactions.
        let visits: Array<{ at: string | null; fseId: string; fseName: string; subject: string }> = [];
        let interactionCounts = { notes: 0, emails: 0, calls: 0, appointments: 0, total: 0 };
        try {
          const btdr: any = await c4cGet(
            `/ServiceRequestCollection('${oid}')/ServiceRequestBusinessTransactionDocumentReference`,
            { "$format": "json", "$top": 100 }
          );
          const refRows: any[] = btdr?.d?.results ?? [];
          for (const ref of refRows) {
            const typeCode = String(ref?.TypeCode || "");
            if (typeCode === "39") interactionCounts.emails++;
            else if (typeCode === "12") interactionCounts.calls++;
            else if (typeCode === "13") interactionCounts.appointments++;
            // Resolve appointment refs to entity for FSE + start time
            if (typeCode === "13" && ref?.UUID) {
              const linkedObjectId = String(ref.UUID).toUpperCase().replace(/-/g, "");
              const rowOwnObjectId = String(ref?.ObjectID || "").toUpperCase();
              if (linkedObjectId && linkedObjectId !== rowOwnObjectId && /^[A-F0-9]{32}$/.test(linkedObjectId)) {
                try {
                  const a: any = await c4cGet(`/AppointmentCollection('${linkedObjectId}')`, { "$format": "json" });
                  const ent: any = a?.d?.results ?? a?.d ?? a;
                  if (ent && typeof ent === "object") {
                    visits.push({
                      at: String(ent?.StartDateTime || ent?.StartDate || ent?.StartDateTimeZoneCode || "") || null,
                      fseId: String(ent?.OwnerPartyID || ent?.OrganizerPartyID || ""),
                      fseName: String(ent?.OwnerName || ent?.OrganizerName || ent?.OwnerFormattedName || "").trim(),
                      subject: String(ent?.Subject || ent?.Name || "").slice(0, 120),
                    });
                  }
                } catch { /* skip unresolved */ }
              }
            }
          }
        } catch { /* BTDR not exposed — non-fatal */ }

        // Sort visits chronologically (oldest first)
        const parseDate = (s: any): number | null => {
          if (!s) return null;
          const m = /\/Date\((\d+)/.exec(String(s));
          if (m) return Number(m[1]);
          const t = Date.parse(String(s));
          return Number.isFinite(t) ? t : null;
        };
        visits.sort((a, b) => (parseDate(a.at) || 0) - (parseDate(b.at) || 0));

        // --- (4) Notes count via existing get_ticket_notes pattern ---
        try {
          const n: any = await c4cGet("/ServiceRequestTextCollection", {
            "$format": "json",
            "$top": 100,
            "$filter": `ParentObjectID eq '${oid}'`,
          });
          interactionCounts.notes = (n?.d?.results ?? []).length;
        } catch { /* non-fatal */ }
        interactionCounts.total = interactionCounts.notes + interactionCounts.emails +
          interactionCounts.calls + interactionCounts.appointments;

        // --- (5) Compute SLA + age fields ---
        // v0.27.2 — field names on Thermo Fisher tenant differ from
        // SAP's documented standards. Use a fallback chain so we work
        // on every tenant we've seen. Fields confirmed via raw entity
        // dump on this tenant:
        //   FirstReactionDuedatetimeContent  → Initial Review Due
        //   RequestInProcessdatetimeContent  → Initial Review Completed
        //   OnSiteArrivalDueDateTime         → Due On-Site
        //   OnSiteArrivalDateTime            → Arrived On-Site (authoritative)
        //   ResolutionDueDateTime            → Resolution Due
        //   ResolvedOnDateTime               → Resolved On
        //   ServiceLevelObjectiveName        → SLA contract label
        const pickFirstDate = (obj: any, ...keys: string[]): { raw: any; ms: number | null } => {
          for (const k of keys) {
            const v = obj?.[k];
            if (v != null && v !== "") {
              const ms = parseDate(v);
              if (ms) return { raw: v, ms };
            }
          }
          return { raw: null, ms: null };
        };
        const now = Date.now();
        const createdAtMs = parseDate(ticketEntity?.CreationDateTime);
        const ageDays = createdAtMs ? Math.floor((now - createdAtMs) / 86400000) : null;

        // Initial Response (Review) SLA
        const initialDue = pickFirstDate(
          ticketEntity,
          "FirstReactionDuedatetimeContent",
          "FirstReactionDueDateTime",
          "RequestFirstReactionByDateTime",
        );
        const initialActual = pickFirstDate(
          ticketEntity,
          "RequestInProcessdatetimeContent",
          "RequestInProcessDateTime",
          "FirstReactionActualDateTime",
          "RequestInitialReceiptDateTime",
          "RequestInitialReceiptdatetimecontent",
        );
        const initialResponseMet = (initialDue.ms && initialActual.ms)
          ? initialActual.ms <= initialDue.ms : null;
        const initialResponseHoursLate = (initialDue.ms && initialActual.ms && initialActual.ms > initialDue.ms)
          ? Math.round((initialActual.ms - initialDue.ms) / 3600000) : 0;

        // On-Site Arrival SLA
        const onSiteDue = pickFirstDate(
          ticketEntity,
          "OnSiteArrivalDueDateTime",
          "ServiceExecutionDueDateTime",
          "OnSiteDueDateTime",
          "ScheduledStartDateTime",
          "RequestedEndDateTime",
        );
        // Prefer SAP-tracked OnSiteArrivalDateTime over our BTDR-derived
        // first-appointment time — the SAP-tracked field IS the
        // authoritative "actual arrival" used to compute SLA met/missed.
        const onSiteActual = pickFirstDate(
          ticketEntity,
          "OnSiteArrivalDateTime",
          "OnSiteActualDateTime",
        );
        const firstVisitMs = onSiteActual.ms ?? (visits.length > 0 ? parseDate(visits[0].at) : null);
        const firstVisitRaw = onSiteActual.raw ?? (visits.length > 0 ? visits[0].at : null);
        const firstVisitMet = (onSiteDue.ms && firstVisitMs)
          ? firstVisitMs <= onSiteDue.ms : null;
        const firstVisitHoursLate = (onSiteDue.ms && firstVisitMs && firstVisitMs > onSiteDue.ms)
          ? Math.round((firstVisitMs - onSiteDue.ms) / 3600000) : 0;

        // v0.27.5 — FSE (Field Service Engineer) name resolution.
        // Tickets with BTDR appointment activities → use the OwnerName
        // from the first appointment (already in visits[0].fseName).
        // Tickets WITHOUT appointment activities (very common — the
        // SAP-tracked OnSiteArrivalDateTime works without a separate
        // Appointment entity) → fall back to ticket-level FSE fields.
        // Spec example phrase: "Tom Doe first onsite June 6" — wants
        // name + date together, prominently. Surfaced in the SLA row
        // by the renderer.
        const firstVisitFseName =
          (visits.length > 0 && visits[0].fseName)
            ? visits[0].fseName
            : String(
                ticketEntity?.ServicePerformerPartyName ||
                ticketEntity?.ServicePerformerPartyFormattedName ||
                ticketEntity?.ServiceTechnicianPartyName ||
                ticketEntity?.ProcessorPartyName ||
                ticketEntity?.OwnerName ||
                ticketEntity?.OwnerFormattedName ||
                ""
              ).trim();
        const firstVisitFseId =
          (visits.length > 0 && visits[0].fseId)
            ? visits[0].fseId
            : String(
                ticketEntity?.ServicePerformerPartyID ||
                ticketEntity?.ServiceTechnicianPartyID ||
                ticketEntity?.ProcessorPartyID ||
                ticketEntity?.OwnerPartyID ||
                ""
              ).trim();

        // Resolution SLA — NEW in v0.27.2
        const resolutionDue = pickFirstDate(
          ticketEntity,
          "ResolutionDueDateTime",
          "ResolutionDueDate",
        );
        const resolutionActual = pickFirstDate(
          ticketEntity,
          "ResolvedOnDateTime",
          "ResolvedAtDateTime",
          "ClosedOnDateTime",
        );
        const resolutionMet = (resolutionDue.ms && resolutionActual.ms)
          ? resolutionActual.ms <= resolutionDue.ms : null;
        const resolutionHoursLate = (resolutionDue.ms && resolutionActual.ms && resolutionActual.ms > resolutionDue.ms)
          ? Math.round((resolutionActual.ms - resolutionDue.ms) / 3600000) : 0;
        // "In progress overdue" state — not resolved yet AND due date passed
        const resolutionOverdueDaysOpen = (resolutionDue.ms && !resolutionActual.ms && now > resolutionDue.ms)
          ? Math.floor((now - resolutionDue.ms) / 86400000) : 0;

        const slaName = String(
          ticketEntity?.ServiceLevelObjectiveName ||
          ticketEntity?.ServiceLevelObjectiveID ||
          ""
        ).trim();

        // v0.27.4 — escalation detection. EscalationStatusCode is the
        // SAP-managed flag (1 = Not Escalated, 2 = Escalated, …). The
        // text variant is operator-readable. We surface BOTH the flag
        // and a derived "trigger reason" hint computed from visit count
        // (a heuristic — many tenants don't populate a dedicated
        // EscalationReason field). The LLM can refine this from notes.
        const escalationStatusCode = String(
          ticketEntity?.EscalationStatusCode ||
          ticketEntity?.escalation_status ||
          ""
        ).trim();
        const escalationStatusText = String(
          ticketEntity?.EscalationStatusCodeText ||
          ""
        ).trim();
        // v0.27.46 — same fix as get_my_day: the naive /escalat/i text
        // fallback matched "Not Escalated" (false-positive on every
        // non-escalated ticket whose text was populated).
        const isEscalated = escalationStatusCode === "2" ||
          (/escalat/i.test(escalationStatusText) && !/^not\b/i.test(escalationStatusText.trim()));
        const visitCount = visits.length;

        sendJson(response, 200, {
          ok: true,
          ticket: {
            id: String(ticketEntity?.ID || ticketId || ""),
            objectId,
            customer: String(ticketEntity?.BuyerPartyName || ticketEntity?.AccountPartyName || ""),
            product: String(ticketEntity?.ProductID || ticketEntity?.ProductName || ""),
            serial: String(ticketEntity?.SerialID || ticketEntity?.InstallationPointID || ""),
            subject: String(ticketEntity?.Name || ticketEntity?.Subject || ""),
            createdAt: ticketEntity?.CreationDateTime || null,
            lastChangedAt: ticketEntity?.LastChangeDateTime || null,
            status: String(ticketEntity?.ServiceRequestUserLifeCycleStatusCode || ""),
            statusText: String(ticketEntity?.ServiceRequestUserLifeCycleStatusCodeText || ticketEntity?.LifeCycleStatusCodeText || ""),
            priority: String(ticketEntity?.ServicePriorityCode || ""),
            priorityText: String(ticketEntity?.ServicePriorityCodeText || ""),
            ageDays,
          },
          sla: {
            // v0.27.2 — surface the SLA contract name when set, plus
            // resolution-due/actual fields (new). Field names now use
            // the actual tenant-confirmed names with fallback chain.
            slaName,
            initialResponseDueBy: initialDue.raw,
            initialResponseActualAt: initialActual.raw,
            initialResponseMet,
            initialResponseHoursLate,
            dueOnSiteAt: onSiteDue.raw,
            firstVisitAt: firstVisitRaw,
            firstVisitFseName,
            firstVisitFseId,
            firstVisitMet,
            firstVisitHoursLate,
            resolutionDueBy: resolutionDue.raw,
            resolutionActualAt: resolutionActual.raw,
            resolutionMet,
            resolutionHoursLate,
            resolutionOverdueDaysOpen,
            // Legacy fields kept for backwards compat with any other caller
            completionDueBy: ticketEntity?.RequestedFulfillmentPeriodEndDateTime || ticketEntity?.RequestedEndDateTime || null,
          },
          visits,
          labour: {
            actualHoursLabour: Number(actualHoursLabour.toFixed(2)),
            actualHoursTravel: Number(actualHoursTravel.toFixed(2)),
            totalHours: Number((actualHoursLabour + actualHoursTravel).toFixed(2)),
            lineItemCount: lineItems.length,
          },
          partsConsumed,
          interactionCounts,
          // v0.27.4 — escalation flags. LLM uses these to compose the
          // trigger-reason narrative + recommended next action.
          escalation: {
            statusCode: escalationStatusCode,
            statusText: escalationStatusText,
            isEscalated,
            visitCount,
          },
          // v0.27.1 — diagnostic data for line-item detection. Surfaces
          // how many items fell into each bucket + one example per
          // bucket showing the actual field values we matched against.
          // Used by the panel's collapsible diagnostic block when
          // labour/travel come back as 0 despite line items existing.
          lineItemsDiagnostic: {
            totalLineItems: lineItems.length,
            kindCounts,
            sampleByKind,
            // First raw line item with __metadata + __deferred preserved
            // so the operator can spot any field name we missed.
            firstRawLineItem: lineItems.length > 0 ? (() => {
              try { return JSON.parse(JSON.stringify(lineItems[0])); }
              catch { return null; }
            })() : null,
          },
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/get_pm_prep — v0.27.38. Pre-visit briefing for an FSE about
     * to perform a preventive-maintenance visit on a piece of equipment.
     * Consolidates serial-history + line-items + notes + InstallationPoint
     * into one structured response so the panel renders without the FSE
     * having to navigate Service History · Labor · Parts · Components
     * tabs across multiple SAP screens.
     *
     * Pulls (all in parallel where possible):
     *   1. Current ticket entity → serial + product + installation-point
     *   2. Past tickets on the SAME serial via direct OData (NOT through
     *      getSerialHistory — we need KUT_Secondary_Ticket_Type which
     *      that tool doesn't $select)
     *   3. Per past ticket, line items for labour + parts aggregation
     *   4. InstallationPoint entity for system-config details
     *   5. Notes on the most-recent PM ticket (for the kit-gap LLM step
     *      done client-side later)
     *
     * Tenant constants (Thermo Fisher my340573-sso, per docs/engineering-notes.md):
     *   PM secondary-type codes: 131 (PM Contract), 141 (IQ/OQ),
     *                            181 (PM Billable)
     *   Labour processing type:  ACTLAB / ACTUAL_LABOR / ACTUAL_LABOUR
     *   Parts processing types:  ZRP1, SRP1 (consumption — see docs/engineering-notes.md
     *                            allowlist; we DO NOT count ZRP3
     *                            ordering as "parts replaced")
     *
     * Concurrency: serial-history query is sequential; line-item queries
     * for past tickets run in parallel batches of 6 (matches the existing
     * InstallationPoint backfill pattern in /map at popup.js line ~13800).
     */
    if (url.pathname === "/api/get_pm_prep" && request.method === "GET") {
      const objectId = url.searchParams.get("objectId")?.trim();
      if (!objectId) {
        sendJson(response, 400, { error: "objectId query param is required" });
        return;
      }
      const oid = objectId.replace(/'/g, "''");
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");

        // PM-related Secondary Type codes on this tenant. Mirrors the
        // hardcoded set in /nearby (popup.js openMapPanel) and in the
        // docs/engineering-notes.md /map LOCKED section. If a tenant uses different
        // codes, override via env in a future iteration; hardcoded for
        // now since this is Thermo-specific anyway.
        const PM_SECONDARY_CODES = new Set(["131", "141", "181"]);

        // --- (1) Current ticket entity ---
        let ticketEntity: any = null;
        try {
          const r: any = await c4cGet(`/ServiceRequestCollection('${oid}')`, { "$format": "json" });
          ticketEntity = r?.d?.results ?? r?.d ?? null;
        } catch { /* non-fatal */ }
        if (!ticketEntity) {
          sendJson(response, 404, { ok: false, error: `Ticket ${objectId} not found` });
          return;
        }

        // SerialID extraction — mirrors pickSerialId chain used by
        // /warranty and /knowledge (10 field names). Without a serial we
        // can't run serial-history; PM prep is pointless without it.
        const serialFromTicket = String(
          ticketEntity?.SerialID ||
          ticketEntity?.EquipmentID ||
          ticketEntity?.InstallationPointID ||
          ticketEntity?.IndividualMaterialID ||
          ticketEntity?.KUT_SerialID_KUT ||
          ticketEntity?.KUT_SerialNumber_KUT ||
          ""
        ).trim();
        if (!serialFromTicket) {
          sendJson(response, 200, {
            ok: true,
            warning: "no-serial",
            message: "This ticket doesn't carry an extractable serial — PM prep needs equipment-level history.",
            currentTicket: {
              id: String(ticketEntity?.ID || ""),
              objectId,
              customer: String(ticketEntity?.BuyerPartyName || ticketEntity?.AccountPartyName || ""),
              product: String(ticketEntity?.ProductID || ticketEntity?.ProductName || ""),
              subject: String(ticketEntity?.Name || ticketEntity?.Subject || ""),
              serial: "",
              installationPointId: String(ticketEntity?.InstallationPointID || ""),
            },
          });
          return;
        }

        const productId = String(ticketEntity?.ProductID || "").trim();
        const installationPointId = String(ticketEntity?.InstallationPointID || "").trim();

        // --- (2) Past tickets on the serial ---
        // We can't use getSerialHistory() because it doesn't $select the
        // KUT_Secondary_Ticket_Type fields. Direct OData here, with the
        // exact $select chain needed for PM categorization + display.
        let pastTickets: any[] = [];
        try {
          const r: any = await c4cGet("/ServiceRequestCollection", {
            "$format": "json",
            "$top": 50,
            "$filter": `SerialID eq '${serialFromTicket.replace(/'/g, "''")}'`,
            "$orderby": "LastChangeDateTime desc",
            "$select": [
              "ObjectID",
              "ID",
              "Name",
              "ProductID",
              "SerialID",
              "InstallationPointID",
              "BuyerPartyName",
              "ProcessorPartyName",
              "ServicePerformerPartyName",
              "ServicePerformerPartyID",
              "ServiceRequestLifeCycleStatusCode",
              "ServiceRequestLifeCycleStatusCodeText",
              "ServiceRequestUserLifeCycleStatusCode",
              "ServiceRequestUserLifeCycleStatusCodeText",
              "ServicePriorityCodeText",
              "CreationDateTime",
              "LastChangeDateTime",
              "OnSiteArrivalDateTime",
              "ResolvedOnDateTime",
              "RequestCloseddatetimeContent",
              "KUT_Secondary_Ticket_Type",
              "KUT_Secondary_Ticket_TypeText",
            ].join(","),
          });
          pastTickets = r?.d?.results ?? [];
        } catch (e: any) {
          console.warn(`[get_pm_prep] serial-history query failed: ${e?.message ?? e}`);
        }

        // Exclude the CURRENT ticket from past-tickets analysis — the
        // operator wants prior history, not the ticket they're staring
        // at. ObjectID comparison case-insensitive because SAP returns
        // uppercase ObjectIDs but the route may pass either.
        const currentObjectIdUpper = objectId.toUpperCase();
        const priorTickets = pastTickets.filter(
          (t) => String(t?.ObjectID || "").toUpperCase() !== currentObjectIdUpper
        );

        // Helper: parse SAP date strings (both /Date(ms)/ and ISO).
        const parseDate = (s: any): number | null => {
          if (!s) return null;
          const m = /\/Date\((\d+)/.exec(String(s));
          if (m) return Number(m[1]);
          const t = Date.parse(String(s));
          return Number.isFinite(t) ? t : null;
        };

        // Helper: is a ticket a PM? Check Secondary Type code first
        // (numeric like "131"), fall back to text match for safety.
        const isPmTicket = (t: any): boolean => {
          const code = String(t?.KUT_Secondary_Ticket_Type || "").trim();
          if (PM_SECONDARY_CODES.has(code)) return true;
          const text = String(t?.KUT_Secondary_Ticket_TypeText || "").toLowerCase();
          return /\bpm\b|preventive|iq\/oq|iqoq/i.test(text);
        };

        // Helper: is the ticket closed/completed? On this tenant we
        // check both the standard code (4 = Closed) and the User code
        // text (since UserLifeCycle is the granular display value).
        const isClosed = (t: any): boolean => {
          const code = String(t?.ServiceRequestLifeCycleStatusCode || "");
          if (code === "4") return true;
          const userText = String(t?.ServiceRequestUserLifeCycleStatusCodeText || "").toLowerCase();
          return /closed|completed|resolved/.test(userText);
        };

        // Helper: get the "when did the visit happen" date for a past
        // ticket. Prefer OnSiteArrivalDateTime (authoritative when SAP
        // tracked the arrival), fall back to ResolvedOnDateTime, then
        // close datetime, then last-change as a last resort.
        const visitMs = (t: any): number | null => {
          return parseDate(t?.OnSiteArrivalDateTime) ||
            parseDate(t?.ResolvedOnDateTime) ||
            parseDate(t?.RequestCloseddatetimeContent) ||
            parseDate(t?.LastChangeDateTime);
        };
        const visitRaw = (t: any): any => {
          return t?.OnSiteArrivalDateTime ||
            t?.ResolvedOnDateTime ||
            t?.RequestCloseddatetimeContent ||
            t?.LastChangeDateTime;
        };

        // --- (3) Identify last PM ---
        // Closed PM ticket with the newest visit date. Tie-breaker is
        // LastChangeDateTime, which the source rows are already sorted by.
        const closedPms = priorTickets
          .filter((t) => isPmTicket(t) && isClosed(t))
          .sort((a, b) => (visitMs(b) || 0) - (visitMs(a) || 0));
        const lastPmTicket = closedPms[0] || null;
        const lastPmAtMs = lastPmTicket ? visitMs(lastPmTicket) : null;

        // --- (4) Per-ticket line items (parallel, batched) ---
        // We need labour hours per ticket (sum ACTLAB) + parts per ticket
        // (ZRP1/SRP1). Cap at 30 most-recent past tickets to keep the
        // total request bounded (~5s on a slow tenant). Batches of 6
        // matches the InstallationPoint backfill concurrency.
        const ticketsForLineItems = priorTickets.slice(0, 30);
        const BATCH_SIZE = 6;

        // Same detectKind / detectQty as /api/get_ticket_summary.
        // v0.27.65 — labour/travel detection widened for the Thermo Fisher
        // tenant, which logs BOTH labour and travel under one processing
        // code, **ZALT** ("Actual Labor / Travel"), and distinguishes them
        // only in the Description ("ONSITE LABOR" vs "TRAVEL"). The old
        // detector only knew the canonical ACTLAB/ACTRVL codes, so every
        // ZALT line fell through to "other" and EFFORT summed to 0h.
        // Strategy: code field for the canonical codes, then the
        // Description/CodeText keywords (which carry the human meaning),
        // then the ZALT fallback. Travel is checked before labour because
        // the ZALT code text literally reads "Actual Labor / Travel".
        const detectKind = (li: any): "labour" | "travel" | "parts" | "other" => {
          const code = (
            String(li?.UserServiceTransactionProcessingTypeCode || "") + "|" +
            String(li?.ProcessingTypeCode || "") + "|" +
            String(li?.ItemListProcessingTypeCode || "") + "|" +
            String(li?.ServiceTransactionItemProcessingTypeCode || "") + "|" +
            String(li?.ProductExternalID || "")
          ).toUpperCase();
          const desc = (
            String(li?.Description || "") + " " + String(li?.ProductDescription || "")
          ).toUpperCase();
          const codeText = (
            String(li?.UserServiceTransactionProcessingTypeCodeText || "") + " " +
            String(li?.ProcessingTypeCodeText || "")
          ).toUpperCase();
          // Travel first (its keyword is the discriminator on combined codes).
          if (/\bACTRVL\b|ACTUAL_TRAVEL|ACTRAV/.test(code) || /\bTRAVEL\b/.test(desc)) return "travel";
          // Labour — canonical code OR a LABO(U)R keyword in the description.
          if (/\bACTLAB\b|ACTUAL_LABOR|ACTUAL_LABOUR/.test(code) || /\bLABO(?:U)?R\b/.test(desc)) return "labour";
          // ZALT = combined "Actual Labor / Travel" on this tenant. If the
          // description didn't already split it, use the code text: TRAVEL
          // (and not LABOR) → travel, otherwise treat as labour.
          if (/\bZALT\b/.test(code) || /LABOR|LABOUR|TRAVEL/.test(codeText)) {
            return /TRAVEL/.test(codeText) && !/LABOR|LABOUR/.test(codeText) ? "travel" : "labour";
          }
          if (/\bZRP1\b|\bSRP1\b/.test(code)) return "parts";
          return "other";
        };
        const detectQty = (li: any): number => {
          const candidates = [
            li?.ActualQuantity,
            li?.PlannedQuantity,
            li?.Quantity,
            li?.BillableQuantity,
            li?.Duration,
          ];
          for (const c of candidates) {
            const n = Number(c);
            if (Number.isFinite(n) && n > 0) return n;
          }
          return 0;
        };

        // Per-ticket aggregate. Stored on a Map keyed by ObjectID so
        // the front-end can pivot however it wants.
        const ticketRollup = new Map<string, {
          labourHours: number;
          travelHours: number;
          parts: Array<{ materialId: string; name: string; quantity: number }>;
        }>();

        for (let i = 0; i < ticketsForLineItems.length; i += BATCH_SIZE) {
          const batch = ticketsForLineItems.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (t) => {
            const tOid = String(t?.ObjectID || "").replace(/'/g, "''");
            if (!tOid) return;
            try {
              const r: any = await c4cGet("/ServiceRequestItemCollection", {
                "$format": "json",
                "$top": 50,
                "$filter": `ParentObjectID eq '${tOid}'`,
              });
              const items: any[] = r?.d?.results ?? [];
              let labourHours = 0;
              let travelHours = 0;
              const parts: Array<{ materialId: string; name: string; quantity: number }> = [];
              for (const li of items) {
                const kind = detectKind(li);
                const qty = detectQty(li);
                if (kind === "labour") labourHours += qty;
                else if (kind === "travel") travelHours += qty;
                else if (kind === "parts") {
                  parts.push({
                    materialId: String(li?.ProductID || li?.MaterialID || ""),
                    name: String(li?.ProductDescription || li?.Description || "(unnamed)").slice(0, 120),
                    quantity: qty,
                  });
                }
              }
              ticketRollup.set(String(t.ObjectID).toUpperCase(), {
                labourHours: Number(labourHours.toFixed(2)),
                travelHours: Number(travelHours.toFixed(2)),
                parts,
              });
            } catch { /* per-ticket failure is non-fatal */ }
          }));
        }

        // --- (5) InstallationPoint for system config ---
        // Pass-through to the existing entity. v0.27.21 noted this
        // returns 403 on some tenants if the integration user lacks
        // permission — we tolerate that and return null systemConfig.
        let installationPoint: any = null;
        if (installationPointId) {
          try {
            const r: any = await c4cGet(
              `/InstallationPointCollection('${installationPointId.replace(/'/g, "''")}')`,
              { "$format": "json" }
            );
            installationPoint = r?.d?.results ?? r?.d ?? null;
          } catch { /* non-fatal */ }
        }

        // --- (6) Last PM notes (for client-side LLM kit-gap step) ---
        // We pull the resolution-style notes (TypeCode 10022 = Service
        // Response Report) for the last PM so the LLM can see "what
        // was actually done last time" when inferring kit contents.
        let lastPmNotes: Array<{ typeCode: string; text: string; createdOn: any }> = [];
        if (lastPmTicket?.ObjectID) {
          try {
            const n: any = await c4cGet("/ServiceRequestTextCollection", {
              "$format": "json",
              "$top": 20,
              "$filter": `ParentObjectID eq '${String(lastPmTicket.ObjectID).replace(/'/g, "''")}'`,
              "$orderby": "CreatedOn desc",
            });
            lastPmNotes = (n?.d?.results ?? []).map((row: any) => ({
              typeCode: String(row?.TypeCode || ""),
              text: String(row?.Text || row?.FormattedText || "").slice(0, 2000),
              createdOn: row?.CreatedOn || null,
            }));
          } catch { /* non-fatal */ }
        }

        // ====== Aggregations the renderer expects ======

        // Last PM — derive FSE name + date for the headline.
        const lastPM = lastPmTicket ? {
          ticketId: String(lastPmTicket?.ID || ""),
          objectId: String(lastPmTicket?.ObjectID || ""),
          completedAt: visitRaw(lastPmTicket),
          completedAtMs: lastPmAtMs,
          daysAgo: lastPmAtMs ? Math.floor((Date.now() - lastPmAtMs) / 86400000) : null,
          subject: String(lastPmTicket?.Name || ""),
          fseName: String(
            lastPmTicket?.ServicePerformerPartyName ||
            lastPmTicket?.ProcessorPartyName ||
            ""
          ).trim(),
          fseId: String(
            lastPmTicket?.ServicePerformerPartyID ||
            ""
          ).trim(),
          secondaryTypeText: String(lastPmTicket?.KUT_Secondary_Ticket_TypeText || ""),
          secondaryTypeCode: String(lastPmTicket?.KUT_Secondary_Ticket_Type || ""),
        } : null;

        // Cumulative labour across all prior closed tickets (not just PMs).
        // Travel kept separate so the FSE sees "X hours on equipment, Y
        // hours driving to it" instead of one inflated number.
        let totalLabourHours = 0;
        let totalTravelHours = 0;
        let ticketsWithLabour = 0;
        for (const t of ticketsForLineItems) {
          const r = ticketRollup.get(String(t.ObjectID).toUpperCase());
          if (!r) continue;
          if (r.labourHours > 0) {
            totalLabourHours += r.labourHours;
            ticketsWithLabour++;
          }
          totalTravelHours += r.travelHours;
        }

        // Corrective maintenance since last PM. Tickets where:
        //   - NOT a PM (Secondary Type is null/empty OR not in PM_CODES)
        //   - Visit happened AFTER the last PM (or no last PM, then
        //     all corrective tickets count)
        //   - Closed (we want completed visits, not pipeline)
        const correctiveSince = priorTickets
          .filter((t) => !isPmTicket(t) && isClosed(t))
          .filter((t) => {
            if (!lastPmAtMs) return true;
            const ms = visitMs(t);
            return ms !== null && ms > lastPmAtMs;
          })
          .sort((a, b) => (visitMs(b) || 0) - (visitMs(a) || 0))
          .map((t) => ({
            ticketId: String(t?.ID || ""),
            objectId: String(t?.ObjectID || ""),
            completedAt: visitRaw(t),
            subject: String(t?.Name || ""),
            secondaryTypeText: String(t?.KUT_Secondary_Ticket_TypeText || ""),
            // "Reason" approximation — the subject line usually carries
            // the symptom (e.g., "Pressure fault on pump"). For a richer
            // reason we'd need to fetch the customer note per ticket;
            // skipped here to keep the endpoint fast. Renderer can hint
            // operator to click into each ticket for the full story.
          }));

        // Parts replacement history — dedupe by ProductDescription
        // (since material IDs can differ across part-number revisions
        // for the same physical part). Count occurrences + last replaced.
        const partsAgg = new Map<string, {
          materialId: string;
          name: string;
          timesReplaced: number;
          lastReplacedAt: any;
          lastReplacedAtMs: number;
        }>();
        for (const t of priorTickets) {
          const r = ticketRollup.get(String(t.ObjectID).toUpperCase());
          if (!r) continue;
          const tVisit = visitMs(t) || 0;
          const tVisitRaw = visitRaw(t);
          for (const p of r.parts) {
            const key = (p.name || p.materialId || "").trim().toLowerCase();
            if (!key) continue;
            const existing = partsAgg.get(key);
            if (existing) {
              existing.timesReplaced += 1;
              if (tVisit > existing.lastReplacedAtMs) {
                existing.lastReplacedAtMs = tVisit;
                existing.lastReplacedAt = tVisitRaw;
              }
            } else {
              partsAgg.set(key, {
                materialId: p.materialId,
                name: p.name,
                timesReplaced: 1,
                lastReplacedAt: tVisitRaw,
                lastReplacedAtMs: tVisit,
              });
            }
          }
        }
        const partsHistory = Array.from(partsAgg.values())
          .sort((a, b) => b.timesReplaced - a.timesReplaced || b.lastReplacedAtMs - a.lastReplacedAtMs)
          .slice(0, 25);

        // Open follow-up tickets — anything still in flight on this
        // serial. Excludes the current ticket (already excluded from
        // priorTickets).
        const openFollowUps = priorTickets
          .filter((t) => !isClosed(t))
          .sort((a, b) => (parseDate(b?.LastChangeDateTime) || 0) - (parseDate(a?.LastChangeDateTime) || 0))
          .map((t) => ({
            ticketId: String(t?.ID || ""),
            objectId: String(t?.ObjectID || ""),
            subject: String(t?.Name || ""),
            statusText: String(t?.ServiceRequestUserLifeCycleStatusCodeText || t?.ServiceRequestLifeCycleStatusCodeText || ""),
            priorityText: String(t?.ServicePriorityCodeText || ""),
            lastChangedAt: t?.LastChangeDateTime,
            ageDays: parseDate(t?.LastChangeDateTime)
              ? Math.floor((Date.now() - (parseDate(t?.LastChangeDateTime) || 0)) / 86400000)
              : null,
          }))
          .slice(0, 10);

        // System config — pull what we can from the InstallationPoint.
        // Field names vary by tenant; we try the common chains. The
        // renderer falls back to just the ticket's product name when
        // this section is sparse.
        const systemConfig = {
          primaryProductId: productId,
          primaryProductName: String(ticketEntity?.ProductDescription || ticketEntity?.ProductName || ""),
          installationPointId,
          installationPointName: String(
            installationPoint?.Description ||
            installationPoint?.InstallationPointDescription ||
            installationPoint?.Name ||
            ""
          ),
          location: String(
            installationPoint?.ServiceLocationName ||
            installationPoint?.InstallationLocationName ||
            ""
          ),
          // Component list — most tenants expose this via a navigation
          // collection, but we don't fetch it here (would need a second
          // round-trip per ticket). Renderer can hint operator to open
          // SAP's Installed Base view for the full component tree.
          componentsAvailableHint: !!installationPointId,
        };

        // --- (7) Kit-gap analysis (opt-in, server-side LLM) ---
        // Moved here from popup.js (v0.27.85): clients must NOT build prompts.
        // The base briefing above is deterministic + fast; this LLM step only
        // runs when the caller asks (?kitAnalysis=1), keeping the endpoint cheap
        // by default. Both doors (PWA, extension) now get it for free — the
        // extension can drop its client-side prompt and just pass the param.
        // Best-effort: any failure leaves kitAnalysis null, never 500s.
        let kitAnalysis: any = null;
        if (url.searchParams.get("kitAnalysis") === "1") {
          try {
            const productHint = String(ticketEntity?.ProductDescription || ticketEntity?.ProductName || productId || "").trim();
            const lastPmNoteTexts = lastPmNotes
              .filter((n) => n.typeCode === "10022")
              .map((n) => n.text)
              .filter(Boolean)
              .slice(0, 5);
            const lastPmNotesBlock = lastPmNoteTexts
              .map((t, i) => `--- Last PM note ${i + 1} ---\n${String(t).slice(0, 2000)}`)
              .join("\n\n");
            const partsHistoryText = partsHistory
              .slice(0, 15)
              .map((p) => `${p.name} (replaced ${p.timesReplaced}× — last ${p.lastReplacedAt || "unknown"})`)
              .join("\n");

            if (productHint && (lastPmNotesBlock || partsHistoryText)) {
              const prompt =
                `You are inferring the typical PM (Preventive Maintenance) kit contents for ` +
                `the product "${productHint}" based on past PM notes and historical parts ` +
                `replacement data. The customer hasn't given us a real BOM — we infer the ` +
                `kit from what FSEs have actually used during past PMs on this exact serial.\n\n` +
                `Return ONLY JSON:\n` +
                `{\n` +
                `  "inferredKitContents": [\n` +
                `    { "name": "<part name>", "typicalUse": "<short reason — e.g. 'standard wear item replaced every PM'>" }\n` +
                `  ],\n` +
                `  "gaps": [\n` +
                `    { "name": "<part name>", "concern": "<why this is a gap — e.g. 'In typical kit but not replaced in last 3 PMs on this serial — likely due'>" }\n` +
                `  ],\n` +
                `  "shortNarrative": "<1-2 sentence summary of what this PM should focus on, given the history>"\n` +
                `}\n\n` +
                `Rules:\n` +
                `- 3-8 inferredKitContents items. Be specific (e.g., "PM kit", "O-ring set", "inline filter").\n` +
                `- 0-5 gaps. A gap is something likely needed for THIS visit based on the time since last replaced.\n` +
                `- shortNarrative: focus on actionable focus areas, not platitudes.\n` +
                `- Output JSON only, no markdown fences.\n\n` +
                `=== Product ===\n${productHint}\n\n` +
                `=== Parts replacement history (this serial) ===\n${partsHistoryText || "(none captured)"}\n\n` +
                `=== Last PM resolution notes ===\n${lastPmNotesBlock || "(no notes available)"}\n`;

              const { chat } = await import("./chat.js");
              const resp = await chat({
                messages: [{ role: "user", content: prompt }],
                maxTokens: 900,
                temperature: 0.2,
                actor: "pm-prep",
                module: "service",
              });
              if (resp.ok && resp.text) {
                const raw = resp.text.trim();
                try {
                  let text = raw;
                  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
                  if (fence) text = fence[1];
                  const a = text.indexOf("{"), b = text.lastIndexOf("}");
                  if (a >= 0 && b > a) text = text.slice(a, b + 1);
                  const parsed = JSON.parse(text);
                  kitAnalysis = {
                    inferredKitContents: Array.isArray(parsed?.inferredKitContents)
                      ? parsed.inferredKitContents.slice(0, 8).map((x: any) => ({
                          name: String(x?.name || "").trim(),
                          typicalUse: String(x?.typicalUse || "").trim(),
                        })).filter((x: any) => x.name)
                      : [],
                    gaps: Array.isArray(parsed?.gaps)
                      ? parsed.gaps.slice(0, 5).map((x: any) => ({
                          name: String(x?.name || "").trim(),
                          concern: String(x?.concern || "").trim(),
                        })).filter((x: any) => x.name)
                      : [],
                    shortNarrative: String(parsed?.shortNarrative || "").trim(),
                  };
                } catch {
                  kitAnalysis = { rawFallback: raw.slice(0, 2000) };
                }
              }
            }
          } catch (e: any) {
            console.warn(`[get_pm_prep] kit-gap LLM step failed: ${e?.message ?? e}`);
          }
        }

        sendJson(response, 200, {
          ok: true,
          currentTicket: {
            id: String(ticketEntity?.ID || ""),
            objectId,
            customer: String(ticketEntity?.BuyerPartyName || ticketEntity?.AccountPartyName || ""),
            product: String(ticketEntity?.ProductID || ""),
            productName: String(ticketEntity?.ProductDescription || ticketEntity?.ProductName || ""),
            subject: String(ticketEntity?.Name || ticketEntity?.Subject || ""),
            serial: serialFromTicket,
            installationPointId,
            currentSecondaryTypeText: String(ticketEntity?.KUT_Secondary_Ticket_TypeText || ""),
            currentSecondaryTypeCode: String(ticketEntity?.KUT_Secondary_Ticket_Type || ""),
          },
          kitAnalysis,
          lastPM,
          cumulativeLabour: {
            totalHours: Number(totalLabourHours.toFixed(2)),
            totalTravelHours: Number(totalTravelHours.toFixed(2)),
            ticketsAggregated: ticketsForLineItems.length,
            ticketsWithLabour,
          },
          correctiveMaintenanceSinceLastPM: {
            count: correctiveSince.length,
            tickets: correctiveSince.slice(0, 15),
            sinceDate: lastPM?.completedAt || null,
          },
          partsHistory: {
            distinctParts: partsHistory,
            totalReplacements: Array.from(partsAgg.values()).reduce((s, p) => s + p.timesReplaced, 0),
          },
          systemConfig,
          openFollowUps: {
            count: openFollowUps.length,
            tickets: openFollowUps,
          },
          // Notes from the last PM — fed to the client-side LLM for
          // kit-content inference + gap analysis. Server doesn't run
          // the LLM call here (keeps endpoint deterministic + fast).
          lastPmContext: {
            ticketObjectId: lastPM?.objectId || null,
            ticketId: lastPM?.ticketId || null,
            resolutionNotes: lastPmNotes
              .filter((n) => n.typeCode === "10022")
              .map((n) => n.text)
              .filter(Boolean)
              .slice(0, 5),
          },
          // Diagnostic — how the categorization split looked.
          diagnostic: {
            pastTicketsTotal: pastTickets.length,
            priorTicketsAfterExclusion: priorTickets.length,
            closedPmCount: closedPms.length,
            ticketsScannedForLineItems: ticketsForLineItems.length,
            serialQueried: serialFromTicket,
          },
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/get_parts_check — v0.27.85. Pre-dispatch parts readiness. This is a
     * faithful SERVER-SIDE port of the extension's runPartsInference (popup.js),
     * so both doors share ONE engine instead of the client re-implementing it.
     * The same inference also seeds /order-parts.
     *
     * Six phases, calling the shim's OWN tools via runNamedTool (so behaviour
     * matches the extension's HTTP calls exactly) + one internal c4cGet for
     * line items + one chat() for the LLM:
     *   1. Similar tickets — find_similar_tickets (vector) ∪ get_serial_history
     *      (serial), unioned/deduped by ObjectID (serial first), source tracked.
     *   2. Per similar ticket (top 5) — notes (get_ticket_notes) + line items
     *      (ServiceRequestItemCollection), in parallel.
     *   3. Structured candidates — parts from CONSUMPTION-proc-type line items
     *      only (allowlist from settings parts.inference_include_types, default
     *      SRP1,ZRP1), with defensive non-part blocklists, aggregated by
     *      MaterialID (recurrence → confidence).
     *   4. LLM inference from the resolution notes, unioned with the structured
     *      candidates by MaterialID (structured is authoritative; LLM enriches).
     *   5. Stock cross-check — search_parts for the top 8.
     *   6. Diagnostics — phase counts + per-ticket provenance.
     *
     * pageContext (the extension's DOM scrape) has no server-side equivalent, so
     * it's omitted — the LLM works from the ticket + resolutions. Never 500s the
     * caller on a sub-phase failure; each phase degrades to empty.
     */
    if (url.pathname === "/api/get_parts_check" && request.method === "GET") {
      const objectId = url.searchParams.get("objectId")?.trim();
      if (!objectId) {
        sendJson(response, 400, { error: "objectId query param is required" });
        return;
      }
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        const { getSettingString } = await import("./settings.js");
        const oid = objectId.replace(/'/g, "''");

        // Ticket entity → product / subject / serial.
        let ticket: any = null;
        try {
          const r: any = await c4cGet(`/ServiceRequestCollection('${oid}')`, { "$format": "json" });
          ticket = r?.d?.results ?? r?.d ?? null;
        } catch { /* non-fatal */ }
        if (!ticket) {
          sendJson(response, 404, { ok: false, error: `Ticket ${objectId} not found` });
          return;
        }
        const productHint = String(ticket?.ProductID || ticket?.ProductName || "").trim();
        const subject = String(ticket?.Name || ticket?.Subject || "").trim();
        const serial = String(ticket?.SerialID || "").trim();
        const ticketId = String(ticket?.ID || "");
        if (!productHint && !subject) {
          sendJson(response, 200, {
            ok: true,
            warning: "no-product-symptom",
            message: "This ticket has no product or subject — can't infer parts.",
            currentTicket: { id: ticketId, objectId, product: productHint, subject, serial },
          });
          return;
        }

        // --- (1) Similar tickets: vector ∪ serial history ---
        const [vec, ser] = await Promise.allSettled([
          runNamedTool("find_similar_tickets", {
            query: [subject, productHint, serial].filter(Boolean).join(" "),
            top: 5,
          }),
          serial
            ? runNamedTool("get_serial_history", {
                serialId: serial, top: 6, includeClosed: true, orderBy: "LastChangeDateTime desc",
              })
            : Promise.resolve(null),
        ]);
        const vectorData: any = vec.status === "fulfilled" ? vec.value : {};
        const serialData: any = ser.status === "fulfilled" ? ser.value : null;
        const vectorResults: any[] = vectorData?.results ?? vectorData?.tickets ?? [];
        const serialResults: any[] = serialData?.tickets ?? serialData?.results ?? [];
        // Union by ObjectID, serial-history first (same-equipment is stronger).
        const sourceByObjectId = new Map<string, string>();
        for (const r of serialResults) {
          const id = r?.ObjectID || r?.objectId;
          if (id && !sourceByObjectId.has(id)) sourceByObjectId.set(id, "serial-history");
        }
        for (const r of vectorResults) {
          const id = r?.ObjectID || r?.objectId;
          if (id && !sourceByObjectId.has(id)) sourceByObjectId.set(id, "vector-search");
        }
        const seenIds = new Set<string>();
        const simResults: any[] = [];
        for (const r of [...serialResults, ...vectorResults]) {
          const id = r?.ObjectID || r?.objectId;
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          simResults.push(r);
        }

        // --- (2) Notes + line items per similar ticket (top 5, parallel) ---
        const similarObjectIds = simResults.map((r) => r.objectId || r.ObjectID).filter(Boolean).slice(0, 5);
        const [notesByTicket, lineItemsByTicket] = await Promise.all([
          Promise.all(similarObjectIds.map(async (sObj: string) => {
            try {
              const d: any = await runNamedTool("get_ticket_notes", { objectId: sObj });
              const notes = Array.isArray(d?.notes) ? d.notes : Array.isArray(d) ? d : [];
              return { objectId: sObj, notes };
            } catch { return { objectId: sObj, notes: [] as any[] }; }
          })),
          Promise.all(similarObjectIds.map(async (sObj: string) => {
            try {
              const r: any = await c4cGet("/ServiceRequestItemCollection", {
                "$format": "json", "$top": 30, "$orderby": "ID desc",
                "$filter": `ParentObjectID eq '${String(sObj).replace(/'/g, "''")}'`,
              });
              const items = (r?.d?.results ?? []).map((row: any) => {
                const o: any = {};
                for (const [k, v] of Object.entries(row)) {
                  if (k === "__metadata") continue;
                  if (v && typeof v === "object" && "__deferred" in (v as Record<string, unknown>)) continue;
                  o[k] = v;
                }
                return o;
              });
              return { objectId: sObj, items };
            } catch { return { objectId: sObj, items: [] as any[] }; }
          })),
        ]);

        // --- (3) Structured candidates from consumption line items ---
        // Allowlist: tenant policy (settings) → default SRP1,ZRP1 (consumption).
        const csvTypes = getSettingString("parts.inference_include_types");
        let includeProcTypes = csvTypes
          ? csvTypes.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
          : ["SRP1", "ZRP1"];
        if (!includeProcTypes.length) includeProcTypes = ["SRP1", "ZRP1"];
        const INCLUDE = new Set(includeProcTypes);
        const NON_PART_PRODUCT_RE = /^(ACTUAL_|REMOTE_|ACT_|TRV_|LBR_)/i;
        const NON_PART_DESC_RE = /(HOURS\s*$|Stundensatz|^ACT(LAB|RVL|TRAV)\b|REMOTE\s*DIAGNOSTIC|DIAGNOSE\s*REMOTE|LABOR\s*HOURS|TRAVEL\s*HOURS)/i;
        const cand = new Map<string, any>();
        let totalScanned = 0, excludedByProcType = 0, excludedByDescOrProduct = 0;
        for (const { objectId: sObj, items } of lineItemsByTicket) {
          for (const it of items) {
            totalScanned++;
            const mid = String(it.ProductID || "").trim();
            if (!mid) continue;
            const desc = String(it.ProductDescription || "").trim();
            const procType = String(it.UserServiceTransactionProcessingTypeCode || "").trim().toUpperCase();
            if (!INCLUDE.has(procType)) { excludedByProcType++; continue; }
            if (NON_PART_PRODUCT_RE.test(mid)) { excludedByDescOrProduct++; continue; }
            if (NON_PART_DESC_RE.test(desc)) { excludedByDescOrProduct++; continue; }
            let e = cand.get(mid);
            if (!e) {
              e = { materialId: mid, description: desc, ticketsSeen: new Set(), processingTypes: new Set(), quantities: [] };
              cand.set(mid, e);
            }
            e.ticketsSeen.add(sObj);
            if (procType) e.processingTypes.add(procType);
            const qty = parseFloat(String(it.PlannedQuantity ?? it.Quantity ?? it.ActualQuantity ?? "0"));
            if (Number.isFinite(qty) && qty > 0) e.quantities.push(qty);
          }
        }
        const structuredList = Array.from(cand.values()).map((e: any) => ({
          materialId: e.materialId,
          name: e.description || e.materialId,
          appearedIn: e.ticketsSeen.size,
          processingTypes: Array.from(e.processingTypes),
          avgQuantity: e.quantities.length ? e.quantities.reduce((s: number, q: number) => s + q, 0) / e.quantities.length : 1,
          source: "line-items",
          confidence: e.ticketsSeen.size >= 3 ? "high" : e.ticketsSeen.size === 2 ? "medium" : "low",
          reason: `Found on ${e.ticketsSeen.size} past ticket${e.ticketsSeen.size === 1 ? "" : "s"} as a line item${e.processingTypes.size > 0 ? ` (processing types: ${Array.from(e.processingTypes).join(", ")})` : ""}.`,
        })).sort((a: any, b: any) => b.appearedIn - a.appearedIn || String(a.name).localeCompare(String(b.name)));

        // --- (4) LLM inference from resolutions, unioned with structured ---
        const resolutionsText = notesByTicket.map((bucket, i) => {
          const t2 = simResults[i];
          const sid = t2?.objectId || t2?.ObjectID || "?";
          const preview = t2?.textPreview || t2?.title || t2?.Name || "";
          const resolution = bucket.notes
            .filter((n: any) => String(n.TypeCode) === "10022" || /response\s*report|execution/i.test(n.TypeCodeText || ""))
            .map((n: any) => String(n.Text || "").trim())
            .filter(Boolean)
            .join("\n---\n");
          if (!resolution) return null;
          return `--- Similar ticket ${i + 1} (${String(sid).slice(0, 8)}…) ---\n${preview}\nResolution:\n${resolution.slice(0, 1500)}`;
        }).filter(Boolean).join("\n\n");

        const prompt =
          `Infer the LIKELY PARTS NEEDED for this service ticket based on the ` +
          `resolutions of similar past tickets. Return ONLY a JSON object:\n\n` +
          `{\n` +
          `  "inferredParts": [\n` +
          `    {\n` +
          `      "name": "<short part name>",\n` +
          `      "materialId": "<SAP material ID if mentioned, else null>",\n` +
          `      "appearedIn": <int — how many of the similar resolutions mentioned this part>,\n` +
          `      "confidence": "high" | "medium" | "low",\n` +
          `      "reason": "<one short sentence — why this part is likely needed>"\n` +
          `    }\n` +
          `  ],\n` +
          `  "summary": "<one sentence top-of-page summary>"\n` +
          `}\n\n` +
          `Rules:\n` +
          `- Return 3-8 parts max. Be selective — only include parts with real ` +
          `evidence of recurrence across the similar tickets.\n` +
          `- Sort by appearedIn DESCENDING (most-recurring first).\n` +
          `- confidence = "high" when ≥3 of 5 similar tickets used the part, ` +
          `"medium" when 2, "low" when 1.\n` +
          `- DO NOT include consumables (gloves, wipes, etc.) — only durable ` +
          `replaceable parts.\n` +
          `- Output the JSON object only.\n\n` +
          `Current ticket: ${ticketId || objectId} — ${subject}\n` +
          `Product: ${productHint}\n` +
          `Serial: ${serial || "?"}\n\n` +
          `Past resolutions on similar tickets:\n${resolutionsText || "(no resolutions found)"}\n`;

        let parsed: any = null;
        try {
          const { chat } = await import("./chat.js");
          const resp = await chat({
            messages: [{ role: "user", content: prompt }],
            maxTokens: 700, temperature: 0.2, actor: "parts-check", module: "service",
          });
          if (resp.ok && resp.text) {
            let text = resp.text.trim();
            const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
            if (fence) text = fence[1];
            const a = text.indexOf("{"), b = text.lastIndexOf("}");
            if (a >= 0 && b > a) text = text.slice(a, b + 1);
            parsed = JSON.parse(text);
          }
        } catch (e: any) {
          console.warn(`[get_parts_check] LLM step failed: ${e?.message ?? e}`);
        }
        const llmInferredParts = (Array.isArray(parsed?.inferredParts) ? parsed.inferredParts : [])
          .map((p: any) => ({ ...p, source: "notes" }));

        // Union structured (authoritative) with LLM by MaterialID.
        const merged = new Map<string, any>();
        for (const sc of structuredList) merged.set(sc.materialId, { ...sc });
        for (const p of llmInferredParts) {
          const mid = String(p.materialId || "").trim();
          if (mid && merged.has(mid)) {
            const ex = merged.get(mid);
            ex.source = "both";
            if (p.reason) ex.reason = `${ex.reason} ${p.reason}`;
            if (ex.confidence === "low" && p.confidence !== "low") ex.confidence = "medium";
            if (ex.confidence === "medium" && p.confidence === "high") ex.confidence = "high";
            continue;
          }
          const key = mid || `__llm__${String(p.name || "").toLowerCase()}`;
          if (!merged.has(key)) merged.set(key, { ...p, source: "notes" });
        }
        const inferredParts = Array.from(merged.values())
          .map((p: any) => ({ ...p, appearedIn: typeof p.appearedIn === "number" ? p.appearedIn : 1 }))
          .sort((a: any, b: any) => b.appearedIn - a.appearedIn);

        // --- (5) Stock cross-check (top 8) ---
        const stockByPart = await Promise.all(inferredParts.slice(0, 8).map(async (p: any) => {
          try {
            const d: any = await runNamedTool("search_parts", { query: p.materialId || p.name, top: 3 });
            const parts = d?.parts ?? d?.results ?? [];
            const best = parts[0];
            return {
              ...p,
              stock: best
                ? {
                    materialId: best.materialId || best.id || p.materialId || "",
                    description: best.description || best.name || "",
                    onHand: typeof best.onHand === "number" ? best.onHand : null,
                    uom: best.uom || best.UOM || "",
                    locations: typeof best.locations === "number" ? best.locations : null,
                  }
                : { onHand: null, materialId: p.materialId, description: p.name },
            };
          } catch {
            return { ...p, stock: { onHand: null, materialId: p.materialId, description: p.name } };
          }
        }));

        // --- (6) Diagnostics ---
        const hasResolution = (n: any) => String(n.TypeCode) === "10022" || /response\s*report|execution/i.test(n.TypeCodeText || "");
        const ticketsWithResolutions = notesByTicket.filter((b) => b.notes.some(hasResolution)).length;
        const stockedCount = stockByPart.filter((p: any) => p.stock?.materialId).length;
        const similarTicketsDetail = simResults.map((r: any) => {
          const sObj = r?.ObjectID || r?.objectId || "";
          const bucket = notesByTicket.find((b) => b.objectId === sObj);
          return {
            objectId: sObj,
            ticketId: r?.ID || r?.id || r?.ServiceRequestID || "",
            title: r?.textPreview || r?.title || r?.Name || r?.Subject || "",
            source: sourceByObjectId.get(sObj) || "unknown",
            hadResolutionNotes: !!(bucket && bucket.notes.some(hasResolution)),
          };
        });

        sendJson(response, 200, {
          ok: true,
          currentTicket: { id: ticketId, objectId, product: productHint, subject, serial, customer: String(ticket?.BuyerPartyName || "") },
          summary: parsed?.summary || "",
          parts: stockByPart,
          similarTicketCount: simResults.length,
          includeProcTypes,
          lineItemsScanned: totalScanned,
          excludedByProcType,
          excludedByDescOrProduct,
          similarTicketsDetail,
          phaseCounts: {
            similarTickets: simResults.length,
            fromVectorSearch: vectorResults.length,
            fromSerialHistory: serialResults.length,
            ticketsWithResolutions,
            inferredByLlm: inferredParts.length,
            matchedInCatalog: stockedCount,
          },
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/resolve_employee — v0.27.47. Resolve the LOGGED-IN SAP UI user
     * to their employee identity (BusinessPartnerID = the party ID that
     * ticket assignments use, plus EmployeeID for display). The extension
     * harvests identity candidates from the SAP shell DOM (user-menu name,
     * logon ID when exposed) and posts them here; we try them against
     * EmployeeCollection in priority order:
     *   1. UserID eq '<LOGON>'            (exact, e.g. MAROUANE.NAJAR)
     *   2. Email eq '<email>'             (corporate email)
     *   3. BusinessPartnerFormattedName eq '<full name>'
     *   4. UserID eq '<FIRST.LAST>'       (derived from the name — this
     *      tenant's logon convention, e.g. "Jane Doe" won't match but
     *      JANE.DOE-style logons that DO follow it will)
     *   5. two-token substringof on the name — accepted ONLY when exactly
     *      one row matches (guards against common surnames)
     * Every strategy requires an unambiguous single row. Admin/service-agent
     * logins (e.g. an admin's own) often have NO employee record — that's a
     * clean {found:false} so the panel can fall back to manual entry.
     */
    /*
     * /api/get_product_prices — v0.27.78. Batch product-price lookup for the
     * Prep-for-PM Price column. Prices live in ECC (the C4C OData API exposes
     * none per-product), so this proxies the ECC pricing simulation via
     * eccPricing.callEccPricing. SCAFFOLD: returns configured:false + empty
     * prices until the ECC endpoint is wired (env ECC_PRICING_*). Best-effort
     * — always 200 so the panel just shows "—" on any miss.
     */
    if (url.pathname === "/api/get_product_prices" && request.method === "POST") {
      try {
        const { getProductPrices, isEccPricingConfigured } = await import("./eccPricing.js");
        const body: any = await readJsonBody(request);
        const productIds = Array.isArray(body?.productIds) ? body.productIds : [];
        const ctx = body?.ctx && typeof body.ctx === "object" ? body.ctx : {};
        const configured = isEccPricingConfigured();
        const prices = configured ? await getProductPrices(productIds, ctx) : {};
        sendJson(response, 200, { ok: true, configured, prices });
      } catch (e: any) {
        sendJson(response, 200, {
          ok: true,
          configured: false,
          prices: {},
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
      return;
    }
    if (url.pathname === "/api/resolve_employee" && request.method === "POST") {
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        const body: any = await readJsonBody(request);
        const clean = (v: unknown): string => String(v ?? "").trim().slice(0, 80);
        const arr = (v: unknown): string[] =>
          (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, 5);
        const userIds = arr(body?.userIds);
        const emails = arr(body?.emails);
        const names = arr(body?.names);
        if (!userIds.length && !emails.length && !names.length) {
          sendJson(response, 400, { ok: false, error: "no identity candidates (userIds/emails/names all empty)" });
          return;
        }
        const esc = (s: string) => s.replace(/'/g, "''");
        const SELECT = "BusinessPartnerID,EmployeeID,UserID,BusinessPartnerFormattedName,Email";

        // Build the attempt list in priority order, deduped by filter.
        const attempts: Array<{ filter: string; via: string }> = [];
        const add = (filter: string, via: string) => {
          if (!attempts.some((a) => a.filter === filter)) attempts.push({ filter, via });
        };
        for (const u of userIds) add(`UserID eq '${esc(u.toUpperCase())}'`, `UserID "${u}"`);
        for (const e of emails) {
          add(`Email eq '${esc(e)}'`, `email "${e}"`);
          if (e !== e.toLowerCase()) add(`Email eq '${esc(e.toLowerCase())}'`, `email "${e.toLowerCase()}"`);
        }
        for (const n of names) add(`BusinessPartnerFormattedName eq '${esc(n)}'`, `exact name "${n}"`);
        for (const n of names) {
          const tokens = n.split(/\s+/).filter(Boolean);
          if (tokens.length >= 2) {
            const derived = tokens.join(".").toUpperCase();
            add(`UserID eq '${esc(derived)}'`, `derived logon "${derived}"`);
          }
        }
        // Last resort: substringof on the SURNAME only — this tenant's
        // OData parser rejects two substringofs joined with `and`
        // ("Operands of logical operator 'and' are not valid", same
        // family as the OR-chain limitation), so the first-name check
        // happens client-side on the fetched rows instead.
        for (const n of names) {
          const tokens = n.split(/\s+/).filter((t) => t.length >= 2);
          if (tokens.length >= 2) {
            const first = tokens[0];
            const last = tokens[tokens.length - 1];
            add(
              `substringof('${esc(last)}',BusinessPartnerFormattedName)`,
              `surname "${last}" (then "${first}" checked client-side)`,
            );
          }
        }

        const firstTokens = names
          .map((n) => n.split(/\s+/).filter((t) => t.length >= 2)[0])
          .filter(Boolean)
          .map((t) => t.toLowerCase());

        const tried: string[] = [];
        for (const a of attempts) {
          try {
            const r: any = await c4cGet("/EmployeeCollection", {
              "$format": "json", "$top": 10, "$filter": a.filter, "$select": SELECT,
            });
            let rows: any[] = r?.d?.results ?? [];
            // Surname-substring rows MUST also contain a harvested first
            // name — otherwise "Alex Doe" would falsely resolve to
            // the one other Doe in the tenant. Applies even to a
            // single-row result.
            if (a.via.startsWith("surname") && firstTokens.length) {
              rows = rows.filter((row) => {
                const nm = String(row?.BusinessPartnerFormattedName || "").toLowerCase();
                return firstTokens.some((ft) => nm.includes(ft));
              });
            }
            if (rows.length === 1) {
              const e = rows[0];
              sendJson(response, 200, {
                ok: true,
                found: true,
                matchedBy: a.via,
                employee: {
                  partyId: String(e?.BusinessPartnerID || "").trim(),
                  employeeId: String(e?.EmployeeID || "").trim(),
                  userId: String(e?.UserID || "").trim(),
                  name: String(e?.BusinessPartnerFormattedName || "").trim(),
                  email: String(e?.Email || "").trim(),
                },
                tried: [...tried, `${a.via} → MATCH`],
              });
              return;
            }
            tried.push(`${a.via} → ${rows.length === 0 ? "no match" : `${rows.length} matches (ambiguous, skipped)`}`);
          } catch (e: any) {
            tried.push(`${a.via} → error: ${String(e?.message ?? e).slice(0, 80)}`);
          }
        }
        sendJson(response, 200, { ok: true, found: false, tried });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/draft_customer_reply — v0.27.54. Server-side, CONTEXT-AWARE
     * customer reply draft built from the ticket's LATEST state — fetched
     * fresh from SAP at draft time (unlike the extension-local v0.27.52
     * path, which drafts from whatever the /interactions panel held):
     *   1. ticket entity   → status, subject, dates, contact email
     *   2. line items      → parts ON ORDER (ZRP3) vs consumed, labour/travel
     *   3. notes           → the running narrative incl. emailed-in content
     * The LLM grounds the draft ONLY in those facts and answers in the
     * customer's language. Returns {draft:{subject,body,language},
     * recipient, contextText} — contextText feeds the extension's tone
     * dial so regeneration uses the same fresh facts.
     */
    if (url.pathname === "/api/draft_customer_reply" && request.method === "POST") {
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        const { getTicketNotes } = await import("./serviceOps.js");
        const { chat } = await import("./chat.js");
        const body: any = await readJsonBody(request);
        let objectId = String(body?.objectId ?? "").trim();
        const ticketId = String(body?.ticketId ?? "").trim();
        const tone = String(body?.tone ?? "formal").trim().toLowerCase();
        // v0.27.58 — operator's display name (resolved client-side from the
        // SAP session) so the sign-off is real, not "[Your name]".
        const senderName = String(body?.senderName ?? "").trim().slice(0, 80);

        // Resolve a human ticket ID to the 32-hex ObjectID when needed.
        if (!/^[A-F0-9]{32}$/i.test(objectId)) {
          const lookupKey = objectId || ticketId;
          if (!lookupKey) {
            sendJson(response, 400, { ok: false, error: "objectId or ticketId is required" });
            return;
          }
          const r: any = await c4cGet("/ServiceRequestCollection", {
            "$format": "json", "$top": 1,
            "$filter": `ID eq '${lookupKey.replace(/'/g, "''")}'`,
            "$select": "ObjectID,ID",
          });
          objectId = String((r?.d?.results ?? [])[0]?.ObjectID || "").trim();
          if (!objectId) {
            sendJson(response, 404, { ok: false, error: `Ticket ${lookupKey} not found` });
            return;
          }
        }
        const oid = objectId.replace(/'/g, "''");

        // ---- Fetch the LATEST state, in parallel. Each is non-fatal. ----
        const [ticketEntity, lineItems, notes] = await Promise.all([
          c4cGet(`/ServiceRequestCollection('${oid}')`, { "$format": "json" })
            .then((r: any) => r?.d?.results ?? r?.d ?? null).catch(() => null),
          c4cGet("/ServiceRequestItemCollection", {
            "$format": "json", "$top": 100,
            "$filter": `ParentObjectID eq '${oid}'`, "$orderby": "ID asc",
          }).then((r: any) => (r?.d?.results ?? []) as any[]).catch(() => [] as any[]),
          getTicketNotes({ objectId, top: 20 })
            .then((r: any) => (Array.isArray(r?.notes) ? r.notes : [])).catch(() => [] as any[]),
        ]);

        const sapDate = (v: any): string => {
          const m = /\/Date\((\d+)\)\//.exec(String(v ?? ""));
          return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : "";
        };

        // Contact email — first @-bearing *mail* field (KUT_CEMAILS_KUT may
        // hold several, ;-separated → first token). Mirrors the extension's
        // pickEmailFromEntity.
        let recipient = "";
        if (ticketEntity && typeof ticketEntity === "object") {
          for (const [k, v] of Object.entries(ticketEntity)) {
            if (typeof v !== "string" || !v.includes("@") || !/mail/i.test(k)) continue;
            const first = v.split(/[;,\s]+/).filter(Boolean)[0] || "";
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first)) { recipient = first; break; }
          }
        }
        // v0.27.58 — customer CONTACT name (the human we're writing to), so
        // the greeting is "Hi <FirstName>," not "Hi [Customer name],". The
        // ticket's main contact / reported-by party is the addressee, NOT
        // the account name (BuyerPartyName = the company).
        const recipientName = String(
          (ticketEntity as any)?.BuyerMainContactPartyName ||
          (ticketEntity as any)?.ReportedPartyName ||
          (ticketEntity as any)?.ContactPartyName || "",
        ).trim();
        const recipientFirst = recipientName.split(/\s+/).filter(Boolean)[0] || "";

        // Parts: ordered (ZRP3) vs consumed (SRP1/ZRP1) — what the customer
        // most often asks about. Labour/travel intentionally summarized only.
        const partsOrdered: string[] = [];
        const partsConsumed: string[] = [];
        for (const li of lineItems) {
          const code = String(li?.UserServiceTransactionProcessingTypeCode || li?.ProcessingTypeCode || "").toUpperCase();
          const desc = String(li?.ProductDescription || li?.Description || li?.ProductID || "").slice(0, 80);
          const qty = Number(li?.ActualQuantity) || Number(li?.PlannedQuantity) || Number(li?.Quantity) || 0;
          const line = `${desc}${qty ? ` (qty ${qty})` : ""}${li?.ProductID ? ` [${li.ProductID}]` : ""}`;
          if (code === "ZRP3") partsOrdered.push(line);
          else if (code === "SRP1" || code === "ZRP1") partsConsumed.push(line);
        }

        const noteLines = notes.slice(0, 12).map((n: any) => {
          const txt = String(n?.Text || n?.FormattedText || "").replace(/\s+/g, " ").trim().slice(0, 500);
          return txt ? `[${sapDate(n?.CreatedOn) || "?"} · ${String(n?.TypeCodeText || "note")}] ${txt}` : "";
        }).filter(Boolean);

        const t = ticketEntity || {};
        const contextText = [
          `Ticket ${String(t.ID || ticketId || "")}: ${String(t.Name || "(no subject)")}`,
          `Status: ${String(t.ServiceRequestUserLifeCycleStatusCodeText || t.ServiceRequestLifeCycleStatusCodeText || "?")}` +
            (t.KUT_Secondary_Ticket_TypeText ? ` · Type: ${t.KUT_Secondary_Ticket_TypeText}` : ""),
          `Customer: ${String(t.BuyerPartyName || "?")}` +
            (t.ProductID ? ` · Product: ${t.ProductID}` : "") + (t.SerialID ? ` · Serial: ${t.SerialID}` : ""),
          sapDate(t.CreationDateTime) ? `Opened: ${sapDate(t.CreationDateTime)}` : "",
          sapDate(t.OnSiteArrivalDueDateTime) ? `On-site due: ${sapDate(t.OnSiteArrivalDueDateTime)}` : "",
          sapDate(t.OnSiteArrivalDateTime) ? `Technician was on-site: ${sapDate(t.OnSiteArrivalDateTime)}` : "",
          partsOrdered.length ? `Parts ON ORDER (not yet confirmed delivered):\n  - ${partsOrdered.join("\n  - ")}` : "No parts currently on order.",
          partsConsumed.length ? `Parts already used:\n  - ${partsConsumed.join("\n  - ")}` : "",
          "",
          noteLines.length ? `Ticket notes, newest first (includes emailed-in content):\n${noteLines.join("\n")}` : "No notes on the ticket.",
        ].filter(Boolean).join("\n");

        const toneInstruction =
          tone === "empathetic" ? "Warm and understanding — acknowledge any frustration first, soften technical language."
          : tone === "concise" ? "Short and direct — 3 to 6 sentences, lead with the key update."
          : "Professional and courteous — precise business register.";

        const prompt =
          `Draft a customer-facing email reply for this service ticket, using ONLY the facts below — ` +
          `never invent dates, part numbers, promises, or commitments that are not in the context.\n\n` +
          `${contextText}\n\n` +
          `Tone: ${toneInstruction}\n\n` +
          `Rules:\n` +
          `- Reply in the SAME LANGUAGE as the customer's most recent message in the notes (greeting included) — a French message gets a fully French reply.\n` +
          (recipientFirst
            ? `- Greet the customer by their first name: start with "Hi ${recipientFirst}," (or that greeting's equivalent in the reply language). Do NOT write a placeholder like "[Customer name]".\n`
            : `- Start with "Hi there," — do NOT write a placeholder like "[Customer name]".\n`) +
          `- Answer their latest open question/request first, then give the current status (parts on order, next step).\n` +
          `- If information they asked for is not in the context, say the team is confirming it — do NOT fabricate.\n` +
          (senderName
            ? `- Plain text only. End with "Best regards," then the sender name "${senderName}" on the next line — use that exact name, NOT a placeholder like "[Your name]".\n`
            : `- Plain text only. End with "Best regards,\\n[Your name]" (or its equivalent in the reply language).\n`) +
          `- Output ONLY a JSON object: {"subject": "...", "body": "...", "language": "<English name of the reply language>"} — no markdown fences, no preamble.\n`;

        const llm: any = await chat({
          messages: [{ role: "user", content: prompt }],
          ticketObjectId: objectId,
          maxTokens: 1200,
          temperature: 0.3,
          actor: String(request.headers["x-admin-actor"] || "chrome-extension"),
          module: "service",
        });
        if (!llm?.ok) {
          sendJson(response, 502, { ok: false, error: llm?.error || "LLM draft failed" });
          return;
        }

        // Robust JSON extraction (fences / preamble tolerated).
        let draft: { subject?: string; body?: string; language?: string } = {};
        try {
          let text = String(llm.text || "").trim();
          const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
          if (fence) text = fence[1];
          const a = text.indexOf("{"), b = text.lastIndexOf("}");
          if (a >= 0 && b > a) text = text.slice(a, b + 1);
          draft = JSON.parse(text);
        } catch {
          // Fall back to raw text as the body — still usable in the editor.
          draft = { subject: `Ticket ${String(t.ID || ticketId || "")} — update`, body: String(llm.text || "").trim() };
        }

        sendJson(response, 200, {
          ok: true,
          draft: {
            subject: String(draft.subject || `Ticket ${String(t.ID || ticketId || "")} — update`).slice(0, 200),
            body: String(draft.body || "").slice(0, 8000),
            language: String(draft.language || ""),
          },
          recipient,
          recipientName,
          contextText,
          meta: {
            ticketId: String(t.ID || ticketId || ""),
            status: String(t.ServiceRequestUserLifeCycleStatusCodeText || ""),
            partsOrdered: partsOrdered.length,
            partsConsumed: partsConsumed.length,
            notesUsed: noteLines.length,
          },
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/get_my_day — v0.27.46. The dashboard's "My Day" AI-companion
     * briefing: every open ticket assigned to THE OPERATOR, across the
     * THREE places assignment happens on this tenant:
     *   a) Service Agent on the ticket header   → ProcessorPartyID
     *   b) Service Technician on the header     → ServicePerformerPartyID
     *   c) Service Technician at ITEM level     → ServiceRequestItem.ServicePerformerPartyID
     * plus per-ticket intelligence: escalation flags, visits due within
     * 7 days, and ordered-parts (ZRP3) attention markers for the focus
     * subset.
     *
     * Identity: ?partyId=NNN wins; else ?email=… is resolved via
     * EmployeeCollection (readable since the 2026-06-12 RBAM grant) →
     * BusinessPartnerID. Both missing/unresolvable → {needsIdentity:true}
     * so the panel renders its setup card.
     */
    if (url.pathname === "/api/get_my_day" && request.method === "GET") {
      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        let partyId = url.searchParams.get("partyId")?.trim() || "";
        const email = url.searchParams.get("email")?.trim() || "";
        let resolvedVia = partyId ? "partyId param" : "";

        if (!partyId && email) {
          // Best-effort email → BusinessPartnerID. Field name "Email"
          // confirmed present on EmployeeCollection rows; tolerate
          // tenants where it's named differently by catching the 400.
          try {
            const r: any = await c4cGet("/EmployeeCollection", {
              "$format": "json",
              "$top": 2,
              "$filter": `Email eq '${email.replace(/'/g, "''")}'`,
              "$select": "BusinessPartnerID,BusinessPartnerFormattedName,Email",
            });
            const rows: any[] = r?.d?.results ?? [];
            if (rows.length === 1) {
              partyId = String(rows[0]?.BusinessPartnerID || "").trim();
              resolvedVia = `email lookup (${String(rows[0]?.BusinessPartnerFormattedName || "")})`;
            }
          } catch (e: any) {
            console.warn("[get_my_day] employee email lookup failed:", e?.message ?? e);
          }
        }
        if (!partyId) {
          sendJson(response, 200, { ok: true, needsIdentity: true });
          return;
        }
        const pid = partyId.replace(/'/g, "''");

        const TICKET_SELECT = [
          "ObjectID", "ID", "Name", "BuyerPartyName", "ProductID", "SerialID",
          "ServiceRequestLifeCycleStatusCode", "ServiceRequestUserLifeCycleStatusCodeText",
          "ServicePriorityCode", "EscalationStatusCode", "EscalationStatusCodeText",
          "OnSiteArrivalDueDateTime", "OnSiteArrivalDateTime",
          "KUT_Secondary_Ticket_TypeText", "LastChangeDateTime",
          "ProcessorPartyID", "ServicePerformerPartyID",
        ].join(",");
        // lt '3' = Open(1) + In Process(2). Live-test with lt '4'
        // flooded the briefing with years-old status-3 "Sys.Completed"
        // rows — completed is NOT "needs my attention".
        const OPEN = "ServiceRequestLifeCycleStatusCode lt '3'";

        const fetchTickets = async (filter: string): Promise<any[]> => {
          try {
            const r: any = await c4cGet("/ServiceRequestCollection", {
              "$format": "json", "$top": 100, "$filter": filter,
              "$orderby": "LastChangeDateTime desc", "$select": TICKET_SELECT,
            });
            return r?.d?.results ?? [];
          } catch (e: any) {
            console.warn("[get_my_day] ticket query failed:", filter.slice(0, 80), e?.message ?? e);
            return [];
          }
        };

        // a + b — header-level assignments (parallel).
        const [agentRows, techRows] = await Promise.all([
          fetchTickets(`ProcessorPartyID eq '${pid}' and ${OPEN}`),
          fetchTickets(`ServicePerformerPartyID eq '${pid}' and ${OPEN}`),
        ]);

        // c — item-level assignment → parent tickets.
        let itemParentIds: string[] = [];
        try {
          const r: any = await c4cGet("/ServiceRequestItemCollection", {
            "$format": "json", "$top": 200,
            "$filter": `ServicePerformerPartyID eq '${pid}'`,
            "$select": "ParentObjectID",
          });
          itemParentIds = [...new Set(((r?.d?.results ?? []) as any[])
            .map((x) => String(x?.ParentObjectID || "").trim()).filter(Boolean))];
        } catch (e: any) {
          console.warn("[get_my_day] item-level query failed:", e?.message ?? e);
        }
        // Fetch item-parents not already covered, in OR-chunks of 12.
        const have = new Set([...agentRows, ...techRows].map((t) => String(t.ObjectID)));
        const missingParents = itemParentIds.filter((id) => !have.has(id));
        const itemRows: any[] = [];
        for (let i = 0; i < missingParents.length && i < 96; i += 12) {
          const chunk = missingParents.slice(i, i + 12);
          const orClause = chunk.map((id) => `ObjectID eq '${id.replace(/'/g, "''")}'`).join(" or ");
          itemRows.push(...(await fetchTickets(`(${orClause}) and ${OPEN}`)));
        }

        // Union + role tagging.
        const agentSet = new Set(agentRows.map((t) => String(t.ObjectID)));
        const techSet = new Set(techRows.map((t) => String(t.ObjectID)));
        const itemSet = new Set(itemParentIds);
        const byId = new Map<string, any>();
        for (const t of [...agentRows, ...techRows, ...itemRows]) {
          byId.set(String(t.ObjectID), t);
        }

        const parseDate = (s: any): number | null => {
          const m = /\/Date\((\d+)/.exec(String(s ?? ""));
          if (m) return Number(m[1]);
          const t = Date.parse(String(s ?? ""));
          return Number.isFinite(t) ? t : null;
        };
        const now = Date.now();
        const in7d = now + 7 * 86400000;

        const tickets = [...byId.values()].map((t) => {
          const oid = String(t.ObjectID);
          const dueMs = parseDate(t.OnSiteArrivalDueDateTime);
          const arrived = Boolean(parseDate(t.OnSiteArrivalDateTime));
          // NOTE: text fallback must NOT match "Not Escalated" — the
          // naive /escalat/i regex flagged 137/137 tickets on the first
          // live test. Code "1" = Not Escalated on this tenant.
          const escText = String(t.EscalationStatusCodeText || "").trim();
          const isEscalated = String(t.EscalationStatusCode || "") === "2" ||
            (/escalat/i.test(escText) && !/^not\b/i.test(escText));
          return {
            objectId: oid,
            ticketId: String(t.ID || ""),
            subject: String(t.Name || ""),
            customer: String(t.BuyerPartyName || ""),
            statusText: String(t.ServiceRequestUserLifeCycleStatusCodeText || ""),
            secondaryTypeText: String(t.KUT_Secondary_Ticket_TypeText || ""),
            roles: {
              agent: agentSet.has(oid),
              technicianHeader: techSet.has(oid),
              technicianItem: itemSet.has(oid),
            },
            isEscalated,
            dueOnSiteAt: t.OnSiteArrivalDueDateTime ?? null,
            visitDueSoon: !arrived && dueMs !== null && dueMs <= in7d,
            visitOverdue: !arrived && dueMs !== null && dueMs < now,
          };
        });

        // Focus subset: escalated first, then due-soon by earliest due.
        const focus = tickets
          .filter((t) => t.isEscalated || t.visitDueSoon)
          .sort((a, b) => {
            if (a.isEscalated !== b.isEscalated) return a.isEscalated ? -1 : 1;
            return (parseDate(a.dueOnSiteAt) ?? Infinity) - (parseDate(b.dueOnSiteAt) ?? Infinity);
          })
          .slice(0, 12);

        // Parts intelligence for the focus subset only (bounded cost):
        // ZRP3 lines = parts ORDERED → verify van stock / customer
        // receipt before the visit.
        for (let i = 0; i < focus.length; i += 6) {
          await Promise.all(focus.slice(i, i + 6).map(async (f: any) => {
            try {
              const r: any = await c4cGet("/ServiceRequestItemCollection", {
                "$format": "json", "$top": 50,
                "$filter": `ParentObjectID eq '${f.objectId.replace(/'/g, "''")}'`,
                "$select": "UserServiceTransactionProcessingTypeCode",
              });
              const codes = ((r?.d?.results ?? []) as any[])
                .map((x) => String(x?.UserServiceTransactionProcessingTypeCode || "").toUpperCase());
              f.partsOrdered = codes.filter((c) => c === "ZRP3").length;
              f.partsConsumed = codes.filter((c) => c === "SRP1" || c === "ZRP1").length;
            } catch { f.partsOrdered = null; f.partsConsumed = null; }
          }));
        }

        sendJson(response, 200, {
          ok: true,
          partyId,
          resolvedVia: resolvedVia || "partyId param",
          counts: {
            assignedTotal: tickets.length,
            asAgent: agentRows.length,
            asTechnicianHeader: techRows.length,
            viaLineItems: itemSet.size,
            escalated: tickets.filter((t) => t.isEscalated).length,
            visitsDueSoon: tickets.filter((t) => t.visitDueSoon).length,
            visitsOverdue: tickets.filter((t) => t.visitOverdue).length,
            focusWithOrderedParts: focus.filter((f: any) => (f.partsOrdered ?? 0) > 0).length,
          },
          focus,
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    // -----------------------------------------------------------------------
    // /api/debug/* — gated by the SAME fail-closed internal auth as
    // /api/admin/*.
    //
    // These endpoints were previously wide open. /api/debug/query in
    // particular proxies arbitrary OData GETs to the live SAP tenant using the
    // server's integration credentials — i.e. unauthenticated read access to
    // the customer's entire ticket database for anyone who found the URL.
    // Harmless bound to 127.0.0.1; a data-exfiltration hole the moment the
    // shim is hosted.
    //
    // NOT gated on isAdminEnabled(): the extension is a legitimate caller of
    // /api/debug/query (InstallationPoint backfill, /nearby service-location
    // lookup) and must keep working with ADMIN_ENABLED unset. It authenticates
    // with its bearer token. Local dev stays open via ASKC4S_ADMIN_INSECURE=true
    // (set by `npm start`, scripts/dev.mjs).
    // -----------------------------------------------------------------------
    if (parts[0] === "api" && parts[1] === "debug" && !isInternalAuthorized(request)) {
      sendJson(response, 401, {
        ok: false,
        error:
          "Unauthorized. /api/debug/* requires a valid internal auth token. " +
          "Set ASKC4S_INTERNAL_PASSWORD and authenticate via /api/internal/auth, " +
          "or ASKC4S_ADMIN_INSECURE=true for local development.",
      });
      return;
    }

    /**
     * /api/debug/system-info — v0.26.103 Debug panel data source.
     * Returns shim version, configured C4C tenant base URL, the
     * integration user identity, and the auto-writeback feature-flag
     * state. The Debug panel surfaces all of these so operators can
     * see at a glance which environment they're talking to.
     */
    if (url.pathname === "/api/debug/system-info" && request.method === "GET") {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        let extensionVersion = null;
        try {
          const manifestPath = path.resolve(process.cwd(), "chrome-extension", "manifest.json");
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { version?: string };
          extensionVersion = manifest.version || null;
        } catch {/* ok */ }
        let tenantBase = null;
        let integrationUser = null;
        try {
          const cfg = await import("./connectors/c4c/client.js");
          const getCfg: any = (cfg as any).getConfigIfAvailable || (cfg as any).getConfig;
          if (typeof getCfg === "function") {
            const c = getCfg();
            if (c) {
              tenantBase = c.baseUrl || null;
              integrationUser = c.user || null;
            }
          }
        } catch { /* defensive */ }
        let featureFlag = false;
        try {
          const { getSettingBoolean } = await import("./settings.js");
          featureFlag = getSettingBoolean("feature.auto_writeback_enabled");
        } catch { /* defensive */ }
        sendJson(response, 200, {
          ok: true,
          shimVersion: extensionVersion,
          tenantBase,
          integrationUser,
          autoWritebackEnabled: featureFlag,
          nodeVersion: process.version,
          shimEndpoint: `http://${process.env.UI_HOST || "127.0.0.1"}:${process.env.UI_PORT || "3031"}`,
        });
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    /**
     * /api/debug/query — v0.26.103 arbitrary OData GET against the
     * tenant. SAFETY: GET-only (read-only), path-prefix-restricted
     * (must start with `/`), and length-capped at 1KB. Operator types a
     * relative OData URL like `/ServiceRequestCollection?$top=3` and
     * sees the raw JSON response. Used by the Debug panel's "Custom
     * Query" tab to verify field names, test filters, etc.
     */
    if (url.pathname === "/api/debug/query" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const queryPath = String((body as { path?: unknown } | null)?.path ?? "").trim();
        if (!queryPath) {
          sendJson(response, 400, { ok: false, error: "path is required (e.g., '/ServiceRequestCollection?$top=1')" });
          return;
        }
        if (!queryPath.startsWith("/")) {
          sendJson(response, 400, { ok: false, error: "path must start with '/' (relative OData path)" });
          return;
        }
        if (queryPath.length > 1024) {
          sendJson(response, 400, { ok: false, error: "path too long (max 1024 chars)" });
          return;
        }
        const { c4cGet } = await import("./connectors/c4c/client.js");
        // Split path + query string. c4cGet accepts (path, queryDict).
        const qIdx = queryPath.indexOf("?");
        const pathOnly = qIdx === -1 ? queryPath : queryPath.slice(0, qIdx);
        const queryString = qIdx === -1 ? "" : queryPath.slice(qIdx + 1);
        const queryDict: Record<string, string> = {};
        if (queryString) {
          for (const pair of queryString.split("&")) {
            const [k, ...rest] = pair.split("=");
            if (k) queryDict[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
          }
        }
        // Default $format=json if not specified.
        if (!queryDict["$format"]) queryDict["$format"] = "json";
        const t0 = Date.now();
        const result = await c4cGet(pathOnly, queryDict);
        const elapsedMs = Date.now() - t0;
        sendJson(response, 200, {
          ok: true,
          path: pathOnly,
          query: queryDict,
          elapsedMs,
          result,
        });
      } catch (e: any) {
        sendJson(response, 500, {
          ok: false,
          error: e?.message ?? String(e),
        });
      }
      return;
    }

    // ------------------------------------------------------------------
    // Shared-password gate — protects the private live-data routes.
    // Threat model: deter casual visitors from a public URL. Not a
    // cryptographic guarantee. The password lives in ASKC4S_INTERNAL_PASSWORD;
    // on success we issue a random hex token kept in-memory for 24h.
    // ------------------------------------------------------------------
    // -------------------------------------------------------------------
    // Personal accounts — sign in / out / change password. The user logic is
    // in users.ts + usersRoutes.ts; this is only the dispatch.
    // -------------------------------------------------------------------
    if (
      parts[0] === "api" &&
      parts[1] === "auth" &&
      (parts[2] === "login" || parts[2] === "logout" || parts[2] === "change-password") &&
      (await handleAuthRoutes(
        { request, response, url, parts, principal, sendJson, readJson: readJsonBody },
        authHooks,
      ))
    ) {
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/dev-login — LOCAL DEV ONLY. Mints an email-bearing token
    // without an IdP, so the SSO auto-identity flow (whoami → My Day) can be
    // built and demoed before the Entra App Registration exists.
    //
    // Safe by construction: it does nothing unless ASKC4S_ADMIN_INSECURE=true,
    // which the Docker images never set — and where it IS set the API gate is
    // already wide open, so this grants no access that isn't already granted.
    // In any real posture it returns 404, as if it didn't exist.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/dev-login" && request.method === "POST") {
      if (!adminInsecureAllowed() || process.env.ASKC4S_INTERNAL_PASSWORD) {
        sendJson(response, 404, { ok: false, error: "Not found." });
        return;
      }
      const body = (await readJsonBody(request)) as { email?: string; name?: string };
      const email = String(body?.email ?? "").trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        sendJson(response, 400, { ok: false, error: "A valid email is required." });
        return;
      }
      const token = issueInternalToken({
        source: "dev",
        user: { email, name: String(body?.name ?? "").trim() || undefined },
      });
      sendJson(response, 200, { ok: true, token, user: { email }, dev: true });
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/providers — PUBLIC. Tells the login screen which SSO options
    // exist, WITHOUT leaking secrets, so the client can show "Sign in with
    // Microsoft" only when Entra is actually configured. Inert deployment →
    // { oidc: false } and the button never appears.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/providers" && request.method === "GET") {
      const { isEntraOidcConfigured } = await import("./connectors/entra-oidc/client.js");
      sendJson(response, 200, {
        ok: true,
        providers: {
          oidc: isEntraOidcConfigured(),
          oidcStartUrl: "/api/auth/oidc/start",
          password: Boolean(process.env.ASKC4S_INTERNAL_PASSWORD),
          // true once personal accounts exist: login screens should ask for an
          // email + password (POST /api/auth/login) instead of the shared one.
          directory: directoryActive(),
        },
      });
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/oidc/start — begin the Entra sign-in. Generates PKCE + state,
    // stashes the verifier, and 302-redirects the browser to Entra. INERT
    // until configured (returns a clear message instead of a broken redirect).
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/oidc/start" && request.method === "GET") {
      const entra = await import("./connectors/entra-oidc/client.js");
      if (!entra.isEntraOidcConfigured()) {
        sendJson(response, 503, {
          ok: false,
          error:
            "Entra SSO is not configured. Set ENTRA_OIDC_TENANT_ID + ENTRA_OIDC_CLIENT_ID " +
            "(+ ENTRA_OIDC_REDIRECT_URI) on the server. See docs/engineering-notes.md → Entra SSO.",
        });
        return;
      }
      try {
        sweepOidcFlows();
        const { verifier, challenge } = entra.newPkce();
        const state = entra.newState();
        // Derive the redirect URI from this request if the env var is unset, so
        // local testing works without hard-coding a host. Prod should set it
        // explicitly so it matches the app registration exactly.
        const status = entra.entraOidcStatus();
        const redirectUri =
          status.redirectUri ||
          `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}/api/auth/oidc/callback`;
        oidcFlows.set(state, { verifier, createdAt: Date.now(), redirectUri });
        const authorizeUrl = entra.buildAuthorizeUrl({ state, codeChallenge: challenge, redirectUri });
        response.writeHead(302, { Location: authorizeUrl });
        response.end();
      } catch (e: any) {
        sendJson(response, 500, { ok: false, error: `OIDC start failed: ${String(e?.message ?? e).slice(0, 200)}` });
      }
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/oidc/callback — Entra redirects here with ?code&state. Exchange
    // the code, verify the id_token, mint our internal token, then hand it to
    // the SPA via a server-rendered bootstrap page (token in the HTML body, NOT
    // the URL — query strings get logged and cached).
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/oidc/callback" && request.method === "GET") {
      const entra = await import("./connectors/entra-oidc/client.js");
      if (!entra.isEntraOidcConfigured()) {
        sendJson(response, 503, { ok: false, error: "Entra SSO is not configured." });
        return;
      }
      const oidcError = url.searchParams.get("error");
      if (oidcError) {
        sendOidcResult(response, null, `Entra returned an error: ${oidcError} — ${url.searchParams.get("error_description") || ""}`);
        return;
      }
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const flow = state ? oidcFlows.get(state) : undefined;
      if (!code || !flow) {
        sendOidcResult(response, null, "Sign-in state expired or invalid. Please try again.");
        return;
      }
      oidcFlows.delete(state); // one-time use
      try {
        const idToken = await entra.exchangeCodeForIdToken({
          code,
          codeVerifier: flow.verifier,
          redirectUri: flow.redirectUri,
        });
        const identity = await entra.verifyIdToken(idToken);
        // Same rule as Google: in directory mode only existing accounts get in.
        let directoryUserId: string | undefined;
        if (directoryActive()) {
          const sso = resolveSsoUser(identity.email);
          if (!sso.ok) {
            sendOidcResult(response, null, sso.error);
            return;
          }
          directoryUserId = sso.user.id;
        }
        const token = issueInternalToken({
          source: "entra",
          userId: directoryUserId,
          user: { email: identity.email, name: identity.name },
        });
        sendOidcResult(response, token, null);
      } catch (e: any) {
        sendOidcResult(response, null, `Sign-in failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      return;
    }

    if (url.pathname === "/api/internal/auth" && request.method === "POST") {
      // Once personal accounts exist, one shared password for everyone is exactly
      // what they replace (no attribution, no revocation). It stays available
      // only as a deliberate break-glass: ASKC4S_ALLOW_SHARED_PASSWORD=true.
      if (
        directoryActive() &&
        String(process.env.ASKC4S_ALLOW_SHARED_PASSWORD ?? "").trim().toLowerCase() !== "true"
      ) {
        sendJson(response, 403, {
          ok: false,
          error:
            "This deployment uses personal accounts. Sign in with your email and password " +
            "(POST /api/auth/login).",
        });
        return;
      }
      const body = await readJsonBody(request);
      const submitted = String((body as { password?: unknown } | null)?.password ?? "");
      const expected = process.env.ASKC4S_INTERNAL_PASSWORD ?? "";
      if (!expected) {
        sendJson(response, 503, {
          ok: false,
          error: "ASKC4S_INTERNAL_PASSWORD is not set on the server. Set it in .env and restart.",
        });
        return;
      }
      if (submitted && submitted === expected) {
        const token = issueInternalToken();
        sendJson(response, 200, { ok: true, token });
        return;
      }
      sendJson(response, 401, { ok: false, error: "Incorrect password." });
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/google — extension/SSO sign-in. Takes a Google access
    // token from chrome.identity.getAuthToken, validates it against
    // Google's userinfo endpoint, checks the email domain against the
    // `ASKC4S_AUTH_ALLOWED_DOMAINS` env-var allowlist (comma-separated),
    // and issues a session token bound to the user.
    //
    // Body: { accessToken: string }
    // Returns: { ok: true, token, user: { email, name, picture }, ttlSec }
    // Errors: 400 (missing token), 401 (Google rejected), 403 (domain not allowed)
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      const body = (await readJsonBody(request)) as { accessToken?: string };
      const accessToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
      if (!accessToken) {
        sendJson(response, 400, { ok: false, error: "accessToken required" });
        return;
      }
      try {
        // Google userinfo endpoint accepts either an access token or an
        // ID token. We use the access token from chrome.identity.
        const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!r.ok) {
          sendJson(response, 401, {
            ok: false,
            error: `Google rejected the token (HTTP ${r.status}). Try signing out + back in.`,
          });
          return;
        }
        const info = (await r.json()) as {
          email?: string;
          email_verified?: boolean;
          name?: string;
          picture?: string;
          sub?: string;
        };
        const email = String(info.email ?? "").trim().toLowerCase();
        if (!email || info.email_verified === false) {
          sendJson(response, 401, {
            ok: false,
            error: "Google didn't return a verified email.",
          });
          return;
        }
        // Domain allowlist — comma-separated env var. Empty/unset means
        // "allow any verified Google account" (open-mode, suitable for dev).
        const allowed = (process.env.ASKC4S_AUTH_ALLOWED_DOMAINS ?? "")
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean);
        if (allowed.length > 0) {
          const domain = email.split("@")[1] ?? "";
          if (!allowed.includes(domain)) {
            sendJson(response, 403, {
              ok: false,
              error: `Email domain '${domain}' is not in ASKC4S_AUTH_ALLOWED_DOMAINS.`,
            });
            return;
          }
        }
        // Directory mode: Google proves who you are, the directory decides
        // whether you may use this deployment (no auto-provisioning). Legacy
        // mode — no accounts yet — is unchanged: the domain allowlist above.
        let directoryUserId: string | undefined;
        let directoryRole: string | undefined;
        if (directoryActive()) {
          const sso = resolveSsoUser(email);
          if (!sso.ok) {
            sendJson(response, sso.status, { ok: false, error: sso.error });
            return;
          }
          directoryUserId = sso.user.id;
          directoryRole = sso.user.role;
        }
        const token = issueInternalToken({
          source: "google",
          userId: directoryUserId,
          user: { email, name: info.name, picture: info.picture },
        });
        sendJson(response, 200, {
          ok: true,
          token,
          user: { email, name: info.name, picture: info.picture },
          role: directoryRole,
          ttlSec: Math.floor(INTERNAL_TOKEN_TTL_MS / 1000),
        });
      } catch (err) {
        sendJson(response, 502, {
          ok: false,
          error:
            "Couldn't reach Google userinfo endpoint: " +
            (err instanceof Error ? err.message : String(err)),
        });
      }
      return;
    }

    // -------------------------------------------------------------------
    // /api/auth/me — returns the user attached to the Bearer token, or
    // null when no token / unauthenticated. Used by the extension popup
    // to show "Signed in as <name>" without re-fetching from the IdP.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const user = getCurrentUser(request);
      // /api/auth/me is a public route (it self-gates), so the funnel didn't
      // resolve a principal for it — do it here. `user` keeps its old shape;
      // the rest is additive.
      const me = getPrincipal(request);
      sendJson(response, 200, {
        user,
        role: me?.role ?? null,
        permissions: me ? permissionsOf(me.role) : [],
        mode: directoryActive() ? "directory" : "legacy",
        mustChangePassword: me?.mustChangePassword ?? false,
      });
      return;
    }

    // -------------------------------------------------------------------
    // /api/whoami — resolve the SIGNED-IN user to their SAP identity.
    //
    // This is what makes SSO zero-touch: the client never asks the tech to
    // type their name. It takes the identity already proven by the Bearer
    // token (email/name from SSO — Entra or Google) and resolves it to the
    // BusinessPartnerID that My Day / assignments key on.
    //
    // Deliberately narrower than /api/resolve_employee: SSO hands us a
    // reliable email, so this does an exact Email match plus a UserID derived
    // from the email local-part (this tenant's UserID convention is
    // FIRST.LAST, e.g. MAROUANE.NAJAR). It does NOT do the display-name fuzzy
    // matching — that fragile, hard-won block stays untouched and is only
    // needed when a name is all you have.
    //
    // needsIdentity:true is a NORMAL outcome, not an error: admin/service-agent
    // logins (e.g. Jane Doe) legitimately have no EmployeeCollection row
    // (see docs/engineering-notes.md), so the client falls back to manual party-ID entry.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/whoami" && request.method === "GET") {
      const user = getCurrentUser(request);
      const email = String(user?.email ?? "").trim();
      const displayName = String(user?.name ?? "").trim();

      // Password-token sessions carry no identity — nothing to resolve.
      if (!email) {
        sendJson(response, 200, {
          ok: true,
          needsIdentity: true,
          reason: "no-identity-in-token",
          name: displayName || undefined,
        });
        return;
      }

      try {
        const { c4cGet } = await import("./connectors/c4c/client.js");
        const esc = (s: string) => s.replace(/'/g, "''");
        const SELECT = "BusinessPartnerID,EmployeeID,UserID,BusinessPartnerFormattedName,Email";

        // Priority: exact email → derived FIRST.LAST logon. String eq is
        // case-INSENSITIVE on this backend, but a lowercase email variant is
        // added defensively for tenants where it isn't.
        const attempts: Array<{ filter: string; via: string }> = [];
        const push = (filter: string, via: string) => {
          if (!attempts.some((a) => a.filter === filter)) attempts.push({ filter, via });
        };
        push(`Email eq '${esc(email)}'`, `email "${email}"`);
        if (email !== email.toLowerCase()) push(`Email eq '${esc(email.toLowerCase())}'`, "email (lowercased)");
        const localPart = email.split("@")[0] ?? "";
        if (localPart.includes(".")) {
          push(`UserID eq '${esc(localPart.toUpperCase())}'`, `derived logon "${localPart.toUpperCase()}"`);
        }

        const tried: string[] = [];
        for (const a of attempts) {
          try {
            const r: any = await c4cGet("/EmployeeCollection", {
              "$format": "json", "$top": 2, "$filter": a.filter, "$select": SELECT,
            });
            const rows: any[] = r?.d?.results ?? [];
            if (rows.length === 1) {
              const e = rows[0];
              sendJson(response, 200, {
                ok: true,
                needsIdentity: false,
                matchedBy: a.via,
                email,
                partyId: String(e?.BusinessPartnerID || "").trim(),
                employeeId: String(e?.EmployeeID || "").trim(),
                userId: String(e?.UserID || "").trim(),
                // Prefer the SAP-formatted name; fall back to the SSO display name.
                name: String(e?.BusinessPartnerFormattedName || "").trim() || displayName || undefined,
                tried: [...tried, `${a.via} → MATCH`],
              });
              return;
            }
            tried.push(`${a.via} → ${rows.length === 0 ? "no match" : `${rows.length} matches (ambiguous, skipped)`}`);
          } catch (e: any) {
            tried.push(`${a.via} → error: ${String(e?.message ?? e).slice(0, 80)}`);
          }
        }

        // Authenticated, but no employee row (admin/agent) or genuinely absent.
        sendJson(response, 200, {
          ok: true,
          needsIdentity: true,
          reason: "no-employee-row",
          email,
          name: displayName || undefined,
          tried,
        });
      } catch (e: any) {
        // Never 500 identity resolution — the client's manual fallback covers it.
        sendJson(response, 200, {
          ok: true,
          needsIdentity: true,
          reason: "resolve-error",
          email,
          name: displayName || undefined,
          error: String(e?.message ?? e).slice(0, 160),
        });
      }
      return;
    }

    if (url.pathname === "/api/internal/verify" && request.method === "POST") {
      // If no password is configured server-side, the gate is intentionally
      // disabled — auto-authorise so the clients skip the password prompt.
      // To re-enable: set ASKC4S_INTERNAL_PASSWORD in .env and restart.
      if (!process.env.ASKC4S_INTERNAL_PASSWORD && !directoryActive()) {
        sendJson(response, 200, { ok: true, gateDisabled: true });
        return;
      }
      const body = await readJsonBody(request);
      const submitted = String((body as { token?: unknown } | null)?.token ?? "");
      const ok = submitted && verifyInternalToken(submitted);
      sendJson(response, ok ? 200 : 401, { ok: Boolean(ok) });
      return;
    }

    // -------------------------------------------------------------------
    // /api/errors — client-side error capture. Public ingest endpoint
    // (no auth) so window.onerror works even pre-login. Per-IP rate
    // limit + payload size cap protect against noisy clients / abuse.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/errors" && request.method === "POST") {
      const body = (await readJsonBody(request)) as {
        source?: string;
        severity?: string;
        message?: string;
        stack?: string;
        page?: string;
        context?: unknown;
      };
      const message = String(body?.message ?? "").trim();
      if (!message) {
        sendJson(response, 400, { ok: false, error: "message required" });
        return;
      }
      try {
        const { logError } = await import("./cache.js");
        const { getTenantId } = await import("./c4cClient.js");
        const sev =
          ["info", "warn", "error", "fatal"].includes(String(body.severity ?? ""))
            ? (body.severity as "info" | "warn" | "error" | "fatal")
            : "error";
        const actorHeader = request.headers["x-admin-actor"];
        logError({
          tenantId: getTenantId() || "default",
          source: String(body.source ?? "client").slice(0, 64),
          severity: sev,
          actor: typeof actorHeader === "string" ? actorHeader : null,
          page: body.page ? String(body.page).slice(0, 500) : null,
          message,
          stack: body.stack ? String(body.stack) : null,
          context:
            body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : null,
          userAgent: String(request.headers["user-agent"] ?? "").slice(0, 500),
        });
      } catch {
        /* don't let logging fail the request */
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // -------------------------------------------------------------------
    // /api/chat — AI Companion chat proxy. Routes to the configured LLM
    // provider (today: Anthropic Claude). Internal use only.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!isInternalAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized — /api/chat is internal-only." });
        return;
      }
      const body = (await readJsonBody(request)) as {
        messages?: { role: "user" | "assistant"; content: string }[];
        context?: string;
        ticketObjectId?: string;
        model?: string;
        maxTokens?: number;
        // Forwarded from /admin → AI Tuning. All optional.
        temperature?: number;
        topP?: number;
        systemPromptOverride?: string;
        appendInstructions?: string;
        fewShotExamples?: { user: string; assistant: string }[];
        stopSequences?: string[];
        // For ai_usage attribution
        actor?: string;
        module?: string;
      };
      const { chat } = await import("./chat.js");
      // The actor header takes precedence over the body (the clients set
      // `X-Admin-Actor`).
      const actorHeader = request.headers["x-admin-actor"];
      // v0.26.57 — wrap in try/catch so thrown errors (missing API key,
      // network failures, etc.) come back as proper JSON instead of
      // the upstream "Internal Server Error" generic 500. The Chrome
      // extension's error display uses `error` from the body to show
      // an actionable message to the operator.
      try {
        const result = await chat({
          messages: Array.isArray(body.messages) ? body.messages : [],
          context: typeof body.context === "string" ? body.context : undefined,
          ticketObjectId: typeof body.ticketObjectId === "string" ? body.ticketObjectId : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
          temperature: typeof body.temperature === "number" ? body.temperature : undefined,
          topP: typeof body.topP === "number" ? body.topP : undefined,
          systemPromptOverride:
            typeof body.systemPromptOverride === "string" ? body.systemPromptOverride : undefined,
          appendInstructions:
            typeof body.appendInstructions === "string" ? body.appendInstructions : undefined,
          fewShotExamples: Array.isArray(body.fewShotExamples)
            ? body.fewShotExamples.filter(
                (p) => p && typeof p.user === "string" && typeof p.assistant === "string",
              )
            : undefined,
          stopSequences: Array.isArray(body.stopSequences)
            ? body.stopSequences.filter((s): s is string => typeof s === "string")
            : undefined,
          actor:
            typeof actorHeader === "string" && actorHeader.trim()
              ? actorHeader.trim()
              : typeof body.actor === "string"
                ? body.actor
                : undefined,
          module: typeof body.module === "string" ? body.module : undefined,
        });
        sendJson(response, result.ok ? 200 : 502, result);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const stack = String(err?.stack ?? "").split("\n").slice(0, 5).join("\n");
        // Log to shim console for the operator + return JSON to caller.
        console.error("[/api/chat] handler threw:", msg, "\n", stack);
        const lower = msg.toLowerCase();
        // Hint at the most common causes so the extension can show a
        // tailored error message without needing this lookup itself.
        let hint = "";
        if (lower.includes("anthropic_api_key") || lower.includes("api key")) {
          hint = "Set ANTHROPIC_API_KEY in your .env file in the repo root.";
        } else if (lower.includes("rate_limit") || lower.includes("429")) {
          hint = "Anthropic API rate-limited — wait 30s and retry.";
        } else if (lower.includes("overload") || lower.includes("529") || lower.includes("503")) {
          hint = "Anthropic API overloaded — retry in a moment.";
        } else if (lower.includes("401") || lower.includes("unauthor")) {
          hint = "Anthropic API key is invalid — check it in .env.";
        }
        sendJson(response, 500, {
          ok: false,
          error: msg,
          hint,
          stack: process.env.NODE_ENV === "production" ? undefined : stack,
        });
      }
      return;
    }

    if (url.pathname === "/api/chat/status" && request.method === "GET") {
      const { chatApiStatus } = await import("./chat.js");
      sendJson(response, 200, chatApiStatus());
      return;
    }

    // -------------------------------------------------------------------
    // /api/chat/stream — Server-Sent-Events stream of incremental chat
    // chunks. Same request body as /api/chat. Emits frames:
    //   data: {"type":"delta","text":"..."}\n\n
    //   data: {"type":"done","model":"...","usage":{...}}\n\n
    //   data: {"type":"error","error":"..."}\n\n
    // The Chrome extension popup uses this for live-typing replies.
    // -------------------------------------------------------------------
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      const body = (await readJsonBody(request)) as any;
      const actorHeader = request.headers["x-admin-actor"];
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // disable proxy buffering
      });
      const send = (obj: unknown) => {
        try {
          response.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          /* socket closed mid-stream — nothing to do */
        }
      };
      try {
        const { streamChat } = await import("./chat.js");
        const result = await streamChat(
          {
            messages: Array.isArray(body.messages) ? body.messages : [],
            context: typeof body.context === "string" ? body.context : undefined,
            ticketObjectId:
              typeof body.ticketObjectId === "string" ? body.ticketObjectId : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
            temperature:
              typeof body.temperature === "number" ? body.temperature : undefined,
            topP: typeof body.topP === "number" ? body.topP : undefined,
            systemPromptOverride:
              typeof body.systemPromptOverride === "string" ? body.systemPromptOverride : undefined,
            appendInstructions:
              typeof body.appendInstructions === "string"
                ? body.appendInstructions
                : undefined,
            fewShotExamples: Array.isArray(body.fewShotExamples)
              ? body.fewShotExamples.filter(
                  (p: any) =>
                    p && typeof p.user === "string" && typeof p.assistant === "string",
                )
              : undefined,
            stopSequences: Array.isArray(body.stopSequences)
              ? body.stopSequences.filter((s: any): s is string => typeof s === "string")
              : undefined,
            actor:
              typeof actorHeader === "string" && actorHeader.trim()
                ? actorHeader.trim()
                : typeof body.actor === "string"
                  ? body.actor
                  : undefined,
            module: typeof body.module === "string" ? body.module : undefined,
          },
          (chunk) => send({ type: "delta", text: chunk }),
        );
        if (!result.ok) {
          send({ type: "error", error: result.error ?? "unknown error" });
        } else {
          send({ type: "done", model: result.model, usage: result.usage });
        }
        // Sentinel for clients that look for [DONE]
        try {
          response.write(`data: [DONE]\n\n`);
        } catch {
          /* ignore */
        }
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        response.end();
      }
      return;
    }

    // -------------------------------------------------------------------
    // /api/integrations/c4c/draft-work-description
    // Called from a Custom Action in SAP C4C (Cloud Applications Studio).
    // Returns drafted Work Description text the action writes into the
    // ticket field. Bearer-gated when ASKC4S_INTERNAL_PASSWORD is set.
    // -------------------------------------------------------------------
    if (
      url.pathname === "/api/integrations/c4c/draft-work-description" &&
      request.method === "POST"
    ) {
      if (!isInternalAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      const body = (await readJsonBody(request)) as {
        objectId?: string;
        style?: "concise" | "detailed" | "checklist";
        field?: string;
      };
      const { draftWorkDescription } = await import("./integrations/c4c-draft.js");
      const started = Date.now();
      const result = await draftWorkDescription({
        objectId: String(body.objectId ?? ""),
        style: body.style,
        field: body.field,
      });
      // Light-touch metric so admins can see how often the C4C button fires.
      recordCall(
        "c4c_draft_work_description",
        Date.now() - started,
        result.ok ? "sap" : "error",
      );
      sendJson(response, result.ok ? 200 : 502, result);
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Only read-only tool POSTs and GET requests are supported." });
      return;
    }

    /**
     * GET /api/client-config — tenant policy for every front door.
     *
     * This is what makes the admin panel actually govern the CLIENTS. Until
     * now the admin console only configured the shim: rules like the
     * parts-ordering code lived in each user's chrome.storage, so any operator
     * could change what SAP receives, with no audit trail, and a second front
     * door (mobile PWA, ChatGPT) would have had to re-implement them.
     *
     * Three-tier client config:
     *   1. MDM / managed storage → the endpoint URL only (bootstrap: a client
     *      must know where the server is before it can ask the server anything)
     *   2. THIS endpoint          → tenant policy (audited, admin-owned)
     *   3. chrome.storage.sync    → genuine per-user preferences
     *
     * Contains no secrets — only policy the clients must obey — so it sits with
     * the rest of the client API rather than behind the admin gate.
     */
    if (url.pathname === "/api/client-config" && request.method === "GET") {
      const { getTenantId } = await import("./c4cClient.js");
      const { getSettingString } = await import("./settings.js");
      const csv = (raw: string) =>
        raw
          .split(/[,\s]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
      sendJson(response, 200, {
        ok: true,
        tenant: getTenantId(),
        // Bump when the shape changes so clients can reason about it.
        version: 1,
        policy: {
          parts: {
            orderingProcessingTypeCode: getSettingString("parts.ordering_processing_type_code"),
            inferenceIncludeTypes: csv(getSettingString("parts.inference_include_types")),
          },
          bookTime: {
            laborProductId: getSettingString("booktime.labor_product_id"),
            travelProductId: getSettingString("booktime.travel_product_id"),
          },
          kb: {
            // Extension-only enhancement; blank disables direct mode.
            directUrl: getSettingString("kb.direct_url"),
            browseUrl: getSettingString("kb.ui_browse_url"),
            browseSearchPath: getSettingString("kb.ui_search_path"),
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/health") {
      // Lazy import to avoid circular deps at module load
      const { getActiveTenantLabel, getActiveTenantEnvironment, getActiveTenantCatalogId, getTenantId, getTenantHost } = await import("./c4cClient.js");
      sendJson(response, 200, {
        ok: true,
        name: "ask-c4s",
        readOnly: true,
        time: new Date().toISOString(),
        tenant: {
          id: getTenantId(),
          host: getTenantHost(),
          catalogId: getActiveTenantCatalogId(),
          label: getActiveTenantLabel(),
          environment: getActiveTenantEnvironment(),
        },
      });
      return;
    }

    if (url.pathname === "/api/metadata") {
      const mode = optionalParam(url, "mode") === "raw" ? "raw" : "summary";
      const result = await getServiceMetadata({
        mode,
        entitySet: optionalParam(url, "entitySet"),
        refresh: booleanParam(url, "refresh")
      });

      if (typeof result === "string") {
        sendText(response, 200, result, "application/xml; charset=utf-8");
      } else {
        sendJson(response, 200, result);
      }
      return;
    }

    if (url.pathname === "/api/tickets") {
      sendJson(
        response,
        200,
        await searchTickets({
          top: numberParam(url, "top", 10, 1, 100),
          skip: numberParam(url, "skip", 0, 0, 100000),
          statusCode: optionalParam(url, "statusCode"),
          odataFilter: optionalParam(url, "odataFilter"),
          orderBy: optionalParam(url, "orderBy")
        })
      );
      return;
    }

    if (parts[0] === "api" && parts[1] === "tickets" && parts[2] && !parts[3]) {
      sendJson(
        response,
        200,
        await getTicket({
          objectId: parts[2],
          expand: splitCsv(optionalParam(url, "expand")),
          includeMetadata: booleanParam(url, "includeMetadata")
        })
      );
      return;
    }

    if (parts[0] === "api" && parts[1] === "tickets" && parts[2] && parts[3] === "history") {
      sendJson(
        response,
        200,
        await getServiceHistory({
          objectId: parts[2],
          navigationProperty: optionalParam(url, "navigationProperty"),
          top: numberParam(url, "top", 20, 1, 50),
          candidateLimit: numberParam(url, "candidateLimit", 5, 1, 10),
          includeDiscovery: booleanParam(url, "includeDiscovery", true),
          refreshMetadata: booleanParam(url, "refreshMetadata")
        })
      );
      return;
    }

    sendJson(response, 404, { error: "API route not found." });
  } catch (error) {
    sendJson(response, 500, { error: formatToolError(error) });
  }
}

async function serveFile(response: ServerResponse, filePath: string) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return false;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
    return true;
  } catch {
    return false;
  }
}

async function serveStatic(response: ServerResponse, pathname: string) {
  // Shared design system — the single source of truth for the look, served to
  // every door. This is what keeps the PWA, the settings page and the extension
  // one product. Kept OUTSIDE the static roots on purpose so /shared/askc4s.css
  // resolves the same everywhere.
  if (/^\/shared\//.test(pathname)) {
    const rel = pathname.replace(/^\/shared\/+/, "");
    const shared = resolve(sharedUiDir, rel);
    if (shared === sharedUiDir || shared.startsWith(`${sharedUiDir}${sep}`)) {
      if (await serveFile(response, shared)) return;
    }
    sendText(response, 404, "Not found");
    return;
  }

  // Light mounts two separate static apps: the field PWA at "/" (staticDir)
  // and the core-settings page at "/settings". They're deliberately distinct
  // artifacts — different audiences, and the PWA must stay lean.
  if (/^\/settings(\/|$)/.test(pathname)) {
    if (await serveFile(response, resolve(lightAdminDir, "index.html"))) return;
    sendText(response, 404, "Not found");
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(staticDir, relativePath);

  if (filePath !== staticDir && !filePath.startsWith(`${staticDir}${sep}`)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (await serveFile(response, filePath)) return;

  sendText(response, 404, "Not found");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    // Attach who is calling to the async context, so the SAP write gate (deep
    // in serviceOps.ts) can see their role without every function between here
    // and there growing a parameter. See access.ts → sapWriteDenial.
    let callerPrincipal: Principal | null = null;
    try {
      callerPrincipal = getPrincipal(request);
    } catch (error) {
      // This runs outside handleApi's try/catch, and an async handler that
      // throws takes the process down. Treat a failed lookup as "nobody"; the
      // funnel repeats it inside the try/catch and answers with a proper error.
      console.error("[auth] principal lookup failed:", error instanceof Error ? error.message : error);
    }
    await runWithPrincipal(callerPrincipal, () => handleApi(request, response, url));
    return;
  }

  await serveStatic(response, url.pathname);
});

// Bind host:
//   - Local dev: 127.0.0.1 (loopback only — never accidentally exposed on a LAN)
//   - Container / behind a reverse proxy (Coolify, Traefik, nginx):
//       set HOST=0.0.0.0 so the proxy can reach the port from the host network.
const bindHost = process.env.HOST || "127.0.0.1";

function listen(port: number, attemptsLeft = 10) {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if ((error.code === "EADDRINUSE" || error.code === "EACCES") && attemptsLeft > 1) {
      // Say so loudly: a second shim that quietly moved to 3032 while the
      // extension still talks to the old one on 3031 is a confusing failure.
      console.warn(
        `Port ${port} is in use (${error.code}) — trying ${port + 1}. The extension expects 3031: ` +
          `if another shim is running, stop it (npm run stop) instead of running two.`,
      );
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    throw error;
  });

  server.listen(port, bindHost, () => {
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    console.log(`Ask C4S running at http://${bindHost}:${resolvedPort}`);
    console.log(`Serving static assets from: ${staticDirSource}`);
    // Make an insecure admin impossible to deploy by accident — the gate fails
    // closed, but say so out loud either way so it's never a silent surprise.
    console.log(
      directoryActive()
        ? "Sign-in: personal accounts (user directory active)."
        : "Sign-in: no personal accounts yet — shared password / SSO as before. " +
            "Create the first owner in Settings → Users (or set ASKC4S_BOOTSTRAP_OWNER_EMAIL + _PASSWORD).",
    );
    if (isAdminEnabled()) {
      if (directoryActive()) {
        console.log("Admin: ENABLED, access by role (owner/admin/manager/agent).");
      } else if (process.env.ASKC4S_INTERNAL_PASSWORD) {
        console.log("Admin: ENABLED, password gate active.");
      } else if (adminInsecureAllowed()) {
        console.warn(
          "Admin: ENABLED and UNAUTHENTICATED (ASKC4S_ADMIN_INSECURE=true). " +
            "Local dev only — never set this on a hosted deployment.",
        );
      } else {
        console.warn(
          "Admin: ENABLED but ASKC4S_INTERNAL_PASSWORD is unset — /api/admin/* will DENY all requests. " +
            "Set ASKC4S_INTERNAL_PASSWORD to use the admin, or ASKC4S_ADMIN_INSECURE=true for local dev.",
        );
      }
    }
    // v0.26.76 — print version banner so operators can verify the
    // rebuild took effect. Reads from chrome-extension/manifest.json
    // which is the source of truth for the build version.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const manifestPath = path.resolve(process.cwd(), "chrome-extension", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { version?: string };
      if (manifest.version) {
        console.log(`Shim build version: v${manifest.version}`);
      }
    } catch {
      /* defensive — version log is informational */
    }
  });
}

// First-run provisioning from the environment (hosted deployments). Async because
// hashing the password is; it's a no-op unless the directory is empty and both
// ASKC4S_BOOTSTRAP_OWNER_* variables are set. listen() waits for it, so the
// account exists before the first sign-in and the start-up banner is accurate.
const bootstrapDone = bootstrapOwnerFromEnv().catch((error) => {
  console.error("[users] bootstrap failed:", error instanceof Error ? error.message : error);
});

void bootstrapDone.then(() => listen(requestedPort));
