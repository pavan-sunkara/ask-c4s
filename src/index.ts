/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatToolError } from "./c4cClient.js";
import {
  addAccountContact,
  addServiceRequestText,
  assignProcessor,
  assignTeam,
  attachKbArticle,
  createAppointment,
  createFollowupTask,
  escalateTicket,
  getAccount,
  getAccountContacts,
  getAccountOpenTickets,
  getCommunicationStream,
  getContract,
  getContractItems,
  getContractsForAccount,
  getDurationStats,
  getEmployeeSkills,
  getFirstTimeFixRate,
  getIssueCategoryTree,
  getMttrByProduct,
  getMyTeamTickets,
  getMyTickets,
  getPartAvailability,
  getRecurringIssues,
  getRepeatVisitRate,
  getResolutionHints,
  getSerialHistory,
  getSlaAtRisk,
  getSurveyResponses,
  getTeamRoster,
  getTicketItems,
  getTicketKbArticles,
  getTicketNotes,
  getKbApiStatus,
  getWorkloadDistribution,
  logPhoneCall,
  logServiceItem,
  searchAppointments,
  searchChats,
  searchCustomerOrders,
  searchEmails,
  searchEmployees,
  searchKbArticles,
  searchKbForTicket,
  searchOpportunities,
  searchOrgUnits,
  searchParts,
  searchPhoneCalls,
  searchSalesQuotes,
  searchTasks,
  updateServiceItemActuals,
  updateTicketDescription,
  updateTicketLifecycle,
  updateTicketPriority,
} from "./serviceOps.js";
// 4 priority service-ticket tools now come from the canonical service module.
// Their implementations currently still live in serviceOps.ts (re-exported);
// a follow-up PR will physically move them once shared helpers are extracted.
import {
  searchTickets,
  getTicket,
  getServiceMetadata,
  getServiceHistory,
} from "./modules/service/index.js";
import { getCodeList, listAvailableCodeLists } from "./codeLists.js";

const server = new McpServer({
  name: "ask-c4s",
  version: "0.1.0"
});

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function textResult(value: string) {
  return {
    content: [{ type: "text" as const, text: value }]
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: formatToolError(error) }]
  };
}

