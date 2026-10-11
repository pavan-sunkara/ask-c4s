/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Employee / team / org-unit tools.
 *
 * Re-export shims from `serviceOps.ts`. Future home for these is
 * `modules/service/employees.ts` once the bodies move.
 */
export {
  searchEmployees,
  getEmployeeSkills,
  getMyTickets,
  getMyTeamTickets,
  searchOrgUnits,
  getTeamRoster,
} from "../../serviceOps.js";
