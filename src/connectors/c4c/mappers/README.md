# `connectors/c4c/mappers/` — native C4C rows → canonical `object-model/` types

One file per canonical entity. Each file exports a pure function `toCanonicalX(raw): X` that takes a native C4C JSON row (as parsed from OData responses) and returns the `object-model/` shape.

## Why mappers live here, not in `object-model/`

`object-model/` is connector-agnostic — it doesn't know C4C field names. The mapping logic IS C4C-specific (it reads `BuyerPartyID`, `ServiceRequestLifeCycleStatusCode`, etc.), so it stays alongside the connector that owns those names.

A future `connectors/salesforce/mappers/ticket.ts` would do the same translation from SF Case fields. Same canonical `Ticket` shape; different source.

## Convention

```ts
// mappers/ticket.ts
import type { Ticket } from "../../../object-model/ticket.js";

export function toCanonicalTicket(raw: Record<string, unknown>): Ticket {
  return {
    sourceSystem: "sap-c4c",
    externalId: String(raw.ObjectID ?? ""),
    displayId: String(raw.ID ?? ""),
    title: String(raw.Name ?? ""),
    // ... etc.
    raw,
  };
}
```

Mappers are **lossless on the way out** — every native field stays accessible via `raw`. AI prompts that need a specific field can drill down; consumers that want canonical shape get it without losing the original.