async function runTool(fn: () => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof textResult>>) {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

server.registerTool(
  "search_tickets",
  {
    title: "Search Tickets",
    description:
      "Search SAP Service Cloud service tickets. Start here before opening a specific ticket.",
    inputSchema: {
      top: z.number().int().min(1).max(100).default(10),
      skip: z.number().int().min(0).default(0),
      statusCode: z.string().min(1).optional(),
      odataFilter: z
        .string()
        .min(1)
        .optional()
        .describe("Optional advanced OData $filter expression. It is combined with statusCode when both are provided."),
      orderBy: z
        .string()
        .min(1)
        .optional()
        .describe("Single OData property name, optionally followed by asc or desc.")
    },
    annotations: READ_ONLY_TOOL
  },
  async ({ top, skip, statusCode, odataFilter, orderBy }) =>
    runTool(async () => jsonResult(await searchTickets({ top, skip, statusCode, odataFilter, orderBy })))
);

server.registerTool(
  "get_ticket",
  {
    title: "Get Ticket",
    description: "Get one SAP Service Cloud service ticket by ObjectID.",
    inputSchema: {
      objectId: z.string().min(1),
      expand: z
        .array(z.string().min(1))
        .default([])
        .describe("Optional metadata-discovered navigation properties to expand, such as notes or parties."),
      includeMetadata: z.boolean().default(false)
    },
    annotations: READ_ONLY_TOOL
  },
  async ({ objectId, expand, includeMetadata }) =>
    runTool(async () => jsonResult(await getTicket({ objectId, expand, includeMetadata })))
);

server.registerTool(
  "get_service_metadata",
  {
    title: "Get Service Metadata",
    description:
      "Read SAP C4C OData metadata. Use summary mode to discover ServiceRequest properties and navigation relationships.",
    inputSchema: {
      mode: z.enum(["summary", "raw"]).default("summary"),
      entitySet: z
        .string()
        .min(1)
        .optional()
        .describe("Optional entity set to summarize. Defaults to ServiceRequestCollection when available."),
      refresh: z.boolean().default(false)
    },
    annotations: READ_ONLY_TOOL
  },
  async ({ mode, entitySet, refresh }) =>
    runTool(async () => {
      const result = await getServiceMetadata({ mode, entitySet, refresh });
      return typeof result === "string" ? textResult(result) : jsonResult(result);
    })
);

server.registerTool(
  "get_service_history",
  {
    title: "Get Service History",
    description:
      "Discover likely service-history navigation properties from SAP C4C metadata and read related history for a service ticket ObjectID.",
    inputSchema: {
      objectId: z.string().min(1),
      navigationProperty: z
        .string()
        .min(1)
        .optional()
        .describe("Optional navigation property override from get_service_metadata summary output."),
      top: z.number().int().min(1).max(50).default(20),
      candidateLimit: z.number().int().min(1).max(10).default(5),
      includeDiscovery: z.boolean().default(true),
      refreshMetadata: z.boolean().default(false)
    },
    annotations: READ_ONLY_TOOL
  },
  async ({ objectId, navigationProperty, top, candidateLimit, includeDiscovery, refreshMetadata }) =>
    runTool(async () =>
      jsonResult(
        await getServiceHistory({
          objectId,
          navigationProperty,
          top,
          candidateLimit,
          includeDiscovery,
          refreshMetadata
        })
      )
    )
);

server.registerTool(
  "search_employees",
  {
    title: "Search Employees",
    description: "Search SAP employees by name or region.",
    inputSchema: {
      query: z.string().min(1).optional(),
      region: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ query, region, top }) =>
    runTool(async () => jsonResult(await searchEmployees({ query, region, top }))),
);

server.registerTool(
  "get_my_tickets",
  {
    title: "Get My Tickets",
    description: "Tickets assigned to a specific processor (Agent scope). Defaults to open tickets.",
    inputSchema: {
      processorPartyId: z.string().min(1).optional(),
      processorPartyUuid: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
      includeClosed: z.boolean().default(false),
      orderBy: z.string().min(1).optional(),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ processorPartyId, processorPartyUuid, top, includeClosed, orderBy }) =>
    runTool(async () => jsonResult(await getMyTickets({ processorPartyId, processorPartyUuid, top, includeClosed, orderBy }))),
);

server.registerTool(
  "get_my_team_tickets",
  {
    title: "Get My Team Tickets",
    description: "Tickets routed to a service execution team (Manager scope). Includes per-processor breakdown.",
    inputSchema: {
      teamPartyId: z.string().min(1).optional(),
      teamPartyUuid: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(50),
      includeClosed: z.boolean().default(false),
      orderBy: z.string().min(1).optional(),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ teamPartyId, teamPartyUuid, top, includeClosed, orderBy }) =>
    runTool(async () => jsonResult(await getMyTeamTickets({ teamPartyId, teamPartyUuid, top, includeClosed, orderBy }))),
);

server.registerTool(
  "get_account_contacts",
  {
    title: "Get Account Contacts",
    description: "Contacts at a customer account (by AccountID).",
    inputSchema: {
      accountId: z.string().min(1),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ accountId, top }) =>
    runTool(async () => jsonResult(await getAccountContacts({ accountId, top }))),
);

server.registerTool(
  "search_appointments",
  {
    title: "Search Appointments",
    description: "Find calendar appointments (visits / meetings). Filter by owner (tech) or account.",
    inputSchema: {
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
      orderBy: z.string().min(1).optional(),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ ownerPartyId, accountPartyId, top, orderBy }) =>
    runTool(async () => jsonResult(await searchAppointments({ ownerPartyId, accountPartyId, top, orderBy }))),
);

server.registerTool(
  "get_serial_history",
  {
    title: "Get Serial History",
    description: "Past service tickets for a specific equipment serial number — equipment-level history across customers and time.",
    inputSchema: {
      serialId: z.string().min(1),
      top: z.number().int().min(1).max(100).default(25),
      includeClosed: z.boolean().default(true),
      orderBy: z.string().min(1).optional(),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ serialId, top, includeClosed, orderBy }) =>
    runTool(async () => jsonResult(await getSerialHistory({ serialId, top, includeClosed, orderBy }))),
);

server.registerTool(
  "search_kb_articles",
  {
    title: "Search KB Articles",
    description:
      "Free-text search against the external knowledge base (Azure AD-protected, MindTouch /@api/deki/site/search). Returns ok=false with a setup-guidance message when Azure AD credentials aren't configured yet.",
    inputSchema: {
      query: z.string().min(1),
      top: z.number().int().min(1).max(50).default(10),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ query, top }) =>
    runTool(async () => jsonResult(await searchKbArticles({ query, top }))),
);

server.registerTool(
  "search_kb_for_ticket",
  {
    title: "Search KB for Ticket",
    description:
      "Derive 2-3 smart KB search queries from a ticket's symptom keywords + product, run them against the external KB, dedupe + merge results ranked by score. Falls back to link-out when Azure AD isn't configured.",
    inputSchema: {
      objectId: z.string().min(1),
      queries: z.array(z.string().min(1)).optional(),
      topPerQuery: z.number().int().min(1).max(20).default(6),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId, queries, topPerQuery }) =>
    runTool(async () =>
      jsonResult(await searchKbForTicket({ objectId, queries, topPerQuery })),
    ),
);

server.registerTool(
  "get_kb_api_status",
  {
    title: "Get KB API Status",
    description:
      "Reports whether the external KB API is reachable: Azure AD config presence, KB base URL, scope. Public-safe (never returns secrets). Use this from the admin UI to verify connectivity before relying on KB search.",
    inputSchema: {},
    annotations: READ_ONLY_TOOL,
  },
  async () => runTool(async () => jsonResult(await getKbApiStatus())),
);

server.registerTool(
  "get_resolution_hints",
  {
    title: "Get Resolution Hints",
    description:
      "Aggregate resolution context for a ticket: mines symptom keywords from the customer's notes, fetches past tickets on the same serial (with their notes — i.e. what was done before), past closed tickets on the same product, and builds multi-angle KB search queries the caller can hand to an external knowledge base.",
    inputSchema: {
      objectId: z.string().min(1),
      pastTicketsTop: z.number().int().min(1).max(20).default(5),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId, pastTicketsTop }) =>
    runTool(async () =>
      jsonResult(await getResolutionHints({ objectId, pastTicketsTop })),
    ),
);

server.registerTool(
  "get_ticket_items",
  {
    title: "Get Ticket Items",
    description:
      "Service-request line items: per-ticket labor entries (hours planned vs actual), parts consumed (technician stock), and billing requests. Grouped by processing type with rollups for total hours, parts consumed, and billable-vs-warranty mix.",
    inputSchema: {
      objectId: z.string().min(1),
      top: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId, top }) =>
    runTool(async () => jsonResult(await getTicketItems({ objectId, top }))),
);

server.registerTool(
  "get_ticket_kb_articles",
  {
    title: "Get Ticket KB Articles",
    description:
      "Knowledge-base articles / solution proposals attached to a service ticket (SAP ServiceRequestSolutionProposalCollection). Returns rows + a populated-vs-empty split so callers can tell if the tenant is actually using the KB feature.",
    inputSchema: {
      objectId: z.string().min(1),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId, top }) =>
    runTool(async () => jsonResult(await getTicketKbArticles({ objectId, top }))),
);

server.registerTool(
  "get_ticket_notes",
  {
    title: "Get Ticket Notes",
    description: "Read the customer-visible and internal notes / text bodies attached to a ticket, grouped by type code.",
    inputSchema: {
      objectId: z.string().min(1),
      top: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId, top }) =>
    runTool(async () => jsonResult(await getTicketNotes({ objectId, top }))),
);

server.registerTool(
  "get_account",
  {
    title: "Get Account",
    description: "Customer master record by AccountID (the human ID, e.g. 1000001). Falls back to ObjectID lookup if input is a 32-char hex.",
    inputSchema: {
      accountId: z.string().min(1),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ accountId }) =>
    runTool(async () => jsonResult(await getAccount({ accountId }))),
);

server.registerTool(
  "get_sla_at_risk",
  {
    title: "Get SLA-at-risk Tickets",
    description: "Tickets at risk of breaching SLA in the next N hours (CompleteDuedatetimeContent < now+N AND not Closed).",
    inputSchema: {
      hoursAhead: z.number().int().min(1).max(168).default(24),
      top: z.number().int().min(1).max(100).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ hoursAhead, top }) =>
    runTool(async () => jsonResult(await getSlaAtRisk({ hoursAhead, top }))),
);

server.registerTool(
  "get_account_open_tickets",
  {
    title: "Get Account Open Tickets",
    description:
      "List service tickets for a customer (Buyer Party ID). Defaults to open tickets only (lifecycle != Closed); pass includeClosed=true to see all.",
    inputSchema: {
      buyerPartyId: z.string().min(1),
      top: z.number().int().min(1).max(100).default(25),
      includeClosed: z.boolean().default(false),
      orderBy: z.string().min(1).optional().describe("Single OData property, optionally followed by asc or desc."),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ buyerPartyId, top, includeClosed, orderBy }) =>
    runTool(async () => jsonResult(await getAccountOpenTickets({ buyerPartyId, top, includeClosed, orderBy }))),
);

server.registerTool(
  "get_employee_skills",
  {
    title: "Get Employee Skills",
    description:
      "List technicians from SAP C4C EmployeeCollection and derive expertise from products they have serviced in recent tickets. Falls back to ServicePerformerPartyName when EmployeeCollection is restricted.",
    inputSchema: {
      top: z.number().int().min(1).max(50).default(20),
      ticketSampleSize: z.number().int().min(10).max(200).default(100),
      productHint: z
        .string()
        .min(1)
        .optional()
        .describe("Optional product / serial hint used to rank technicians by match."),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ top, ticketSampleSize, productHint }) =>
    runTool(async () =>
      jsonResult(await getEmployeeSkills({ top, ticketSampleSize, productHint })),
    ),
);

server.registerTool(
  "search_parts",
  {
    title: "Search Parts",
    description:
      "List parts (materials) that have any tracked stock anywhere, grouped by MaterialID with aggregate on-hand qty. Sources data from StockLocationItemCollection because ProductCollection is read-restricted in this tenant.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Match against standard ServiceRequestItem/StockLocationItem fields: MaterialID (substring), ProductID / ProductIDExternalKey (exact, via past line items), or ProductDescription (substring, via past line items)."),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ query, top }) =>
    runTool(async () => jsonResult(await searchParts({ query, top }))),
);

