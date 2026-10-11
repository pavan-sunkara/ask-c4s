/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Public surface of the `service/` module.
 *
 * Tools registered in `src/index.ts` should import from this file (not from
 * the individual sub-files) so future file splits don't ripple through the
 * codebase. Each sub-file is currently a re-export shim from the monolithic
 * `serviceOps.ts`; physical migration happens incrementally.
 */
export * from "./tickets.js";
export * from "./account.js";
export * from "./employees.js";
export * from "./knowledge.js";
export * from "./parts.js";
export * from "./history.js";
export * from "./scheduling.js";
export * from "./communication.js";
export * from "./contracts.js";
export * from "./sales-orders.js";
export * from "./writes.js";
export * from "./analytics.js";
export * from "./survey.js";
