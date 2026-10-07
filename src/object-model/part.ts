import type { SourceRef, RawRecord } from "./common.js";

/**
 * Part — a stocked material that techs consume on tickets / service orders.
 *
 * Source-system mappings:
 *  - SAP C4C    → derived from StockLocationItem (grouped by MaterialID)
 *  - SAP ERP MM → MARA + MARD (header + stock-by-plant)
 *  - Legacy SQL → custom inventory table
 */
export interface Part extends SourceRef {
  materialId: string;
  /** Customer-facing external part number (standard ProductIDExternalKey
   *  on SAP C4C ServiceRequestItem). Distinct from SourceRef.externalId,
   *  which is the source-system primary key. */
  externalPartCode?: string;
  /** Optional description / display name. */
  description?: string;
  /** Unit of measure (e.g. EA, kg, L). */
  uom?: string;
  /** Aggregate quantities across all stock locations. */
  onHand?: number;
  /** Quantity in consignment (vendor-owned, on customer site). */
  consignment?: number;
  /** Quantity blocked / in quality inspection / returns. */
  blocked?: number;
  qualityInspection?: number;
  /** Distinct stock locations that carry the part. */
  locationCount?: number;
  raw?: RawRecord;
}

/** Per-location row for a specific Material's stock breakdown. */
export interface PartStockLocation {
  stockLocationId: string;
  onHand: number;
  consignment?: number;
  blocked?: number;
  batchNumber?: string;
  uom?: string;
  raw?: RawRecord;
}
