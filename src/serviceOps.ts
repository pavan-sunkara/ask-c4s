/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import {
  c4cDelete,
  c4cGet,
  c4cGetCustom,
  c4cGetService,
  c4cPatch,
  c4cPost,
  c4cPostWithMeta,
  formatToolError,
  isSafeODataPath,
  odataStringLiteral,
  type ODataQuery
} from "./c4cClient.js";
import { getSettingBoolean } from "./settings.js";
import { sapWriteDenial } from "./access.js";
import { searchKb, kbApiStatus, type KbSearchResponse } from "./kbClient.js";

// ---------------------------------------------------------------------------
// SHARED WRITE-GATE — every write tool runs through this so dryRun + feature
// flag + production-acknowledgment are enforced uniformly.
// ---------------------------------------------------------------------------

export type WriteGateOpts = {
  dryRun?: boolean;
  acknowledgeProduction?: boolean;
};

type GateBlocked = {
  dryRun: boolean;
  blocked: true;
  reason: string;
  wouldDo: { method: string; path: string; body?: unknown };
};

type GateDryRun = {
  dryRun: true;
  wouldDo: { method: string; path: string; body?: unknown };
  note: string;
};

type GateWritten<T> = { dryRun: false; written: true; sap: T };

async function runGatedWrite<T>(
  opts: WriteGateOpts,
  intent: { method: "POST" | "PATCH" | "DELETE"; path: string; body?: unknown },
  execute: () => Promise<T>,
): Promise<GateBlocked | GateDryRun | GateWritten<T>> {
  const dryRun = opts.dryRun !== false; // default true
  if (dryRun) {
    return {
      dryRun: true,
      wouldDo: intent,
      note:
        "Dry-run only. To actually write to SAP: set dryRun=false AND set " +
        "feature.auto_writeback_enabled=true in /settings.",
    };
  }
  // Role check. Previews above stay open to every role; a REAL write needs the
  // sap:write permission (agents, admins, owners — not managers). This is the
  // one place every SAP write converges, which is why the role is checked here
  // and not per route. Outside an HTTP request (stdio MCP) there is no caller to
  // check, so it passes — same local trust as before.
  const roleDenied = sapWriteDenial();
  if (roleDenied) {
    return { dryRun: false, blocked: true, reason: roleDenied, wouldDo: intent };
  }
  // Feature flag
  let enabled = false;
  try {
    enabled = getSettingBoolean("feature.auto_writeback_enabled");
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return {
      dryRun: false,
      blocked: true,
      reason:
        "Write blocked: feature.auto_writeback_enabled is false. Flip it in /settings.",
      wouldDo: intent,
    };
  }
  // Production guard
  try {
    const { getActiveTenantEnvironment, getActiveTenantLabel } = await import("./c4cClient.js");
    const env = getActiveTenantEnvironment();
    if (env === "production" && !opts.acknowledgeProduction) {
      return {
        dryRun: false,
        blocked: true,
        reason:
          `Active tenant is tagged PRODUCTION (${getActiveTenantLabel() ?? "?"}). ` +
          `Call again with acknowledgeProduction=true to confirm.`,
        wouldDo: intent,
      };
    }
  } catch {
    /* if env detection fails, fall through to actual write */
  }
  const result = await execute();
  return { dryRun: false, written: true, sap: result };
}
import {
  discoverServiceHistoryCandidates,
  getParsedMetadata,
  getRawMetadata,
  getServiceRequestEntity,
  resolveNavigationTarget,
  summarizeMetadata,
  type NavigationCandidate,
  type NavigationProperty
} from "./metadata.js";

export type SearchTicketsOptions = {
  top: number;
  skip?: number;
  statusCode?: string;
  odataFilter?: string;
  orderBy?: string;
};

export type GetTicketOptions = {
  objectId: string;
  expand?: string[];
  includeMetadata?: boolean;
};

export type GetServiceMetadataOptions = {
  mode?: "summary" | "raw";
  entitySet?: string;
  refresh?: boolean;
};

export type GetServiceHistoryOptions = {
  objectId: string;
  navigationProperty?: string;
  top?: number;
  candidateLimit?: number;
  includeDiscovery?: boolean;
  refreshMetadata?: boolean;
};

export function serviceRequestPath(objectId: string) {
  return `/ServiceRequestCollection(${odataStringLiteral(objectId)})`;
}

export function validateODataPaths(paths: string[]) {
  for (const path of paths) {
    if (!isSafeODataPath(path)) {
      throw new Error(`Invalid OData navigation path: ${path}`);
    }
  }
}

export function validateOrderBy(orderBy?: string) {
  if (orderBy && !/^[A-Za-z_][A-Za-z0-9_]*(\s+(asc|desc))?$/i.test(orderBy)) {
    throw new Error("orderBy must be a single property name, optionally followed by asc or desc.");
  }
}

export function validateFilter(filter?: string) {
  if (filter && /[\r\n]/.test(filter)) {
    throw new Error("odataFilter must be a single-line OData filter expression.");
  }
}

function candidateFromNavigationProperty(nav: NavigationProperty): NavigationCandidate {
  return {
    ...nav,
    score: 0,
    reasons: ["manual override"]
  };
}

export type SearchEmployeesOptions = {
  query?: string;        // free text — matches FirstName / LastName / FormattedName
  region?: string;       // RegionCode filter
  top?: number;
};

/**
 * Search employees by free-text name or region. Limited to what the integration
 * user can see (~20 in this tenant).
 */
export async function searchEmployees({ query, region, top = 25 }: SearchEmployeesOptions = {}) {
  const filters: string[] = [];
  if (query?.trim()) {
    const q = odataStringLiteral(query.trim());
    filters.push(
      `(substringof(${q},FirstName) or substringof(${q},LastName) or substringof(${q},BusinessPartnerFormattedName))`,
    );
  }
  if (region?.trim()) {
    filters.push(`RegionCode eq ${odataStringLiteral(region.trim())}`);
  }

  const odata: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$select":
      "ObjectID,EmployeeID,FirstName,LastName,BusinessPartnerFormattedName,UserID,EmployeeValidityEndDate,LanguageCodeText",
  };
  if (filters.length) odata["$filter"] = filters.join(" and ");

  const result: any = await c4cGet("/EmployeeCollection", odata);
  const rows: any[] = result?.d?.results ?? [];

  return {
    query: query ?? null,
    region: region ?? null,
    total: rows.length,
    employees: rows,
  };
}

export type GetMyTicketsOptions = {
  processorPartyId?: string;    // human Employee ID (e.g. 8000019150)
  processorPartyUuid?: string;  // GUID
  top?: number;
  includeClosed?: boolean;
  orderBy?: string;
};

/**
 * Tickets assigned to a specific processor (Agent scope).
 * Accepts either the human ProcessorPartyID or the ProcessorPartyUUID.
 */
export async function getMyTickets({
  processorPartyId,
  processorPartyUuid,
  top = 25,
  includeClosed = false,
  orderBy = "LastChangeDateTime desc",
}: GetMyTicketsOptions) {
  validateOrderBy(orderBy);
  if (!processorPartyId?.trim() && !processorPartyUuid?.trim()) {
    throw new Error("processorPartyId or processorPartyUuid is required.");
  }

  const filters: string[] = [];
  if (processorPartyId?.trim()) {
    filters.push(`ProcessorPartyID eq ${odataStringLiteral(processorPartyId.trim())}`);
  } else if (processorPartyUuid?.trim()) {
    filters.push(`ProcessorPartyUUID eq guid'${processorPartyUuid.trim()}'`);
  }
  if (!includeClosed) filters.push("ServiceRequestLifeCycleStatusCode lt '4'");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": filters.join(" and "),
    "$orderby": orderBy,
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCode,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCodeText,BuyerPartyID,BuyerPartyName,ProductID,SerialID,CreationDateTime,LastChangeDateTime,CompleteDuedatetimeContent,ProcessorPartyName",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const buckets = { open: 0, in_process: 0, completed: 0, closed: 0, other: 0 };
  for (const r of rows) {
    const code = String(r.ServiceRequestLifeCycleStatusCode ?? "");
    if (code === "1") buckets.open++;
    else if (code === "2") buckets.in_process++;
    else if (code === "3") buckets.completed++;
    else if (code === "4") buckets.closed++;
    else buckets.other++;
  }

  return {
    processorPartyId: processorPartyId ?? null,
    processorPartyUuid: processorPartyUuid ?? null,
    total: rows.length,
    includeClosed,
    buckets,
    tickets: rows,
  };
}

export type GetMyTeamTicketsOptions = {
  teamPartyId?: string;
  teamPartyUuid?: string;
  top?: number;
  includeClosed?: boolean;
  orderBy?: string;
};

/**
 * Tickets routed to a service-execution team (Manager scope).
 */
export async function getMyTeamTickets({
  teamPartyId,
  teamPartyUuid,
  top = 50,
  includeClosed = false,
  orderBy = "LastChangeDateTime desc",
}: GetMyTeamTicketsOptions) {
  validateOrderBy(orderBy);
  if (!teamPartyId?.trim() && !teamPartyUuid?.trim()) {
    throw new Error("teamPartyId or teamPartyUuid is required.");
  }

  const filters: string[] = [];
  if (teamPartyId?.trim()) {
    filters.push(`ServiceExecutionTeamPartyID eq ${odataStringLiteral(teamPartyId.trim())}`);
  } else if (teamPartyUuid?.trim()) {
    filters.push(`ServiceExecutionTeamPartyUUID eq guid'${teamPartyUuid.trim()}'`);
  }
  if (!includeClosed) filters.push("ServiceRequestLifeCycleStatusCode lt '4'");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": filters.join(" and "),
    "$orderby": orderBy,
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCode,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCodeText,BuyerPartyName,SerialID,CompleteDuedatetimeContent,ProcessorPartyName,ServiceExecutionTeamPartyName,LastChangeDateTime",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const buckets = { open: 0, in_process: 0, completed: 0, closed: 0, other: 0 };
  const byProcessor = new Map<string, number>();
  for (const r of rows) {
    const code = String(r.ServiceRequestLifeCycleStatusCode ?? "");
    if (code === "1") buckets.open++;
    else if (code === "2") buckets.in_process++;
    else if (code === "3") buckets.completed++;
    else if (code === "4") buckets.closed++;
    else buckets.other++;
    const p = String(r.ProcessorPartyName ?? "(unassigned)");
    byProcessor.set(p, (byProcessor.get(p) ?? 0) + 1);
  }

  return {
    teamPartyId: teamPartyId ?? null,
    teamPartyUuid: teamPartyUuid ?? null,
    total: rows.length,
    includeClosed,
    buckets,
    perProcessor: Array.from(byProcessor.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    tickets: rows,
  };
}

export type GetAccountContactsOptions = {
  accountId: string;
  top?: number;
};

/**
 * Contacts at a customer account.
 */
export async function getAccountContacts({ accountId, top = 25 }: GetAccountContactsOptions) {
  if (!accountId.trim()) throw new Error("accountId is required.");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": `AccountID eq ${odataStringLiteral(accountId)}`,
    "$select":
      "ObjectID,ContactID,FirstName,LastName,Name,JobTitle,Phone,Mobile,Email,AccountID,AccountFormattedName,StatusCodeText,Department,FunctionCodeText,TitleCodeText",
  };

  const result: any = await c4cGet("/ContactCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  const reachable = {
    withEmail: rows.filter((r) => r.Email).length,
    withPhone: rows.filter((r) => r.Phone).length,
    withMobile: rows.filter((r) => r.Mobile).length,
  };

  return {
    accountId,
    total: rows.length,
    reachable,
    contacts: rows,
  };
}

export type SearchAppointmentsOptions = {
  ownerPartyId?: string;
  accountPartyId?: string;
  top?: number;
  orderBy?: string;
};

/**
 * Find appointments (calendar events). Filter by owner (assigned tech) or account.
 */
