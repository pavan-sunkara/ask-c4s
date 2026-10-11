/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import { c4cGet, c4cGetCustom, c4cGetService } from "./client.js";
import {
  deleteCodeList,
  listCodeLists as listCachedCodeLists,
  readCodeList,
  writeCodeList,
  type CodeListItem,
} from "../../cache.js";
import { getSettingNumber } from "../../settings.js";

type Fetcher = () => Promise<CodeListItem[]>;

type Definition = {
  name: string;        // canonical key used everywhere (also the API path segment)
  title: string;       // human label
  sourceUrl: string;   // documentary — not used to fetch
  getTtlMs: () => number; // live TTL from settings
  fetch: Fetcher;
};

// TTLs are derived per-call from settings so tenants can override them live.
function defaultTtl() {
  return getSettingNumber("cache.code_list_ttl_ms");
}
function skillTtl() {
  return getSettingNumber("cache.skill_master_ttl_ms");
}

function pickCodeDesc(rows: any[]): CodeListItem[] {
  return rows
    .map((r) => ({
      code: String(r.Code ?? r.code ?? r.SkillID ?? "").trim(),
      description: String(r.Description ?? r.code_text ?? r.codelabel ?? r.SkillDescription ?? r.SkillID ?? "").trim(),
    }))
    .filter((r) => r.code);
}

// Wrappers around c4cGet/c4cGetCustom/c4cGetService that always pull all rows
async function fetchSrCodeList(entitySet: string): Promise<CodeListItem[]> {
  const result: any = await c4cGet(`/${entitySet}`, { "$format": "json", "$top": 200 });
  return pickCodeDesc(result?.d?.results ?? []);
}

async function fetchKutCodeList(entitySet: string): Promise<CodeListItem[]> {
  const result: any = await c4cGet(`/${entitySet}`, { "$format": "json", "$top": 200 });
  return pickCodeDesc(result?.d?.results ?? []);
}

async function fetchSkillMaster(): Promise<CodeListItem[]> {
  const result: any = await c4cGetService("cod_skill_wcf.svc", "/cod_skill_tts", {
    "$format": "json",
    "$top": 500,
  });
  return pickCodeDesc(result?.d?.results ?? []);
}

/**
 * Sales organisations are not a flat code list — they live as Organisational Units
 * whose IDs follow the SO_* convention. Pull them with $expand on the name nav
 * so we get human-readable labels.
 */
async function fetchSalesOrgs(): Promise<CodeListItem[]> {
  const result: any = await c4cGet("/OrganisationalUnitCollection", {
    "$format": "json",
    "$top": 500,
    "$filter": "startswith(OrganisationalUnitID,'SO_')",
    "$expand": "OrganisationalUnitNameAndAddress",
    "$select": "OrganisationalUnitID,OrganisationalUnitNameAndAddress",
  });
  const rows: any[] = result?.d?.results ?? [];
  return rows
    .map((r) => {
      const id = String(r.OrganisationalUnitID ?? "").trim();
      const raw = r.OrganisationalUnitNameAndAddress;
      const naa: any[] = Array.isArray(raw) ? raw : (raw?.results ?? []);
      const first = naa[0] ?? {};
      const name =
        String(first.Name ?? "").trim() ||
        String(first.OrganisationalName1 ?? "").trim() ||
        String(first.FormattedName ?? "").trim() ||
        String(first.FormattedPostalAddressDescription ?? "").trim() ||
        id;
      return { code: id, description: name };
    })
    .filter((x) => x.code)
    .sort((a, b) => a.code.localeCompare(b.code));
}