server.registerTool(
  "get_part_availability",
  {
    title: "Get Part Availability",
    description:
      "Stock-on-hand for a specific material across every warehouse / stock-location row. Returns totals (usable / blocked / consignment / quality-inspection) plus per-location detail.",
    inputSchema: {
      materialId: z.string().min(1),
      top: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ materialId, top }) =>
    runTool(async () => jsonResult(await getPartAvailability({ materialId, top }))),
);

server.registerTool(
  "get_duration_stats",
  {
    title: "Get Duration Stats",
    description:
      "Planned-vs-actual processing-duration statistics across closed tickets matching a product (and/or buyer). Returns p10/median/p90 for planned hours, actual hours, and the (actual - planned)/planned overshoot ratio.",
    inputSchema: {
      productId: z.string().min(1).optional(),
      buyerPartyId: z.string().min(1).optional(),
      sampleSize: z.number().int().min(10).max(500).default(100),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ productId, buyerPartyId, sampleSize }) =>
    runTool(async () => jsonResult(await getDurationStats({ productId, buyerPartyId, sampleSize }))),
);

server.registerTool(
  "attach_kb_article",
  {
    title: "Attach KB Article (write)",
    description:
      "Create a ServiceRequestSolutionProposal row linking a KB article (or free-text note) to a ticket. SAFE BY DEFAULT: dryRun=true returns the would-be payload without firing. Real POST also requires feature.auto_writeback_enabled=true in /settings.",
    inputSchema: {
      objectId: z.string().min(1).describe("Parent ticket ObjectID."),
      articleId: z.string().min(1).optional(),
      articleUri: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      note: z.string().min(1).optional(),
      dryRun: z.boolean().default(true).describe("Default true. Set false to attempt a real SAP POST (still requires the feature flag)."),
      acknowledgeProduction: z.boolean().default(false).describe("Must be true when the active tenant is tagged production. Blocks production writes by default."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ objectId, articleId, articleUri, description, note, dryRun, acknowledgeProduction }) =>
    runTool(async () =>
      jsonResult(
        await attachKbArticle({
          objectId,
          articleId,
          articleUri,
          description,
          note,
          dryRun,
          acknowledgeProduction,
        }),
      ),
    ),
);

server.registerTool(
  "list_code_lists",
  {
    title: "List Code Lists",
    description:
      "Return all known SAP code lists and their local-cache status (rowCount, age, ttl, freshness).",
    inputSchema: {},
    annotations: READ_ONLY_TOOL,
  },
  async () => runTool(async () => jsonResult({ lists: listAvailableCodeLists() })),
);

server.registerTool(
  "get_code_list",
  {
    title: "Get Code List",
    description:
      "Return the items of a named SAP code list. Cached locally for 24h (skill_master: 4h). Pass refresh=true to bypass cache and re-fetch from SAP.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe(
          "Code list name. Known names: lifecycle_status, user_lifecycle_status, service_priority, processing_type, escalation_status, document_language, distribution_channel, division, data_origin_type, kut_secondary_ticket_type, skill_master",
        ),
      refresh: z.boolean().default(false),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ name, refresh }) =>
    runTool(async () => jsonResult(await getCodeList(name, { refresh }))),
);