export async function searchAppointments({
  ownerPartyId,
  accountPartyId,
  top = 25,
  orderBy = "LastChangeDateTime desc",
}: SearchAppointmentsOptions = {}) {
  validateOrderBy(orderBy);

  const filters: string[] = [];
  if (ownerPartyId?.trim()) filters.push(`OwnerPartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  if (accountPartyId?.trim()) filters.push(`MainAccountPartyID eq ${odataStringLiteral(accountPartyId.trim())}`);

  const odata: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": orderBy,
    "$select":
      "ObjectID,ID,Subject,LifeCycleStatusCode,LifeCycleStatusCodeText,OwnerPartyID,OrganizerPartyID,OrganizerEmailURI,MainAccountPartyID,MainContactPartyID,AccountName,StartDate,EndDate,Location,Priority,PriorityText,CategoryText,LastChangeDateTime",
  };
  if (filters.length) odata["$filter"] = filters.join(" and ");

  const result: any = await c4cGet("/AppointmentCollection", odata);
  const rows: any[] = result?.d?.results ?? [];

  return {
    ownerPartyId: ownerPartyId ?? null,
    accountPartyId: accountPartyId ?? null,
    total: rows.length,
    appointments: rows,
  };
}

export type GetSerialHistoryOptions = {
  serialId: string;
  top?: number;
  includeClosed?: boolean;
  orderBy?: string;
};

/**
 * Past service tickets for a specific equipment serial — equipment-level history
 * across customers and time.
 */
export async function getSerialHistory({
  serialId,
  top = 25,
  includeClosed = true,
  orderBy = "LastChangeDateTime desc",
}: GetSerialHistoryOptions) {
  validateOrderBy(orderBy);
  if (!serialId.trim()) throw new Error("serialId is required.");

  const filters = [
    `SerialID eq ${odataStringLiteral(serialId)}`,
    includeClosed ? undefined : "ServiceRequestLifeCycleStatusCode lt '4'",
  ].filter((f): f is string => Boolean(f));

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": filters.join(" and "),
    "$orderby": orderBy,
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCode,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCodeText,BuyerPartyID,BuyerPartyName,ProductID,SerialID,CreationDateTime,LastChangeDateTime,ProcessorPartyName,RequestCloseddatetimeContent",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  // Bucket by lifecycle + distinct customers
  const buckets = { open: 0, in_process: 0, completed: 0, closed: 0, other: 0 };
  const customers = new Set<string>();
  for (const r of rows) {
    const code = String(r.ServiceRequestLifeCycleStatusCode ?? "");
    if (code === "1") buckets.open++;
    else if (code === "2") buckets.in_process++;
    else if (code === "3") buckets.completed++;
    else if (code === "4") buckets.closed++;
    else buckets.other++;
    if (r.BuyerPartyName) customers.add(String(r.BuyerPartyName));
  }

  return {
    serialId,
    total: rows.length,
    includeClosed,
    distinctCustomers: Array.from(customers),
    buckets,
    tickets: rows,
  };
}

export type GetTicketNotesOptions = {
  objectId: string;
  top?: number;
};

/**
 * Notes / texts attached to a Service Request — customer-visible comments,
 * internal notes, work descriptions. Returns the actual text bodies with type labels.
 */
export async function getTicketNotes({ objectId, top = 50 }: GetTicketNotesOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");

  // ServiceRequestTextCollection is only reachable via the nav property on a Service Request,
  // not at the OData service root.
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 200),
    "$orderby": "CreatedOn desc",
    "$select":
      "ObjectID,ParentObjectID,TypeCode,TypeCodeText,Text,FormattedText,CreatedBy,CreatedOn,UpdatedOn,LastUpdatedBy,LanguageCodeText",
  };

  const result: any = await c4cGet(`${serviceRequestPath(objectId)}/ServiceRequestTextCollection`, query);
  const rows: any[] = result?.d?.results ?? [];

  // Group by type so the UI can show "Resolution" vs "Internal Note" vs "Customer Reply" cleanly.
  const byType: Record<string, { type: string; typeCode: string; count: number; latest: string | null }> = {};
  for (const r of rows) {
    const typeCode = String(r.TypeCode ?? "");
    const typeText = String(r.TypeCodeText ?? typeCode);
    if (!byType[typeCode]) {
      byType[typeCode] = { type: typeText, typeCode, count: 0, latest: null };
    }
    byType[typeCode].count++;
    if (!byType[typeCode].latest && r.CreatedOn) {
      byType[typeCode].latest = String(r.CreatedOn);
    }
  }

  return {
    objectId,
    total: rows.length,
    typeSummary: Object.values(byType).sort((a, b) => b.count - a.count),
    notes: rows,
  };
}

// ---------------------------------------------------------------------------
// EXTERNAL KB SEARCH — Azure AD-protected. See src/kbClient.ts.
//
// search_kb_articles: free-text search the external KB. Returns ok=false with
// a guidance message when Azure AD isn't configured yet — UI falls back to
// link-out tiles in that case.
//
// search_kb_for_ticket: convenience tool that derives smart queries from a
// ticket (symptom keywords + product) and fans out to the KB. Useful for the
// AI Companion chat ("what does the KB say about this ticket?").
// ---------------------------------------------------------------------------

export type SearchKbArticlesOptions = {
  query: string;
  top?: number;
};

export async function searchKbArticles({
  query,
  top = 10,
}: SearchKbArticlesOptions): Promise<KbSearchResponse> {
  return searchKb({ query, top });
}

export async function getKbApiStatus() {
  return kbApiStatus();
}

export type SearchKbForTicketOptions = {
  objectId: string;
  /** Override queries explicitly; otherwise we derive from the ticket. */
  queries?: string[];
  topPerQuery?: number;
};

/**
 * Fan-out KB search for a single ticket. Derives 2-3 angles from the ticket's
 * symptom keywords + product, runs them, dedupes results by URL, returns the
 * merged set ranked by max score.
 */
export async function searchKbForTicket({
  objectId,
  queries,
  topPerQuery = 6,
}: SearchKbForTicketOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");

  // Reuse resolution-hints to get the symptom keywords + smart angles
  let derivedQueries: string[];
  if (queries && queries.length > 0) {
    derivedQueries = queries.filter((q) => q.trim().length > 0);
  } else {
    const hints = await getResolutionHints({ objectId, pastTicketsTop: 1 });
    derivedQueries = hints.searchAngles.slice(0, 3).map((a) => a.query);
  }
  if (derivedQueries.length === 0) {
    return {
      objectId,
      configured: false,
      queries: [],
      total: 0,
      results: [],
      error: "Could not derive a search query from this ticket — no symptom keywords found.",
    };
  }

  const seenUrls = new Set<string>();
  const merged: Array<{
    query: string;
    title: string;
    url: string;
    snippet: string;
    score?: number;
    modifiedAt?: string;
  }> = [];
  let anyConfigured = false;
  let anyOk = false;
  let firstError: string | undefined;
  for (const q of derivedQueries) {
    const resp = await searchKb({ query: q, top: topPerQuery });
    anyConfigured = anyConfigured || resp.configured;
    anyOk = anyOk || resp.ok;
    if (resp.error && !firstError) firstError = resp.error;
    for (const r of resp.results) {
      const key = (r.url || r.title || "").toLowerCase();
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      merged.push({ query: q, ...r });
    }
  }
  merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    objectId,
    configured: anyConfigured,
    queries: derivedQueries,
    total: merged.length,
    results: merged,
    error: anyOk ? undefined : firstError,
  };
}

// ---------------------------------------------------------------------------
// RESOLUTION SUGGESTIONS — aggregate the data we have to suggest likely
// resolutions for a ticket. We can't query the external KB (auth-walled), so
// the value comes from:
//   1. Symptom keywords mined from the customer's notes
//   2. Past tickets on the SAME serial (with their resolution notes if any)
//   3. Past tickets on the SAME product category (recent closed ones)
//   4. A pre-built set of multi-angle search URLs the user can open against
//      the external KB.
// ---------------------------------------------------------------------------

export type GetResolutionHintsOptions = {
  objectId: string;
  pastTicketsTop?: number;
};

// Words we never use as search keywords (too generic / SAP-flavoured)
const SYMPTOM_STOPWORDS = new Set([
  "the","a","an","is","of","to","and","or","for","on","in","at","by","with","from","this","that","it","its",
  "issue","issues","problem","problems","ticket","customer","service","request","please","kindly","need","needs",
  "thanks","thank","you","hi","hello","regards","best","sincerely",
  "pm","preventive","maintenance","case","description","update","updates",
]);

/** Extract symptom keywords from a free-text body (title or note). */
function symptomKeywords(text: string, max = 8): string[] {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[^\w\s-]/g, " ")
    .toLowerCase();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (SYMPTOM_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t) && t.length < 4) continue; // drop tiny numbers
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Strip HTML + collapse to a single-line snippet. */
function snippet(raw: unknown, limit = 200): string {
  const s = String(raw ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
}

/**
 * Get a ticket-detail row + its notes in a single call.
 * Reused by getResolutionHints for the parent ticket and past tickets.
 */
async function fetchTicketWithNotes(objectId: string, notesTop = 5) {
  // Single ticket detail (lightweight projection)
  const ticketResp: any = await c4cGet(serviceRequestPath(objectId), {
    "$format": "json",
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCode,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCodeText,BuyerPartyID,BuyerPartyName,ProductID,SerialID,CreationDateTime,LastChangeDateTime,RequestCloseddatetimeContent,ProcessorPartyName",
  });
  const t = ticketResp?.d?.results ?? ticketResp?.d ?? {};
  // Notes
  const notesResp: any = await c4cGet(
    `${serviceRequestPath(objectId)}/ServiceRequestTextCollection`,
    {
      "$format": "json",
      "$top": Math.min(Math.max(notesTop, 1), 20),
      "$orderby": "CreatedOn desc",
      "$select": "TypeCode,TypeCodeText,Text,FormattedText,CreatedBy,CreatedOn",
    },
  );
  const notes: any[] = notesResp?.d?.results ?? [];
  return { ticket: t, notes };
}

/**
 * Aggregate resolution context for a ticket.
 * Returns symptom keywords, past tickets on the same serial WITH their note
 * snippets, past closed tickets on the same product, and a set of pre-built
 * multi-angle search queries the caller can hand to the external KB.
 */
export async function getResolutionHints({
  objectId,
  pastTicketsTop = 5,
}: GetResolutionHintsOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");

  // 1. Current ticket + its notes
  const current = await fetchTicketWithNotes(objectId, 8);
  const t = current.ticket;
  const title = String(t.Name ?? "");
  const productId = String(t.ProductID ?? "");
  const serialId = String(t.SerialID ?? "");
  const buyerName = String(t.BuyerPartyName ?? "");

  // 2. Symptom keywords from title + first customer note
  const customerNote = current.notes.find(
    (n) =>
      String(n.TypeCodeText ?? "")
        .toLowerCase()
        .includes("case description") ||
      String(n.TypeCodeText ?? "")
        .toLowerCase()
        .includes("customer"),
  );
  const noteText = customerNote
    ? snippet(customerNote.FormattedText || customerNote.Text, 500)
    : "";
  const keywords = symptomKeywords(`${title} ${noteText}`, 8);

  // 3. Past tickets on the same serial — these are the most relevant
  //    "resolutions" we have access to.
  let serialHistory: any[] = [];
  if (serialId) {
    const histResp: any = await c4cGet("/ServiceRequestCollection", {
      "$format": "json",
      "$top": Math.min(Math.max(pastTicketsTop, 1), 20),
      "$filter": `SerialID eq ${odataStringLiteral(serialId)} and ObjectID ne ${odataStringLiteral(objectId)}`,
      "$orderby": "LastChangeDateTime desc",
      "$select":
        "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCodeText,BuyerPartyName,CreationDateTime,LastChangeDateTime,RequestCloseddatetimeContent,ProcessorPartyName",
    });
    serialHistory = histResp?.d?.results ?? [];
  }

  // 4. For the top 3 past tickets on the same serial, fetch their resolution
  //    notes (Service Response Reports, TypeCode 10022) AND their service
  //    items (parts consumed + labor). Cap to keep latency bounded.
  type EnrichedTicket = {
    id: string;
    objectId: string;
    title: string;
    status: string;
    closedAt: string | null;
    customer: string;
    processor: string;
    /** TypeCode 10022 — the actual "Problem / Actions taken" writeup. */
    resolutionText: string | null;
    resolutionAuthor: string | null;
    resolutionDate: string | null;
    /** All notes, ordered with resolution first. */
    noteSnippets: Array<{ type: string; date: string; body: string }>;
    /** Parts consumed (SRP1) on this past ticket — the concrete "what was used". */
    partsUsed: Array<{ productId: string; description: string; qty: number; uom: string }>;
    laborHours: number;
  };

  const enrichedHistory: EnrichedTicket[] = [];
  const enrichTargets = serialHistory.slice(0, 3);
  for (const r of enrichTargets) {
    try {
      const subId = String(r.ObjectID ?? "");
      if (!subId) continue;

      // Notes — fetch up to 10, with resolution (10022) ordered first via filter+merge
      const allNotesResp: any = await c4cGet(
        `${serviceRequestPath(subId)}/ServiceRequestTextCollection`,
        {
          "$format": "json",
          "$top": 10,
          "$orderby": "CreatedOn desc",
          "$select": "TypeCode,TypeCodeText,Text,FormattedText,CreatedBy,CreatedOn",
        },
      );
      const allNotes: any[] = allNotesResp?.d?.results ?? [];
      const resolutionRow = allNotes.find(
        (n) =>
          String(n.TypeCode ?? "") === "10022" ||
          String(n.TypeCodeText ?? "").toLowerCase().includes("response report") ||
          String(n.TypeCodeText ?? "").toLowerCase().includes("resolution") ||
          String(n.TypeCodeText ?? "").toLowerCase().includes("work description"),
      );
      const resolutionText = resolutionRow
        ? snippet(resolutionRow.FormattedText || resolutionRow.Text, 1200)
        : null;
      // Sort notes: resolution first, then by date desc
      const sortedNotes = [
        ...(resolutionRow ? [resolutionRow] : []),
        ...allNotes.filter((n) => n !== resolutionRow),
      ];

      // Items — labor + parts
      let partsUsed: EnrichedTicket["partsUsed"] = [];
      let laborHours = 0;
      try {
        const itemsResp: any = await c4cGet(
          `${serviceRequestPath(subId)}/ServiceRequestItem`,
          {
            "$format": "json",
            "$top": 50,
            "$select":
              "ID,ProductID,ProductDescription,UserServiceTransactionProcessingTypeCode,QuantityMeasureUnitCodeText,ActualQuantity,PlannedQuantity",
          },
        );
        const items: any[] = itemsResp?.d?.results ?? [];
        for (const it of items) {
          const code = String(it.UserServiceTransactionProcessingTypeCode ?? "");
          // For resolution context we only care about ACTUAL work performed.
          // Planned-only items don't tell us what was actually done.
          const qty = parseDecimal(it.ActualQuantity);
          if (qty === 0) continue;
          const uomText = String(it.QuantityMeasureUnitCodeText ?? "").toLowerCase();
          if (code === "SRP1") {
            // Parts consumed
            partsUsed.push({
              productId: String(it.ProductID ?? ""),
              description: String(it.ProductDescription ?? ""),
              qty,
              uom: String(it.QuantityMeasureUnitCodeText ?? ""),
            });
          } else if (code.startsWith("Z") && uomText.includes("hour")) {
            laborHours += qty;
          }
        }
      } catch {
        /* items fetch failure is non-fatal */
      }

      enrichedHistory.push({
        id: String(r.ID ?? ""),
        objectId: subId,
        title: String(r.Name ?? ""),
        status: String(r.ServiceRequestLifeCycleStatusCodeText ?? ""),
        closedAt: String(r.RequestCloseddatetimeContent ?? "") || null,
        customer: String(r.BuyerPartyName ?? ""),
        processor: String(r.ProcessorPartyName ?? ""),
        resolutionText,
        resolutionAuthor: resolutionRow ? String(resolutionRow.CreatedBy ?? "") : null,
        resolutionDate: resolutionRow ? String(resolutionRow.CreatedOn ?? "") : null,
        noteSnippets: sortedNotes.slice(0, 6).map((n) => ({
          type: String(n.TypeCodeText ?? n.TypeCode ?? ""),
          date: String(n.CreatedOn ?? ""),
          body: snippet(n.FormattedText || n.Text, 600),
        })),
        partsUsed,
        laborHours: Math.round(laborHours * 10) / 10,
      });
    } catch {
      /* skip enrichment failures silently */
    }
  }

  // Past tickets on same serial that weren't enriched still get listed
  const remainingHistory: EnrichedTicket[] = serialHistory.slice(3).map((r) => ({
    id: String(r.ID ?? ""),
    objectId: String(r.ObjectID ?? ""),
    title: String(r.Name ?? ""),
    status: String(r.ServiceRequestLifeCycleStatusCodeText ?? ""),
    closedAt: String(r.RequestCloseddatetimeContent ?? "") || null,
    customer: String(r.BuyerPartyName ?? ""),
    processor: String(r.ProcessorPartyName ?? ""),
    resolutionText: null,
    resolutionAuthor: null,
    resolutionDate: null,
    noteSnippets: [],
    partsUsed: [],
    laborHours: 0,
  }));

  // 5. Past CLOSED tickets on the same product (different serials) — broader
  //    cross-customer context. Enrich the top 2 with resolution + parts.
  type EnrichedProduct = {
    id: string;
    objectId: string;
    title: string;
    serialId: string;
    customer: string;
    closedAt: string | null;
    processor: string;
    resolutionText: string | null;
    resolutionAuthor: string | null;
    resolutionDate: string | null;
    partsUsed: Array<{ productId: string; description: string; qty: number; uom: string }>;
    laborHours: number;
  };

  let productHistoryRaw: any[] = [];
  if (productId) {
    const prodResp: any = await c4cGet("/ServiceRequestCollection", {
      "$format": "json",
      "$top": Math.min(Math.max(pastTicketsTop, 1), 10),
      "$filter": `ProductID eq ${odataStringLiteral(productId)} and ServiceRequestLifeCycleStatusCode eq '4' and ObjectID ne ${odataStringLiteral(objectId)}`,
      "$orderby": "LastChangeDateTime desc",
      "$select":
        "ObjectID,ID,Name,SerialID,BuyerPartyName,RequestCloseddatetimeContent,ProcessorPartyName",
    });
    productHistoryRaw = prodResp?.d?.results ?? [];
  }

  const productHistory: EnrichedProduct[] = [];
  for (let i = 0; i < productHistoryRaw.length; i++) {
    const r = productHistoryRaw[i];
    const subId = String(r.ObjectID ?? "");
    const base: EnrichedProduct = {
      id: String(r.ID ?? ""),
      objectId: subId,
      title: String(r.Name ?? ""),
      serialId: String(r.SerialID ?? ""),
      customer: String(r.BuyerPartyName ?? ""),
      closedAt: String(r.RequestCloseddatetimeContent ?? "") || null,
      processor: String(r.ProcessorPartyName ?? ""),
      resolutionText: null,
      resolutionAuthor: null,
      resolutionDate: null,
      partsUsed: [],
      laborHours: 0,
    };
    // Enrich only the top 2 to keep latency bounded
    if (i < 2 && subId) {
      try {
        const subNotesResp: any = await c4cGet(
          `${serviceRequestPath(subId)}/ServiceRequestTextCollection`,
          {
            "$format": "json",
            "$top": 10,
            "$filter": "TypeCode eq '10022'",
            "$select": "TypeCodeText,Text,FormattedText,CreatedBy,CreatedOn",
          },
        );
        const resRow: any = (subNotesResp?.d?.results ?? [])[0];
        if (resRow) {
          base.resolutionText = snippet(resRow.FormattedText || resRow.Text, 1200);
          base.resolutionAuthor = String(resRow.CreatedBy ?? "");
          base.resolutionDate = String(resRow.CreatedOn ?? "");
        }
        const itemsResp: any = await c4cGet(
          `${serviceRequestPath(subId)}/ServiceRequestItem`,
          {
            "$format": "json",
            "$top": 50,
            "$select":
              "ProductID,ProductDescription,UserServiceTransactionProcessingTypeCode,QuantityMeasureUnitCodeText,ActualQuantity,PlannedQuantity",
          },
        );
        const items: any[] = itemsResp?.d?.results ?? [];
        for (const it of items) {
          const code = String(it.UserServiceTransactionProcessingTypeCode ?? "");
          // For resolution context we only care about ACTUAL work performed.
          // Planned-only items don't tell us what was actually done.
          const qty = parseDecimal(it.ActualQuantity);
          if (qty === 0) continue;
          const uomText = String(it.QuantityMeasureUnitCodeText ?? "").toLowerCase();
          if (code === "SRP1") {
            base.partsUsed.push({
              productId: String(it.ProductID ?? ""),
              description: String(it.ProductDescription ?? ""),
              qty,
              uom: String(it.QuantityMeasureUnitCodeText ?? ""),
            });
          } else if (code.startsWith("Z") && uomText.includes("hour")) {
            base.laborHours += qty;
          }
        }
        base.laborHours = Math.round(base.laborHours * 10) / 10;
      } catch {
        /* enrichment failure non-fatal */
      }
    }
    productHistory.push(base);
  }

  // 6. Build multi-angle KB search queries — the consumer will append base URL.
  const searchAngles: Array<{ label: string; query: string; weight: number }> = [];
  if (keywords.length >= 2) {
    searchAngles.push({
      label: "Symptom (top keywords)",
      query: keywords.slice(0, 4).join(" "),
      weight: 100,
    });
  }
  if (productId && keywords.length > 0) {
    searchAngles.push({
      label: "Symptom + product",
      query: `${keywords.slice(0, 3).join(" ")} ${productId}`,
      weight: 95,
    });
  }
  if (title) {
    searchAngles.push({
      label: "Ticket title",
      query: title.replace(/\b\d{6,}\b/g, "").trim(),
      weight: 90,
    });
  }
  if (productId) {
    searchAngles.push({ label: "Product only", query: productId, weight: 70 });
  }
  if (serialId) {
    searchAngles.push({ label: "Serial number", query: serialId, weight: 60 });
  }
  // Dedupe by query
  const seenQ = new Set<string>();
  const angles = searchAngles
    .filter((a) => {
      const k = a.query.trim().toLowerCase();
      if (!k) return false;
      if (seenQ.has(k)) return false;
      seenQ.add(k);
      return true;
    })
    .sort((a, b) => b.weight - a.weight);

  return {
    objectId,
    ticket: {
      id: String(t.ID ?? ""),
      title,
      status: String(t.ServiceRequestLifeCycleStatusCodeText ?? ""),
      customer: buyerName,
      productId,
      serialId,
    },
    symptomNote: noteText || null,
    keywords,
    searchAngles: angles,
    serialHistory: [...enrichedHistory, ...remainingHistory],
    productHistory,
  };
}

export type GetTicketItemsOptions = {
  objectId: string;
  top?: number;
};

/**
 * Service-request line items — the per-ticket labor entries, parts consumed,
 * and billing requests that drive billable hours, parts write-offs, and
 * grey-stock-vs-formal-consumption analytics.
 *
 * Three processing types observed in this tenant:
 *   ZALT — Actual Labor / Travel       (dominant, hours)
 *   SRP0 — Billing Request             (count)
 *   SRP1 — Part Consumption (tech stock) (rare — most parts go grey-stock)
 *
 * Returns rows + per-type rollups (labor hours planned vs actual, parts
 * consumed, billable count). Grouped so the UI can show one line per category.
 */
export async function getTicketItems({ objectId, top = 50 }: GetTicketItemsOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 200),
    "$orderby": "ID asc",
    "$select":
      "ObjectID,ID,ProductID,ProductDescription,UserServiceTransactionProcessingTypeCode,UserServiceTransactionProcessingTypeCodeText,QuantityMeasureUnitCode,QuantityMeasureUnitCodeText,PlannedQuantity,ActualQuantity,WarrantyGoodwillCode,WarrantyGoodwillCodeText,ServicePerformerPartyID,ServicePerformerPartyName,ServiceRequestExecutionLifeCycleStatusCode,ServiceRequestExecutionLifeCycleStatusCodeText,RequestedStartDateTime,RequestedEndDateTime,ActualStartDateTime,ActualEndDateTime,ContractID,ContractItemID,Description",
  };

  const result: any = await c4cGet(
    `${serviceRequestPath(objectId)}/ServiceRequestItem`,
    query,
  );
  const rows: any[] = result?.d?.results ?? [];

  // Buckets keyed by processing-type code (ZALT / SRP0 / SRP1 / etc.)
  type Bucket = {
    code: string;
    label: string;
    count: number;
    plannedTotal: number;
    actualTotal: number;
    uom: string;
    billable: number;
    warranty: number;
    items: Array<{
      id: string;
      productId: string;
      description: string;
      planned: number;
      actual: number;
      uom: string;
      warranty: string;
      performer: string;
      status: string;
    }>;
  };

  const bucketByCode = new Map<string, Bucket>();
  let totalPlannedHours = 0;
  let totalActualHours = 0;
  let totalPartsConsumed = 0;
  let billableCount = 0;
  let warrantyCount = 0;

  for (const r of rows) {
    const code = String(r.UserServiceTransactionProcessingTypeCode ?? "?");
    const label = String(r.UserServiceTransactionProcessingTypeCodeText ?? code);
    let bucket = bucketByCode.get(code);
    if (!bucket) {
      bucket = {
        code,
        label,
        count: 0,
        plannedTotal: 0,
        actualTotal: 0,
        uom: String(r.QuantityMeasureUnitCodeText ?? ""),
        billable: 0,
        warranty: 0,
        items: [],
      };
      bucketByCode.set(code, bucket);
    }
    const planned = parseDecimal(r.PlannedQuantity);
    const actual = parseDecimal(r.ActualQuantity);
    bucket.count++;
    bucket.plannedTotal += planned;
    bucket.actualTotal += actual;

    const wcText = String(r.WarrantyGoodwillCodeText ?? "").toLowerCase();
    if (wcText.includes("billable")) {
      bucket.billable++;
      billableCount++;
    } else if (wcText.includes("warranty") || wcText.includes("goodwill")) {
      bucket.warranty++;
      warrantyCount++;
    }

    const uomText = String(r.QuantityMeasureUnitCodeText ?? "").toLowerCase();
    if (uomText.includes("hour")) {
      totalPlannedHours += planned;
      totalActualHours += actual;
    } else if (code === "SRP1") {
      totalPartsConsumed += actual;
    }

    bucket.items.push({
      id: String(r.ID ?? ""),
      productId: String(r.ProductID ?? ""),
      description: String(r.ProductDescription ?? r.Description ?? ""),
      planned,
      actual,
      uom: String(r.QuantityMeasureUnitCodeText ?? r.QuantityMeasureUnitCode ?? ""),
      warranty: String(r.WarrantyGoodwillCodeText ?? ""),
      performer: String(r.ServicePerformerPartyName ?? ""),
      status: String(r.ServiceRequestExecutionLifeCycleStatusCodeText ?? ""),
    });
  }

  const buckets = Array.from(bucketByCode.values()).sort(
    (a, b) => b.count - a.count,
  );

  return {
    objectId,
    total: rows.length,
    totals: {
      plannedHours: totalPlannedHours,
      actualHours: totalActualHours,
      hoursCompletion:
        totalPlannedHours > 0
          ? Math.round((totalActualHours / totalPlannedHours) * 100)
          : null,
      partsConsumed: totalPartsConsumed,
      billable: billableCount,
      warranty: warrantyCount,
    },
    buckets,
  };
}

export type GetTicketKbArticlesOptions = {
  objectId: string;
  top?: number;
};

/**
 * KB articles / solution proposals attached to a Service Request.
 *
 * SAP exposes this via ServiceRequestSolutionProposalCollection. Each row
 * represents one proposed solution (typically a link to an external KB
 * article) bound to a ticket via ParentObjectID.
 *
 * In this tenant the entity is reachable but very sparsely populated — most
 * rows have empty ExternalKnowledgeBaseArticleID. The tool reports honestly:
 * total rows + a split between "populated" (has KB article or note) vs
 * "empty" (proposal created but never filled in).
 */
export async function getTicketKbArticles({ objectId, top = 25 }: GetTicketKbArticlesOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "CreationDateTime desc",
    "$select":
      "ObjectID,ID,ParentObjectID,ServiceRequestID,ExternalKnowledgeBaseArticleID,ExternalKnowledgeBaseArticleURI,ExternalKnowledgeBaseArticleDescription,ExternalKnowledgeBaseArticleDescriptionLanguageCodeText,Note,NoteLanguageCodeText,CreationDateTime,EntityLastChangedOn",
  };

  const result: any = await c4cGet(
    `${serviceRequestPath(objectId)}/ServiceRequestSolutionProposal`,
    query,
  );
  const rows: any[] = result?.d?.results ?? [];

  let populated = 0;
  let empty = 0;
  for (const r of rows) {
    const hasArticle = String(r.ExternalKnowledgeBaseArticleID ?? "").trim();
    const hasUri = String(r.ExternalKnowledgeBaseArticleURI ?? "").trim();
    const hasDesc = String(r.ExternalKnowledgeBaseArticleDescription ?? "").trim();
    const hasNote = String(r.Note ?? "").trim();
    if (hasArticle || hasUri || hasDesc || hasNote) populated++;
    else empty++;
  }

  return {
    objectId,
    total: rows.length,
    populated,
    empty,
    articles: rows,
  };
}

export type GetAccountOptions = {
  accountId: string;
};

/**
 * Customer master record by AccountID (the human ID, not ObjectID).
 * Returns the first matching account plus a documented set of useful fields.
 */
export async function getAccount({ accountId }: GetAccountOptions) {
  if (!accountId.trim()) throw new Error("accountId is required.");

  const query: ODataQuery = {
    "$format": "json",
    "$top": 1,
    "$filter": `AccountID eq ${odataStringLiteral(accountId)}`,
  };

  const result: any = await c4cGet("/CorporateAccountCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  if (rows.length === 0) {
    // Try ObjectID as a fallback (in case caller passed the GUID)
    if (/^[0-9A-Fa-f]{32}$/.test(accountId)) {
      const byObj: any = await c4cGet(`/CorporateAccountCollection(${odataStringLiteral(accountId)})`, { "$format": "json" });
      const obj = byObj?.d?.results ?? byObj?.d;
      if (obj && typeof obj === "object") {
        return { accountId, found: true, source: "objectId", account: obj };
      }
    }
    return { accountId, found: false, source: "search", account: null };
  }

  return { accountId, found: true, source: "search", account: rows[0] };
}

export type GetSlaAtRiskOptions = {
  hoursAhead?: number;
  top?: number;
};

/**
 * Tickets at risk of breaching SLA in the next N hours.
 * Uses CompleteDuedatetimeContent and excludes closed tickets.
 */
export async function getSlaAtRisk({ hoursAhead = 24, top = 50 }: GetSlaAtRiskOptions = {}) {
  const cutoff = new Date(Date.now() + hoursAhead * 3_600_000);
  const cutoffIso = cutoff.toISOString().replace(/\.\d+Z$/, "Z");

  // CompleteDuedatetimeContent is exposed as a plain ISO string in this tenant —
  // SAP rejects datetime/datetimeoffset literals AND rejects gt+lt on the same field.
  // Use a single string-comparison lt clause and post-filter empty dates in JS.
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1) * 2, 200), // over-fetch to compensate for empty-due-date rows
    "$filter":
      `CompleteDuedatetimeContent lt '${cutoffIso}' ` +
      `and ServiceRequestLifeCycleStatusCode lt '3'`, // 1=Open, 2=In Process
    "$orderby": "CompleteDuedatetimeContent asc",
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCode,ServicePriorityCodeText,BuyerPartyName,SerialID,CompleteDuedatetimeContent,ProcessorPartyName,ServiceExecutionTeamPartyName,EscalationStatusCodeText",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const allRows: any[] = result?.d?.results ?? [];
  // Drop rows with empty / sentinel dates that snuck past the lt clause
  const rows = allRows.filter((r) => {
    const v = String(r.CompleteDuedatetimeContent ?? "").trim();
    if (!v) return false;
    if (v.startsWith("0001-")) return false; // SAP often uses 0001-01-01 as "unset"
    return true;
  }).slice(0, Math.min(Math.max(top, 1), 100));

  // Bucket by priority and compute hours-until-due
  const now = Date.now();
  const priorityBuckets = { immediate: 0, urgent: 0, normal: 0, low: 0, other: 0 };
  const enriched = rows.map((r) => {
    const pcode = String(r.ServicePriorityCode ?? "");
    if (pcode === "1") priorityBuckets.immediate++;
    else if (pcode === "2") priorityBuckets.urgent++;
    else if (pcode === "3") priorityBuckets.normal++;
    else if (pcode === "7") priorityBuckets.low++;
    else priorityBuckets.other++;

    const dueRaw = String(r.CompleteDuedatetimeContent ?? "");
    const m = /\/Date\((-?\d+)\)\//.exec(dueRaw);
    const dueMs = m ? Number(m[1]) : Date.parse(dueRaw);
    const hoursUntilDue = Number.isFinite(dueMs) ? Math.round(((dueMs - now) / 3_600_000) * 10) / 10 : null;
    return { ...r, hoursUntilDue };
  });

  return {
    hoursAhead,
    cutoff: cutoffIso,
    total: rows.length,
    priorityBuckets,
    tickets: enriched,
  };
}

export type GetAccountOpenTicketsOptions = {
  buyerPartyId: string;
  top?: number;
  includeClosed?: boolean;
  orderBy?: string;
};

/**
 * Tickets for a customer (buyer). Defaults to open tickets only.
 * SAP lifecycle codes: 1=Open, 2=In Process, 3=Completed, 4=Closed.
 */
export async function getAccountOpenTickets({
  buyerPartyId,
  top = 25,
  includeClosed = false,
  orderBy = "LastChangeDateTime desc",
}: GetAccountOpenTicketsOptions) {
  validateOrderBy(orderBy);
  if (!buyerPartyId.trim()) throw new Error("buyerPartyId is required.");

  const filters = [
    `BuyerPartyID eq ${odataStringLiteral(buyerPartyId)}`,
    includeClosed ? undefined : "ServiceRequestLifeCycleStatusCode lt '4'",
  ].filter((f): f is string => Boolean(f));

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": filters.join(" and "),
    "$orderby": orderBy,
    "$select":
      "ObjectID,ID,Name,ServiceRequestLifeCycleStatusCode,ServiceRequestLifeCycleStatusCodeText,ServicePriorityCode,ServicePriorityCodeText,BuyerPartyID,BuyerPartyName,ProductID,SerialID,CreationDateTime,LastChangeDateTime,ProcessorPartyName",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  // Bucket by lifecycle so the UI/AI can show a quick split
  const buckets = { open: 0, in_process: 0, completed: 0, closed: 0, other: 0 };
  for (const r of rows) {
    const code = String(r.ServiceRequestLifeCycleStatusCode ?? "");
    if (code === "1") buckets.open++;
    else if (code === "2") buckets.in_process++;
    else if (code === "3") buckets.completed++;
    else if (code === "4") buckets.closed++;
    else buckets.other++;
  }

  return {
    buyerPartyId,
    total: rows.length,
    includeClosed,
    buckets,
    tickets: rows,
  };
}

export async function searchTickets({
  top,
  skip = 0,
  statusCode,
  odataFilter,
  orderBy
}: SearchTicketsOptions) {
  validateFilter(odataFilter);
  validateOrderBy(orderBy);

  const filters = [
    statusCode ? `ServiceRequestLifeCycleStatusCode eq ${odataStringLiteral(statusCode)}` : undefined,
    odataFilter ? `(${odataFilter})` : undefined
  ].filter((filter): filter is string => Boolean(filter));

  const query: ODataQuery = {
    "$format": "json",
    "$top": top,
    "$skip": skip,
    "$filter": filters.length ? filters.join(" and ") : undefined,
    "$orderby": orderBy
  };

  return c4cGet("/ServiceRequestCollection", query);
}

export async function getTicket({ objectId, expand = [], includeMetadata = false }: GetTicketOptions) {
  validateODataPaths(expand);

  const query: ODataQuery = {
    "$format": "json",
    "$expand": expand.length ? expand.join(",") : undefined
  };

  const ticket = await c4cGet(serviceRequestPath(objectId), query);

  if (!includeMetadata) {
    return ticket;
  }

  const metadata = await getParsedMetadata();
  return {
    ticket,
    metadata: summarizeMetadata(metadata, "ServiceRequestCollection")
  };
}

export async function getServiceMetadata({
  mode = "summary",
  entitySet,
  refresh = false
}: GetServiceMetadataOptions) {
  if (mode === "raw") {
    return getRawMetadata(refresh);
  }

  return summarizeMetadata(await getParsedMetadata(refresh), entitySet);
}

export type GetEmployeeSkillsOptions = {
  top?: number;
  ticketSampleSize?: number;
  productHint?: string;
};

type SkillEntry = {
  skillId: string;
  description: string;
  action: "PM" | "REPAIR" | "INSTALL" | "QUAL" | "OTHER";
  equipment: string;
};

type SkillTechnician = {
  id: string;
  name: string;
  salesOrg: string;
  managerId: string;
  jobId: string;
  skills: SkillEntry[];        // REAL — from ZSDK_EmployeeSkillsRoot
  matchingSkills: SkillEntry[]; // subset matching the productHint keyword(s)
  actionCounts: { PM: number; REPAIR: number; INSTALL: number; QUAL: number; OTHER: number };
  available: boolean;
  source: "ZSDK_EmployeeSkillsRoot";
};

const NOISE_TOKENS = new Set([
  // SAP product description noise
  "PROD", "STD", "TYPE", "PART", "UNIT", "GAS", "DGAS", "QUAT", "INST", "MOD",
  // English stopwords / filler
  "AND", "OR", "WITH", "FROM", "FOR", "THE", "ARE", "WAS", "ALL", "ANY", "NEW", "OLD",
  "BUT", "NOT", "HAS", "HAD", "CAN", "GET", "USE", "OUR", "OUT", "OFF", "ITS",
  // Support-speak nouns that aren't equipment
  "ISSUE", "ISSUES", "PROBLEM", "PROBLEMS", "ERROR", "ERRORS", "FAULT", "FAULTS",
  "FAIL", "FAILS", "FAILED", "BROKEN", "REQUEST", "TICKET",
  // Skill action prefixes — we don't want to search by these alone (they're part of the SkillID structure)
  "PM", "REPAIR", "INSTALL", "QUAL",
]);

function extractKeywords(hint: string): string[] {
  if (!hint) return [];
  const tokens = hint
    .toUpperCase()
    .split(/[\s,/_+\-()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !NOISE_TOKENS.has(t) && /[A-Z]/.test(t));
  // De-duplicate, preserve order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result.slice(0, 6);
}

function classifySkill(skillId: string): SkillEntry["action"] {
  const upper = skillId.toUpperCase();
  if (upper.startsWith("PM_") || upper.startsWith("PM ")) return "PM";
  if (upper.startsWith("REPAIR")) return "REPAIR";
  if (upper.startsWith("INSTALL")) return "INSTALL";
  if (upper.startsWith("QUAL")) return "QUAL";
  return "OTHER";
}

function skillEquipment(skillId: string): string {
  const idx = skillId.indexOf("_");
  return idx >= 0 ? skillId.slice(idx + 1).trim() : skillId.trim();
}

async function fetchSkillRows(filter: string | undefined, top: number) {
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 500),
    "$select":
      "ObjectID,EmployeeID,EmployeeName,SkillID,SkillDescription,empsalesorg,jobID,ManagerID,DeleteIndicator,Enableindicator,ChangedOn",
    "$orderby": "ChangedOn desc",
  };
  if (filter) query["$filter"] = filter;
  const result: any = await c4cGetCustom("zskill_employeeskills", "/ZSDK_EmployeeSkillsRootCollection", query).catch(
    () => ({ d: { results: [] } }),
  );
  const rows: any[] = (result?.d?.results ?? []).filter((r: any) => !r?.DeleteIndicator);
  return rows;
}

export async function getEmployeeSkills({
  top = 20,
  ticketSampleSize: _unused = 100,
  productHint,
}: GetEmployeeSkillsOptions = {}) {
  void _unused;
  const keywords = extractKeywords(productHint ?? "");

  // 1. Targeted: pull skill rows matching any extracted keyword
  let matchingRows: any[] = [];
  const keywordsUsed: string[] = [];
  for (const kw of keywords) {
    const filter = `substringof('${kw.replace(/'/g, "''")}',SkillID)`;
    const rows = await fetchSkillRows(filter, 200);
    if (rows.length > 0) {
      matchingRows = matchingRows.concat(rows);
      keywordsUsed.push(kw);
    }
  }

  // 2. Always grab a recent baseline so we have a list even with no keyword matches
  const baselineRows = await fetchSkillRows(undefined, 200);

  // De-dupe by ObjectID
  const allMap = new Map<string, any>();
  for (const r of [...matchingRows, ...baselineRows]) {
    const k = String(r.ObjectID ?? `${r.EmployeeID}|${r.SkillID}`);
    if (!allMap.has(k)) allMap.set(k, r);
  }
  const allRows = Array.from(allMap.values());

  // 3. Group by employee
  type Bucket = {
    employeeId: string;
    name: string;
    salesOrg: string;
    managerId: string;
    jobId: string;
    skills: SkillEntry[];
    matching: SkillEntry[];
  };
  const byEmp = new Map<string, Bucket>();
  for (const r of allRows) {
    const name = String(r.EmployeeName ?? "").trim();
    const empId = String(r.EmployeeID ?? "").trim() || name;
    if (!empId) continue;
    const skillId = String(r.SkillID ?? "").trim();
    if (!skillId) continue;
    const entry: SkillEntry = {
      skillId,
      description: String(r.SkillDescription ?? skillId),
      action: classifySkill(skillId),
      equipment: skillEquipment(skillId),
    };
    const isMatch = keywordsUsed.some((kw) => skillId.toUpperCase().includes(kw));
    const bucket =
      byEmp.get(empId) ??
      ({
        employeeId: empId,
        name: name || empId,
        salesOrg: String(r.empsalesorg ?? "").trim(),
        managerId: String(r.ManagerID ?? "").trim(),
        jobId: String(r.jobID ?? "").trim(),
        skills: [],
        matching: [],
      } as Bucket);
    bucket.skills.push(entry);
    if (isMatch) bucket.matching.push(entry);
    byEmp.set(empId, bucket);
  }

  // 4. Build technician list
  const technicians: SkillTechnician[] = Array.from(byEmp.values()).map((b) => {
    const counts = { PM: 0, REPAIR: 0, INSTALL: 0, QUAL: 0, OTHER: 0 };
    for (const s of b.skills) counts[s.action] += 1;
    return {
      id: b.employeeId,
      name: b.name,
      salesOrg: b.salesOrg || "—",
      managerId: b.managerId || "—",
      jobId: b.jobId || "—",
      skills: b.skills,
      matchingSkills: b.matching,
      actionCounts: counts,
      available: true,
      source: "ZSDK_EmployeeSkillsRoot",
    };
  });

  // 5. Rank: matching skills first, then total skills
  technicians.sort((a, b) => {
    if (b.matchingSkills.length !== a.matchingSkills.length)
      return b.matchingSkills.length - a.matchingSkills.length;
    return b.skills.length - a.skills.length;
  });

  // 6. Trim to requested top
  const trimmed = technicians.slice(0, Math.min(Math.max(top, 1), 50));

  return {
    technicians: trimmed,
    keywordsUsed,
    counts: {
      totalTechniciansFound: technicians.length,
      matchingTechnicians: technicians.filter((t) => t.matchingSkills.length > 0).length,
      skillRowsScanned: allRows.length,
      keywordCount: keywords.length,
    },
    productHint: productHint ?? null,
    notes: [
      `Real per-employee skill assignments from cust/v1/zskill_employeeskills/ZSDK_EmployeeSkillsRootCollection.`,
      keywordsUsed.length > 0
        ? `Filtered by keywords: ${keywordsUsed.join(", ")} — matched ${technicians.filter((t) => t.matchingSkills.length > 0).length} of ${technicians.length} technicians.`
        : keywords.length > 0
          ? `Tried keywords ${keywords.join(", ")} — no skill IDs matched. Showing baseline recent assignments.`
          : `No product hint provided — showing most recently updated skill assignments.`,
      `Skill IDs follow <ACTION>_<EQUIPMENT> pattern, e.g. REPAIR_ULT3S0PUMP, PM_ICSXX050CH.`,
    ],
  };
}

