import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * ServiceOrder — the work order / dispatch record (distinct from a Ticket,
 * which represents the customer-facing incident).
 *
 * Source-system mappings:
 *  - SAP ERP CS     → Service Order
 *  - SAP S/4 Service → Service Order
 *  - ServiceMax     → Work Order
 *  - SAP C4C        → no direct equivalent — closest is the assigned visit
 */
export interface ServiceOrder extends SourceRef {
  /** Linked customer-facing ticket, if any. */
  ticketExternalId?: string;
  /** Customer / asset. */
  customerExternalId?: string;
  assetExternalId?: string;
  /** Owning technician / team. */
  processorExternalId?: string;
  teamId?: string;
  /** Lifecycle status. */
  status?: CodedValue;
  /** Coarse buckets: scheduled / in-progress / completed / cancelled. */
  lifecycle?: "scheduled" | "in_progress" | "completed" | "cancelled" | "other";
  /** Scheduled time window. */
  scheduledStart?: Timestamp;
  scheduledEnd?: Timestamp;
  /** Actuals from completed work. */
  actualStart?: Timestamp;
  actualEnd?: Timestamp;
  /** Planned vs. actual effort in hours, when reported. */
  plannedHours?: number;
  actualHours?: number;
  raw?: RawRecord;
}