// ===========================================================================
// ====================  TIER 1 READS — ACTIVITIES  ==========================
// ===========================================================================

const WRITE_ANNOTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const WRITE_INPUT_BASE = {
  dryRun: z.boolean().default(true).describe("Default true — returns the would-be payload without firing."),
  acknowledgeProduction: z.boolean().default(false).describe("Required when active tenant is tagged production."),
};

server.registerTool(
  "search_tasks",
  {
    title: "Search Tasks",
    description: "Find Tasks (follow-ups, callbacks) by owner / account / status.",
    inputSchema: {
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      status: z.string().min(1).optional().describe("Status code: 1=Open, 2=InProcess, 3=Completed, 4=Canceled"),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ ownerPartyId, accountPartyId, status, top }) =>
    runTool(async () => jsonResult(await searchTasks({ ownerPartyId, accountPartyId, status, top }))),
);

server.registerTool(
  "search_phone_calls",
  {
    title: "Search Phone Calls",
    description: "Phone call activities filtered by owner or account.",
    inputSchema: {
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ ownerPartyId, accountPartyId, top }) =>
    runTool(async () => jsonResult(await searchPhoneCalls({ ownerPartyId, accountPartyId, top }))),
);

server.registerTool(
  "search_emails",
  {
    title: "Search Emails",
    description:
      "Email activities (sent + received) filtered by owner or account. " +
      "Set includeBody=true to fan-out and fetch each email's body text via " +
      "the EMailItem child entity (slower; bounded by top).",
    inputSchema: {
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
      includeBody: z.boolean().optional().default(false),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ ownerPartyId, accountPartyId, top, includeBody }) =>
    runTool(async () => jsonResult(await searchEmails({ ownerPartyId, accountPartyId, top, includeBody }))),
);

