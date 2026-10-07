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