export async function getServiceHistory({
  objectId,
  navigationProperty,
  top = 20,
  candidateLimit = 5,
  includeDiscovery = true,
  refreshMetadata = false
}: GetServiceHistoryOptions) {
  if (navigationProperty) {
    validateODataPaths([navigationProperty]);
  }

  const metadata = await getParsedMetadata(refreshMetadata);
  const serviceRequest = getServiceRequestEntity(metadata);

  if (!serviceRequest) {
    throw new Error("Could not find ServiceRequestCollection in SAP C4C metadata.");
  }

  const selectedCandidates = navigationProperty
    ? serviceRequest.entityType.navigationProperties
        .filter((nav) => nav.name === navigationProperty)
        .map((nav) => ({
          ...candidateFromNavigationProperty(nav),
          ...resolveNavigationTarget(metadata, nav)
        }))
    : discoverServiceHistoryCandidates(metadata).slice(0, candidateLimit);

  if (!selectedCandidates.length) {
    const available = serviceRequest.entityType.navigationProperties.map((nav) => nav.name);
    throw new Error(
      navigationProperty
        ? `Navigation property '${navigationProperty}' was not found on ServiceRequestCollection. Available navigation properties: ${available.join(", ")}`
        : `No likely service-history navigation properties were discovered. Available navigation properties: ${available.join(", ")}`
    );
  }

  const history = [];
  const failures = [];

  for (const candidate of selectedCandidates) {
    const query: ODataQuery = {
      "$format": "json",
      "$top": candidate.targetMultiplicity === "*" ? top : undefined
    };

    try {
      history.push({
        navigationProperty: candidate.name,
        targetEntityType: candidate.targetEntityType,
        targetMultiplicity: candidate.targetMultiplicity,
        reasons: candidate.reasons,
        data: await c4cGet(`${serviceRequestPath(objectId)}/${candidate.name}`, query)
      });
    } catch (error) {
      failures.push({
        navigationProperty: candidate.name,
        targetEntityType: candidate.targetEntityType,
        error: formatToolError(error)
      });
    }
  }

  return {
    sourceTicketObjectId: objectId,
    serviceRequestEntitySet: serviceRequest.entitySet.name,
    serviceRequestEntityType: serviceRequest.entityType.fullName,
    history,
    failures,
    discovery: includeDiscovery
      ? {
          selectedNavigationProperties: selectedCandidates.map((candidate) => ({
            name: candidate.name,
            targetEntityType: candidate.targetEntityType,
            targetMultiplicity: candidate.targetMultiplicity,
            score: candidate.score,
            reasons: candidate.reasons
          })),
          serviceHistoryCandidates: discoverServiceHistoryCandidates(metadata)
        }
      : undefined
  };
}

// ---------------------------------------------------------------------------
// PARTS — backed by StockLocationItemCollection.
//
// ProductCollection is blocked in this tenant (RBAM_ERROR), so we can't browse
// the product master directly. Instead we derive the parts catalogue from
// StockLocationItem rows (every part with any inventory shows up here).
// ---------------------------------------------------------------------------

export type SearchPartsOptions = {
  query?: string;        // matches MaterialID substring, ProductID/ProductIDExternalKey exact, or ProductDescription substring
  top?: number;
};

