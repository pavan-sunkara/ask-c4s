/**
 * `modules/service/tickets.ts` — the canonical public surface for the four
 * priority service-ticket tools.
 *
 * Today these are re-exports from the monolithic `src/serviceOps.ts`. The
 * implementations stay there because they depend on shared helpers
 * (`serviceRequestPath`, `validateOrderBy`, `validateODataPaths`,
 * `candidateFromNavigationProperty`) that are also used by ~30 other tools
 * still living in `serviceOps.ts`. Moving them all in one PR would explode
 * the diff and make review hard.
 *
 * Follow-up PRs will physically migrate the implementations here once those
 * shared helpers are themselves factored out (likely into `core/odata.ts`
 * and a dedicated `connectors/c4c/paths.ts`).
 *
 * Until that lands, callers should import from THIS file, not from
 * `serviceOps.ts` directly — that future-proofs them against the move.
 */

import { getTicket as rawGetTicket } from "../../serviceOps.js";
import { toCanonicalTicket } from "../../connectors/c4c/mappers/ticket.js";
import type { Ticket } from "../../object-model/types.js";

export {
  searchTickets,
  getTicket,
  getServiceMetadata,
  getServiceHistory,
} from "../../serviceOps.js";

export type {
  SearchTicketsOptions,
  GetTicketOptions,
  GetServiceMetadataOptions,
  GetServiceHistoryOptions,
} from "../../serviceOps.js";

/**
 * Fetch a ticket and return it in the canonical Ticket shape (not C4C raw).
 *
 * Wraps the existing `getTicket` and pipes the result through the
 * `toCanonicalTicket` mapper. Callers that want a connector-agnostic
 * record (e.g. the chat layer, future cross-connector tools) should use
 * this instead of `getTicket` directly.
 *
 * The raw C4C shape is still available on `Ticket.sourceRef.raw` for
 * callers that need vendor-specific fields.
 */
export async function getCanonicalTicket(opts: {
  objectId: string;
  refresh?: boolean;
}): Promise<Ticket> {
  const raw = (await rawGetTicket(opts)) as Record<string, unknown>;
  // The raw shape is OData v2 — unwrap the typical { d: { results: {...} } }
  // envelope if present, otherwise treat the whole payload as the record.
  const inner =
    (raw && typeof raw === "object" && "d" in raw && typeof (raw as any).d === "object"
      ? (raw as any).d.results ?? (raw as any).d
      : raw) as Record<string, unknown>;
  return toCanonicalTicket(inner);
}
