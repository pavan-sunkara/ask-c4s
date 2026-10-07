/**
 * Write-back tools — every operation that mutates a C4C record.
 *
 * Every function here runs the three-gate safety chain:
 *   1. dryRun=true by default — returns the would-be POST/PATCH body
 *   2. Feature flag must enable writes (writes.enabled setting)
 *   3. Production tenants require acknowledgeProduction=true
 *
 * The frontend WriteBackActions component talks to these via callTool().
 */
export {
  updateTicketDescription,
  updateTicketPriority,
  updateTicketLifecycle,
  escalateTicket,
  assignProcessor,
  assignTeam,
  addServiceRequestText,
  logServiceItem,
  updateServiceItemActuals,
  createFollowupTask,
  createAppointment,
  logPhoneCall,
} from "../../serviceOps.js";
