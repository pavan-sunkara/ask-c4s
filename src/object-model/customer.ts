/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, RawRecord } from "./common.js";

/**
 * Customer — the buying organisation. Equivalent to "Account" in B2B speak;
 * `Account` is exported as an alias in `account.ts` for callers that prefer
 * that vocabulary.
 *
 * Source-system mappings:
 *  - SAP C4C    → CorporateAccount
 *  - SAP ERP    → KNA1 (general customer master)
 *  - Salesforce → Account
 *  - Dynamics   → Account
 */
export interface Customer extends SourceRef {
  /** Canonical display name. */
  name: string;
  /** Customer master ID — the "human" account ID, not the GUID. */
  accountId?: string;
  /** Industry / segment classification (optional, source-dependent). */
  industry?: CodedValue;
  /** Country code (ISO 3166-1 alpha-2) when available. */
  country?: string;
  /** Lifecycle status of the customer record (active / blocked / archived). */
  lifecycleStatus?: CodedValue;
  /** Whether this is a top-tier / VIP customer in the source system. */
  vip?: boolean;
  /** Account / industry classification (e.g. ABC analysis). */
  classification?: CodedValue;
  /** Optional composite health score 0-100, when computed. */
  healthScore?: number;
  /** Raw native row for connector-specific drill-down. */
  raw?: RawRecord;
}
