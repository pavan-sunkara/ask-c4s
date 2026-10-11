/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Catalog of every MCP tool the Companion knows about for SAP C4C — both
 * those currently wired (status='implemented') and those we could build
 * (status='planned'). Surfaces on /admin/tools so the demo audience can see
 * what's live, what's queued, and where each tool reads from SAP.
 */

export type ToolStorage =
  | "local-db"
  | "live"
  | "in-memory"
  | "meta"
  | "n/a";

export type ToolStatus = "implemented" | "planned" | "considered";

export type ToolCategory =
  | "ticket"
  | "history"
  | "customer"
  | "technician"
  | "scheduling"
  | "parts"
  | "knowledge"
  | "analytics"
  | "geo"
  | "write"
  | "meta";

export type WriteBlastRadius = "none" | "low" | "medium" | "high";

export type ToolInfo = {
  name: string;
  description: string;
  status: ToolStatus;
  category: ToolCategory;
  storage: ToolStorage;
  cacheTable: string | null;
  ttlSettingKey: string | null;
  sapEndpoints: string[];
  invokedBy: string[];
  notes?: string;
  effortHours?: number;
  writeOperation?: boolean;
  blastRadius?: WriteBlastRadius;
};

export const TOOL_REGISTRY: ToolInfo[] = [
  // =========================================================================
  // IMPLEMENTED — currently wired and metric-instrumented
  // =========================================================================
  {
    name: "search_tickets",
    description: "Search SAP Service Cloud tickets by filter / order.",
    status: "implemented",
    category: "ticket",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection"],
    invokedBy: ["Header ticket-ID resolver", "AI chat (\"search latest tickets\")"],
    notes: "Always hits SAP. Filter/sort permutations are unbounded; results not cached.",
  },
  {
    name: "get_ticket",
    description: "Fetch one Service Request by ObjectID.",
    status: "implemented",
    category: "ticket",
    storage: "local-db",
    cacheTable: "tickets",
    ttlSettingKey: "cache.ticket_ttl_ms",
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["Click ticket → /api/lookup", "AI chat (\"summarize ticket\")"],
  },
  {
    name: "get_service_history",
    description: "Discover history-related nav properties and fetch their rows for a ticket.",
    status: "implemented",
    category: "history",
    storage: "local-db",
    cacheTable: "history",
    ttlSettingKey: "cache.history_ttl_ms",
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection('<id>')/ServiceRequestHistoricalVersion",
      "/c4codataapi/ServiceRequestCollection('<id>')/ServiceRequestTextCollection",
      "/c4codataapi/ServiceRequestCollection('<id>')/ServiceRequestBusinessTransactionDocumentReference",
    ],
    invokedBy: ["Click ticket → /api/lookup", "Service History tab", "AI chat"],
    notes: "Up to 5 SAP requests per cache miss (one per discovered nav property).",
  },
  {
    name: "get_service_metadata",
    description: "Fetch and summarize the SAP C4C OData $metadata document.",
    status: "implemented",
    category: "meta",
    storage: "in-memory",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/$metadata"],
    invokedBy: ["First call from any other tool", "AI chat (\"show metadata\")"],
    notes: "~2 MB XML, parsed once per process. Survives until server restart but isn't on disk.",
  },
  {
    name: "get_employee_skills",
    description: "Pull technicians + per-product expertise from the custom skills table.",
    status: "implemented",
    category: "technician",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/cust/v1/zskill_employeeskills/ZSDK_EmployeeSkillsRootCollection",
    ],
    invokedBy: ["Skills tab", "Scheduler / Dispatch tab"],
    notes: "Multi-keyword fan-out: typically 2-6 SAP calls per invocation. Caching planned (Tier 2).",
  },
  {
    name: "list_code_lists",
    description: "Return all known SAP code lists and their local cache status.",
    status: "implemented",
    category: "meta",
    storage: "meta",
    cacheTable: "code_lists",
    ttlSettingKey: null,
    sapEndpoints: [],
    invokedBy: ["/admin/code-lists", "AI chat (rare)"],
    notes: "Reads only — no SAP call.",
  },
  {
    name: "get_code_list",
    description: "Return items of a named SAP code list, cache-first.",
    status: "implemented",
    category: "meta",
    storage: "local-db",
    cacheTable: "code_lists",
    ttlSettingKey: "cache.code_list_ttl_ms",
    sapEndpoints: [
      "/c4codataapi/ServiceRequest*CodeCollection",
      "/cod_skill_wcf.svc/cod_skill_tts",
      "/c4codataapi/OrganisationalUnitCollection",
    ],
    invokedBy: ["/admin/code-lists viewer", "AI chat", "Future label-resolution"],
    notes: "Skill master uses a different TTL (cache.skill_master_ttl_ms, default 4h).",
  },

  // =========================================================================
  // PLANNED — Tier 1: highest demo impact, easy reads
  // =========================================================================
  {
    name: "search_kb_articles",
    description: "Free-text search the external KB via the MindTouch REST API, authenticated with Azure AD (same SSO as C4C). Falls back to ok=false with guidance when AAD isn't configured.",
    status: "implemented",
    category: "knowledge",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["GET <kb-base-url>/@api/deki/site/search (Bearer <aad-token>)"],
    invokedBy: ["Knowledge tab → KB results section", "AI chat (\"search kb for X\")", "Demo playground"],
    notes:
      "Requires Azure AD app registration with KB scope. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, KB_API_SCOPE in root .env. Token cached in-memory until 60s before expiry. Parses MindTouch XML response (title, uri, snippet, score). Falls back to JSON if KB returns it.",
  },
  {
    name: "search_kb_for_ticket",
    description: "Fan-out KB search for a ticket — derives 2-3 smart queries from symptom keywords + product, runs them in parallel, dedupes + ranks by score.",
    status: "implemented",
    category: "knowledge",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "Internally: get_resolution_hints (for queries) + 2-3 × search_kb_articles fan-out",
    ],
    invokedBy: ["Knowledge tab (proactive KB results when ticket loads)", "AI chat (\"what does the KB say\" / \"find articles for this ticket\")", "Demo playground"],
    notes: "Convenience wrapper. Total SAP calls: ~1 (resolution hints with pastTicketsTop=1) + N KB calls. Doesn't hit C4C beyond that.",
  },
  {
    name: "get_kb_api_status",
    description: "Public-safe diagnostic — is Azure AD configured? Which KB base URL + scope are wired? Never returns secrets.",
    status: "implemented",
    category: "meta",
    storage: "in-memory",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [],
    invokedBy: ["Knowledge tab status badge", "Admin → Health (future)", "Demo playground"],
    notes: "Returns { configured, baseUrl, searchPath, scope, azureConfigured } — used to decide whether to show real KB results or fall back to link tiles.",
  },
  {
    name: "get_resolution_hints",
    description: "Aggregates symptom keywords (from notes), past tickets on the same serial WITH their resolution notes, and same-product closures. The Knowledge tab uses this to suggest likely resolutions instead of needing an authenticated external-KB query.",
    status: "implemented",
    category: "knowledge",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection('<id>') + ServiceRequestTextCollection nav",
      "/c4codataapi/ServiceRequestCollection?$filter=SerialID eq '<serial>'",
      "/c4codataapi/ServiceRequestCollection?$filter=ProductID eq '<product>' and lifecycle eq '4'",
    ],
    invokedBy: ["Knowledge tab → Resolution Suggestions section", "AI chat (\"how was this fixed before?\" / \"resolution suggestions\")", "Demo playground"],
    notes:
      "Fan-out: up to ~6 SAP requests per call (parent ticket + parent notes + serial history + 3 enriched past-ticket notes + product-history search). Bounded by pastTicketsTop. External KB itself is auth-walled, so this tool surfaces resolution context from data we DO have access to + builds multi-angle search URLs for the user to open externally.",
  },
  {
    name: "get_ticket_items",
    description: "Per-ticket line items: labor entries (hours planned vs actual), parts consumed from technician stock, billing requests. Grouped by processing type with rollups for total hours and parts.",
    status: "implemented",
    category: "ticket",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection('<id>')/ServiceRequestItem"],
    invokedBy: ["Ticket Summary panel → Service items section", "AI chat (\"show items\" / \"parts used\" / \"labor logged\")", "Demo playground"],
    notes:
      "Three processing types observed: ZALT (Labor/Travel, dominant), SRP0 (Billing Request), SRP1 (Part Consumption from Technician Stock — rare, confirms grey-stock pattern). Hours are tallied across labor rows; parts consumed are tallied across SRP1 rows. Warranty vs billable split exposes the billable-rework risk on PM tickets.",
  },
  {
    name: "get_ticket_notes",
    description: "Notes / text bodies attached to a ticket, grouped by type code.",
    status: "implemented",
    category: "history",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestTextCollection?$filter=ParentObjectID eq '<id>'"],
    invokedBy: ["Service History tab (future text-row block)", "AI chat (\"what did the customer say?\")", "Demo playground"],
    notes: "Returns rows + a type summary (count per TypeCodeText) so the UI can group notes cleanly. Not cached — notes can change mid-call.",
  },
  {
    name: "get_serial_history",
    description: "Past service tickets for the same SerialID — equipment-level history across customers and time.",
    status: "implemented",
    category: "history",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection?$filter=SerialID eq '<serial>'"],
    invokedBy: ["Service History tab → Equipment sub-tab", "AI chat (\"history for this serial\")", "Demo playground"],
    notes: "Returns lifecycle buckets + distinct customer list alongside the raw rows.",
  },
  {
    name: "get_account_open_tickets",
    description: "Service tickets for a customer (Buyer Party ID). Defaults to open only.",
    status: "implemented",
    category: "customer",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection?$filter=BuyerPartyID eq '<id>' and ServiceRequestLifeCycleStatusCode lt '4'",
    ],
    invokedBy: ["Ticket summary popover (Customer Context section)", "AI chat (\"other open tickets for this customer\")", "Demo playground"],
    notes: "Returns rows + lifecycle bucket counts (open / in_process / completed / closed) for quick summarisation.",
  },
  {
    name: "get_account",
    description: "Customer master record by AccountID (the human ID, e.g. 1000001).",
    status: "implemented",
    category: "customer",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/CorporateAccountCollection?$filter=AccountID eq '<id>'",
      "/c4codataapi/CorporateAccountCollection('<id>')  (32-char ObjectID fallback)",
    ],
    invokedBy: ["Hover over customer name in ticket header (future)", "AI chat", "Demo playground"],
    notes: "Returns the first matching row, plus a `source` field indicating whether it was matched by AccountID search or ObjectID key.",
  },
  {
    name: "get_account_contacts",
    description: "All contacts at a customer account (by AccountID).",
    status: "implemented",
    category: "customer",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ContactCollection?$filter=AccountID eq '<id>'"],
    invokedBy: ["Customer Context section", "AI chat (\"who can I reach at this customer?\")", "Demo playground"],
    notes: "Returns rows + a summary of work / mobile / email contact info presence so the UI can prioritise contacts to surface.",
  },
  {
    name: "get_registered_product",
    description: "Installed equipment registered for a customer.",
    status: "planned",
    category: "customer",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/RegisteredProductCollection?$filter=BuyerPartyID eq '<id>'"],
    invokedBy: ["Customer Context section", "Closure Readiness"],
    effortHours: 1.5,
  },
  {
    name: "get_installed_base",
    description: "Customer-site equipment hierarchy (parent unit + sub-components).",
    status: "planned",
    category: "customer",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/InstalledBaseCollection?$filter=BuyerPartyID eq '<id>'"],
    invokedBy: ["Customer Context section", "Future: Asset tree viewer"],
    effortHours: 2,
  },
  {
    name: "get_warranty",
    description: "Warranty terms for a product/serial.",
    status: "planned",
    category: "customer",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/WarrantyCollection?$filter=SerialID eq '<serial>'"],
    invokedBy: ["FSE brief", "Closure Readiness"],
    effortHours: 1,
  },
  {
    name: "get_service_contract",
    description: "Service contract + SLA + coverage for a ticket / customer.",
    status: "planned",
    category: "customer",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ContractCollection('<id>')"],
    invokedBy: ["Ticket summary (Coverage line)", "FSE brief"],
    effortHours: 1.5,
  },
  {
    name: "get_sla",
    description: "SLA definition (response time, resolution time).",
    status: "planned",
    category: "customer",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceLevelObjectiveCollection('<id>')"],
    invokedBy: ["KPI tile (SLA risk)", "Closure Readiness"],
    effortHours: 1,
  },

  // =========================================================================
  // PLANNED — Tier 2: technician / dispatch / activities
  // =========================================================================
  {
    name: "search_employees",
    description: "Find employees by name / region substring.",
    status: "implemented",
    category: "technician",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/EmployeeCollection"],
    invokedBy: ["Scheduler candidate-tech search", "AI chat (\"find techs in EU\")", "Demo playground"],
    notes: "Substring match against FormattedName / FirstName / LastName / Region. Useful as a name → PartyID resolver for the other 'My …' tools.",
  },
  {
    name: "get_employee_availability",
    description: "Today's / future appointments for a tech.",
    status: "planned",
    category: "scheduling",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/AppointmentActivityCollection?$filter=OwnerPartyID eq '<id>'"],
    invokedBy: ["Team Calendar tab", "Scheduler"],
    effortHours: 1.5,
  },
  {
    name: "get_team_roster",
    description: "Members of an org unit (Service Execution Team).",
    status: "planned",
    category: "technician",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/EmployeeOrganisationalUnitAssignmentCollection?$filter=OrganisationalUnitID eq '<id>'"],
    invokedBy: ["Scheduler", "Manager role views"],
    effortHours: 1.5,
  },
  {
    name: "get_territory",
    description: "Service territory definitions.",
    status: "planned",
    category: "geo",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/TerritoryCollection"],
    invokedBy: ["Dispatch geo-filtering", "Scheduler"],
    effortHours: 1,
  },
  {
    name: "search_appointments",
    description: "Find calendar appointments (visits / meetings). Filter by owner (tech) or account.",
    status: "implemented",
    category: "scheduling",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/AppointmentCollection"],
    invokedBy: ["Team Calendar tab", "Scheduler", "Demo playground"],
    notes: "Uses root AppointmentCollection (AppointmentActivityCollection does not exist in this tenant). Filter by OwnerPartyID and/or MainAccountPartyID.",
  },
  {
    name: "search_tasks",
    description: "Find tasks (follow-ups, callbacks, etc.).",
    status: "planned",
    category: "scheduling",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/TaskCollection"],
    invokedBy: ["Future Activities tab", "AI chat"],
    effortHours: 0.5,
  },
  {
    name: "search_phone_calls",
    description: "Recent phone-call activities with the customer.",
    status: "planned",
    category: "scheduling",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/PhoneCallActivityCollection?$filter=AccountID eq '<id>'"],
    invokedBy: ["Customer Context section", "AI chat"],
    effortHours: 0.5,
  },
  {
    name: "search_visits",
    description: "Field visits for a customer / tech.",
    status: "planned",
    category: "scheduling",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/VisitCollection"],
    invokedBy: ["Team Calendar", "Future Visit log tab"],
    effortHours: 1,
  },

  // =========================================================================
  // PLANNED — Parts & materials
  // =========================================================================
  {
    name: "search_parts",
    description: "Parts with tracked stock anywhere — grouped by MaterialID with aggregate on-hand qty across locations.",
    status: "implemented",
    category: "parts",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/StockLocationItemCollection"],
    invokedBy: ["Parts Readiness panel", "AI chat (\"do we have part XYZ?\")", "Demo playground"],
    notes:
      "ProductCollection is read-restricted in this tenant (RBAM_ERROR), so the parts catalogue is derived from StockLocationItemCollection rows + past ServiceRequestItem line items. Search uses STANDARD fields only: MaterialID substring, ProductID / ProductIDExternalKey exact (via line items), or ProductDescription substring (via line items). KUT_PRODUCTEXTID_KUT is NOT used here (clarified v0.26.68 — that custom KUT field is unrelated to parts ordering).",
  },
  {
    name: "get_part_availability",
    description: "Per-location stock for one MaterialID. Returns totals (usable / blocked / consignment / inspection) + per-row detail.",
    status: "implemented",
    category: "parts",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/StockLocationItemCollection?$filter=MaterialID eq '<id>'"],
    invokedBy: ["Parts Readiness panel (fuel real numbers)", "FSE brief", "AI chat (\"stock for part X\")", "Demo playground"],
    notes: "Real-time stock data — not cached. Each row is one stock-location-batch combo.",
  },
  {
    name: "get_pm_kit",
    description: "Standard PM kit (BOM) for a serial / model.",
    status: "considered",
    category: "parts",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["(no exposed BOM entity found in this tenant — verify with SAP team)"],
    invokedBy: ["Parts Readiness panel"],
    notes:
      "Blocked: probed all 1950 entity sets in this tenant's $metadata — no MaterialQuantityComponentCollection, BillOfMaterialsCollection, or similar exists. Either the BOM lives in a different OData service or it's not exposed at all. Confirm with SAP team before scoping.",
    effortHours: 5,
  },

  // =========================================================================
  // PLANNED — Knowledge / categorization
  // =========================================================================
  {
    name: "get_ticket_kb_articles",
    description: "KB articles / solution proposals linked to a ticket. Honest about how sparsely the SAP KB-link is populated in this tenant.",
    status: "implemented",
    category: "knowledge",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection('<id>')/ServiceRequestSolutionProposal",
    ],
    invokedBy: ["Knowledge suggestions panel", "AI chat (\"any KB on this?\" / \"knowledge base\")", "Demo playground"],
    notes: "SAP's global KnowledgeBaseArticleCollection is not exposed in this tenant. The closest entity is per-ticket SolutionProposal — most rows are empty, so the tool returns total + populated/empty split.",
  },
  {
    name: "get_issue_category_tree",
    description: "Incident / cause / resolution category catalogue.",
    status: "planned",
    category: "knowledge",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceIssueCategoryCatalogueCollection"],
    invokedBy: ["Ticket categorisation pickers", "Auto-mode categorisation suggestions"],
    effortHours: 2,
  },

  // =========================================================================
  // PLANNED — Analytics / scope filters
  // =========================================================================
  {
    name: "get_ticket_stats",
    description: "Aggregate ticket counts (open / closed / escalated / SLA-at-risk).",
    status: "planned",
    category: "analytics",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection?$inlinecount=allpages with filters"],
    invokedBy: ["KPI tiles (replaces single-ticket derivation)", "AI chat"],
    effortHours: 1.5,
  },
  {
    name: "get_duration_stats",
    description: "Planned-vs-actual processing hours across closed tickets — p10/median/p90 + overshoot ratio. Surfaces planning-confidence gaps.",
    status: "implemented",
    category: "analytics",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection?$filter=ServiceRequestLifeCycleStatusCode eq '4' and ProductID eq '<id>'",
    ],
    invokedBy: ["AI chat (\"duration stats for product X\")", "Future KPI tile (\"planning confidence\")", "Demo playground"],
    notes:
      "Reads RequestedTotalProcessingDuration (planned, ISO 8601) and computes actual from RequestInProcessdatetimeContent → RequestCloseddatetimeContent. Drops rows with missing endpoints.",
  },
  {
    name: "get_sla_at_risk",
    description: "Tickets at risk of breaching SLA in the next N hours (default 24).",
    status: "implemented",
    category: "analytics",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection?$filter=CompleteDuedatetimeContent lt datetimeoffset'<now+Nh>' and CompleteDuedatetimeContent gt datetimeoffset'1970-01-01T00:00:00Z' and ServiceRequestLifeCycleStatusCode lt '4'",
    ],
    invokedBy: ["KPI tile (\"SLA risk\")", "Manager dashboard", "Demo playground"],
    notes: "Returns rows with `hoursUntilDue` computed + priority buckets (immediate/urgent/normal/low).",
  },
  {
    name: "get_my_tickets",
    description: "Tickets assigned to a specific processor (Agent scope). Defaults to open tickets.",
    status: "implemented",
    category: "analytics",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection?$filter=ProcessorPartyID eq '<id>' and ServiceRequestLifeCycleStatusCode lt '4'",
      "/c4codataapi/ServiceRequestCollection?$filter=ProcessorPartyUUID eq guid'<uuid>' …",
    ],
    invokedBy: ["Recent dropdown (Agent role)", "AI chat (\"my tickets\")", "Demo playground"],
    notes: "Returns rows + lifecycle bucket counts. Accepts either ProcessorPartyID (human ID) or ProcessorPartyUUID.",
  },
  {
    name: "get_my_team_tickets",
    description: "Tickets routed to a service execution team (Manager scope). Includes per-processor breakdown.",
    status: "implemented",
    category: "analytics",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "/c4codataapi/ServiceRequestCollection?$filter=ServiceExecutionTeamPartyID eq '<id>' …",
      "/c4codataapi/ServiceRequestCollection?$filter=ServiceExecutionTeamPartyUUID eq guid'<uuid>' …",
    ],
    invokedBy: ["Recent dropdown (Manager role)", "AI chat (\"team backlog\")", "Demo playground"],
    notes: "Returns rows, lifecycle buckets, and per-processor breakdown (workload distribution).",
  },

  // =========================================================================
  // PLANNED — Geo / nearby
  // =========================================================================
  {
    name: "search_nearby_tickets",
    description: "Tickets within radius of a lat/lon — drives the Nearby PM map.",
    status: "considered",
    category: "geo",
    storage: "live",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["/c4codataapi/ServiceRequestCollection (custom KUT lat/lon filter)"],
    invokedBy: ["Nearby PM tab"],
    notes: "C4C OData doesn't do native geo — needs post-filter on KUT_RPLatitude_KUT.",
    effortHours: 3,
  },
  {
    name: "geocode_address",
    description: "Resolve a ZIP / address to lat/lon (external geocoder).",
    status: "considered",
    category: "geo",
    storage: "local-db",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [],
    invokedBy: ["Service-location resolver", "Nearby PM map anchoring"],
    notes: "Outside SAP — Nominatim / Mapbox / Google. Needs API key.",
    effortHours: 2,
  },

  // =========================================================================
  // WRITE TOOLS — Phase 2, makes Auto-mode real
  // =========================================================================
  {
    name: "update_ticket_description",
    description: "PATCH the Service Request Description field.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["PATCH /c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["AI Companion → Auto mode (\"suggest description update\")", "Edit pencil on ticket header"],
    notes: "Requires CSRF token + ETag header. First write tool to wire.",
    writeOperation: true,
    blastRadius: "low",
    effortHours: 3,
  },
  {
    name: "add_service_request_text",
    description: "POST a new note (customer-visible, internal, or work description).",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["POST /c4codataapi/ServiceRequestTextCollection"],
    invokedBy: ["AI Companion → Auto mode (\"add a status note\")", "Future Notes editor"],
    notes: "Append-only — safest write to ship first. Type Code drives whether note is customer-visible.",
    writeOperation: true,
    blastRadius: "low",
    effortHours: 2,
  },
  {
    name: "attach_solution_to_ticket",
    description: "POST an external KB article reference into the ticket's 'Solutions Used' facet (Solution Center tab).",
    status: "implemented",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["POST /c4codataapi/ServiceRequestSolutionProposalCollection"],
    invokedBy: ["/kb-resolve 'Mark as resolution' button (alongside the TypeCode-10022 note)"],
    notes:
      "v0.27.40 — uses the ExternalKnowledgeBaseArticle* fields (ID / URI / Description) designed for non-SAP KBs like MindTouch, plus Note for the facet's Content column. Append-only; self-healing strip-retry for create-not-allowed properties.",
    writeOperation: true,
    blastRadius: "low",
    effortHours: 2,
  },
  {
    name: "update_ticket_priority",
    description: "PATCH ServicePriorityCode.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["PATCH /c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["Edit ticket header", "AI Companion (\"raise priority\")"],
    notes: "Affects SLA calculations — medium risk.",
    writeOperation: true,
    blastRadius: "medium",
    effortHours: 1.5,
  },
  {
    name: "assign_processor",
    description: "PATCH ProcessorPartyUUID to a different employee.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["PATCH /c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["Scheduler → Assign button", "AI Companion (\"assign to <name>\")"],
    writeOperation: true,
    blastRadius: "medium",
    effortHours: 2,
  },
  {
    name: "assign_team",
    description: "PATCH ServiceExecutionTeamPartyUUID.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["PATCH /c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["Scheduler (team reassign)", "Manager actions"],
    writeOperation: true,
    blastRadius: "medium",
    effortHours: 2,
  },
  {
    name: "escalate_ticket",
    description: "PATCH EscalationStatusCode → escalated, with a reason note.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: [
      "PATCH /c4codataapi/ServiceRequestCollection('<id>')",
      "POST /c4codataapi/ServiceRequestTextCollection (audit note)",
    ],
    invokedBy: ["Ticket header Escalate button (Admin role)", "AI Companion (\"escalate this\")"],
    writeOperation: true,
    blastRadius: "medium",
    effortHours: 2.5,
  },
  {
    name: "set_lifecycle_status",
    description: "PATCH ServiceRequestLifeCycleStatusCode (close / reopen / in-process).",
    status: "considered",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["PATCH /c4codataapi/ServiceRequestCollection('<id>')"],
    invokedBy: ["Closure Readiness → close button", "Future state-machine actions"],
    notes: "High blast radius — closing a ticket has downstream effects (billing, SLA stop, notifications).",
    writeOperation: true,
    blastRadius: "high",
    effortHours: 3,
  },
  {
    name: "create_followup_task",
    description: "POST a new Task linked to the current ticket.",
    status: "planned",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["POST /c4codataapi/TaskCollection"],
    invokedBy: ["Closure Readiness", "AI Companion (\"schedule a follow-up\")"],
    writeOperation: true,
    blastRadius: "low",
    effortHours: 2,
  },
  {
    name: "attach_kb_article",
    description: "POST a Solution Proposal linking a KB article (or free-text note) to a ticket. First write tool — gated by dryRun + feature.auto_writeback_enabled.",
    status: "implemented",
    category: "write",
    storage: "n/a",
    cacheTable: null,
    ttlSettingKey: null,
    sapEndpoints: ["POST /c4codataapi/ServiceRequestSolutionProposalCollection"],
    invokedBy: ["Knowledge panel → Attach button", "AI Companion Auto-mode (when feature flag is enabled)", "Demo playground"],
    notes:
      "Two-gate safety: (1) dryRun=true (default) returns the would-be payload without firing; (2) real POST requires feature.auto_writeback_enabled=true in /settings. Includes CSRF token + cookie dance. Append-only entity — lowest blast radius for the first SAP write.",
    writeOperation: true,
    blastRadius: "low",
  },
];

export function getToolInfo(name: string): ToolInfo | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
