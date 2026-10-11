/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Account / customer-related service tools.
 *
 * Re-export shims from `serviceOps.ts`. Implementations stay there until
 * the shared OData helpers move into `core/odata-helpers.ts` and the
 * canonical Customer/Contact mappers in `connectors/c4c/mappers/` are
 * wired (see object-model/customer.ts, object-model/contact.ts).
 */
export {
  getAccount,
  getAccountContacts,
  getAccountOpenTickets,
  addAccountContact,
} from "../../serviceOps.js";