function parseDecimal(raw: unknown): number {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * v0.26.65 / .68 — module-level cache for "does entity X have property Y?"
 *
 * SAP C4C entities vary across tenants. The standard fields are usually
 * stable, but optional / extension fields (e.g., `ProductIDExternalKey`,
 * tenant-specific KUT_* customizations) may or may not exist. When we
 * query a missing property, SAP responds with EITHER:
 *   - 400 "Property X not found in type Y" (filter clause)
 *   - 404 "Resource not found for the segment 'X'" (select clause)
 * Both kill the whole query — even if the other selected fields exist.
 *
 * This cache lets us probe once, remember the answer for the process
 * lifetime, and skip subsequent attempts that we know will fail. The
 * cache is keyed by `${EntityName}.${PropertyName}` and stores boolean
 * (true = exists, false = doesn't exist, undefined = unknown / not yet
 * probed).
 *
 * Detection happens in catch blocks: when a request fails with one of
 * the two error patterns above AND the URL contains the property name,
 * we mark it as `false` so the next call skips that attempt entirely.
 *
 * v0.26.68: KUT_PRODUCTEXTID_KUT removed from order-parts paths entirely
 * (the reporter clarified it's unrelated to parts ordering). The cache
 * mechanism now guards optional STANDARD fields like ProductIDExternalKey.
 */
const TENANT_FIELD_CACHE = new Map<string, boolean>();
function markFieldMissing(entity: string, property: string): void {
  TENANT_FIELD_CACHE.set(`${entity}.${property}`, false);
  console.warn(`[search_parts] tenant schema cache: ${entity}.${property} = MISSING (will skip future attempts)`);
}
function isFieldKnownMissing(entity: string, property: string): boolean {
  return TENANT_FIELD_CACHE.get(`${entity}.${property}`) === false;
}
/** Detect "property not found" / "segment not found" / 500-on-filter patterns. */
function isPropertyNotFoundError(err: unknown, property: string): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  // 400 form: "Property X not found in type Y"
  if (msg.includes(`Property ${property} not found`)) return true;
  // 404 form: "Resource not found for the segment 'X'"
  if (msg.includes(`segment '${property}'`)) return true;
  if (msg.includes(`segment "${property}"`)) return true;
  // v0.26.76 — 500 form: SAP server crashes when filtering on certain
  // fields that exist but aren't OData-filterable (e.g.,
  // ProductIDExternalKey on this tenant). The error message contains
  // both "HTTP 500" and the field name in the URL. Cache it the same
  // as "missing" so we stop trying to filter on it.
  if (
    (msg.includes("HTTP 500") || msg.includes("Internal Server Error")) &&
    msg.includes(property)
  ) {
    return true;
  }
  return false;
}

/**
 * List parts that have any tracked stock anywhere — grouped by MaterialID.
 * Returns aggregate on-hand qty across all stock locations + which locations carry it.
 */
export async function searchParts({ query, top = 25 }: SearchPartsOptions = {}) {
  // v0.26.59 / .68 — multi-attempt search across STANDARD ServiceRequestItem
  // and StockLocationItem fields, because operators search by whatever
  // they have visible on the SAP UI:
  //   1. MaterialID (canonical stock-catalog ID, substring)
  //   2. ProductID / ProductIDExternalKey via past line items (exact match —
  //      catches parts with no current stock entry, e.g., ATP/order-only
  //      items like the reporter's 094485 / 10013161 FRU CDU DRIP PAN)
  //   3. ProductDescription via past line items (substring — catches
  //      description searches like "PISTON" or "DRIP PAN")
  // Each attempt is one OData call. We stop on the first non-empty.
  //
  // OData v2 doesn't have a clean OR across collections, so iterating
  // attempts is the simplest robust approach. Each one uses the same
  // sanitized token to keep filter parsers happy.
  //
  // v0.26.68: removed KUT_PRODUCTEXTID_KUT entirely — per reporter
  // clarification, that custom KUT field is unrelated to parts ordering.
  // We now use only standard SAP C4C fields (ProductID, ProductIDExternalKey,
  // ProductDescription, MaterialID, Quantity).
  const rawQuery = query?.trim() ?? "";
  const sanitized = rawQuery.replace(/[^A-Za-z0-9._-]+/g, " ").trim().split(/\s+/)[0]?.slice(0, 50) ?? "";

  /** Run a single search against StockLocationItemCollection with the
   *  given filter. Returns the rows array (possibly empty).
   *  v0.26.68 — uses ONLY standard SAP C4C fields. The previous
   *  KUT_PRODUCTEXTID_KUT references were misguided: that custom KUT
   *  field has nothing to do with parts ordering. Stock catalog uses
   *  MaterialID (the canonical internal ID); ServiceRequestItem-linked
   *  searches use ProductID / ProductIDExternalKey / ProductDescription
   *  (all standard fields). */
  async function searchStockBy(filterClause: string): Promise<any[]> {
    const q: ODataQuery = {
      "$format": "json",
      "$top": Math.min(Math.max(top, 1) * 8, 500),
      "$select": "ObjectID,MaterialID,StockLocationID,ValuatedUnrestrictedUseStock,UnrestrictedUseConsignmentStock,BlockedStock,BaseUnitofMeasure,BaseUnitofMeasureText",
    };
    if (filterClause) q["$filter"] = filterClause;
    try {
      const r: any = await c4cGet("/StockLocationItemCollection", q);
      return r?.d?.results ?? [];
    } catch (e: any) {
      // Property-not-found / filter-parse errors: log + return empty so
      // the next attempt fires.
      console.warn("[search_parts] attempt failed:", filterClause, "→", e?.message ?? e);
      return [];
    }
  }

  // v0.26.64 — synthetic "stockless" rows for parts found in line items
  // but missing from StockLocationItem. These end up in the byPart map
  // with onHand=null so the UI can render them with a "stock unknown"
  // badge instead of dropping them entirely.
  // v0.26.68 — uses standard ProductIDExternalKey (not the custom KUT field
  // that the reporter clarified is unrelated to order parts).
  const stocklessSeeds: Array<{
    MaterialID: string;
    ProductIDExternalKey: string;
    ProductDescription: string;
    /** v0.27.44 — real base UoM when known (product-master seeds). */
    BaseUOM?: string;
  }> = [];

  /** Try a list of optional SELECT fields against ServiceRequestItem,
   *  dropping any that the tenant doesn't have. Returns the resulting
   *  rows + the SELECT clause that actually worked. v0.26.68 — replaces
   *  the previous KUT-specific retry with a generic schema-aware
   *  approach that drops missing standard fields too (e.g.,
   *  ProductIDExternalKey exists on most C4C tenants but not all). */
  async function querySrqItemsWithFallback(
    filterClause: string,
    requiredFields: string[],
    optionalFields: string[],
    topRows: number,
  ): Promise<any[]> {
    const baseSelect = requiredFields.join(",");
    const optAvailable = optionalFields.filter(
      (f) => !isFieldKnownMissing("ServiceRequestItem", f),
    );
    const fullSelect = optAvailable.length > 0
      ? `${baseSelect},${optAvailable.join(",")}`
      : baseSelect;
    const runQuery = (sel: string) =>
      c4cGet("/ServiceRequestItemCollection", {
        "$format": "json",
        "$top": topRows,
        "$orderby": "ID desc",
        "$filter": filterClause,
        "$select": sel,
      });
    try {
      const r: any = await runQuery(fullSelect);
      return r?.d?.results ?? [];
    } catch (e: any) {
      // Detect which (if any) optional field is missing; mark + retry.
      for (const f of optAvailable) {
        if (isPropertyNotFoundError(e, f)) {
          markFieldMissing("ServiceRequestItem", f);
        }
      }
      const remaining = optAvailable.filter(
        (f) => !isFieldKnownMissing("ServiceRequestItem", f),
      );
      const retrySelect = remaining.length > 0
        ? `${baseSelect},${remaining.join(",")}`
        : baseSelect;
      if (retrySelect !== fullSelect) {
        try {
          const r: any = await runQuery(retrySelect);
          return r?.d?.results ?? [];
        } catch (e2: any) {
          console.warn("[search_parts] retry without missing optional fields failed:", e2?.message ?? e2);
          return [];
        }
      }
      console.warn("[search_parts] query failed:", filterClause, "→", e?.message ?? e);
      return [];
    }
  }

  /** Description search — query ServiceRequestItemCollection where
   *  ProductDescription is denormalised. Returns a set of MaterialIDs
   *  whose past line items mention the query text. We then re-query
   *  StockLocationItem for those specific MaterialIDs to get stock data.
   *  v0.26.68: only standard fields (ProductID, ProductDescription,
   *  ProductIDExternalKey). Drops missing optionals automatically via the
   *  fallback helper. */
  async function searchByDescription(): Promise<any[]> {
    if (!rawQuery) return [];
    const descToken = rawQuery.replace(/[^A-Za-z0-9._\- ]+/g, " ").trim();
    if (!descToken) return [];
    const items = await querySrqItemsWithFallback(
      `substringof(${odataStringLiteral(descToken)},ProductDescription)`,
      ["ProductID", "ProductDescription"],   // required — known to exist
      ["ProductIDExternalKey"],                  // optional — drop if missing
      100,
    );
    const seenIds = new Set<string>();
    for (const it of items) {
      const pid = String(it.ProductID ?? "").trim();
      if (!pid || seenIds.has(pid)) continue;
      seenIds.add(pid);
      stocklessSeeds.push({
        MaterialID: pid,
        ProductIDExternalKey: String(it.ProductIDExternalKey ?? "").trim(),
        ProductDescription: String(it.ProductDescription ?? "").trim(),
      });
    }
    const materialIds = Array.from(seenIds).slice(0, 25);
    if (materialIds.length === 0) return [];
    const orFilter = materialIds
      .map((id) => `MaterialID eq ${odataStringLiteral(id)}`)
      .join(" or ");
    return await searchStockBy(orFilter);
  }

  /** v0.26.68 — search ServiceRequestItemCollection by standard
   *  product fields. Two filters tried in sequence:
   *    (a) ProductID eq <query>         — if the query is the internal ID
   *    (b) ProductIDExternalKey eq <query> — standard SAP external-ID field
   *  Both are STANDARD C4S fields per the reporter's clarification
   *  (KUT_PRODUCTEXTID_KUT was wrong — that's a custom KUT extension
   *  unrelated to parts ordering). If ProductIDExternalKey doesn't exist
   *  on the tenant either, the schema-cache skips it on next call. */
  async function searchLineItemsByProductCode(code: string): Promise<any[]> {
    if (!code) return [];
    const tryFilter = async (filterClause: string): Promise<any[]> => {
      const items = await querySrqItemsWithFallback(
        filterClause,
        ["ProductID", "ProductDescription"],
        ["ProductIDExternalKey"],
        50,
      );
      const seenIds = new Set<string>();
      for (const it of items) {
        const pid = String(it.ProductID ?? "").trim();
        if (!pid || seenIds.has(pid)) continue;
        seenIds.add(pid);
        stocklessSeeds.push({
          MaterialID: pid,
          ProductIDExternalKey: String(it.ProductIDExternalKey ?? "").trim(),
          ProductDescription: String(it.ProductDescription ?? "").trim(),
        });
      }
      const materialIds = Array.from(seenIds).slice(0, 25);
      if (materialIds.length === 0) return [];
      const orFilter = materialIds
        .map((id) => `MaterialID eq ${odataStringLiteral(id)}`)
        .join(" or ");
      return await searchStockBy(orFilter);
    };
    // Attempt (a) — exact match on ProductID (canonical line-item field).
    const byProductId = await tryFilter(`ProductID eq ${odataStringLiteral(code)}`);
    if (byProductId.length > 0) return byProductId;
    // Attempt (b) — exact match on ProductIDExternalKey (standard external
    // ID). Skip if the schema cache knows it's missing on this tenant.
    if (!isFieldKnownMissing("ServiceRequestItem", "ProductIDExternalKey")) {
      try {
        const byExtId = await tryFilter(`ProductIDExternalKey eq ${odataStringLiteral(code)}`);
        if (byExtId.length > 0) return byExtId;
      } catch (e: any) {
        if (isPropertyNotFoundError(e, "ProductIDExternalKey")) {
          markFieldMissing("ServiceRequestItem", "ProductIDExternalKey");
        }
      }
    }
    return [];
  }

  // Run the attempts in priority order; stop at first non-empty.
  // v0.26.68 — uses STANDARD ServiceRequestItem / StockLocationItem
  // fields only (no KUT_PRODUCTEXTID_KUT — clarified by the reporter
  // as unrelated to parts ordering).
  let rows: any[] = [];
  let matchedBy: string | null = null;
  if (sanitized) {
    // Attempt 1 — MaterialID substring (canonical stock-catalog field).
    rows = await searchStockBy(`substringof(${odataStringLiteral(sanitized)},MaterialID)`);
    if (rows.length > 0) matchedBy = "MaterialID";
  }
  if (rows.length === 0 && sanitized) {
    // Attempt 2 — ProductID / ProductIDExternalKey via past line items.
    // Catches parts that exist in past tickets but have no current
    // StockLocationItem entry (ATP/order-only parts like the user's
    // 094485 / 10013161 FRU CDU DRIP PAN SW OPT PUMA).
    rows = await searchLineItemsByProductCode(sanitized);
    if (rows.length > 0) matchedBy = "ProductID/ProductIDExternalKey (via past line items)";
  }
  if (rows.length === 0 && rawQuery) {
    // Attempt 3 — description via ServiceRequestItemCollection.
    rows = await searchByDescription();
    if (rows.length > 0) matchedBy = "ProductDescription (via past line items)";
  }
  if (rows.length === 0 && sanitized) {
    // Attempt 4 (v0.27.44) — the full PRODUCT MASTER. Catches parts
    // never stocked anywhere AND never used on any ticket (reporter
    // case: 10013549 OPAMP — visible in SAP's Products dialog, invisible
    // to attempts 1-3). Requires the integration user to hold Products
    // read access (RBAM) — granted on this tenant 2026-06-12; on
    // tenants without it the 403 is caught and this attempt is a no-op.
    // Key field is ProductID (InternalID / ID don't exist in this
    // tenant's Product entity type). Feeds stocklessSeeds so the
    // synthetic-row pipeline + "no stock data" badge handle the rest.
    const tryMaster = async (filterClause: string): Promise<any[]> => {
      try {
        const r: any = await c4cGet("/ProductCollection", {
          "$format": "json",
          "$top": 25,
          "$filter": filterClause,
          "$select": "ProductID,Description,BaseUOM,Status,StatusText",
        });
        return r?.d?.results ?? [];
      } catch (e: any) {
        console.warn("[search_parts] product-master attempt failed (no Products read access?):", e?.message ?? e);
        return [];
      }
    };
    let masterRows = await tryMaster(`ProductID eq ${odataStringLiteral(sanitized)}`);
    if (masterRows.length === 0 && rawQuery.length >= 4) {
      const descToken = rawQuery.replace(/[^A-Za-z0-9._\- ]+/g, " ").trim();
      if (descToken) {
        masterRows = await tryMaster(`substringof(${odataStringLiteral(descToken)},Description)`);
      }
    }
    for (const p of masterRows) {
      const pid = String(p.ProductID ?? "").trim();
      if (!pid) continue;
      // Flag non-active products inline — operators should see they're
      // picking an obsoleted/blocked material before committing.
      const statusSuffix =
        String(p.Status ?? "2") !== "2" ? ` [${String(p.StatusText || "not active")}]` : "";
      stocklessSeeds.push({
        MaterialID: pid,
        ProductIDExternalKey: "",
        ProductDescription: String(p.Description ?? "").trim() + statusSuffix,
        BaseUOM: String(p.BaseUOM ?? "").trim(),
      });
    }
    if (masterRows.length > 0) {
      matchedBy = "ProductMaster (full product list — no stock/usage records)";
      console.log(`[search_parts] product-master matched ${masterRows.length} row(s)`);
    }
  }
  if (rows.length === 0 && !sanitized) {
    rows = await searchStockBy("");
    if (rows.length > 0) matchedBy = "top-stock (no query)";
  }
  if (matchedBy) console.log(`[search_parts] matched ${rows.length} row(s) via ${matchedBy}`);

  // v0.26.64 — synthetic "stockless" rows. If we found ProductIDs in
  // line items (descriptionSearch / externalIdSearch populated
  // stocklessSeeds) but their StockLocationItem follow-up returned 0
  // for some of them, those parts are real but have no current stock.
  // Inject them with onHand=null so they show up in results as
  // "Stock unknown" — adding them to the cart still works because the
  // commit only needs ProductID + quantity.
  if (stocklessSeeds.length > 0) {
    const seenMaterialIds = new Set(rows.map((r) => String(r.MaterialID ?? "").trim()));
    for (const seed of stocklessSeeds) {
      if (seenMaterialIds.has(seed.MaterialID)) continue;
      rows.push({
        MaterialID: seed.MaterialID,
        // v0.26.68 — standard ProductIDExternalKey (not KUT_PRODUCTEXTID_KUT).
        // Carried through onto the row so the byPart aggregator surfaces
        // it on the response as `externalId`.
        _seedProductIDExternalKey: seed.ProductIDExternalKey,
        StockLocationID: null,
        ValuatedUnrestrictedUseStock: null,
        UnrestrictedUseConsignmentStock: null,
        BlockedStock: null,
        // v0.27.44 — product-master seeds carry the REAL base UoM
        // (e.g. ZDP for consumables); line-item seeds default to EA.
        BaseUnitofMeasure: seed.BaseUOM || "EA",
        BaseUnitofMeasureText: seed.BaseUOM || "EA",
        // Carry the description through so enrichWithDescriptions doesn't
        // have to re-fetch.
        _seedDescription: seed.ProductDescription,
      });
      seenMaterialIds.add(seed.MaterialID);
    }
    console.log(`[search_parts] added ${stocklessSeeds.length} stockless seed(s) — parts found in line items but no stock entry`);
  }

  // Group by MaterialID. v0.26.64 — stockless rows (synthetic seeds
  // from past line items) have null stock values + StockLocationID;
  // those entries get onHand = null so the UI can render "Stock
  // unknown" instead of "0 in stock" (which would be misleading —
  // 0 means actually-tracked-as-zero, null means we don't know).
  const byPart = new Map<
    string,
    {
      materialId: string;
      externalId: string;
      description: string;
      uom: string;
      onHand: number | null;
      consignment: number;
      blocked: number;
      locations: number;
      sampleLocations: string[];
    }
  >();
  for (const r of rows) {
    const id = String(r.MaterialID ?? "").trim();
    if (!id) continue;
    let entry = byPart.get(id);
    if (!entry) {
      entry = {
        materialId: id,
        // v0.26.68 — externalId now comes from standard ProductIDExternalKey
        // (carried via _seedProductIDExternalKey on stockless seeds) — not
        // the custom KUT field which is unrelated to parts ordering.
        externalId: String((r as any)._seedProductIDExternalKey ?? "").trim(),
        description: String((r as any)._seedDescription ?? "").trim(),
        // v0.26.85 — prefer the CODE (BaseUnitofMeasure = "EA") over the
        // TEXT (BaseUnitofMeasureText = "Each"). The code is what SAP
        // expects in POST bodies; the text fails QuantityMeasureUnitCode
        // validation ("Property 'QuantityMeasureUnitCode' at offset N is
        // invalid"). Only fall back to text if the code is unavailable;
        // even then we validate the shape downstream in buildBodyFromProbe.
        uom: String(r.BaseUnitofMeasure ?? r.BaseUnitofMeasureText ?? "").trim() || "EA",
        // v0.26.64 — null means stockless seed; the rest of the loop
        // checks this before accumulating real stock values.
        onHand: r.StockLocationID == null ? null : 0,
        consignment: 0,
        blocked: 0,
        locations: 0,
        sampleLocations: [],
      };
      byPart.set(id, entry);
    }
    // Only accumulate when we have actual stock-location data.
    if (r.StockLocationID != null) {
      // If we previously seeded as stockless (null) and now have real
      // stock data, flip onHand back to 0 before adding.
      if (entry.onHand === null) entry.onHand = 0;
      entry.onHand += parseDecimal(r.ValuatedUnrestrictedUseStock);
      entry.consignment += parseDecimal(r.UnrestrictedUseConsignmentStock);
      entry.blocked += parseDecimal(r.BlockedStock);
      entry.locations++;
      const locId = String(r.StockLocationID ?? "").trim();
      if (locId && entry.sampleLocations.length < 3 && !entry.sampleLocations.includes(locId)) {
        entry.sampleLocations.push(locId);
      }
    }
  }

  // v0.26.64 — sort: in-stock parts first (most stock first), then
  // stockless parts (onHand=null) at the end of the IN-STOCK list,
  // then 0-stock parts. Stockless entries are NEW info (from line
  // items), so they're at least as valuable as 0-stock entries.
  const parts = Array.from(byPart.values())
    .sort((a, b) => {
      const aTotal = (a.onHand ?? -1) + a.consignment;
      const bTotal = (b.onHand ?? -1) + b.consignment;
      return bTotal - aTotal;
    })
    .slice(0, Math.min(Math.max(top, 1), 100));

  /*
   * Enrich with human-readable descriptions.
   *
   * ProductCollection / MaterialCollection are blocked in this tenant
   * (RBAM_ERROR — integration user can't read product master). But the
   * SAME description is denormalised onto every ServiceRequestItem, so
   * we fire one extra OData call against ServiceRequestItemCollection
   * filtered to our materialIds, and pick the most recent description
   * per ProductID. This is approximate (descriptions can differ across
   * tickets) but the most-recent value is good enough for the panel.
   *
   * Cost: 1 extra round-trip per searchParts call, capped at ~6 parts
   * × $top of 50 rows ≈ 300 rows of metadata. Cheap.
   */
  await enrichWithDescriptions(parts).catch((err) => {
    // Non-fatal — if the enrichment 500s we just return ids without names.
    console.warn("[search_parts] description enrichment failed:", err?.message ?? err);
  });

  return {
    query: sanitized || null,
    rawQuery: rawQuery || null,
    matchedBy, // v0.26.68 — which attribute matched (MaterialID / ProductID / ProductIDExternalKey / ProductDescription / null)
    sampledRows: rows.length,
    distinctParts: byPart.size,
    parts,
  };
}

/**
 * Look up part descriptions by querying ServiceRequestItemCollection — the
 * ProductDescription field is denormalised there even though ProductCollection
 * is RBAM-blocked. Mutates `parts` in place by adding a `description` field.
 */
async function enrichWithDescriptions(
  parts: Array<{ materialId: string } & Record<string, unknown>>,
) {
  if (parts.length === 0) return;
  const ids = parts.map((p) => p.materialId).filter(Boolean);
  if (ids.length === 0) return;

  // OData $filter: ProductID eq 'X' or ProductID eq 'Y' or …
  // Cap at 25 ids/call to keep the filter URL under SAP's length limit
  // (~2KB practical). For a top-6 parts panel this is always one call.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 25) chunks.push(ids.slice(i, i + 25));

  // Pick the most-recent description per ProductID, since the same product
  // can have slightly different label text across older tickets.
  const descByProductId = new Map<string, string>();

  for (const chunk of chunks) {
    const filter = chunk
      .map((id) => `ProductID eq ${odataStringLiteral(id)}`)
      .join(" or ");
    const result: any = await c4cGet("/ServiceRequestItemCollection", {
      $format: "json",
      $top: 200,
      $orderby: "ID desc",
      $filter: filter,
      $select: "ProductID,ProductDescription",
    });
    const rows: any[] = result?.d?.results ?? [];
    for (const r of rows) {
      const pid = String(r.ProductID ?? "").trim();
      const desc = String(r.ProductDescription ?? "").trim();
      if (pid && desc && !descByProductId.has(pid)) {
        descByProductId.set(pid, desc);
      }
    }
  }

  for (const p of parts) {
    const d = descByProductId.get(p.materialId);
    if (d) (p as Record<string, unknown>).description = d;
  }
}

export type GetPartAvailabilityOptions = {
  materialId: string;
  top?: number;
};

/**
 * Stock on hand for a specific material — every stock-location row with
 * computed total/usable/blocked quantities.
 */
export async function getPartAvailability({ materialId, top = 50 }: GetPartAvailabilityOptions) {
  if (!materialId.trim()) throw new Error("materialId is required.");

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 200),
    "$filter": `MaterialID eq ${odataStringLiteral(materialId)}`,
    "$orderby": "ValuatedUnrestrictedUseStock desc",
    // v0.26.68 — dropped KUT_PRODUCTEXTID_KUT (custom KUT extension,
    // unrelated to parts ordering per reporter clarification). Standard
    // StockLocationItem fields only.
    "$select":
      "ObjectID,MaterialID,StockLocationID,ValuatedUnrestrictedUseStock,UnrestrictedUseConsignmentStock,StockInQualityInspection,BlockedStock,BlockedStockReturns,BatchNumber,SpecialStockIndicator,BaseUnitofMeasure,BaseUnitofMeasureText,AccountNumberOfVendorOrCreditor",
  };

  const result: any = await c4cGet("/StockLocationItemCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  let totalOnHand = 0;
  let totalConsignment = 0;
  let totalBlocked = 0;
  let totalInspection = 0;
  for (const r of rows) {
    totalOnHand += parseDecimal(r.ValuatedUnrestrictedUseStock);
    totalConsignment += parseDecimal(r.UnrestrictedUseConsignmentStock);
    totalBlocked += parseDecimal(r.BlockedStock) + parseDecimal(r.BlockedStockReturns);
    totalInspection += parseDecimal(r.StockInQualityInspection);
  }

  return {
    materialId,
    locations: rows.length,
    totals: {
      onHand: totalOnHand,
      consignment: totalConsignment,
      blocked: totalBlocked,
      qualityInspection: totalInspection,
      usable: totalOnHand + totalConsignment,
    },
    uom: rows[0]?.BaseUnitofMeasureText ?? rows[0]?.BaseUnitofMeasure ?? "",
    rows,
  };
}

// ---------------------------------------------------------------------------
// DURATION STATS — planned vs actual processing time per product / issue.
// Source fields on ServiceRequest:
//   RequestedTotalProcessingDuration  (ISO 8601 duration, e.g. "PT4H")
//   RequestInProcessdatetimeContent   (ISO timestamp when status → 2)
//   RequestCloseddatetimeContent      (ISO timestamp when status → 4)
// We compute actual = closed - inProcess and report median / p90 / spread.
// ---------------------------------------------------------------------------

export type GetDurationStatsOptions = {
  productId?: string;
  buyerPartyId?: string;
  sampleSize?: number;
};

function parseIsoDuration(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // SAP returns either "PT4H30M" style or plain decimal hours as string.
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  return days * 24 + hours + mins / 60 + secs / 3600;
}