server.registerTool(
  "search_chats",
  {
    title: "Search Chat Activities",
    description: "Chat transcripts filtered by account.",
    inputSchema: {
      accountPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ accountPartyId, top }) =>
    runTool(async () => jsonResult(await searchChats({ accountPartyId, top }))),
);

server.registerTool(
  "get_communication_stream",
  {
    title: "Get Communication Stream",
    description: "Unified time-ordered stream of tasks + phone calls + emails + chats for one account.",
    inputSchema: {
      accountPartyId: z.string().min(1),
      topPerType: z.number().int().min(1).max(50).default(10),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ accountPartyId, topPerType }) =>
    runTool(async () => jsonResult(await getCommunicationStream({ accountPartyId, topPerType }))),
);

// ----- Contracts -----
server.registerTool(
  "get_contract",
  {
    title: "Get Contract",
    description: "One service contract by ObjectID.",
    inputSchema: { objectId: z.string().min(1) },
    annotations: READ_ONLY_TOOL,
  },
  async ({ objectId }) => runTool(async () => jsonResult(await getContract({ objectId }))),
);

server.registerTool(
  "get_contracts_for_account",
  {
    title: "Get Contracts for Account",
    description: "All contracts for a customer with active/expired counts.",
    inputSchema: {
      buyerPartyId: z.string().min(1),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ buyerPartyId, top }) =>
    runTool(async () => jsonResult(await getContractsForAccount({ buyerPartyId, top }))),
);

