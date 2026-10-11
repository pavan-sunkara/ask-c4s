/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * SAP C4C `ServiceRequest` → canonical `Ticket`.
 *
 * Pure function. No I/O. Tested against the C4C OData v2 row shape we get
 * back from `/c4codataapi/ServiceRequestCollection`.
 *
 * Today, no caller is wired to this mapper yet — the 4 priority tools still
 * return their raw C4C shape for back-compat with the React UI. Future PRs
 * will switch the chat layer and (optionally) the UI panels to consume the
 * canonical shape via this mapper.
 */

import type {
  Ticket,
  TicketLifecycle,
  TicketPriorityBucket,
} from "../../../object-model/types.js";

/**
 * Map SAP C4C `ServiceRequestLifeCycleStatusCode` to canonical lifecycle.
 *
 *   1 = Open       → "open"
 *   2 = In Process → "in_process"
 *   3 = Completed  → "completed"
 *   4 = Closed     → "closed"
 *  other / null    → "other"
 */
export function c4cLifecycleToCanonical(code: unknown): TicketLifecycle {
  const v = String(code ?? "").trim();
  if (v === "1") return "open";
  if (v === "2") return "in_process";
  if (v === "3") return "completed";
  if (v === "4") return "closed";
  // Status-text fallback (in case the code was localised away)
  const lower = String(code ?? "").toLowerCase();
  if (lower.includes("open")) return "open";
  if (lower.includes("process") || lower.includes("progress")) return "in_process";
  if (lower.includes("complete")) return "completed";
  if (lower.includes("close")) return "closed";
  if (lower.includes("cancel")) return "cancelled";
  return "other";
}

/**
 * Map SAP C4C `ServicePriorityCode` to a coarse bucket.
 *
 *   1 = Immediate
 *   2 = Urgent
 *   3 = Normal
 *   7 = Low
 *  other → "other"
 */
export function c4cPriorityToCanonical(code: unknown): TicketPriorityBucket {
  const v = String(code ?? "").trim();
  if (v === "1") return "immediate";
  if (v === "2") return "urgent";
  if (v === "3") return "normal";
  if (v === "7") return "low";
  return "other";
}

/** Convert `/Date(1234567890000)/` blobs to ISO strings; pass through ISO. */
export function c4cTimestampToIso(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const s = String(raw);
  if (s.startsWith("0001-")) return undefined; // SAP "unset" sentinel
  const m = /\/Date\((-?\d+)\)\//.exec(s);
  const ms = m ? Number(m[1]) : Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Translate one raw SAP C4C ServiceRequest row → canonical `Ticket`.
 *
 * Input shape: the OData v2 entity body for a single ServiceRequest. The
 * function reads the C4C field names directly; downstream callers see the
 * connector-agnostic Ticket interface.
 *
 * Missing fields stay `undefined` on the canonical shape — the mapper never
 * fabricates values. `raw` carries the entire input through for callers
 * that need to drill into native fields.
 */
export function toCanonicalTicket(raw: Record<string, unknown>): Ticket {
  const lifecycleCode = raw["ServiceRequestLifeCycleStatusCode"];
  const lifecycleText = raw["ServiceRequestLifeCycleStatusCodeText"];
  const priorityCode = raw["ServicePriorityCode"];
  const priorityText = raw["ServicePriorityCodeText"];
  const escalationCode = raw["EscalationStatusCode"];
  const escalationText = raw["EscalationStatusCodeText"];

  return {
    sourceSystem: "sap-c4c",
    externalId: String(raw["ObjectID"] ?? ""),
    displayId: raw["ID"] != null ? String(raw["ID"]) : undefined,
    title: String(raw["Name"] ?? raw["ID"] ?? "(no subject)"),
    lifecycle: c4cLifecycleToCanonical(lifecycleCode),
    status:
      lifecycleCode != null
        ? { code: String(lifecycleCode), text: lifecycleText ? String(lifecycleText) : undefined }
        : undefined,
    priorityBucket: c4cPriorityToCanonical(priorityCode),
    priority:
      priorityCode != null
        ? { code: String(priorityCode), text: priorityText ? String(priorityText) : undefined }
        : undefined,

    customerExternalId: stringOrUndefined(raw["BuyerPartyUUID"]),
    customerName: stringOrUndefined(raw["BuyerPartyName"]),
    accountId: stringOrUndefined(raw["BuyerPartyID"]),

    processorExternalId: stringOrUndefined(raw["ProcessorPartyUUID"]),
    processorName: stringOrUndefined(raw["ProcessorPartyName"]),
    teamId: stringOrUndefined(raw["ServiceExecutionTeamPartyID"]),
    teamName: stringOrUndefined(raw["ServiceExecutionTeamPartyName"]),

    serialId: stringOrUndefined(raw["SerialID"]),
    productId: stringOrUndefined(raw["ProductID"]),
    productName: stringOrUndefined(raw["ProductDescription"]),

    escalation:
      escalationCode != null
        ? {
            code: String(escalationCode),
            text: escalationText ? String(escalationText) : undefined,
          }
        : undefined,

    createdAt: c4cTimestampToIso(raw["CreationDateTime"]),
    changedAt: c4cTimestampToIso(raw["LastChangeDateTime"]),
    inProcessAt: c4cTimestampToIso(raw["RequestInProcessdatetimeContent"]),
    closedAt: c4cTimestampToIso(raw["RequestCloseddatetimeContent"]),
    dueAt: c4cTimestampToIso(raw["CompleteDuedatetimeContent"]),

    raw,
  };
}

function stringOrUndefined(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}