function parseTimestamp(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.startsWith("0001-")) return null; // SAP "unset" sentinel
  const m = /\/Date\((-?\d+)\)\//.exec(s);
  if (m) return Number(m[1]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Median actual vs planned processing duration for closed tickets matching
 * a product (and/or customer). Used by the "planned 4h, actual P50 6.5h"
 * confidence story.
 */
export async function getDurationStats({
  productId,
  buyerPartyId,
  sampleSize = 100,
}: GetDurationStatsOptions = {}) {
  const filters: string[] = ["ServiceRequestLifeCycleStatusCode eq '4'"]; // Closed only
  if (productId?.trim()) filters.push(`ProductID eq ${odataStringLiteral(productId.trim())}`);
  if (buyerPartyId?.trim()) filters.push(`BuyerPartyID eq ${odataStringLiteral(buyerPartyId.trim())}`);

  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(sampleSize, 10), 500),
    "$filter": filters.join(" and "),
    "$orderby": "LastChangeDateTime desc",
    "$select":
      "ObjectID,ID,ProductID,BuyerPartyID,SerialID,RequestedTotalProcessingDuration,RequestInProcessdatetimeContent,RequestCloseddatetimeContent,RequestInitialReceiptdatetimecontent",
  };

  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  const actuals: number[] = [];
  const planneds: number[] = [];
  const paired: { actual: number; planned: number | null }[] = [];
  let plannedAndActual = 0;
  let actualOnly = 0;
  let neither = 0;

  for (const r of rows) {
    const startMs = parseTimestamp(r.RequestInProcessdatetimeContent);
    const endMs = parseTimestamp(r.RequestCloseddatetimeContent);
    const planned = parseIsoDuration(r.RequestedTotalProcessingDuration);
    const actual =
      startMs != null && endMs != null && endMs > startMs
        ? (endMs - startMs) / 3_600_000
        : null;
    if (actual != null) actuals.push(actual);
    if (planned != null) planneds.push(planned);
    if (actual != null && planned != null) {
      paired.push({ actual, planned });
      plannedAndActual++;
    } else if (actual != null) {
      actualOnly++;
    } else {
      neither++;
    }
  }

  const sortedActual = [...actuals].sort((a, b) => a - b);
  const sortedPlanned = [...planneds].sort((a, b) => a - b);

  const overshoot = paired
    .filter((p): p is { actual: number; planned: number } => p.planned != null && p.planned > 0)
    .map((p) => (p.actual - p.planned) / p.planned);
  const sortedOvershoot = [...overshoot].sort((a, b) => a - b);

  return {
    filter: {
      productId: productId ?? null,
      buyerPartyId: buyerPartyId ?? null,
      lifecycle: "Closed only",
    },
    sampled: rows.length,
    coverage: {
      withPlannedAndActual: plannedAndActual,
      withActualOnly: actualOnly,
      withNeither: neither,
    },
    actualHours: {
      p10: percentile(sortedActual, 10),
      median: percentile(sortedActual, 50),
      p90: percentile(sortedActual, 90),
      count: sortedActual.length,
    },
    plannedHours: {
      p10: percentile(sortedPlanned, 10),
      median: percentile(sortedPlanned, 50),
      p90: percentile(sortedPlanned, 90),
      count: sortedPlanned.length,
    },
    overshootRatio: {
      // (actual - planned) / planned. 0.5 = 50% over plan. -0.2 = 20% under.
      p10: percentile(sortedOvershoot, 10),
      median: percentile(sortedOvershoot, 50),
      p90: percentile(sortedOvershoot, 90),
      count: sortedOvershoot.length,
    },
  };
}

// ---------------------------------------------------------------------------
// ATTACH KB ARTICLE — first write tool.
//
// Posts a row to ServiceRequestSolutionProposalCollection linking a KB article
// to a ticket. Gated by:
//   1. dryRun: true (default) → returns the would-be payload without firing.
//   2. feature.auto_writeback_enabled (settings flag) → must be true to execute.
//
// Both gates must be open for an actual POST. The audit log records every
// call including dry-runs.
// ---------------------------------------------------------------------------

export type AttachKbArticleOptions = {
  objectId: string;          // parent ticket ObjectID
  articleId?: string;        // external KB article ID
  articleUri?: string;       // direct URL to the article
  description?: string;      // human-readable summary
  note?: string;             // free-text annotation
  dryRun?: boolean;          // default true
  /** Must be explicitly true when writing to a production-tagged tenant. */
  acknowledgeProduction?: boolean;
};

export async function attachKbArticle({
  objectId,
  articleId,
  articleUri,
  description,
  note,
  dryRun = true,
  acknowledgeProduction = false,
}: AttachKbArticleOptions) {
  const opts = { acknowledgeProduction };
  if (!objectId.trim()) throw new Error("objectId is required.");
  const aId = (articleId ?? "").trim();
  const aUri = (articleUri ?? "").trim();
  const desc = (description ?? "").trim();
  const noteText = (note ?? "").trim();
  if (!aId && !aUri && !desc && !noteText) {
    throw new Error("At least one of articleId, articleUri, description, or note must be provided.");
  }

  const payload: Record<string, string> = {
    ParentObjectID: objectId,
    ExternalKnowledgeBaseArticleID: aId,
    ExternalKnowledgeBaseArticleURI: aUri,
    ExternalKnowledgeBaseArticleDescription: desc,
    Note: noteText,
  };

  if (dryRun) {
    return {
      dryRun: true,
      wouldPost: {
        path: "/ServiceRequestSolutionProposalCollection",
        method: "POST",
        body: payload,
      },
      note:
        "Dry-run only. To actually write to SAP: set dryRun=false AND set " +
        "feature.auto_writeback_enabled=true in /settings.",
    };
  }

  // Role check — this function carries its own copy of the write gate rather
  // than going through runGatedWrite, so it needs its own copy of the check.
  const roleDenied = sapWriteDenial();
  if (roleDenied) {
    return {
      dryRun: false,
      blocked: true,
      reason: roleDenied,
      wouldPost: {
        path: "/ServiceRequestSolutionProposalCollection",
        method: "POST",
        body: payload,
      },
    };
  }

  // Production write guard — extra check beyond the feature flag.
  // Imported dynamically to avoid module-load-order issues.
  try {
    const { getActiveTenantEnvironment, getActiveTenantLabel } = await import("./c4cClient.js");
    const env = getActiveTenantEnvironment();
    if (env === "production") {
      // Look for an explicit override flag the caller can set to acknowledge.
      const acknowledged =
        (opts as { acknowledgeProduction?: boolean }).acknowledgeProduction === true;
      if (!acknowledged) {
        return {
          dryRun: false,
          blocked: true,
          reason:
            `Active tenant is tagged PRODUCTION (${getActiveTenantLabel() ?? "?"}). ` +
            `Write blocked. Call again with acknowledgeProduction=true to confirm.`,
          wouldPost: {
            path: "/ServiceRequestSolutionProposalCollection",
            method: "POST",
            body: payload,
          },
        };
      }
    }
  } catch {
    /* if the c4cClient import fails, fall through — feature flag still gates */
  }

  // Feature flag gate — second line of defence.
  let enabled = false;
  try {
    enabled = getSettingBoolean("feature.auto_writeback_enabled");
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return {
      dryRun: false,
      blocked: true,
      reason:
        "Write blocked: feature.auto_writeback_enabled is false. Flip it in /settings to allow real POSTs to SAP.",
      wouldPost: {
        path: "/ServiceRequestSolutionProposalCollection",
        method: "POST",
        body: payload,
      },
    };
  }

  const written: any = await c4cPost(
    "/ServiceRequestSolutionProposalCollection",
    payload,
  );
  return {
    dryRun: false,
    written: true,
    sap: written?.d ?? written,
  };
}

// ===========================================================================
// =====================  TIER 1 — ACTIVITY READS  ===========================
// ===========================================================================

export type SearchTasksOptions = {
  ownerPartyId?: string;
  accountPartyId?: string;
  status?: string; // status code 1=Open / 2=InProcess / 3=Completed / 4=Canceled
  top?: number;
};