server.registerTool(
  "get_contract_items",
  {
    title: "Get Contract Items",
    description: "Line items / entitlements on a service contract.",
    inputSchema: {
      contractObjectId: z.string().min(1),
      top: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ contractObjectId, top }) =>
    runTool(async () => jsonResult(await getContractItems({ contractObjectId, top }))),
);

// ----- Sales / orders -----
server.registerTool(
  "search_sales_quotes",
  {
    title: "Search Sales Quotes",
    description: "Sales quotes by buyer or owner.",
    inputSchema: {
      buyerPartyId: z.string().min(1).optional(),
      ownerPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ buyerPartyId, ownerPartyId, top }) =>
    runTool(async () => jsonResult(await searchSalesQuotes({ buyerPartyId, ownerPartyId, top }))),
);

server.registerTool(
  "search_customer_orders",
  {
    title: "Search Customer Orders",
    description: "Customer orders by buyer.",
    inputSchema: {
      buyerPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ buyerPartyId, top }) =>
    runTool(async () => jsonResult(await searchCustomerOrders({ buyerPartyId, top }))),
);

server.registerTool(
  "search_opportunities",
  {
    title: "Search Opportunities",
    description: "Sales opportunities by buyer or owner.",
    inputSchema: {
      buyerPartyId: z.string().min(1).optional(),
      ownerPartyId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ buyerPartyId, ownerPartyId, top }) =>
    runTool(async () => jsonResult(await searchOpportunities({ buyerPartyId, ownerPartyId, top }))),
);

// ----- Org / surveys -----
server.registerTool(
  "search_org_units",
  {
    title: "Search Org Units",
    description: "Service teams + organisational units by ID substring.",
    inputSchema: {
      query: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(50),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ query, top }) =>
    runTool(async () => jsonResult(await searchOrgUnits({ query, top }))),
);

server.registerTool(
  "get_team_roster",
  {
    title: "Get Team Roster",
    description: "Employees assigned to a specific org unit.",
    inputSchema: {
      orgUnitId: z.string().min(1),
      top: z.number().int().min(1).max(200).default(100),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ orgUnitId, top }) =>
    runTool(async () => jsonResult(await getTeamRoster({ orgUnitId, top }))),
);

server.registerTool(
  "get_survey_responses",
  {
    title: "Get Survey Responses",
    description: "Customer satisfaction survey responses, optionally filtered by ticket.",
    inputSchema: {
      ticketObjectId: z.string().min(1).optional(),
      top: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ ticketObjectId, top }) =>
    runTool(async () => jsonResult(await getSurveyResponses({ ticketObjectId, top }))),
);

server.registerTool(
  "get_issue_category_tree",
  {
    title: "Get Issue Category Tree",
    description: "Service issue category catalogue (incident / cause / resolution taxonomy).",
    inputSchema: { top: z.number().int().min(1).max(100).default(50) },
    annotations: READ_ONLY_TOOL,
  },
  async ({ top }) => runTool(async () => jsonResult(await getIssueCategoryTree({ top }))),
);

// ===========================================================================
// =================  TIER 2 WRITES — gated by dry-run + flag  ===============
// ===========================================================================

