/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * History / notes / longitudinal tools.
 *
 * Service history per-ticket lives in `tickets.ts`; this module covers
 * the serial / customer / duration angles.
 */
export {
  getSerialHistory,
  getTicketNotes,
  getDurationStats,
} from "../../serviceOps.js";
