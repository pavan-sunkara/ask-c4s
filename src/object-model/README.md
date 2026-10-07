# `object-model/` — canonical enterprise entities

Ask C4S reads from many source systems (SAP C4C, future SAP ERP/S4, legacy SQL, CRM/FSM, knowledge stores). Each system has its own native shape for a "customer", a "ticket", an "asset". This folder holds the **single, source-system-agnostic** shape that downstream modules + AI prompts consume.

## How it works

```
┌───────────────────┐      ┌────────────────────────┐      ┌──────────────────┐
│  Connector reads  │  →   │  Connector-specific    │  →   │  Canonical type  │
│  native row       │      │  mapper                │      │  in object-model │
└───────────────────┘      └────────────────────────┘      └──────────────────┘
   e.g. SAP C4C              connectors/c4c/                  Ticket
   ServiceRequest            mappers/ticket.ts                (this folder)
```

Modules import **only** from `object-model/` types — they don't know whether the data came from C4C, ERP, or a CSV.

## What's here

| File | Type | Maps from |
|---|---|---|
| `ticket.ts` | `Ticket` | C4C ServiceRequest, ERP PM Notification, Salesforce Case, ServiceNow Incident, ServiceMax Work Order |
| `customer.ts` | `Customer` | C4C CorporateAccount, ERP KNA1, SF Account, Dynamics Account |
| `account.ts` | `Account` | Alias of `Customer` in B2B contexts |
| `contact.ts` | `Contact` | C4C Contact, ERP KNVK, SF Contact |
| `asset.ts` | `Asset` | C4C InstalledBase, ERP EQUI |
| `equipment.ts` | `Equipment` | ERP PM EQUI (the PM-flavored asset) |
| `service-order.ts` | `ServiceOrder` | ERP CS service order, S/4 service order |
| `service-history.ts` | `ServiceHistoryEvent` | C4C SR history, ERP PM order history |
| `opportunity.ts` | `Opportunity` | C4C Opportunity, SF Opportunity |
| `product.ts` | `Product` | C4C Product, ERP MARA |
| `part.ts` | `Part` | ERP MARA + MARD (with stock), C4C StockLocationItem |
| `contract.ts` | `Contract`, `ContractItem`, `SLA` | C4C Contract, ERP CRM contract |
| `knowledge-article.ts` | `KnowledgeArticle` | MindTouch article, SharePoint doc, Confluence page |
| `activity.ts` | `Activity` (union: Task / PhoneCall / Email / Chat) | C4C activities, ERP activity, SF Task |
| `employee.ts` | `Employee`, `Skill`, `TeamMembership` | C4C Employee, ERP HR PA0001 |

## Rules for new types

1. **Pure interfaces only.** No runtime code. Mappers belong in `connectors/<system>/mappers/`.
2. **Source-system tag every entity.** Every interface has `sourceSystem: string` and `externalId: string` so cross-system dedup is possible.
3. **Required vs. optional.** Mark fields required only if EVERY supported source system can populate them. Otherwise optional.
4. **Code+text pairs.** SAP-flavored fields like status / priority usually come as code+text. Model as `{ code: string; text?: string }` rather than collapsing to a single string.
5. **Connector-specific extras.** Each entity carries a `raw: Record<string, unknown>` escape hatch so callers can drill into native fields when needed.

The interface stubs in this folder define the contract; mappers in each connector live up to it.