const REGISTRY: Definition[] = [
  {
    name: "lifecycle_status",
    title: "ServiceRequest Lifecycle Status",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestServiceRequestLifeCycleStatusCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestServiceRequestLifeCycleStatusCodeCollection"),
  },
  {
    name: "user_lifecycle_status",
    title: "ServiceRequest User Lifecycle Status",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestServiceRequestUserLifeCycleStatusCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestServiceRequestUserLifeCycleStatusCodeCollection"),
  },
  {
    name: "service_priority",
    title: "Service Priority",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestServicePriorityCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestServicePriorityCodeCollection"),
  },
  {
    name: "processing_type",
    title: "Processing Type",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestProcessingTypeCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestProcessingTypeCodeCollection"),
  },
  {
    name: "escalation_status",
    title: "Escalation Status",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestEscalationStatusCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestEscalationStatusCodeCollection"),
  },
  {
    name: "document_language",
    title: "Document Language",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestDocumentLanguageCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestDocumentLanguageCodeCollection"),
  },
  {
    name: "distribution_channel",
    title: "Distribution Channel",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestDistributionChannelCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestDistributionChannelCodeCollection"),
  },
  {
    name: "division",
    title: "Division",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestDivisionCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestDivisionCodeCollection"),
  },
  {
    name: "data_origin_type",
    title: "Data Origin Type",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestDataOriginTypeCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestDataOriginTypeCodeCollection"),
  },
  {
    name: "kut_secondary_ticket_type",
    title: "Secondary Ticket Type (custom)",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestKUT_Secondary_Ticket_TypeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchKutCodeList("ServiceRequestKUT_Secondary_Ticket_TypeCollection"),
  },
  {
    name: "skill_master",
    title: "Skill catalogue (cod_skill_wcf.svc)",
    sourceUrl: "/sap/c4c/odata/cod_skill_wcf.svc/cod_skill_tts",
    getTtlMs: skillTtl,
    fetch: fetchSkillMaster,
  },
  {
    name: "text_collection_type",
    title: "Service Request text-collection types",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestTextCollectionTypeCodeCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchSrCodeList("ServiceRequestTextCollectionTypeCodeCollection"),
  },
  {
    name: "kut_logic_coverage",
    title: "Logic Coverage (custom)",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/ServiceRequestKUT_LogicCoverage_KUTCollection",
    getTtlMs: defaultTtl,
    fetch: () => fetchKutCodeList("ServiceRequestKUT_LogicCoverage_KUTCollection"),
  },
  {
    name: "sales_organisations",
    title: "Sales Organisations (SO_* org units)",
    sourceUrl: "/sap/c4c/odata/v1/c4codataapi/OrganisationalUnitCollection?$filter=startswith(OrganisationalUnitID,'SO_')",
    getTtlMs: defaultTtl,
    fetch: fetchSalesOrgs,
  },
];

const REGISTRY_INDEX = new Map<string, Definition>(REGISTRY.map((d) => [d.name, d]));

export type CodeListSummary = {
  name: string;
  title: string;
  sourceUrl: string;
  ttlMs: number;
  cached: boolean;
  fresh: boolean;
  rowCount: number;
  ageMs: number | null;
  fetchedAt: number | null;
};

export function listAvailableCodeLists(): CodeListSummary[] {
  const cached = new Map(listCachedCodeLists().map((row) => [row.listName, row]));
  return REGISTRY.map((d) => {
    const c = cached.get(d.name);
    if (!c) {
      return {
        name: d.name,
        title: d.title,
        sourceUrl: d.sourceUrl,
        ttlMs: d.getTtlMs(),
        cached: false,
        fresh: false,
        rowCount: 0,
        ageMs: null,
        fetchedAt: null,
      };
    }
    const age = Date.now() - c.fetchedAt;
    return {
      name: d.name,
      title: d.title,
      sourceUrl: d.sourceUrl,
      ttlMs: d.getTtlMs(),
      cached: true,
      fresh: age < c.ttlMs,
      rowCount: c.rowCount,
      ageMs: age,
      fetchedAt: c.fetchedAt,
    };
  });
}

export function getDefinition(name: string): Definition | undefined {
  return REGISTRY_INDEX.get(name);
}

export async function getCodeList(name: string, opts: { refresh?: boolean } = {}) {
  const def = REGISTRY_INDEX.get(name);
  if (!def) {
    const known = REGISTRY.map((d) => d.name).join(", ");
    throw new Error(`Unknown code list '${name}'. Known: ${known}`);
  }

  if (!opts.refresh) {
    const cached = readCodeList(name);
    if (cached?.fresh) {
      return {
        name,
        title: def.title,
        items: cached.items,
        rowCount: cached.rowCount,
        fetchedAt: cached.fetchedAt,
        ageMs: cached.age,
        ttlMs: cached.ttlMs,
        source: "cache" as const,
        sourceUrl: def.sourceUrl,
      };
    }
  }

  const ttl = def.getTtlMs();
  const items = await def.fetch();
  writeCodeList({ listName: name, items, sourceUrl: def.sourceUrl, ttlMs: ttl });
  return {
    name,
    title: def.title,
    items,
    rowCount: items.length,
    fetchedAt: Date.now(),
    ageMs: 0,
    ttlMs: ttl,
    source: "sap" as const,
    sourceUrl: def.sourceUrl,
  };
}

export async function refreshAllCodeLists() {
  const results: { name: string; ok: boolean; rows?: number; error?: string }[] = [];
  for (const def of REGISTRY) {
    try {
      const r = await getCodeList(def.name, { refresh: true });
      results.push({ name: def.name, ok: true, rows: r.rowCount });
    } catch (error) {
      results.push({
        name: def.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function purgeCodeList(name: string) {
  deleteCodeList(name);
}
