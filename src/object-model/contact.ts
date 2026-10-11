/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, RawRecord } from "./common.js";

/**
 * Contact — an individual person at a customer organisation.
 *
 * Source-system mappings:
 *  - SAP C4C    → Contact (under CorporateAccount)
 *  - SAP ERP    → KNVK (contact partners)
 *  - Salesforce → Contact
 */
export interface Contact extends SourceRef {
  /** Full display name (handles cultural orderings; not all systems split first/last). */
  name: string;
  firstName?: string;
  lastName?: string;
  /** Owning customer's external ID — links back to `Customer.externalId`. */
  customerExternalId?: string;
  /** Owning customer's accountId (the "human" account number). */
  accountId?: string;
  jobTitle?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  /** Lifecycle status (active / inactive). */
  lifecycleStatus?: CodedValue;
  /** Country / language hints. */
  country?: string;
  language?: string;
  raw?: RawRecord;
}

/** Aggregate reach-ability counts for a list of contacts. */
export interface ContactReachability {
  total: number;
  withEmail: number;
  withPhone: number;
  withMobile: number;
}
