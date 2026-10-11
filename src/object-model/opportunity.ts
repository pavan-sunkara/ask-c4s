/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * Opportunity — a sales-pipeline record.
 *
 * Source-system mappings:
 *  - SAP C4C    → Opportunity
 *  - Salesforce → Opportunity
 *  - Dynamics   → Opportunity
 */
export interface Opportunity extends SourceRef {
  name: string;
  customerExternalId?: string;
  customerName?: string;
  /** Owning sales rep. */
  ownerExternalId?: string;
  ownerName?: string;
  /** Pipeline stage code+text. */
  stage?: CodedValue;
  /** Expected close date. */
  expectedCloseAt?: Timestamp;
  /** Monetary amount + ISO currency code. */
  amount?: number;
  currency?: string;
  /** Win-probability percentage (0-100), when reported. */
  probability?: number;
  raw?: RawRecord;
}
