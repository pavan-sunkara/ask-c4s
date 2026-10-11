/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Knowledge-base tools — search, fetch attached articles, attach.
 *
 * Re-export shims from `serviceOps.ts`. The KB transport itself lives at
 * `connectors/knowledge-mindtouch/client.ts`; these tools wrap that
 * transport in MCP-compatible function signatures plus C4C-side
 * attachment writes.
 */
export {
  searchKbArticles,
  searchKbForTicket,
  getKbApiStatus,
  getTicketKbArticles,
  attachKbArticle,
  getResolutionHints,
} from "../../serviceOps.js";
