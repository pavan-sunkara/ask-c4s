/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * Activity — a logged interaction with a customer (task / phone call / email
 * / chat). Modeled as a discriminated union so callers can pattern-match on
 * `kind` and access the type-narrowed shape.
 *
 * Source-system mappings:
 *  - SAP C4C → TasksCollection, PhoneCallCollection, EMailCollection, ChatActivityCollection
 *  - Salesforce / Dynamics → Activity (task / event / call)
 */

interface ActivityBase extends SourceRef {
  subject?: string;
  /** Owning employee / dispatcher. */
  ownerExternalId?: string;
  ownerName?: string;
  /** Linked customer / account. */
  customerExternalId?: string;
  customerName?: string;
  /** Linked primary contact (if any). */
  contactExternalId?: string;
  status?: CodedValue;
  startAt?: Timestamp;
  endAt?: Timestamp;
  raw?: RawRecord;
}

export interface TaskActivity extends ActivityBase {
  kind: "task";
  dueAt?: Timestamp;
  completionAt?: Timestamp;
}

export interface PhoneCallActivity extends ActivityBase {
  kind: "phone-call";
  /** "inbound" (customer called us) | "outbound" (we called them). */
  direction?: "inbound" | "outbound";
}

export interface EmailActivity extends ActivityBase {
  kind: "email";
  /** "sent" / "received" / "draft". */
  transmissionStatus?: CodedValue;
  category?: CodedValue;
}

export interface ChatActivity extends ActivityBase {
  kind: "chat";
}

export type Activity = TaskActivity | PhoneCallActivity | EmailActivity | ChatActivity;
