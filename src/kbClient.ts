/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Back-compat re-export shim.
 *
 * The real implementation moved to `src/connectors/knowledge-mindtouch/client.ts`
 * as part of the connector-based refactor. This file preserves the original
 * import path so existing imports across the codebase keep working unchanged.
 *
 * New code should import from `connectors/knowledge-mindtouch/client.js` directly.
 */
export * from "./connectors/knowledge-mindtouch/client.js";