server.registerTool(
  "update_ticket_description",
  {
    title: "Update Ticket Description (write)",
    description: "PATCH ServiceRequest.Description. Dry-run by default.",
    inputSchema: {
      objectId: z.string().min(1),
      description: z.string().min(1),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) =>
    runTool(async () => jsonResult(await updateTicketDescription(args as any))),
);

server.registerTool(
  "update_ticket_priority",
  {
    title: "Update Ticket Priority (write)",
    description: "PATCH ServicePriorityCode. 1=Immediate / 2=Urgent / 3=Normal / 7=Low.",
    inputSchema: {
      objectId: z.string().min(1),
      servicePriorityCode: z.string().min(1),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) =>
    runTool(async () => jsonResult(await updateTicketPriority(args as any))),
);

server.registerTool(
  "update_ticket_lifecycle",
  {
    title: "Update Ticket Lifecycle (write)",
    description: "PATCH ServiceRequestLifeCycleStatusCode. 1=Open / 2=InProcess / 3=Completed / 4=Closed.",
    inputSchema: {
      objectId: z.string().min(1),
      lifecycleStatusCode: z.string().min(1),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) =>
    runTool(async () => jsonResult(await updateTicketLifecycle(args as any))),
);

server.registerTool(
  "escalate_ticket",
  {
    title: "Escalate Ticket (write)",
    description: "PATCH EscalationStatusCode to Escalated. Optional reason captured in audit log.",
    inputSchema: {
      objectId: z.string().min(1),
      reason: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await escalateTicket(args as any))),
);

server.registerTool(
  "assign_processor",
  {
    title: "Assign Processor (write)",
    description: "PATCH ProcessorPartyUUID to a different employee.",
    inputSchema: {
      objectId: z.string().min(1),
      processorPartyUuid: z.string().min(1),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await assignProcessor(args as any))),
);

server.registerTool(
  "assign_team",
  {
    title: "Assign Team (write)",
    description: "PATCH ServiceExecutionTeamPartyID to a different team.",
    inputSchema: {
      objectId: z.string().min(1),
      teamPartyId: z.string().min(1),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await assignTeam(args as any))),
);

server.registerTool(
  "add_service_request_text",
  {
    title: "Add Service Request Text (write)",
    description: "POST a note / resolution writeup to a ticket. Default TypeCode 10022 (Service Response Report).",
    inputSchema: {
      objectId: z.string().min(1),
      text: z.string().min(1),
      typeCode: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) =>
    runTool(async () => jsonResult(await addServiceRequestText(args as any))),
);

server.registerTool(
  "log_service_item",
  {
    title: "Log Service Item (write)",
    description: "POST a labor / parts / billing line to a ticket. Directly closes the grey-stock gap when used for SRP1. NOTE: some tenants use custom Z-prefix codes (e.g., ZRP1 for parts) — accept any 3-5 char alphanumeric code so tenant variance doesn't reject the write before it reaches SAP.",
    inputSchema: {
      objectId: z.string().min(1),
      // v0.26.51 — was z.enum(["SRP1", "ZALT", "SRP0"]). Reporter's
      // Thermo Fisher tenant uses ZRP1 (Z = customer extension) and
      // the strict enum rejected the write at the shim before SAP
      // ever saw it. Loosened to any 3-5 char alphanumeric so custom
      // tenant codes pass through to SAP for actual validation.
      processingTypeCode: z.string().regex(/^[A-Z][A-Z0-9]{2,4}$/, "Expected a 3-5 char alphanumeric SAP type code (e.g., SRP1, ZRP1, ZALT)"),
      productId: z.string().min(1),
      quantity: z.number(),
      uomCode: z.string().min(1).optional(),
      warrantyCode: z.string().min(1).optional(),
      servicePerformerPartyId: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await logServiceItem(args as any))),
);

server.registerTool(
  "update_service_item_actuals",
  {
    title: "Update Service Item Actuals (write)",
    description: "PATCH ActualQuantity / ActualStart / ActualEnd on an existing item.",
    inputSchema: {
      itemObjectId: z.string().min(1),
      actualQuantity: z.number().optional(),
      actualStartDateTime: z.string().min(1).optional(),
      actualEndDateTime: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) =>
    runTool(async () => jsonResult(await updateServiceItemActuals(args as any))),
);

server.registerTool(
  "create_followup_task",
  {
    title: "Create Follow-up Task (write)",
    description: "POST a new Task. Subject is required; owner / account / due-date optional.",
    inputSchema: {
      subject: z.string().min(1),
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      dueDateTime: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await createFollowupTask(args as any))),
);

server.registerTool(
  "create_appointment",
  {
    title: "Create Appointment (write)",
    description: "POST a new Appointment / visit.",
    inputSchema: {
      subject: z.string().min(1),
      startDateTime: z.string().min(1),
      endDateTime: z.string().min(1),
      ownerPartyId: z.string().min(1).optional(),
      accountPartyId: z.string().min(1).optional(),
      location: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await createAppointment(args as any))),
);

server.registerTool(
  "log_phone_call",
  {
    title: "Log Phone Call (write)",
    description: "POST a new PhoneCall activity.",
    inputSchema: {
      subject: z.string().min(1),
      startDateTime: z.string().min(1),
      endDateTime: z.string().min(1).optional(),
      initiatorCode: z.enum(["1", "2"]).optional().describe("1=Outbound, 2=Inbound"),
      accountPartyId: z.string().min(1).optional(),
      contactPartyId: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await logPhoneCall(args as any))),
);

server.registerTool(
  "add_account_contact",
  {
    title: "Add Account Contact (write)",
    description: "POST a new Contact bound to an Account.",
    inputSchema: {
      accountId: z.string().min(1),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      jobTitle: z.string().min(1).optional(),
      ...WRITE_INPUT_BASE,
    },
    annotations: WRITE_ANNOTATION,
  },
  async (args) => runTool(async () => jsonResult(await addAccountContact(args as any))),
);

// ===========================================================================
// =====================  TIER 3 — ANALYTICS  ================================
// ===========================================================================

server.registerTool(
  "get_first_time_fix_rate",
  {
    title: "Get First-Time-Fix Rate",
    description: "Lightweight FTF sample for closed tickets — full rate calculation requires history fan-out (planned).",
    inputSchema: {
      productId: z.string().min(1).optional(),
      sampleSize: z.number().int().min(10).max(500).default(100),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ productId, sampleSize }) =>
    runTool(async () => jsonResult(await getFirstTimeFixRate({ productId, sampleSize }))),
);

server.registerTool(
  "get_repeat_visit_rate",
  {
    title: "Get Repeat-Visit Rate",
    description: "Serials with ≥2 tickets in a sliding window — proxy for 'chronic units'.",
    inputSchema: {
      productId: z.string().min(1).optional(),
      windowDays: z.number().int().min(1).max(730).default(90),
      sampleSize: z.number().int().min(50).max(1000).default(300),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ productId, windowDays, sampleSize }) =>
    runTool(async () =>
      jsonResult(await getRepeatVisitRate({ productId, windowDays, sampleSize })),
    ),
);

server.registerTool(
  "get_mttr_by_product",
  {
    title: "Get Mean-Time-To-Resolution by Product",
    description: "Median resolution time across closed tickets for a product.",
    inputSchema: {
      productId: z.string().min(1),
      sampleSize: z.number().int().min(10).max(500).default(100),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ productId, sampleSize }) =>
    runTool(async () => jsonResult(await getMttrByProduct({ productId, sampleSize }))),
);

server.registerTool(
  "get_workload_distribution",
  {
    title: "Get Workload Distribution",
    description: "Open + in-process tickets per processor, optionally scoped to a team.",
    inputSchema: {
      teamPartyId: z.string().min(1).optional(),
      sampleSize: z.number().int().min(50).max(500).default(200),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ teamPartyId, sampleSize }) =>
    runTool(async () => jsonResult(await getWorkloadDistribution({ teamPartyId, sampleSize }))),
);

server.registerTool(
  "get_recurring_issues",
  {
    title: "Get Recurring Issues",
    description: "Top-N repeating ticket titles across a product family.",
    inputSchema: {
      productId: z.string().min(1).optional(),
      sampleSize: z.number().int().min(50).max(1000).default(300),
    },
    annotations: READ_ONLY_TOOL,
  },
  async ({ productId, sampleSize }) =>
    runTool(async () => jsonResult(await getRecurringIssues({ productId, sampleSize }))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