export async function searchTasks({
  ownerPartyId,
  accountPartyId,
  status,
  top = 25,
}: SearchTasksOptions = {}) {
  const filters: string[] = [];
  if (ownerPartyId?.trim()) filters.push(`MainEmployeeResponsiblePartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  if (accountPartyId?.trim()) filters.push(`MainAccountPartyID eq ${odataStringLiteral(accountPartyId.trim())}`);
  if (status?.trim()) filters.push(`Status eq ${odataStringLiteral(status.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "DueDateTime desc",
    "$select":
      "ObjectID,ID,Subject,Status,StatusText,StartDateTime,DueDateTime,CompletionDateTime,MainEmployeeResponsiblePartyID,MainAccountPartyID,PlannedDuration,ActualDuration",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/TasksCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { ownerPartyId, accountPartyId, status }, total: rows.length, tasks: rows };
}

export type SearchPhoneCallsOptions = {
  ownerPartyId?: string;
  accountPartyId?: string;
  top?: number;
};

export async function searchPhoneCalls({
  ownerPartyId,
  accountPartyId,
  top = 25,
}: SearchPhoneCallsOptions = {}) {
  const filters: string[] = [];
  if (ownerPartyId?.trim()) filters.push(`OwnerPartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  if (accountPartyId?.trim()) filters.push(`MainAccountPartyID eq ${odataStringLiteral(accountPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "StartDateTime desc",
    "$select":
      "ObjectID,ID,Subject,Status,StatusText,StartDateTime,EndDateTime,InitiatorCode,InitiatorCodeText,OwnerPartyID,MainAccountPartyID,MainContactPartyID",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/PhoneCallCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { ownerPartyId, accountPartyId }, total: rows.length, calls: rows };
}

export type SearchEmailsOptions = {
  ownerPartyId?: string;
  accountPartyId?: string;
  top?: number;
  /**
   * When true, fetches each email's body / payload via a follow-up call
   * to the EMailItem child collection (SAP exposes the body separately
   * from the activity header — `$expand=EmailItem` works on most tenants
   * but a few require an explicit child-collection fetch). Adds N more
   * round-trips, so use sparingly (e.g. only for the few emails we're
   * about to summarise). Default false (header-only is much faster).
   */
  includeBody?: boolean;
};

export async function searchEmails({
  ownerPartyId,
  accountPartyId,
  top = 25,
  includeBody = false,
}: SearchEmailsOptions = {}) {
  const filters: string[] = [];
  if (ownerPartyId?.trim()) filters.push(`OwnerPartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  if (accountPartyId?.trim()) filters.push(`MainAccountPartyID eq ${odataStringLiteral(accountPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "DateTime desc",
    "$select":
      "ObjectID,ID,Subject,Status,StatusText,Category,CategoryText,DateTime,TransmissionStatusCode,TransmissionStatusCodeText,OwnerPartyID,MainAccountPartyID,MainContactPartyID,PriorityCodeText",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/EMailCollection", query);
  const rows: any[] = result?.d?.results ?? [];

  // Optionally pull body text for each email via the EMailItem child
  // collection. Bounded by `top` (already capped at 100) — and we run
  // them in parallel for latency. Body is typically in `TextContent`
  // (plain) or `HtmlContent` (HTML). Different tenants expose different
  // fields; we capture the body that's actually present.
  if (includeBody && rows.length > 0) {
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const objectId = row?.ObjectID;
        if (!objectId) return row;
        try {
          // EMailCollection('OBJ_ID')/EmailItem returns the email body
          // child entity (some tenants name it differently — fall back
          // to /EMailItemTextCollection by ParentObjectID if needed).
          const itemResult: any = await c4cGet(
            `/EMailCollection('${String(objectId).replace(/'/g, "''")}')`,
            { "$format": "json", "$expand": "EmailItem" },
          );
          const node = itemResult?.d ?? itemResult;
          const item = node?.EmailItem?.results?.[0] ?? node?.EmailItem ?? null;
          const textBody = item?.TextContent ?? item?.Text ?? "";
          const htmlBody = item?.HtmlContent ?? item?.HTML ?? "";
          return {
            ...row,
            BodyText: textBody || "",
            BodyHtml: htmlBody || "",
            BodyPreview: String(textBody || htmlBody || "")
              .replace(/<[^>]+>/g, " ") // strip tags if HTML
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 600),
          };
        } catch (err) {
          // Body fetch failed — keep the metadata row, just no body.
          return row;
        }
      }),
    );
    return { filter: { ownerPartyId, accountPartyId }, total: enriched.length, emails: enriched };
  }

  return { filter: { ownerPartyId, accountPartyId }, total: rows.length, emails: rows };
}

export type SearchChatsOptions = {
  accountPartyId?: string;
  top?: number;
};

export async function searchChats({ accountPartyId, top = 25 }: SearchChatsOptions = {}) {
  const filters: string[] = [];
  if (accountPartyId?.trim()) filters.push(`MainAccountPartyID eq ${odataStringLiteral(accountPartyId.trim())}`);
  // ChatActivityCollection's $orderby targets are unpredictable; let SAP default.
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/ChatActivityCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { accountPartyId }, total: rows.length, chats: rows };
}

/**
 * Unified communication stream for an account — merges tasks + phone calls
 * + emails + chats into a single time-ordered timeline. Useful for "what
 * have we discussed with this customer recently" questions.
 */
export type GetCommunicationStreamOptions = {
  accountPartyId: string;
  topPerType?: number;
};

export async function getCommunicationStream({
  accountPartyId,
  topPerType = 10,
}: GetCommunicationStreamOptions) {
  if (!accountPartyId.trim()) throw new Error("accountPartyId is required.");
  const [tasks, phones, emails, chats] = await Promise.all([
    searchTasks({ accountPartyId, top: topPerType }).catch(() => ({ tasks: [] as any[] })),
    searchPhoneCalls({ accountPartyId, top: topPerType }).catch(() => ({ calls: [] as any[] })),
    searchEmails({ accountPartyId, top: topPerType }).catch(() => ({ emails: [] as any[] })),
    searchChats({ accountPartyId, top: topPerType }).catch(() => ({ chats: [] as any[] })),
  ]);
  const events: Array<{ kind: string; at: number | null; subject: string; status?: string; raw: any }> = [];
  const toMs = (s: any): number | null => {
    const v = String(s ?? "");
    const m = /\/Date\((-?\d+)\)\//.exec(v);
    if (m) return Number(m[1]);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  for (const t of (tasks as any).tasks ?? []) {
    events.push({
      kind: "task",
      at: toMs(t.DueDateTime ?? t.StartDateTime),
      subject: String(t.Subject ?? "(task)"),
      status: t.StatusText,
      raw: t,
    });
  }
  for (const c of (phones as any).calls ?? []) {
    events.push({
      kind: c.InitiatorCodeText?.toLowerCase().includes("inbound") ? "phone-in" : "phone-out",
      at: toMs(c.StartDateTime),
      subject: String(c.Subject ?? "(phone)"),
      status: c.StatusText,
      raw: c,
    });
  }
  for (const e of (emails as any).emails ?? []) {
    events.push({
      kind: "email",
      at: toMs(e.DateTime),
      subject: String(e.Subject ?? "(email)"),
      status: e.StatusText,
      raw: e,
    });
  }
  for (const ch of (chats as any).chats ?? []) {
    events.push({
      kind: "chat",
      at: toMs(ch.LastChangeDateTime ?? ch.StartDateTime),
      subject: String(ch.Subject ?? "(chat)"),
      raw: ch,
    });
  }
  events.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return {
    accountPartyId,
    total: events.length,
    counts: {
      tasks: (tasks as any).tasks?.length ?? 0,
      phones: (phones as any).calls?.length ?? 0,
      emails: (emails as any).emails?.length ?? 0,
      chats: (chats as any).chats?.length ?? 0,
    },
    events,
  };
}

// ===========================================================================
// =====================  TIER 1 — CONTRACTS / SLA  ==========================
// ===========================================================================

export type GetContractOptions = { objectId: string };
export async function getContract({ objectId }: GetContractOptions) {
  if (!objectId.trim()) throw new Error("objectId is required.");
  const result: any = await c4cGet(`/ContractCollection(${odataStringLiteral(objectId)})`, {
    "$format": "json",
  });
  return { objectId, contract: result?.d?.results ?? result?.d };
}

export type GetContractsForAccountOptions = { buyerPartyId: string; top?: number };
export async function getContractsForAccount({ buyerPartyId, top = 25 }: GetContractsForAccountOptions) {
  if (!buyerPartyId.trim()) throw new Error("buyerPartyId is required.");
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$filter": `BuyerID eq ${odataStringLiteral(buyerPartyId)}`,
    "$orderby": "ValidityEndDate desc",
    "$select":
      "ObjectID,ID,Name,BuyerID,ProcessingTypeCodeText,MainBusinessProcessVariantTypeCodeText,ValidityStartDate,ValidityEndDate,CreationDateTime,LastChangeDateTime",
  };
  const result: any = await c4cGet("/ContractCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const now = Date.now();
  let active = 0;
  let expired = 0;
  for (const r of rows) {
    const endMs = (() => {
      const m = /\/Date\((-?\d+)\)\//.exec(String(r.ValidityEndDate ?? ""));
      return m ? Number(m[1]) : null;
    })();
    if (endMs == null) continue;
    if (endMs >= now) active++;
    else expired++;
  }
  return { buyerPartyId, total: rows.length, active, expired, contracts: rows };
}

export type GetContractItemsOptions = { contractObjectId: string; top?: number };
export async function getContractItems({ contractObjectId, top = 50 }: GetContractItemsOptions) {
  if (!contractObjectId.trim()) throw new Error("contractObjectId is required.");
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 200),
  };
  const result: any = await c4cGet(
    `/ContractCollection(${odataStringLiteral(contractObjectId)})/ContractItem`,
    query,
  );
  const rows: any[] = result?.d?.results ?? [];
  return { contractObjectId, total: rows.length, items: rows };
}

// ===========================================================================
// =====================  TIER 1 — SALES / ORDERS  ===========================
// ===========================================================================

export type SearchSalesQuotesOptions = {
  buyerPartyId?: string;
  ownerPartyId?: string;
  top?: number;
};

export async function searchSalesQuotes({
  buyerPartyId,
  ownerPartyId,
  top = 25,
}: SearchSalesQuotesOptions = {}) {
  const filters: string[] = [];
  if (buyerPartyId?.trim()) filters.push(`BuyerPartyID eq ${odataStringLiteral(buyerPartyId.trim())}`);
  if (ownerPartyId?.trim()) filters.push(`EmployeeResponsiblePartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "LastChangeDateTime desc",
    "$select":
      "ObjectID,ID,Name,ProcessingTypeCodeText,BuyerPartyID,BuyerPartyName,BuyerContactPartyName,EmployeeResponsiblePartyID,EmployeeResponsiblePartyName,SalesUnitPartyName,LastChangeDateTime",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/SalesQuoteCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { buyerPartyId, ownerPartyId }, total: rows.length, quotes: rows };
}

export type SearchCustomerOrdersOptions = {
  buyerPartyId?: string;
  top?: number;
};

export async function searchCustomerOrders({
  buyerPartyId,
  top = 25,
}: SearchCustomerOrdersOptions = {}) {
  const filters: string[] = [];
  if (buyerPartyId?.trim()) filters.push(`BuyerID eq ${odataStringLiteral(buyerPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "LastChangeDate desc",
    "$select":
      "ObjectID,ID,Name,BuyerID,ProcessingTypeCodeText,InformationLifeCycleStatusCodeText,OrderExternalLifeCycleStatusCodeText,LastChangeDate",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/CustomerOrderCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { buyerPartyId }, total: rows.length, orders: rows };
}

export type SearchOpportunitiesOptions = {
  buyerPartyId?: string;
  ownerPartyId?: string;
  top?: number;
};

export async function searchOpportunities({
  buyerPartyId,
  ownerPartyId,
  top = 25,
}: SearchOpportunitiesOptions = {}) {
  const filters: string[] = [];
  if (buyerPartyId?.trim()) filters.push(`ProspectPartyID eq ${odataStringLiteral(buyerPartyId.trim())}`);
  if (ownerPartyId?.trim()) filters.push(`OwnerPartyID eq ${odataStringLiteral(ownerPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/OpportunityCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { buyerPartyId, ownerPartyId }, total: rows.length, opportunities: rows };
}

// ===========================================================================
// =====================  TIER 1 — ORG / SURVEYS  ============================
// ===========================================================================

export type SearchOrgUnitsOptions = { query?: string; top?: number };
export async function searchOrgUnits({ query, top = 50 }: SearchOrgUnitsOptions = {}) {
  const filters: string[] = [];
  if (query?.trim()) filters.push(`substringof(${odataStringLiteral(query.trim())},OrganisationalUnitID)`);
  const odata: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$select": "ObjectID,OrganisationalUnitID,LifeCycleStatusCode,StartDate,EndDate",
  };
  if (filters.length) odata["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/OrganisationalUnitCollection", odata);
  const rows: any[] = result?.d?.results ?? [];
  return { query: query ?? null, total: rows.length, orgUnits: rows };
}

export type GetTeamRosterOptions = { orgUnitId: string; top?: number };
export async function getTeamRoster({ orgUnitId, top = 100 }: GetTeamRosterOptions) {
  if (!orgUnitId.trim()) throw new Error("orgUnitId is required.");
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 200),
    "$filter": `OrganisationalUnitID eq ${odataStringLiteral(orgUnitId)}`,
  };
  const result: any = await c4cGet("/EmployeeOrganisationalUnitAssignmentCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { orgUnitId, total: rows.length, members: rows };
}

export type GetSurveyResponsesOptions = { ticketObjectId?: string; top?: number };
export async function getSurveyResponses({ ticketObjectId, top = 25 }: GetSurveyResponsesOptions = {}) {
  const filters: string[] = [];
  if (ticketObjectId?.trim()) {
    // Surveys reference the ticket via BusinessTransactionDocumentUUID (32-char hex)
    filters.push(`BusinessTransactionDocumentUUID eq guid'${ticketObjectId.trim()}'`);
  }
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "EntityLastChangedOn desc",
    "$select":
      "ObjectID,ID,Version,BusinessTransactionDocumentID,BusinessTransactionDocumentTypeCodeText,ProcessorID,LifeCycleStatusCodeText,EntityLastChangedOn,ValuationCollectionLastChangedBy",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/SurveyResponseCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { filter: { ticketObjectId }, total: rows.length, responses: rows };
}

export async function getIssueCategoryTree({ top = 50 }: { top?: number } = {}) {
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(top, 1), 100),
    "$orderby": "EntityLastChangedOn desc",
  };
  const result: any = await c4cGet("/ServiceCategoryCatalogueCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  return { total: rows.length, catalogues: rows };
}

// ===========================================================================
// ====================  TIER 2 — WRITE TOOLS  ===============================
// ===========================================================================
//
// All write tools use `runGatedWrite` so dryRun + feature flag + production
// acknowledgment gates apply uniformly. The MCP / HTTP-shim layer passes
// `dryRun` and `acknowledgeProduction` through unchanged.
// ===========================================================================

export type UpdateTicketDescriptionOptions = WriteGateOpts & {
  objectId: string;
  description: string;
};

export async function updateTicketDescription(opts: UpdateTicketDescriptionOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.description.trim()) throw new Error("description is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { Description: opts.description };
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type UpdateTicketPriorityOptions = WriteGateOpts & {
  objectId: string;
  /** Code: 1=Immediate, 2=Urgent, 3=Normal, 7=Low */
  servicePriorityCode: string;
};

export async function updateTicketPriority(opts: UpdateTicketPriorityOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.servicePriorityCode.trim()) throw new Error("servicePriorityCode is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { ServicePriorityCode: opts.servicePriorityCode };
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type UpdateTicketLifecycleOptions = WriteGateOpts & {
  objectId: string;
  /** 1=Open, 2=InProcess, 3=Completed, 4=Closed */
  lifecycleStatusCode: string;
};

export async function updateTicketLifecycle(opts: UpdateTicketLifecycleOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.lifecycleStatusCode.trim()) throw new Error("lifecycleStatusCode is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { ServiceRequestLifeCycleStatusCode: opts.lifecycleStatusCode };
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type EscalateTicketOptions = WriteGateOpts & {
  objectId: string;
  reason?: string;
};

export async function escalateTicket(opts: EscalateTicketOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { EscalationStatusCode: "2" }; // 2 = Escalated
  // Optionally also append an audit note when reason is provided. For simplicity
  // we only update the escalation code here; the AssistantPanel's "draft an
  // escalation" intent can call add_service_request_text alongside.
  return runGatedWrite(opts, { method: "PATCH", path, body: { ...body, _reason: opts.reason ?? null } }, async () => {
    const out = await c4cPatch(path, body);
    return { escalated: true, reason: opts.reason ?? null, sap: out };
  });
}

export type AssignProcessorOptions = WriteGateOpts & {
  objectId: string;
  processorPartyUuid: string;
};

export async function assignProcessor(opts: AssignProcessorOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.processorPartyUuid.trim()) throw new Error("processorPartyUuid is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { ProcessorPartyUUID: { __metadata: { type: "Edm.Guid" }, value: opts.processorPartyUuid } };
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type AssignTeamOptions = WriteGateOpts & {
  objectId: string;
  teamPartyId: string;
};

export async function assignTeam(opts: AssignTeamOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.teamPartyId.trim()) throw new Error("teamPartyId is required.");
  const path = serviceRequestPath(opts.objectId);
  const body = { ServiceExecutionTeamPartyID: opts.teamPartyId };
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type AddServiceRequestTextOptions = WriteGateOpts & {
  objectId: string;
  text: string;
  /** Type code: 10004=Case Description, 10022=Service Response Report, etc. Default 10022. */
  typeCode?: string;
};

export async function addServiceRequestText(opts: AddServiceRequestTextOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.text.trim()) throw new Error("text is required.");
  // v0.27.40 — TENANT QUIRK (Thermo Fisher my340573): the flat
  // /ServiceRequestTextCollection entity set is NOT exposed at the
  // service root — POST returns 404 "Resource not found for the
  // segment". Texts are only reachable through the navigation property
  // on the parent Service Request (the read path in getTicketNotes has
  // always known this). This is the MIRROR of the line-item quirk in
  // docs/engineering-notes.md, where the NAV path 404s and only the flat path works.
  // Strategy: try flat first (works on tenants that expose it), fall
  // back to the navigation POST on segment-not-found. The nav body
  // MUST still carry ParentObjectID — first live test confirmed SAP
  // rejects the nav POST with HTTP 500 "ParentObjectID is not provided
  // for Service Request Notes" when it's omitted.
  const flatPath = "/ServiceRequestTextCollection";
  const navPath = `${serviceRequestPath(opts.objectId)}/ServiceRequestTextCollection`;
  const body = {
    ParentObjectID: opts.objectId,
    TypeCode: opts.typeCode ?? "10022",
    Text: opts.text,
  };
  const typeCode = body.TypeCode;
  return runGatedWrite(opts, { method: "POST", path: flatPath, body }, async () => {
    const postOnce = async () => {
      try {
        return await c4cPost(flatPath, body);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!/Resource not found for the segment/i.test(msg)) throw e;
        console.warn(
          "[add_service_request_text] flat collection not exposed on this tenant — retrying via navigation path",
          navPath,
        );
        return await c4cPost(navPath, body);
      }
    };
    try {
      return await postOnce();
    } catch (e: any) {
      // SAP edit-lock collision (same class as the order-parts lock in
      // docs/engineering-notes.md). Heals transient locks; a ticket held open in Edit
      // mode by an operator will still fail after the retry — the
      // extension surfaces an actionable hint for that case.
      const msg = String(e?.message ?? e);
      if (/Locking object not possible|object locked by/i.test(msg)) {
        console.warn("[add_service_request_text] parent ticket locked — retrying once in 1500ms");
        await new Promise((r) => setTimeout(r, 1500));
        try {
          return await postOnce();
        } catch (e2: any) {
          const appended = await appendToExistingText(opts.objectId, typeCode, opts.text);
          if (appended) return appended;
          throw e2;
        }
      }
      // v0.27.81 — single-instance text-type recovery. Some text types allow
      // only ONE row per ticket (e.g. TypeCode 10022 "Service Response
      // Reports" on my340573). A second create 500s with
      // "Text of type Service Response Reports already ...". Rather than fail,
      // APPEND our text to the EXISTING row of that type (operator-approved:
      // "if the text type exists, can you append?"). The existence of a
      // same-type row IS the collision signature, so we don't depend on
      // SAP's exact (localized/truncated) wording. If no such row exists,
      // this was some other failure — rethrow the original error.
      const appended = await appendToExistingText(opts.objectId, typeCode, opts.text);
      if (appended) return appended;
      throw e;
    }
  });
}

/**
 * v0.27.81 — recovery helper for single-instance text types. Finds an
 * existing ServiceRequestText row of `typeCode` on the ticket and PATCHes it
 * to append `text` (with a separator when the row already has content). The
 * individual text row is addressed via the `ServiceRequestTextCollectionCollection`
 * entity set (note the doubled "Collection" — that's what the row's own
 * __metadata.uri uses on this tenant; the singular `ServiceRequestTextCollection`
 * is nav-only and 404s for by-key access).
 *
 * Returns the PATCH result (annotated) on success, or null when there's no
 * existing row to append to (so the caller rethrows the original create error).
 */
async function appendToExistingText(
  objectId: string,
  typeCode: string,
  text: string,
): Promise<any | null> {
  try {
    const listPath = `${serviceRequestPath(objectId)}/ServiceRequestTextCollection`;
    const res: any = await c4cGet(listPath, {
      "$filter": `TypeCode eq ${odataStringLiteral(typeCode)}`,
      "$select": "ObjectID,Text",
      "$top": "2",
      "$format": "json",
    });
    const rows: any[] = res?.d?.results ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return null; // not a single-instance collision
    const existing = rows[0];
    const oid = String(existing?.ObjectID ?? "");
    if (!oid) return null;
    const prior = String(existing?.Text ?? "");
    const combined = prior.trim() ? `${prior}\n\n---\n\n${text}` : text;
    const patchPath = `/ServiceRequestTextCollectionCollection(${odataStringLiteral(oid)})`;
    console.warn(
      `[add_service_request_text] text type ${typeCode} is single-instance — appending to existing row ${oid}`,
    );
    const patchResult = await c4cPatch(patchPath, { Text: combined });
    return {
      ...(patchResult && typeof patchResult === "object" ? patchResult : {}),
      _appendedToExistingText: true,
      _existingTextObjectId: oid,
      _textTypeCode: typeCode,
    };
  } catch (appendErr) {
    console.warn("[add_service_request_text] append-to-existing recovery failed:", appendErr);
    return null; // let the caller rethrow the original create error
  }
}

export type AttachSolutionToTicketOptions = WriteGateOpts & {
  objectId: string;
  /** External KB article id, e.g. "MAN0010249". */
  articleId?: string;
  /** External KB article URL (MindTouch page). */
  articleUri?: string;
  /** Article title — shows in the Solutions Used facet. */
  articleDescription?: string;
  /** Free text — maps to the facet's "Content" column. */
  note?: string;
};

/**
 * v0.27.40 — attach an external KB article to a ticket's "Solutions
 * Used" facet (Solution Center tab in the C4C UI).
 *
 * Backed by ServiceRequestSolutionProposalCollection, which carries
 * dedicated ExternalKnowledgeBaseArticle* fields for non-SAP knowledge
 * bases — exactly the MindTouch case on this tenant. Field shape
 * confirmed by probing existing tenant rows via /api/debug/query:
 *   ParentObjectID · ExternalKnowledgeBaseArticleID ·
 *   ExternalKnowledgeBaseArticleURI · ExternalKnowledgeBaseArticleDescription
 *   (+LanguageCode) · Note (+NoteLanguageCode) · ServiceRequestID (derived)
 *
 * Length caps are conservative guesses (SAP rejects over-length with a
 * clear error, so caps only need to avoid the obvious). Language codes
 * are sent as "EN" alongside their text fields; if a tenant rejects
 * them as create-not-allowed, the self-healing retry strips and
 * re-POSTs once (same pattern as log_service_item v0.26.81).
 */
export async function attachSolutionToTicket(opts: AttachSolutionToTicketOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  const articleId = (opts.articleId ?? "").trim();
  const articleUri = (opts.articleUri ?? "").trim();
  const articleDescription = (opts.articleDescription ?? "").trim();
  const note = (opts.note ?? "").trim();
  if (!articleUri && !articleDescription && !note) {
    throw new Error("At least one of articleUri / articleDescription / note is required.");
  }

  const path = "/ServiceRequestSolutionProposalCollection";
  const body: Record<string, string> = { ParentObjectID: opts.objectId };
  if (articleId) body.ExternalKnowledgeBaseArticleID = articleId.slice(0, 40);
  if (articleUri) body.ExternalKnowledgeBaseArticleURI = articleUri.slice(0, 1000);
  if (articleDescription) {
    body.ExternalKnowledgeBaseArticleDescription = articleDescription.slice(0, 255);
    body.ExternalKnowledgeBaseArticleDescriptionLanguageCode = "EN";
  }
  if (note) {
    body.Note = note.slice(0, 2000);
    body.NoteLanguageCode = "EN";
  }

  // Same parse-strip-retry as log_service_item for SAP's
  // "Create not allowed for properties: X, Y" annotation errors.
  const stripCreateNotAllowed = (errMsg: string, currentBody: Record<string, string>): Record<string, string> | null => {
    const m = errMsg.match(/Create not allowed for propert(?:y|ies):\s*([^.]+?)(?:\.|$)/i);
    if (!m) return null;
    const fields = m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const stripped = { ...currentBody };
    let removed = 0;
    for (const f of fields) {
      if (f in stripped) {
        delete stripped[f];
        removed++;
      }
    }
    if (removed === 0) return null;
    console.warn(
      `[attach_solution] SAP rejected ${removed} create-not-allowed field(s); retrying without:`,
      fields.join(", "),
    );
    return stripped;
  };

  // v0.27.40 — same flat→navigation fallback as addServiceRequestText.
  // The flat collection answers GET on this tenant, but POST exposure
  // can differ (texts: flat 404s, nav works; line items: the exact
  // opposite). ParentObjectID STAYS in the nav body — the texts nav
  // POST proved SAP wants it even when the URL implies the parent
  // (HTTP 500 "ParentObjectID is not provided" without it). If a
  // tenant rejects it as create-not-allowed, strip-retry removes it.
  const navPath = `${serviceRequestPath(opts.objectId)}/ServiceRequestSolutionProposal`;
  return runGatedWrite(opts, { method: "POST", path, body }, async () => {
    let currentPath = path;
    let currentBody: Record<string, string> = body;
    let navFallbackUsed = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await c4cPost(currentPath, currentBody);
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        if (!navFallbackUsed && /Resource not found for the segment/i.test(msg)) {
          navFallbackUsed = true;
          currentPath = navPath;
          console.warn(
            "[attach_solution] flat collection POST rejected — retrying via navigation path",
            navPath,
          );
          continue;
        }
        // SAP edit-lock collision — wait out a transient lock once.
        if (attempt < 2 && /Locking object not possible|object locked by/i.test(msg)) {
          console.warn("[attach_solution] parent ticket locked — retrying in 1500ms");
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const stripped = stripCreateNotAllowed(msg, currentBody);
        if (!stripped) throw e;
        currentBody = stripped;
      }
    }
    throw lastErr;
  });
}

export type LogServiceItemOptions = WriteGateOpts & {
  objectId: string;
  /**
   * Processing type. Standard codes: SRP1=Part Consumption,
   * ZALT=Labor/Travel, SRP0=Billing. Tenants frequently introduce
   * custom Z-prefix codes (e.g., ZRP1 for Parts) — accept any
   * tenant-defined code as a string. SAP itself enforces validity.
   */
  processingTypeCode: string;
  productId: string;
  quantity: number;
  /** UoM code: EA, HUR, etc. */
  uomCode?: string;
  warrantyCode?: string;
  servicePerformerPartyId?: string;
  /**
   * v0.27.42 — send PlannedQuantity = ActualQuantity = qty (the SRP1
   * consumption shape on this tenant) instead of the ZRP3 ordering
   * convention Planned=0/Actual=qty. Set by the explicit "Retry as
   * <code>" flow only.
   */
  plannedEqualsActual?: boolean;
  /**
   * v0.27.72 — Book Time: the work's start (and optional end) instant, as
   * epoch milliseconds (string or number). The booked time belongs in
   * ActualStartDateTime / ActualEndDateTime (the columns the operator reads
   * in the Time tab) — NOT Requested* (user: "It must go to Actual start and
   * Actual End not Requested"). But SAP forbids Actual* on CREATE ("Create
   * not allowed for properties"; they're in buildBodyFromProbe's SKIP_EXACT),
   * so logServiceItem creates the line first, then PATCHes the created item's
   * ActualStart/EndDateTime (the same write updateServiceItemActuals does).
   * End is derived from start + quantity-hours when actualEndMs is absent or
   * not after start.
   */
  actualStartMs?: string | number;
  actualEndMs?: string | number;
  /**
   * v0.27.69 — set the Requested schedule fields on create (mirrored from the
   * probe, overridable). Superseded for Book Time by actualStartMs/actualEndMs
   * in v0.27.72 — kept for any other caller that wants Requested* set.
   */
  requestedStartMs?: string | number;
  requestedEndMs?: string | number;
};

/**
 * v0.26.69 — probe ONE existing line item on the same ticket and dump
 * its field shape. Helps identify field-naming mismatches and missing
 * required-field combinations without trial-and-error. Returns the raw
 * entity or null if no existing items.
 */
async function probeExistingServiceItem(parentObjectId: string): Promise<Record<string, unknown> | null> {
  // v0.26.85 — probe specifically a PARTS-shaped line item (SRP1/ZRP1
  // or ZRP3). Previously we took the most-recent line item, which on
  // many tickets is travel/labor (ACTRVL/ACTLAB) — those have different
  // field shapes (UoM "HUR", warranty codes, etc.) that don't transfer
  // to a parts POST. SAP rejected with errors like:
  //   "Property 'QuantityMeasureUnitCode' at offset 'N' is invalid"
  // because we mirrored "Each" (a labor row's UoM display text) onto
  // a parts entry. The fix is to find a real parts line item to mirror.
  //
  // Strategy: query the top 20 line items, then pick the first one
  // whose UserServiceTransactionProcessingTypeCode is in the parts set
  // (ZRP3 / ZRP1 / SRP1). Fall back to the most-recent row if none
  // match (rare — typical tickets have at least one parts entry).
  const PART_PROC_TYPES = new Set(["ZRP3", "ZRP1", "SRP1"]);
  try {
    const result: any = await c4cGet("/ServiceRequestItemCollection", {
      "$format": "json",
      "$top": 20,
      "$orderby": "ID desc",
      "$filter": `ParentObjectID eq ${odataStringLiteral(parentObjectId)}`,
    });
    const rows: any[] = result?.d?.results ?? [];
    if (rows.length === 0) return null;
    // Prefer a parts-shaped row.
    const partsRow = rows.find((r) => {
      const code = String(r?.UserServiceTransactionProcessingTypeCode || "").trim().toUpperCase();
      return PART_PROC_TYPES.has(code);
    });
    if (partsRow) {
      console.log(
        `[log_service_item] PROBE — selected parts-shaped row (processingType=${partsRow.UserServiceTransactionProcessingTypeCode}) out of ${rows.length} candidates`,
      );
      return partsRow;
    }
    console.warn(
      `[log_service_item] PROBE — no parts-shaped row found among ${rows.length} line items; falling back to most-recent (processingType=${rows[0]?.UserServiceTransactionProcessingTypeCode})`,
    );
    return rows[0];
  } catch (e: any) {
    console.warn("[log_service_item] PROBE failed:", e?.message ?? e);
    return null;
  }
}

/**
 * v0.26.70 — build a POST body by MIRRORING an existing line item's
 * field shape. The existing item is proof that SAP accepts that schema
 * on this tenant, so the new item will too — modulo overriding the
 * fields whose values we control (ProductID, ParentObjectID, quantities,
 * UoM). All other fields are carried through as-is.
 *
 * What's excluded:
 *   - Generated identity fields: ObjectID, ID, ETag, ChangeStateID
 *   - Audit fields: CreationDateTime, CreatedBy, LastChangeDateTime, etc.
 *   - Navigation properties (anything with __deferred or __metadata)
 *   - SAP-derived: ItemNumber, LineNumber (auto-assigned)
 *
 * What's overridden (using our values):
 *   - ParentObjectID    → our ticket
 *   - ProductID         → our product
 *   - Quantity fields   → our quantity (covers Quantity / PlannedQuantity
 *                         / ActualQuantity — whichever exists on probe)
 *   - QuantityMeasureUnitCode / QuantityUnitCode / QuantityTypeCode →
 *                         our UoM (whichever exists on probe)
 *   - Processing-type field (whichever naming the tenant uses) → our
 *                         processingTypeCode if the operator explicitly
 *                         set one; otherwise KEEP the probe's value
 *                         (mirror exactly what worked before)
 *
 * Field-name mapping rationale: SAP C4C V1 vs V2 vs custom tenants vary
 * on whether quantity is `Quantity` / `PlannedQuantity+ActualQuantity` /
 * `QuantityValue`, and processing-type is `ProcessingTypeCode` /
 * `UserServiceTransactionProcessingTypeCode` / `ItemListProcessingTypeCode`.
 * By using the probe's actual field names we side-step all of that.
 */
function buildBodyFromProbe(
  probe: Record<string, any>,
  opts: LogServiceItemOptions,
): Record<string, any> {
  // v0.26.74 — switched from narrow allowlist to WIDE mirror with smart
  // exclusions. The previous v0.26.73 stripped too much — fields like
  // RequestedStartDateTime / RequestedEndDateTime / DescriptionLanguageCode
  // / empty KUT_OrderReason_KUT were dropped, but SAP's message-type
  // classifier may require them to be PRESENT (even if empty/null) to
  // identify the document type. We now mirror nearly the whole probe
  // except for explicitly-derived / SAP-managed fields, and keep
  // null/empty values intact so the schema is structurally complete.
  //
  // Categorical exclusions:
  //   - Identity / audit:     __metadata, ObjectID, ID, ETag, ChangeStateID,
  //                           EntityLastChangedOn, Creation*/LastChange*
  //   - Derived from ProductID:    ProductDescription, ProductUUID,
  //                                ProductIDExternalKey
  //   - Derived from ParentObjectID: ServiceRequestID
  //   - Derived from ServicePerformerPartyID: ServicePerformerPartyName,
  //                                           ServicePerformerPartyUUID
  //   - Any *Text suffix (derived text resolutions)
  //   - Any *UUID suffix (derived from corresponding ID)
  //   - SAP-managed lifecycle / status:
  //       ServiceRequestExecutionLifeCycleStatusCode(Text)
  //       ExternalFollowUpProcessingReleaseStatusCode(Text)
  //   - OData navigation refs (__deferred objects, arrays)
  const SKIP_EXACT = new Set([
    "__metadata",
    "ObjectID",
    "ID",
    "ETag",
    "ChangeStateID",
    "EntityLastChangedOn",
    "CreationDateTime",
    "CreatedBy",
    "CreatedByID",
    "LastChangeDateTime",
    "LastChangedBy",
    "LastChangedByID",
    "LastChangedDateTime",
    "ItemNumber",
    "LineNumber",
    "ServiceRequestID",       // derived from ParentObjectID
    "ProductDescription",     // derived from ProductID
    "ProductIDExternalKey",   // derived from ProductID
    "ProductUUID",            // derived from ProductID
    "ServicePerformerPartyName", // derived from ServicePerformerPartyID
    "ServicePerformerPartyUUID", // derived
    // v0.26.81 — SAP returned `CX_ODATA_ANNOTATION_ERROR: Create not
    // allowed for properties: PlannedStartDateTime, PlannedEndDateTime`.
    // These are SAP-managed (computed from parent ticket's schedule).
    // Same shape for ActualStart/End — Actual* is set during execution
    // by SAP's workflow, never on create.
    "PlannedStartDateTime",
    "PlannedEndDateTime",
    "ActualStartDateTime",
    "ActualEndDateTime",
    // v0.26.85 — Description should be DERIVED by SAP from ProductID.
    // Mirroring the probe's Description hardcodes the OLD product's
    // description text (or worse, a labor row's "ACTRVL - ACTUAL TRAVEL
    // HOURS" string) onto the new parts entry. Drop it; let SAP look
    // up the right text from the ProductID we're setting.
    "Description",
    "DescriptionLanguageCode",
  ]);
  const body: Record<string, any> = {};
  for (const [k, v] of Object.entries(probe)) {
    if (SKIP_EXACT.has(k)) continue;
    if (/Text$/.test(k)) continue;           // *Text — derived resolutions
    if (/UUID$/.test(k)) continue;            // *UUID — derived
    if (/LifeCycleStatusCode$/.test(k)) continue;
    if (/ReleaseStatusCode$/.test(k)) continue;
    // Skip OData navigation pointers + expanded arrays
    if (v && typeof v === "object" && ("__deferred" in v || "__metadata" in v)) continue;
    if (Array.isArray(v)) continue;
    // KEEP null + empty string — SAP may require the field to be
    // present in the body even with no value, to classify the
    // document type correctly.
    body[k] = v;
  }
  // Core overrides — values we explicitly control.
  body.ParentObjectID = opts.objectId;
  body.ProductID = opts.productId;
  body.UserServiceTransactionProcessingTypeCode = opts.processingTypeCode;
  // v0.26.94 — per reporter: "for ZRP3 we are using Actual Quantity to
  // order parts then there is other processing type for consumption.
  // Can you simply add the quantities to Actual rather than planned."
  //
  // The operator-entered quantity goes into ActualQuantity ONLY.
  // PlannedQuantity is set to 0 so SAP's ATP-lifecycle rule (which
  // zeros Actual when Planned > Actual) doesn't trip — Planned=0,
  // Actual=N is internally consistent for this tenant's workflow:
  //   ZRP3 (Parts Ordering)   → ActualQuantity holds the order amount
  //   SRP1/ZRP1 (Consumption) → handled separately by other code paths
  //
  // Previous attempts (v0.26.90 mirroring both Planned=Actual, v0.26.93
  // adding a post-POST PATCH) didn't survive SAP's server-side
  // overrides. This is the user-specified shape; trust their workflow.
  const qtyNum = Number(opts.quantity);
  // v0.27.42 — plannedEqualsActual: the SRP1/consumption historical
  // shape on this tenant is Planned = Actual = qty (confirmed 10/10 on
  // product 11083446). Used by the explicit "Retry as <code>" flow.
  // Default (ZRP3 ordering) keeps the v0.26.94 Planned=0 convention.
  body.PlannedQuantity = opts.plannedEqualsActual
    ? qtyNum.toFixed(14)
    : "0.00000000000000";
  body.ActualQuantity = qtyNum.toFixed(14);
  // v0.26.85 — UoM must be a CODE ("EA"/"HUR"/"PC") not a TEXT label
  // ("Each", "Hours"). SAP rejects text labels with:
  //   "Property 'QuantityMeasureUnitCode' at offset 'N' is invalid"
  // Validate the value looks like a code; fall back to "EA" / "HUR".
  // Candidates (in priority): operator opts → probe → "EA".
  const isLaborCode = /^[A-Z]?(ALT|HR|LB|LAB)$/i.test(opts.processingTypeCode);
  const looksLikeUomCode = (v: unknown): boolean =>
    typeof v === "string" && /^[A-Z0-9]{1,4}$/.test(v.trim());
  const uomCandidates = [
    opts.uomCode,
    probe.QuantityMeasureUnitCode,
  ];
  const validUom = uomCandidates.find(looksLikeUomCode);
  body.QuantityMeasureUnitCode = validUom
    ? String(validUom).trim()
    : (isLaborCode ? "HUR" : "EA");
  if (!validUom && (opts.uomCode || probe.QuantityMeasureUnitCode)) {
    console.warn(
      "[log_service_item] UoM candidate did not look like a code; falling back to",
      body.QuantityMeasureUnitCode,
      "{ from opts:", opts.uomCode, ", from probe:", probe.QuantityMeasureUnitCode, "}",
    );
  }

  // Optional ops-supplied overrides.
  if (opts.warrantyCode?.trim()) body.WarrantyGoodwillCode = opts.warrantyCode;
  if (opts.servicePerformerPartyId?.trim()) body.ServicePerformerPartyID = opts.servicePerformerPartyId;

  // v0.27.69/71 — Book Time: set the work's start/end on the SETTABLE
  // schedule fields (RequestedStart/End). These are mirrored from the probe
  // (not in the forbidden-on-create list, unlike ActualStart/End), so
  // overriding them is accepted. SAP's V2 JSON date wire-format is /Date(ms)/.
  //
  // v0.27.71 — CRITICAL: when overriding the START we MUST also set an END
  // that is AFTER it. The probe's mirrored RequestedEndDateTime is an old
  // date, so a future start alone trips SAP's HTTP 500 "End date must be
  // after start date." Derive end = start + quantity-hours (Book Time
  // quantity IS hours), or the caller's explicit requestedEndMs if it's
  // valid and later than start; floor the gap at 1 minute.
  if (opts.requestedStartMs != null) {
    const startMs = Number(opts.requestedStartMs);
    if (Number.isFinite(startMs) && startMs > 0) {
      body.RequestedStartDateTime = `/Date(${Math.round(startMs)})/`;
      let endMs = Number(opts.requestedEndMs);
      if (!Number.isFinite(endMs) || endMs <= startMs) {
        const hours = Number(opts.quantity);
        const addMs = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 3_600_000;
        endMs = startMs + Math.max(addMs, 60_000);
      }
      body.RequestedEndDateTime = `/Date(${Math.round(endMs)})/`;
    }
  } else if (opts.requestedEndMs != null) {
    const endMs = Number(opts.requestedEndMs);
    if (Number.isFinite(endMs) && endMs > 0) body.RequestedEndDateTime = `/Date(${Math.round(endMs)})/`;
  }

  return body;
}

// v0.27.75 — Order-Parts item-type rule: the MSD division must order parts
// under item type SRP3; every other division keeps the ZRP3 default. The
// division lives on the ServiceRequest HEADER (KUTDivision_KUT, a string code
// like GSS / IES / MSD — distinct from the standard DivisionCode). We read it
// once per ticket (short-lived cache) so a multi-part commit doesn't refetch.
const divisionCache = new Map<string, { code: string; at: number }>();
const DIVISION_CACHE_TTL_MS = 60_000;

async function fetchTicketDivision(objectId: string): Promise<string> {
  const cached = divisionCache.get(objectId);
  if (cached && Date.now() - cached.at < DIVISION_CACHE_TTL_MS) return cached.code;
  let code = "";
  try {
    const r: any = await c4cGet(`/ServiceRequestCollection('${objectId}')`, {
      "$format": "json",
      "$select": "KUTDivision_KUT",
    });
    // Single-row reads on this tenant come back as { d: { results: <obj> } };
    // tolerate the array and bare-object shapes too.
    const d = r?.d;
    const row = Array.isArray(d?.results) ? d.results[0] : (d?.results ?? d);
    code = String(row?.KUTDivision_KUT ?? "").trim();
  } catch (e: any) {
    console.warn(
      "[log_service_item] division lookup failed — keeping the base item type:",
      e?.message ?? e,
    );
  }
  divisionCache.set(objectId, { code, at: Date.now() });
  return code;
}

export async function logServiceItem(opts: LogServiceItemOptions) {
  if (!opts.objectId.trim()) throw new Error("objectId is required.");
  if (!opts.productId.trim()) throw new Error("productId is required.");
  if (!Number.isFinite(opts.quantity) || opts.quantity <= 0) {
    throw new Error("quantity must be a positive number.");
  }
  // v0.27.75 — division-driven item type for Order Parts. ONLY when the
  // incoming code is the ZRP3 ordering default (so Book Time's ZALT,
  // consumption SRP1, and any explicit override are untouched): if the
  // ticket's KUTDivision_KUT is "MSD", switch the item type to SRP3. This is
  // an explicit, deterministic business rule (not a silent heuristic) — it's
  // logged, and because we set opts.processingTypeCode here the dry-run
  // preview + SAP body + failure diagnostics all reflect the effective code.
  if (/^ZRP3$/i.test(opts.processingTypeCode.trim())) {
    const division = await fetchTicketDivision(opts.objectId);
    if (division.toUpperCase() === "MSD") {
      console.log(
        `[log_service_item] KUTDivision_KUT=MSD → item type ZRP3 → SRP3 (ticket ${opts.objectId})`,
      );
      opts.processingTypeCode = "SRP3";
    } else if (division) {
      console.log(
        `[log_service_item] KUTDivision_KUT=${division} → keeping item type ${opts.processingTypeCode}`,
      );
    }
  }
  // v0.26.81 — direct POST is the canonical path on c4codataapi for
  // this tenant. v0.26.75's navigation POST attempt
  // (`/ServiceRequestCollection('<id>')/ServiceRequestItemCollection`)
  // returned 404 "Resource not found for the segment ...", so the
  // navigation form isn't exposed here. Removed the dual-try.
  const directPath = "/ServiceRequestItemCollection";

  // v0.26.69 — PROBE step: dump one existing line item's schema first.
  // v0.26.70 — also USE the probe data to BUILD the body, mirroring the
  // exact field shape SAP already accepted on this ticket. No more
  // guessing field names. Falls back to the old hardcoded body shape
  // only if the ticket has zero existing line items (rare; the panel
  // shows the operator that case clearly via "(can't mirror schema)").
  const probe = await probeExistingServiceItem(opts.objectId);
  if (probe) {
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(probe)) {
      if (k === "__metadata") continue;
      if (v && typeof v === "object" && "__deferred" in (v as Record<string, unknown>)) continue;
      stripped[k] = v;
    }
    console.log(
      "[log_service_item] PROBE — existing line item field shape on ticket",
      opts.objectId,
      ":",
      JSON.stringify(stripped, null, 2),
    );
    console.log(
      "[log_service_item] PROBE field names:",
      Object.keys(stripped).sort().join(", "),
    );
  } else {
    console.log(
      "[log_service_item] PROBE — no existing line items on ticket",
      opts.objectId,
      "(can't mirror schema; will use default field set)",
    );
  }

  // v0.26.70 — build body by mirroring probe schema when available.
  // When unavailable, fall back to the legacy hardcoded shape (which
  // works on tenants that use V1 standard field names).
  let body: Record<string, any>;
  if (probe) {
    body = buildBodyFromProbe(probe, opts);
    console.log(
      "[log_service_item] body built by mirroring probe (",
      Object.keys(body).length,
      "fields )",
    );
  } else {
    const isLaborCode = /^[A-Z]?(ALT|HR|LB|LAB)$/i.test(opts.processingTypeCode);
    body = {
      ParentObjectID: opts.objectId,
      UserServiceTransactionProcessingTypeCode: opts.processingTypeCode,
      ProductID: opts.productId,
      PlannedQuantity: String(opts.quantity),
      ActualQuantity: String(opts.quantity),
      QuantityMeasureUnitCode: opts.uomCode ?? (isLaborCode ? "HUR" : "EA"),
    };
    if (opts.warrantyCode?.trim()) body.WarrantyGoodwillCode = opts.warrantyCode;
    if (opts.servicePerformerPartyId?.trim()) body.ServicePerformerPartyID = opts.servicePerformerPartyId;
  }
  // v0.26.63 — detailed logging for tenant-write debugging.
  // v0.26.81 — Direct POST only (navigation POST 404s on c4codataapi).
  console.log(
    "[log_service_item] POST", directPath, "with body:",
    JSON.stringify(body, null, 2),
  );
  // v0.26.81 — parse SAP's "Create not allowed for properties: X, Y, Z"
  // annotation error. When SAP returns this, retry once with those
  // fields stripped from the body. Future-proofs against newly-discovered
  // computed fields without requiring a code change for each.
  const stripCreateNotAllowed = (errMsg: string, currentBody: Record<string, any>): Record<string, any> | null => {
    const m = errMsg.match(/Create not allowed for propert(?:y|ies):\s*([^.]+?)(?:\.|$)/i);
    if (!m) return null;
    const fields = m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (fields.length === 0) return null;
    const stripped = { ...currentBody };
    let removed = 0;
    for (const f of fields) {
      if (f in stripped) {
        delete stripped[f];
        removed++;
      }
    }
    if (removed === 0) return null;
    console.warn(
      `[log_service_item] SAP rejected ${fields.length} create-not-allowed field(s); retrying without:`,
      fields.join(", "),
    );
    return stripped;
  };

  // v0.27.72 — Book Time: the operator-entered start/end belong in
  // ActualStartDateTime / ActualEndDateTime (the columns the operator reads
  // in the Time tab), NOT Requested*. SAP forbids Actual* on CREATE, so we
  // create the line first (body above), then PATCH the created item's
  // actuals below. Derive end = start + quantity-hours when actualEndMs is
  // absent or not after start; floor the gap at 1 minute. SAP's JSON date
  // wire-format is /Date(ms)/.
  let actualStartWire: string | null = null;
  let actualEndWire: string | null = null;
  if (opts.actualStartMs != null) {
    const startMs = Number(opts.actualStartMs);
    if (Number.isFinite(startMs) && startMs > 0) {
      actualStartWire = `/Date(${Math.round(startMs)})/`;
      let endMs = Number(opts.actualEndMs);
      if (!Number.isFinite(endMs) || endMs <= startMs) {
        const hours = Number(opts.quantity);
        const addMs = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 3_600_000;
        endMs = startMs + Math.max(addMs, 60_000);
      }
      actualEndWire = `/Date(${Math.round(endMs)})/`;
    }
  } else if (opts.actualEndMs != null) {
    const endMs = Number(opts.actualEndMs);
    if (Number.isFinite(endMs) && endMs > 0) actualEndWire = `/Date(${Math.round(endMs)})/`;
  }
  // Dry-run preview shows the create body PLUS the planned post-create
  // Actual* PATCH (annotated keys), so the operator sees BOTH writes. The
  // executor below uses the clean `body` for the real POST — these annotated
  // keys never reach SAP.
  const previewBody: Record<string, any> = { ...body };
  if (actualStartWire) previewBody["(post-create PATCH) ActualStartDateTime"] = actualStartWire;
  if (actualEndWire) previewBody["(post-create PATCH) ActualEndDateTime"] = actualEndWire;

  return runGatedWrite(opts, { method: "POST", path: directPath, body: previewBody }, async () => {
    // v0.26.81 — direct POST is the only path that works on c4codataapi
    // for this tenant. v0.26.75's navigation POST path returns 404
    // (the endpoint doesn't exist on c4codataapi). Self-healing loop:
    // up to 3 attempts where SAP tells us "Create not allowed for X" →
    // we strip those fields and retry automatically.
    let currentBody: Record<string, any> = body;
    let lastErr: any = null;
    // v0.27.42 — heal stage for SAP's "Schedule line type is not valid".
    // Root cause: on tickets with NO prior parts rows (e.g., PM-contract
    // tickets), probeExistingServiceItem's v0.26.85 fallback mirrors the
    // most-recent line — often the PM SERVICE line — contaminating the
    // parts POST with service-schedule fields (SchedulingRelevant_KUT,
    // service UoM like ZDP, contract linkage). Two-stage strip, fired
    // ONLY on that exact error so working flows are untouched.
    let scheduleHealStage = 0;
    // v0.27.42 iteration 5 — product-history FINDING (not auto-switch).
    // Populated by stage 3 when the product's own order history uses a
    // different processing code than the one sent; embedded into the
    // failure diagnostic so the OPERATOR decides whether to re-commit
    // under the historical code. Ordering (ZRP3) vs consumption (SRP1)
    // is a business distinction — never silently flipped.
    let productHistoryHint: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        // v0.27.74 — POST via the meta variant so we can read the created
        // line's ObjectID from the Location header. On this tenant the POST
        // body comes back empty (echo = {}), so the header is the only place
        // the new key appears — without it the Book Time Actual-date PATCH
        // was being skipped and the timestamps never landed.
        const created = await c4cPostWithMeta<any>(directPath, currentBody);
        const result: any = created.data ?? {};
        // v0.26.91 — log SAP's echoed-back response on success. This
        // surfaces server-side transformations (e.g., SAP rounding
        // ActualQuantity back to 0 for ATP items in certain lifecycle
        // states, regardless of what we sent). Compare body sent vs
        // SAP response to detect overrides.
        try {
          const echo: any = (result as any)?.d ?? result;
          const echoSubset: Record<string, unknown> = {};
          for (const k of [
            "ID", "ObjectID",
            "PlannedQuantity", "ActualQuantity", "QuantityMeasureUnitCode",
            "ProductID", "Description", "ProductDescription",
            "UserServiceTransactionProcessingTypeCode",
          ]) {
            if (echo && k in echo) echoSubset[k] = echo[k];
          }
          console.log(
            `[log_service_item] SUCCESS — SAP accepted write (attempt ${attempt}). Echoed back:`,
            JSON.stringify(echoSubset, null, 2),
          );
          // Highlight quantity transformation if SAP didn't echo what we sent
          if (
            "ActualQuantity" in echoSubset
            && String(echoSubset.ActualQuantity) !== String(currentBody.ActualQuantity)
          ) {
            console.warn(
              `[log_service_item] NOTE: SAP changed ActualQuantity. Sent="${currentBody.ActualQuantity}" but SAP returned="${echoSubset.ActualQuantity}". Server-side override — likely an ATP/lifecycle rule.`,
            );
          }
        } catch (logErr) {
          console.log(`[log_service_item] SUCCESS — SAP accepted write (attempt ${attempt})`);
        }
        // v0.26.94 — removed the post-create PATCH for ActualQuantity.
        // With Planned=0 + Actual=N (the tenant-correct shape), SAP's ATP
        // rule doesn't apply and Actual quantity sticks on the first POST.
        //
        // v0.27.72 — Book Time still needs a post-create PATCH, but for the
        // Actual *dates* (ActualStartDateTime / ActualEndDateTime), which SAP
        // forbids on create. The line is already created at this point; this
        // is best-effort: if SAP rejects the date PATCH (e.g. an item
        // lifecycle state that locks Actual*), the line still exists, so we
        // surface a soft warning on the result rather than throwing — throwing
        // would imply nothing was written and tempt a duplicate re-add.
        if (actualStartWire || actualEndWire) {
          const echoAny: any = (result as any)?.d ?? result;
          let createdId: string | null = (echoAny && (echoAny.ObjectID || echoAny.ID)) || null;
          // v0.27.74 — the POST body is empty on this tenant (echo = {}), so
          // the created key isn't there. SAP returns it in the Location
          // header: <root>/ServiceRequestItemCollection('<ObjectID>'). Parse
          // whatever's in the final (...) and strip a guid' prefix / quotes.
          if (!createdId && created.location) {
            const m = created.location.match(/\(([^)]*)\)\s*$/);
            if (m) createdId = (m[1].replace(/^guid'/i, "").replace(/^'|'$/g, "").trim() || null);
            if (createdId) console.log("[log_service_item] Book Time: resolved created line via Location header →", createdId);
          }
          // Last-ditch: re-query the just-created line by parent + product,
          // newest first. Labour vs travel use distinct ProductIDs, so this
          // disambiguates. Two `eq` clauses are safe on this tenant's parser.
          if (!createdId) {
            try {
              const q: any = await c4cGet("/ServiceRequestItemCollection", {
                "$format": "json",
                "$top": 1,
                "$orderby": "CreationDateTime desc",
                "$filter": `ParentObjectID eq ${odataStringLiteral(opts.objectId)} and ProductID eq ${odataStringLiteral(opts.productId)}`,
                "$select": "ObjectID,ID,CreationDateTime",
              });
              const rows: any[] = q?.d?.results ?? (Array.isArray(q?.d) ? q.d : []);
              if (rows[0]?.ObjectID) {
                createdId = rows[0].ObjectID;
                console.log("[log_service_item] Book Time: resolved created line via re-query →", createdId);
              }
            } catch (qErr: any) {
              console.warn("[log_service_item] Book Time: re-query for created line failed:", qErr?.message ?? qErr);
            }
          }
          if (!createdId) {
            console.warn(
              "[log_service_item] Book Time: created line but couldn't resolve its ObjectID (echo + Location header + re-query all failed) — skipping Actual-date PATCH.",
            );
            try { (result as any)._actualDatesWarning = "Line created, but its ObjectID wasn't returned by SAP (empty body, no Location header), so Actual Start/End could not be set."; } catch {}
          } else {
            const patchPath = `/ServiceRequestItemCollection('${String(createdId)}')`;
            const patchBody: Record<string, any> = {};
            if (actualStartWire) patchBody.ActualStartDateTime = actualStartWire;
            if (actualEndWire) patchBody.ActualEndDateTime = actualEndWire;
            console.log(
              "[log_service_item] Book Time: post-create PATCH", patchPath,
              "with Actual dates:", JSON.stringify(patchBody),
            );
            const runPatch = async () => c4cPatch(patchPath, patchBody);
            try {
              await runPatch();
              console.log("[log_service_item] Book Time: Actual Start/End set on", createdId);
              try { (result as any)._actualDatesSet = patchBody; } catch {}
            } catch (patchErr: any) {
              const pmsg = patchErr?.message ?? String(patchErr);
              // SAP locks the parent ServiceRequest per write — the create
              // we just did may still hold the lock. Retry the PATCH once
              // after a pause, exactly like the commit lock-retry pattern.
              if (/Locking object not possible|object locked by/i.test(pmsg)) {
                console.warn("[log_service_item] Book Time: Actual-date PATCH hit a lock — retrying once after 1500ms.");
                await new Promise((r) => setTimeout(r, 1500));
                try {
                  await runPatch();
                  console.log("[log_service_item] Book Time: Actual Start/End set on retry for", createdId);
                  try { (result as any)._actualDatesSet = patchBody; } catch {}
                } catch (patchErr2: any) {
                  const pmsg2 = patchErr2?.message ?? String(patchErr2);
                  console.warn("[log_service_item] Book Time: Actual-date PATCH rejected after retry:", pmsg2);
                  try { (result as any)._actualDatesWarning = "Line created, but SAP rejected setting Actual Start/End: " + pmsg2.slice(0, 200); } catch {}
                }
              } else {
                console.warn("[log_service_item] Book Time: Actual-date PATCH rejected:", pmsg);
                try { (result as any)._actualDatesWarning = "Line created, but SAP rejected setting Actual Start/End: " + pmsg.slice(0, 200); } catch {}
              }
            }
          }
        }
        return result;
      } catch (err: any) {
        lastErr = err;
        const msg = err?.message ?? String(err);
        const stripped = stripCreateNotAllowed(msg, currentBody);
        if (stripped) {
          currentBody = stripped;
          continue;
        }
        // v0.27.42 — service-line contamination heal (see scheduleHealStage
        // declaration above for the why). Stage 1: drop schedule-line KUT
        // fields + normalize the UoM to the caller's (cart's) unit or EA —
        // a mirrored PM service line carries units like ZDP that are
        // invalid on a parts line. Stage 2: also drop contract linkage +
        // requested dates if SAP still complains.
        // NOTE the [\s\S]{0,30} — SAP's actual message is "Schedule line
        // type  is not valid" (DOUBLE space; an empty type placeholder is
        // interpolated into the template). A literal single-space regex
        // silently never matched. Tolerate any short filler so variants
        // like "Schedule line type XYZ is not valid" also heal.
        // Stage 3 — PRODUCT-HISTORY heal. When stages 1-2 didn't help,
        // the processing code itself is likely wrong for this product
        // class: e.g. ZDP-unit consumables on this tenant are ordered
        // as SRP1 (10/10 historical rows for product 11083446), never
        // ZRP3 — SAP has no schedule-line type configured for that
        // combo (the blank in "Schedule line type  is not valid" IS the
        // failed lookup). Ask SAP how this product was historically
        // ordered and mimic the dominant code + UoM + quantity shape.
        if (/Schedule line type[\s\S]{0,30}?is not valid/i.test(msg) && scheduleHealStage === 2) {
          scheduleHealStage++;
          try {
            const hist: any = await c4cGet("/ServiceRequestItemCollection", {
              "$format": "json",
              "$top": 10,
              "$filter": `ProductID eq ${odataStringLiteral(opts.productId)}`,
              "$select": "UserServiceTransactionProcessingTypeCode,QuantityMeasureUnitCode,PlannedQuantity,ActualQuantity",
            });
            const rows: any[] = hist?.d?.results ?? [];
            const tally = new Map<string, { count: number; uom: string; plannedNonZero: boolean }>();
            for (const r of rows) {
              const code = String(r?.UserServiceTransactionProcessingTypeCode || "").trim();
              if (!code) continue;
              const cur = tally.get(code) ?? { count: 0, uom: "", plannedNonZero: false };
              cur.count++;
              cur.uom = String(r?.QuantityMeasureUnitCode || cur.uom);
              if (Number(r?.PlannedQuantity) > 0) cur.plannedNonZero = true;
              tally.set(code, cur);
            }
            const dominant = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)[0];
            if (dominant && dominant[0] !== currentBody.UserServiceTransactionProcessingTypeCode) {
              const [histCode, info] = dominant;
              // DO NOT silently switch the processing code — ordering
              // (ZRP3) vs consumption (SRP1) is a business-meaning
              // distinction the operator owns (user pushback on the
              // first iteration of this heal). Capture the finding for
              // the failure diagnostic instead; the panel surfaces it
              // and the operator decides how to proceed.
              productHistoryHint = {
                productId: opts.productId,
                codeSent: String(currentBody.UserServiceTransactionProcessingTypeCode || ""),
                historicalCode: histCode,
                historicalUom: info.uom || "",
                historicalRows: rows.length,
                historicalRowsWithThatCode: info.count,
                quantityShape: info.plannedNonZero ? "Planned = Actual = qty" : "Planned = 0, Actual = qty",
                interpretation:
                  `SAP has no schedule-line type configured for ${currentBody.UserServiceTransactionProcessingTypeCode} ` +
                  `on this product class. The product's own history is ${info.count}/${rows.length} ${histCode} — ` +
                  `it appears to be ${histCode}-only on this tenant.`,
              };
              console.warn(
                `[log_service_item] product-history finding: ${info.count}/${rows.length} prior items for ${opts.productId} use ${histCode}@${info.uom || "?"} — NOT auto-switching (operator decision). Surfacing in diagnostic.`,
              );
            } else {
              console.warn(
                `[log_service_item] product-history heal: no alternative code found for ${opts.productId} (history: ${rows.length} rows) — giving up`,
              );
            }
          } catch (histErr: any) {
            console.warn(
              "[log_service_item] product-history heal lookup failed:",
              histErr?.message ?? histErr,
            );
          }
          break;
        }
        if (/Schedule line type[\s\S]{0,30}?is not valid/i.test(msg) && scheduleHealStage < 2) {
          scheduleHealStage++;
          const healed = { ...currentBody };
          if (scheduleHealStage === 1) {
            delete healed.SchedulingRelevant_KUT;
            delete healed.KUT_PlannedDurationHours_KUT;
            const wantUom = opts.uomCode?.trim() || "EA";
            if (healed.QuantityMeasureUnitCode !== wantUom) {
              healed.QuantityMeasureUnitCode = wantUom;
            }
            console.warn(
              `[log_service_item] "Schedule line type is not valid" — heal stage 1: dropped SchedulingRelevant_KUT + KUT_PlannedDurationHours_KUT, UoM → ${wantUom}`,
            );
          } else {
            delete healed.ContractID;
            delete healed.ContractItemID;
            delete healed.RequestedStartDateTime;
            delete healed.RequestedEndDateTime;
            console.warn(
              "[log_service_item] heal stage 2: dropped ContractID/ContractItemID + RequestedStart/EndDateTime",
            );
          }
          currentBody = healed;
          continue;
        }
        break;
      }
    }
    // All attempts exhausted — build the structured diagnostic and throw.
    const directMsg = lastErr?.message ?? String(lastErr);
    console.error(
      "[log_service_item] FAILURE — SAP rejected write after retries\n",
      "  final body sent:", JSON.stringify(currentBody), "\n",
      "  SAP response:", directMsg,
    );
    let schemaDiff: { missing: string[]; extra: string[] } | null = null;
    if (probe) {
      const existingKeys = new Set(Object.keys(probe).filter((k) => k !== "__metadata"));
      const ourKeys = new Set(Object.keys(currentBody));
      const missing = [...existingKeys].filter((k) => !ourKeys.has(k));
      const extra = [...ourKeys].filter((k) => !existingKeys.has(k));
      schemaDiff = { missing, extra };
      console.error(
        "[log_service_item] SCHEMA MISMATCH:\n",
        "  Fields on existing line item but NOT in our POST:", missing.slice(0, 30).join(", ") || "(none)",
        "\n  Fields in our POST but NOT on the existing line item:", extra.join(", ") || "(none)",
      );
    }
    // v0.26.78 — embed diagnostic at the START of the error message so it
    // survives redactSensitiveDetails's 3000-char trim.
    const directMsgShort = directMsg.slice(0, 300);
    const buildDiag = (includeBody: boolean) =>
      JSON.stringify({
        directPath,
        bodySent: includeBody ? currentBody : "[truncated for size — see shim console]",
        sapResponse: directMsgShort,
        schemaDiff,
        // v0.27.42 — present only when stage 3 found the product's
        // history under a DIFFERENT processing code (e.g. consumption-
        // only ZDP parts). The panel renders this as an actionable hint.
        productHistory: productHistoryHint,
      });
    let diagJson = buildDiag(true);
    if (diagJson.length > 2200) diagJson = buildDiag(false);
    const enrichedMsg =
      "===C4S_DIAG_BEGIN===" + diagJson + "===C4S_DIAG_END===\n" +
      "SAP rejected commit. " + directMsgShort;
    throw new Error(enrichedMsg);
  });
}

