/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * Barrel re-export — single import surface for the canonical object model.
 *
 * Usage:
 *   import type { Ticket, Customer, Asset } from "../object-model/types.js";
 *
 * Importing from this file (rather than directly from `./ticket.js` etc.)
 * keeps domain modules decoupled from the on-disk file layout, so future
 * splits / merges of the object-model files don't ripple through the codebase.
 */

export type {
  SourceSystem,
  SourceRef,
  CodedValue,
  Timestamp,
  RawRecord,
} from "./common.js";

export type { Customer } from "./customer.js";
export type { Account } from "./account.js";
export type { Contact, ContactReachability } from "./contact.js";
export type {
  Ticket,
  TicketLifecycle,
  TicketPriorityBucket,
  TicketLifecycleCounts,
} from "./ticket.js";
export type { Asset, InstalledBaseEntry } from "./asset.js";
export type { Equipment } from "./equipment.js";
export type { ServiceOrder } from "./service-order.js";
export type { ServiceHistoryEvent } from "./service-history.js";
export type { Opportunity } from "./opportunity.js";
export type { Product } from "./product.js";
export type { Part, PartStockLocation } from "./part.js";
export type { Contract, ContractItem, SLA } from "./contract.js";
export type { KnowledgeArticle } from "./knowledge-article.js";
export type {
  Activity,
  TaskActivity,
  PhoneCallActivity,
  EmailActivity,
  ChatActivity,
} from "./activity.js";
export type { Employee, Skill, TeamMembership } from "./employee.js";
