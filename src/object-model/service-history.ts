/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, Timestamp, RawRecord } from "./common.js";

/**
 * A single past event in the service history of a ticket / asset / customer.
 *
 * Service history is intentionally typed as a flat list of timestamped events
 * rather than a tree — different source systems have different hierarchies
 * (C4C nav properties, ERP PM order history, audit logs, etc.), and the
 * flat list is the lowest-common-denominator that AI prompts can consume.
 */
export interface ServiceHistoryEvent extends SourceRef {
  /** Free-form event type label (e.g. "note added", "status change", "labor logged"). */
  eventType: string;
  /** ISO timestamp the event occurred. */
  occurredAt: Timestamp;
  /** Who triggered it (employee name / system ID). */
  actor?: string;
  /** One-line human summary. */
  summary?: string;
  /** Long-form body (e.g. note text, resolution writeup). */
  body?: string;
  /** Optional link to the canonical entity this event happened on. */
  parentExternalId?: string;
  /** Native row for connector-specific drill-down. */
  raw?: RawRecord;
}
