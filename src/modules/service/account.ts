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
