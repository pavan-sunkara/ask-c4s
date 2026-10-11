/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import type { SourceRef, CodedValue, Timestamp, RawRecord } from "./common.js";

/**
 * Asset — a physical item installed at a customer site.
 *
 * Most B2B service contexts treat "asset" and "equipment" as synonyms;
 * this object-model splits them so SAP PM-specific fields can live on
 * `Equipment` without polluting the broader Asset shape used by other systems.
 *
 * Source-system mappings:
 *  - SAP C4C  → InstalledBase / RegisteredProduct
 *  - SAP ERP  → EQUI (mostly maps to `Equipment` — the richer subtype)
 *  - SF / Dyn → Asset
 */
export interface Asset extends SourceRef {
  /** Serial number / unit identifier (as the customer / tech recognises it). */
  serialId?: string;
  /** Product ID this asset is an instance of. */
  productId?: string;
  productName?: string;
  /** Customer that owns / operates this asset. */
  customerExternalId?: string;
  customerName?: string;
  /** Status / lifecycle (in-service / decommissioned / loaner). */
  lifecycleStatus?: CodedValue;
  /** When the asset was installed (start of warranty / service window). */
  installedAt?: Timestamp;
  /** Warranty end date (if known). */
  warrantyEndAt?: Timestamp;
  /** Address / site location (free text). */
  location?: string;
  raw?: RawRecord;
}

/**
 * One entry in a customer's installed base — a thin pointer to an Asset
 * plus the hierarchical context (parent unit / sub-component).
 */
export interface InstalledBaseEntry extends SourceRef {
  assetExternalId: string;
  parentExternalId?: string;
  serialId?: string;
  productId?: string;
  productName?: string;
  /** Position / slot in parent (e.g. "Pump module 2 of 3"). */
  position?: string;
  raw?: RawRecord;
}
