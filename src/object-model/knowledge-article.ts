import type { SourceRef, Timestamp, RawRecord } from "./common.js";

/**
 * Knowledge article — a piece of external documentation linkable to a ticket.
 *
 * Source-system mappings:
 *  - MindTouch     → Manual_Repository page
 *  - SharePoint    → document / wiki page
 *  - Confluence    → page
 *  - SAP C4C       → ServiceRequestSolutionProposal (per-ticket link; rare)
 *  - Local PDFs    → indexed by hash
 */
export interface KnowledgeArticle extends SourceRef {
  title: string;
  /** Direct URL to the article (when reachable). */
  url?: string;
  /** Optional short snippet / preview. */
  snippet?: string;
  /** Relevance score from the search engine (0-1 or 0-100, normalised). */
  score?: number;
  /** Last modified date. */
  modifiedAt?: Timestamp;
  /** Author when known. */
  author?: string;
  /** Tags / categories from the source system. */
  tags?: string[];
  raw?: RawRecord;
}
