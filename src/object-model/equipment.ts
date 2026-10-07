import type { CodedValue, Timestamp, RawRecord } from "./common.js";
import type { Asset } from "./asset.js";

/**
 * Equipment — the SAP PM-flavoured asset.
 *
 * Adds Plant-Maintenance-specific fields on top of the generic Asset:
 * functional location, equipment category, PM strategy, last/next PM date.
 *
 * Source-system mappings:
 *  - SAP ERP PM     → EQUI + EQKT (description) + ILOA (location data)
 *  - SAP S/4 PM     → Equipment master
 *  - SAP C4C        → degraded view (no PM-specific fields)
 */
export interface Equipment extends Asset {
  /** Functional location code (where the equipment sits in the site hierarchy). */
  functionalLocation?: string;
  /** PM equipment category (e.g. "M" = Machine, "P" = Production Resource). */
  category?: CodedValue;
  /** Maintenance plan / strategy ID associated with this unit. */
  maintenancePlanId?: string;
  /** Date of the most recent completed PM. */
  lastPmAt?: Timestamp;
  /** Scheduled next PM date. */
  nextPmAt?: Timestamp;
  /** ABC indicator for maintenance prioritisation. */
  abcIndicator?: string;
  /** Construction year, manufacturer (PM-specific master data). */
  constructionYear?: number;
  manufacturer?: string;
  rawEquipment?: RawRecord;
}
