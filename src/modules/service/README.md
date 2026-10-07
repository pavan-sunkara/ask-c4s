# `modules/service/` — service-ticket domain

The first real module. Owns:

| Tool | Source |
|---|---|
| `search_tickets` | SAP C4C `ServiceRequestCollection` (today); future: union with SAP ERP PM Notifications + Salesforce Cases |
| `get_ticket` | C4C `ServiceRequestCollection('<id>')` |
| `get_service_metadata` | C4C `$metadata` summary |
| `get_service_history` | Auto-discovered C4C nav properties on `ServiceRequestCollection` |

These four tools were extracted from the monolithic `src/serviceOps.ts` in Phase 5 of the refactor. The remaining ~24 ticket-context tools (`get_ticket_items`, `get_ticket_notes`, `get_resolution_hints`, `get_serial_history`, etc.) still live in `serviceOps.ts` and will migrate here in follow-up PRs.

## Files

- `tickets.ts` — the four priority tools' implementations + their TypeScript types
- `index.ts` — re-exports the public surface

## What it depends on

```
modules/service/tickets.ts
  ├── imports from connectors/c4c/client.ts        (HTTP / OData)
  ├── imports from connectors/c4c/metadata.ts      (metadata parsing)
  ├── imports from connectors/c4c/mappers/ticket.ts (raw → canonical)
  └── returns object-model/ticket.ts shapes
```

No imports from other modules. Yet.
