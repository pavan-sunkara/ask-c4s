# `modules/` — domain-aligned tool groups

A module owns a business domain. Today there is one: `service/`. Modules:

1. **Register MCP tools** in their own `index.ts` (or in the central `src/index.ts` until the move is complete)
2. **Import connector clients** from `connectors/<system>/`
3. **Return `object-model/` canonical types** to callers
4. **Don't know** which source system the data came from — they consume mappers, not raw rows

## What lives where

| Module | Today | Future |
|---|---|---|
| `service/` | The 4 priority tools (`search_tickets`, `get_ticket`, `get_service_metadata`, `get_service_history`) extracted from `serviceOps.ts` | The remaining ~24 ticket-related tools currently in `serviceOps.ts` |

The sales, marketing, customer-success and operations placeholders are not part of this product.

## Module shape (when fully migrated)

```
modules/service/
├── tickets.ts                    business logic — calls connectors, runs mappers
├── tickets.tools.ts              MCP registrations (later — currently in src/index.ts)
├── history.ts                    business logic for service-history tools
├── activities.ts                 (future) task / phone / email tools
└── index.ts                      re-exports public surface
```

## Cross-module rule

A tool that needs data from multiple domains lives in **the most specific module that owns the primary entity**, and imports from sibling modules through their public `index.ts`.

Module A never reaches into Module B's internals.