export type UpdateServiceItemActualsOptions = WriteGateOpts & {
  itemObjectId: string;
  actualQuantity?: number;
  actualStartDateTime?: string;
  actualEndDateTime?: string;
};

export async function updateServiceItemActuals(opts: UpdateServiceItemActualsOptions) {
  if (!opts.itemObjectId.trim()) throw new Error("itemObjectId is required.");
  const path = `/ServiceRequestItemCollection(${odataStringLiteral(opts.itemObjectId)})`;
  const body: any = {};
  if (opts.actualQuantity != null) body.ActualQuantity = String(opts.actualQuantity);
  if (opts.actualStartDateTime) body.ActualStartDateTime = opts.actualStartDateTime;
  if (opts.actualEndDateTime) body.ActualEndDateTime = opts.actualEndDateTime;
  if (Object.keys(body).length === 0) throw new Error("Provide at least one of actualQuantity/actualStartDateTime/actualEndDateTime.");
  return runGatedWrite(opts, { method: "PATCH", path, body }, () => c4cPatch(path, body));
}

export type CreateFollowupTaskOptions = WriteGateOpts & {
  subject: string;
  ownerPartyId?: string;
  accountPartyId?: string;
  /** ISO 8601 timestamp. */
  dueDateTime?: string;
};

export async function createFollowupTask(opts: CreateFollowupTaskOptions) {
  if (!opts.subject.trim()) throw new Error("subject is required.");
  const path = "/TasksCollection";
  const body: any = { Subject: opts.subject, Status: "1" };
  if (opts.ownerPartyId?.trim()) body.MainEmployeeResponsiblePartyID = opts.ownerPartyId;
  if (opts.accountPartyId?.trim()) body.MainAccountPartyID = opts.accountPartyId;
  if (opts.dueDateTime?.trim()) body.DueDateTime = opts.dueDateTime;
  return runGatedWrite(opts, { method: "POST", path, body }, () => c4cPost(path, body));
}

