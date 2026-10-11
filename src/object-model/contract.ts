/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * Contract — a service contract / coverage agreement.
 *
 * Source-system mappings:
 *  - SAP C4C    → Contract (BuyerID + service contract type)
 *  - SAP ERP CS → Service Contract
 *  - SAP CRM    → contract
 */
export interface Contract extends SourceRef {
  /** Buyer / customer external ID. */
  customerExternalId?: string;
  /** Display name (often the contract type + period). */
  name?: string;
  /** Coarse classification (Service Contract / Maintenance / Warranty Extension). */
  contractType?: CodedValue;
  /** Validity window. */
  validFrom?: Timestamp;
  validTo?: Timestamp;
  /** Lifecycle (active / expired / draft / cancelled). */
  lifecycleStatus?: CodedValue;
  raw?: RawRecord;
}

/**
 * One line on a service contract — typically links to a product family or
 * specific asset, plus the entitlements (hours included, response time SLAs).
 */
export interface ContractItem extends SourceRef {
  contractExternalId: string;
  /** Item-level product / asset coverage. */
  productId?: string;
  assetExternalId?: string;
  /** Hours / count entitlement. */
  entitledQty?: number;
  /** Consumed-to-date (when reported by source). */
  consumedQty?: number;
  /** Linked SLA. */
  slaExternalId?: string;
  raw?: RawRecord;
}

/**
 * Service-Level Objective — response / resolution time targets.
 *
 * Source-system mappings:
 *  - SAP C4C → ServiceLevelObjective (not exposed in every tenant)
 *  - SAP ERP CS → response-time profile
 */
export interface SLA extends SourceRef {
  name?: string;
  /** Response-time target (minutes / hours). */
  responseMinutes?: number;
  /** Resolution-time target. */
  resolutionMinutes?: number;
  /** Operating window (e.g. "24x7" or "Mon-Fri 8x5"). */
  operatingWindow?: string;
  raw?: RawRecord;
}
