import type { SourceRef, CodedValue, RawRecord } from "./common.js";

/**
 * Product — a catalog entry. A serialized unit of a product is an `Asset`.
 *
 * Source-system mappings:
 *  - SAP C4C    → Product (often RBAM-restricted in service tenants)
 *  - SAP ERP MM → MARA (material master, header)
 *  - Salesforce → Product2
 */
export interface Product extends SourceRef {
  productId: string;
  name: string;
  /** Product family / category. */
  category?: CodedValue;
  /** Active / discontinued / obsolete. */
  lifecycleStatus?: CodedValue;
  /** Customer-facing external code (if different from internal ID). */
  externalCode?: string;
  /** Base unit of measure. */
  baseUom?: string;
  raw?: RawRecord;
}
