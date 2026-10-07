# `connectors/c4c/` — SAP Service Cloud V1 (SAP C4C)

The real, implemented connector. Powers the 4 priority MCP tools (`search_tickets`, `get_ticket`, `get_service_metadata`, `get_service_history`) plus the broader 56-tool surface in `src/serviceOps.ts` (those will migrate into domain modules in follow-up PRs).

## Files

| File | Role |
|---|---|
| `client.ts` | HTTP client, CSRF dance, tenant resolution. Exports `c4cGet`, `c4cPost`, `c4cPatch`, `c4cDelete`. |
| `metadata.ts` | Parses SAP C4C `$metadata` XML — entity-set/property/nav-property discovery, service-history candidate ranking. |
| `mappers/*` | Native row → `object-model/` translators. One file per canonical entity. |

## Tenant resolution

The active tenant comes from `secureConfig` (multi-tenant catalog) first, then root `.env` (`C4C_BASE_URL` / `C4C_USER` / `C4C_PASSWORD`). The catalog is encrypted; env is plaintext-on-local-disk.

## Auth

HTTP Basic per integration user. CSRF token cached for 25 minutes (well under SAP's 30-min window). Token-expired retry happens once automatically.

## Write support

PATCH uses OData v2 `MERGE` with `If-Match: *` so partial updates work without etag round-trips. Write tools are gated three ways:
1. `dryRun: true` (default — returns the would-be payload without firing)
2. `feature.auto_writeback_enabled = true` in `/settings`
3. `acknowledgeProduction: true` when active tenant is tagged `production`

## What's reachable vs. blocked in a typical tenant

| Entity set | Status |
|---|---|
| `ServiceRequestCollection` (tickets) | ✅ |
| `ServiceRequestItemCollection` (labor + parts lines) | ✅ |
| `ServiceRequestTextCollection` (notes, via nav property) | ✅ |
| `ServiceRequestSolutionProposalCollection` (KB links, sparse) | ✅ |
| `CorporateAccountCollection` | ✅ |
| `ContactCollection` | ✅ |
| `EmployeeCollection` | ✅ |
| `AppointmentCollection` | ✅ |
| `TasksCollection`, `PhoneCallCollection`, `EMailCollection`, `ChatActivityCollection` | ✅ |
| `ContractCollection`, `ContractItemCollection` | ✅ |
| `SalesQuoteCollection`, `CustomerOrderCollection`, `OpportunityCollection` | ✅ |
| `StockLocationItemCollection` (parts stock) | ✅ |
| `OrganisationalUnitCollection` | ✅ |
| `SurveyResponseCollection`, `ServiceCategoryCatalogueCollection` | ✅ |
| `ProductCollection`, `RegisteredProductCollection`, `InstalledBaseCollection`, `VisitCollection`, `CodTimeReportPartyCollection`, `SalesTerritoryCollection`, `PartnerCollection`, `CompetitorCollection` | ⚠️ RBAM_ERROR (integration-user authorization blocks reads) |
| `TerritoryCollection`, `WarrantyCollection`, `ServiceLevelObjectiveCollection`, `ApprovalCollection`, `ServiceRequestAttachmentFolderCollection`, `MaterialCollection` (replaced by Product), `MaterialQuantityComponentCollection` (no BOM entity in tenant) | ❌ Not exposed |

If your integration user has different permissions, your reachable set will differ. Run `get_service_metadata` against your tenant to inspect the actual entity sets exposed.
