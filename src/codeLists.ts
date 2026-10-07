/**
 * Back-compat re-export shim.
 *
 * The real implementation moved to `src/connectors/c4c/codeLists.ts` as part
 * of the connector-based refactor. This file preserves the original import path
 * so existing imports across the codebase keep working unchanged.
 *
 * New code should import from `connectors/c4c/codeLists.js` directly.
 */
export * from "./connectors/c4c/codeLists.js";
