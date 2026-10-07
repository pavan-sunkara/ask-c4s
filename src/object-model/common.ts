/**
 * Shared building blocks used across every canonical entity.
 *
 * - `SourceRef` — every entity carries this so callers can dedup across
 *   systems and drill back to the native row.
 * - `CodedValue` — SAP-flavoured "code + text" pair (e.g. status, priority).
 * - `Timestamp` — ISO 8601 string with optional zone hint.
 */

/** The source system identifier — used in object-model entries' `sourceSystem`. */
export type SourceSystem =
  | "sap-c4c"
  | "sap-erp"
  | "sap-s4"
  | "salesforce"
  | "dynamics"
  | "servicenow"
  | "servicemax"
  | "knowledge-mindtouch"
  | "knowledge-sharepoint"
  | "knowledge-confluence"
  | "legacy-sql"
  | "legacy-file"
  | "legacy-api"
  | "other";

export type SourceRef = {
  /** Which connector produced this record. */
  sourceSystem: SourceSystem;
  /** The native system's primary key (e.g. C4C ObjectID, ERP EQUI EQUNR). */
  externalId: string;
  /** Optional human-readable display ID shown in source-system UIs. */
  displayId?: string;
};

/** SAP-style code-with-text pair. */
export type CodedValue = {
  code: string;
  text?: string;
};

/** ISO 8601 timestamp string. */
export type Timestamp = string;

/** Generic escape hatch for connector-specific extras. */
export type RawRecord = Record<string, unknown>;
