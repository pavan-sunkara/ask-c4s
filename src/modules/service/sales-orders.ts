/**
 * Sales-side tools surfaced through C4C — quotes, customer orders,
 * opportunities. These live under `modules/service/` because today they
 * read from the C4C connector; when the dedicated Salesforce / SAP-SD
 * connectors come online, equivalent tools will live under
 * `modules/sales/` and consume those connectors.
 */
export {
  searchSalesQuotes,
  searchCustomerOrders,
  searchOpportunities,
} from "../../serviceOps.js";