export type CreateAppointmentOptions = WriteGateOpts & {
  subject: string;
  startDateTime: string;
  endDateTime: string;
  ownerPartyId?: string;
  accountPartyId?: string;
  location?: string;
};

export async function createAppointment(opts: CreateAppointmentOptions) {
  if (!opts.subject.trim()) throw new Error("subject is required.");
  if (!opts.startDateTime.trim() || !opts.endDateTime.trim()) {
    throw new Error("startDateTime and endDateTime are required.");
  }
  const path = "/AppointmentCollection";
  const body: any = {
    Subject: opts.subject,
    StartDate: opts.startDateTime,
    EndDate: opts.endDateTime,
  };
  if (opts.ownerPartyId?.trim()) body.OwnerPartyID = opts.ownerPartyId;
  if (opts.accountPartyId?.trim()) body.MainAccountPartyID = opts.accountPartyId;
  if (opts.location?.trim()) body.Location = opts.location;
  return runGatedWrite(opts, { method: "POST", path, body }, () => c4cPost(path, body));
}

export type LogPhoneCallOptions = WriteGateOpts & {
  subject: string;
  startDateTime: string;
  endDateTime?: string;
  /** 1=Outbound, 2=Inbound. */
  initiatorCode?: "1" | "2";
  accountPartyId?: string;
  contactPartyId?: string;
};

export async function logPhoneCall(opts: LogPhoneCallOptions) {
  if (!opts.subject.trim()) throw new Error("subject is required.");
  if (!opts.startDateTime.trim()) throw new Error("startDateTime is required.");
  const path = "/PhoneCallCollection";
  const body: any = {
    Subject: opts.subject,
    StartDateTime: opts.startDateTime,
    InitiatorCode: opts.initiatorCode ?? "1",
  };
  if (opts.endDateTime?.trim()) body.EndDateTime = opts.endDateTime;
  if (opts.accountPartyId?.trim()) body.MainAccountPartyID = opts.accountPartyId;
  if (opts.contactPartyId?.trim()) body.MainContactPartyID = opts.contactPartyId;
  return runGatedWrite(opts, { method: "POST", path, body }, () => c4cPost(path, body));
}

export type AddAccountContactOptions = WriteGateOpts & {
  accountId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
};

export async function addAccountContact(opts: AddAccountContactOptions) {
  if (!opts.accountId.trim()) throw new Error("accountId is required.");
  if (!opts.firstName.trim() || !opts.lastName.trim()) {
    throw new Error("firstName and lastName are required.");
  }
  const path = "/ContactCollection";
  const body: any = {
    AccountID: opts.accountId,
    FirstName: opts.firstName,
    LastName: opts.lastName,
  };
  if (opts.email?.trim()) body.Email = opts.email;
  if (opts.phone?.trim()) body.Phone = opts.phone;
  if (opts.jobTitle?.trim()) body.JobTitle = opts.jobTitle;
  return runGatedWrite(opts, { method: "POST", path, body }, () => c4cPost(path, body));
}

// ===========================================================================
// =====================  TIER 3 — ANALYTICS  ================================
// ===========================================================================

export type GetFirstTimeFixRateOptions = {
  productId?: string;
  sampleSize?: number;
};

/**
 * First-time-fix rate (approximated): % of closed tickets that had no
 * processor change between in-process and closed (i.e. one tech, one trip).
 * Real-world FTF would also factor in appointment count per ticket; we don't
 * have a clean Appointment→ServiceRequest link in this tenant, so we use the
 * lighter heuristic.
 */
export async function getFirstTimeFixRate({
  productId,
  sampleSize = 100,
}: GetFirstTimeFixRateOptions = {}) {
  const filters: string[] = ["ServiceRequestLifeCycleStatusCode eq '4'"]; // closed
  if (productId?.trim()) filters.push(`ProductID eq ${odataStringLiteral(productId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(sampleSize, 10), 500),
    "$filter": filters.join(" and "),
    "$orderby": "LastChangeDateTime desc",
    "$select":
      "ID,ProductID,SerialID,ProcessorPartyName,CreationDateTime,RequestInProcessdatetimeContent,RequestCloseddatetimeContent",
  };
  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  // For each, check if the ticket has any history rows showing processor changes.
  // That's an N+1 fan-out and may be slow; instead we use a much lighter proxy:
  // a single-tech ticket is one where the same processor was on it from
  // in-process through close. Without per-ticket history we can't measure that
  // perfectly — but we CAN spot-check service-request history rows lazily.
  // For now: report a placeholder rate based on sample shape so the UI
  // surfaces "this number depends on history-fanout, see notes".
  // (When we have time to fan out properly we'll refine.)
  return {
    filter: { productId: productId ?? null },
    sampled: rows.length,
    method: "lightweight",
    note:
      "FTF rate measurement here is a sample listing — proper FTF requires per-ticket history fan-out (one /ServiceRequestHistoricalVersion call per ticket). Coming soon: a fanned-out version with rate calculation.",
    tickets: rows.slice(0, 25),
  };
}

export type GetRepeatVisitRateOptions = {
  productId?: string;
  windowDays?: number;
  sampleSize?: number;
};

/**
 * Serials with ≥2 tickets in a sliding window — proxy for "this unit keeps
 * coming back". Returns the offending serials with their ticket count.
 */
export async function getRepeatVisitRate({
  productId,
  windowDays = 90,
  sampleSize = 300,
}: GetRepeatVisitRateOptions = {}) {
  const filters: string[] = [];
  if (productId?.trim()) filters.push(`ProductID eq ${odataStringLiteral(productId.trim())}`);
  // Compute cutoff date
  const cutoff = new Date(Date.now() - windowDays * 24 * 3_600_000);
  const cutoffIso = cutoff.toISOString().replace(/\.\d+Z$/, "Z");
  filters.push(`LastChangeDateTime ge datetimeoffset'${cutoffIso}'`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(sampleSize, 50), 1000),
    "$filter": filters.join(" and "),
    "$orderby": "LastChangeDateTime desc",
    "$select": "ID,ProductID,SerialID,BuyerPartyName,CreationDateTime",
  };
  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const bySerial = new Map<string, { serialId: string; productId: string; tickets: any[] }>();
  for (const r of rows) {
    const sid = String(r.SerialID ?? "").trim();
    if (!sid) continue;
    if (!bySerial.has(sid)) {
      bySerial.set(sid, { serialId: sid, productId: String(r.ProductID ?? ""), tickets: [] });
    }
    bySerial.get(sid)!.tickets.push({
      id: String(r.ID ?? ""),
      customer: String(r.BuyerPartyName ?? ""),
      createdAt: String(r.CreationDateTime ?? ""),
    });
  }
  const repeats = Array.from(bySerial.values()).filter((s) => s.tickets.length >= 2);
  repeats.sort((a, b) => b.tickets.length - a.tickets.length);
  const distinctSerials = bySerial.size;
  return {
    windowDays,
    productId: productId ?? null,
    sampledTickets: rows.length,
    distinctSerials,
    serialsWithRepeats: repeats.length,
    repeatRate: distinctSerials > 0 ? Math.round((repeats.length / distinctSerials) * 1000) / 10 : 0,
    topRepeats: repeats.slice(0, 15),
  };
}

export type GetMttrByProductOptions = {
  productId: string;
  sampleSize?: number;
};

export async function getMttrByProduct({ productId, sampleSize = 100 }: GetMttrByProductOptions) {
  if (!productId.trim()) throw new Error("productId is required.");
  // Reuse getDurationStats with the productId filter. MTTR = median actual hours.
  const stats = await getDurationStats({ productId, sampleSize });
  return {
    productId,
    sampleSize,
    mttrHours: stats.actualHours.median,
    p10Hours: stats.actualHours.p10,
    p90Hours: stats.actualHours.p90,
    count: stats.actualHours.count,
    underlying: stats,
  };
}

export type GetWorkloadDistributionOptions = {
  teamPartyId?: string;
  sampleSize?: number;
};

export async function getWorkloadDistribution({
  teamPartyId,
  sampleSize = 200,
}: GetWorkloadDistributionOptions = {}) {
  const filters: string[] = ["ServiceRequestLifeCycleStatusCode lt '4'"]; // open only
  if (teamPartyId?.trim()) filters.push(`ServiceExecutionTeamPartyID eq ${odataStringLiteral(teamPartyId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(sampleSize, 50), 500),
    "$filter": filters.join(" and "),
    "$orderby": "LastChangeDateTime desc",
    "$select": "ID,ProcessorPartyName,ServicePriorityCode,ServiceRequestLifeCycleStatusCode",
  };
  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const byProcessor = new Map<string, { processor: string; open: number; inProcess: number; high: number; total: number }>();
  for (const r of rows) {
    const p = String(r.ProcessorPartyName ?? "(unassigned)");
    if (!byProcessor.has(p)) {
      byProcessor.set(p, { processor: p, open: 0, inProcess: 0, high: 0, total: 0 });
    }
    const b = byProcessor.get(p)!;
    b.total++;
    if (String(r.ServiceRequestLifeCycleStatusCode) === "1") b.open++;
    else if (String(r.ServiceRequestLifeCycleStatusCode) === "2") b.inProcess++;
    const pri = String(r.ServicePriorityCode ?? "");
    if (pri === "1" || pri === "2") b.high++;
  }
  const buckets = Array.from(byProcessor.values()).sort((a, b) => b.total - a.total);
  return {
    teamPartyId: teamPartyId ?? null,
    sampledTickets: rows.length,
    distinctProcessors: buckets.length,
    buckets,
  };
}

export type GetRecurringIssuesOptions = {
  productId?: string;
  sampleSize?: number;
};

/**
 * Group tickets by Name (title) within a product family. Returns the top N
 * recurring symptom strings — useful for "what does product X keep breaking
 * with?" reports.
 */
export async function getRecurringIssues({
  productId,
  sampleSize = 300,
}: GetRecurringIssuesOptions = {}) {
  const filters: string[] = [];
  if (productId?.trim()) filters.push(`ProductID eq ${odataStringLiteral(productId.trim())}`);
  const query: ODataQuery = {
    "$format": "json",
    "$top": Math.min(Math.max(sampleSize, 50), 1000),
    "$orderby": "LastChangeDateTime desc",
    "$select": "ID,ProductID,Name,SerialID,BuyerPartyName",
  };
  if (filters.length) query["$filter"] = filters.join(" and ");
  const result: any = await c4cGet("/ServiceRequestCollection", query);
  const rows: any[] = result?.d?.results ?? [];
  const titleCounts = new Map<string, { title: string; count: number; productIds: Set<string>; sample: any[] }>();
  for (const r of rows) {
    const t = String(r.Name ?? "").trim();
    if (!t) continue;
    // Normalize: lowercase + collapse whitespace
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (!titleCounts.has(key)) {
      titleCounts.set(key, { title: t, count: 0, productIds: new Set<string>(), sample: [] });
    }
    const entry = titleCounts.get(key)!;
    entry.count++;
    entry.productIds.add(String(r.ProductID ?? ""));
    if (entry.sample.length < 3) entry.sample.push({ id: r.ID, serial: r.SerialID, customer: r.BuyerPartyName });
  }
  const top = Array.from(titleCounts.values())
    .filter((t) => t.count >= 2)
    .map((t) => ({
      title: t.title,
      count: t.count,
      productCount: t.productIds.size,
      productIds: Array.from(t.productIds),
      sample: t.sample,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  return {
    filter: { productId: productId ?? null },
    sampled: rows.length,
    recurringTitles: top.length,
    top,
  };
}
