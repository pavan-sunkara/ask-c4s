/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * Ticket — the canonical unit of customer-facing work / incident.
 *
 * Source-system mappings:
 *  - SAP C4C       → ServiceRequest
 *  - SAP ERP PM    → Notification (QMEL) — type-coded breakdown / corrective / preventive
 *  - SAP ERP CS    → Service Order
 *  - Salesforce    → Case
 *  - ServiceNow    → Incident / Request
 *  - ServiceMax    → Work Order
 *
 * Not every field is populatable by every source. Required fields are the
 * minimum that any system can provide: source ref + title + lifecycle status.
 */

/** Canonical lifecycle buckets, mapped from source-system status codes. */
export type TicketLifecycle = "open" | "in_process" | "completed" | "closed" | "cancelled" | "other";

/** Coarse priority bucket, mapped from native priority codes. */
export type TicketPriorityBucket = "immediate" | "urgent" | "normal" | "low" | "other";

export interface Ticket extends SourceRef {
  /** Subject / short description. Required. */
  title: string;
  /** Canonical lifecycle bucket. Required. */
  lifecycle: TicketLifecycle;
  /** Original status code+text from the source system. */
  status?: CodedValue;
  /** Coarse priority bucket. */
  priorityBucket?: TicketPriorityBucket;
  /** Original priority code+text. */
  priority?: CodedValue;

  /** Buying customer (links to Customer.externalId). */
  customerExternalId?: string;
  customerName?: string;
  /** Account ID (the "human" customer number). */
  accountId?: string;

  /** Processing technician / case owner. */
  processorExternalId?: string;
  processorName?: string;
  /** Service execution team / queue / org unit. */
  teamId?: string;
  teamName?: string;

  /** Linked equipment / asset (if the ticket is about a specific unit). */
  assetExternalId?: string;
  serialId?: string;
  productId?: string;
  productName?: string;

  /** Escalation flag/code from the source system. */
  escalation?: CodedValue;

  /** Timestamps — all optional, populated when available. */
  createdAt?: Timestamp;
  changedAt?: Timestamp;
  /** When the ticket transitioned to "in_process" (work started). */
  inProcessAt?: Timestamp;
  /** When work was completed (status → completed). */
  completedAt?: Timestamp;
  /** When the ticket was closed (final state). */
  closedAt?: Timestamp;
  /** Due-date target for SLA evaluation. */
  dueAt?: Timestamp;

  /** Native row for connector-specific drill-down. */
  raw?: RawRecord;
}

/** Aggregate buckets across a list of tickets. */
export interface TicketLifecycleCounts {
  open: number;
  in_process: number;
  completed: number;
  closed: number;
  other: number;
}
