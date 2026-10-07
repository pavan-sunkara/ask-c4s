/**
 * Roles, permissions and the per-request principal.
 *
 * This is the ONE place that says who may do what. Everything else (the auth
 * gate in uiServer.ts, the SAP write gate in serviceOps.ts, the admin UI) asks
 * this module instead of hard-coding role names, so the matrix below can't
 * drift from what's enforced.
 *
 * Roles (least → most privileged):
 *   agent    field technician / service agent. Uses the extension + PWA, reads
 *            and WRITES to SAP (through the usual write gate). No admin.
 *   manager  oversight. Read-only: reads SAP, can view settings + audit. Can't
 *            write to SAP, can't change anything.
 *   admin    runs the deployment: settings, SAP tenants, users (managers and
 *            agents only), audit. Also writes to SAP.
 *   owner    everything, including other admins/owners and the DB browser.
 *            A deployment always keeps at least one active owner.
 *
 * ENFORCEMENT (see docs/engineering-notes.md → "Users and roles"):
 *   - Route level: requiredPermission() is checked ONCE, in the single funnel
 *     at the top of handleApi — never per route.
 *   - SAP writes: sapWriteDenial() is checked inside the shared write gate
 *     (runGatedWrite), because writes reach SAP from many routes and the gate is
 *     the only place that sees all of them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const ROLES = ["owner", "admin", "manager", "agent"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  agent: "Agent",
};

export type Permission =
  | "sap:read"
  | "sap:write"
  | "settings:read"
  | "settings:write"
  | "tenants:manage"
  | "users:read"
  | "users:manage"
  | "audit:read"
  | "debug";

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "sap:read",
    "sap:write",
    "settings:read",
    "settings:write",
    "tenants:manage",
    "users:read",
    "users:manage",
    "audit:read",
    "debug",
  ]),
  admin: new Set<Permission>([
    "sap:read",
    "sap:write",
    "settings:read",
    "settings:write",
    "tenants:manage",
    "users:read",
    "users:manage",
    "audit:read",
  ]),
  manager: new Set<Permission>(["sap:read", "settings:read", "audit:read"]),
  agent: new Set<Permission>(["sap:read", "sap:write"]),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...GRANTS[role]];
}

/**
 * Roles `actor` may hand out and manage. Owners manage everyone; admins manage
 * managers and agents only — so an admin can never mint or touch an owner/admin.
 */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return [...ROLES];
  if (actor === "admin") return ["manager", "agent"];
  return [];
}

export function canManageRole(actor: Role, target: Role): boolean {
  return assignableRoles(actor).includes(target);
}

// ---------------------------------------------------------------------------
// Principal — who is making this request
// ---------------------------------------------------------------------------

export type PrincipalSource =
  /** A personal account from the user directory (the normal case). */
  | "directory"
  /** Shared admin password — pre-directory deployments, or break-glass. */
  | "password"
  /** SSO token minted before a directory existed. */
  | "google"
  | "entra"
  | "dev"
  /** No token at all: ASKC4S_ADMIN_INSECURE local-dev bypass. */
  | "insecure";

export type Principal = {
  role: Role;
  source: PrincipalSource;
  userId?: string;
  email?: string;
  name?: string;
  /** Directory users with a temporary password must change it before anything else. */
  mustChangePassword?: boolean;
};

/** Short label for audit rows: the email when we know it, else the source. */
export function actorLabel(principal: Principal | null | undefined): string | null {
  if (!principal) return null;
  if (principal.email) return principal.email;
  return principal.source === "insecure" ? "local-dev" : principal.source;
}

const store = new AsyncLocalStorage<Principal | null>();

/**
 * Run `fn` with `principal` attached to the current async context, so code deep
 * in the SAP write path can see who is calling without every function growing a
 * parameter. Used once, around handleApi.
 */
export function runWithPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return store.run(principal, fn);
}

/**
 * undefined → not inside an HTTP request (stdio MCP server, scripts): local
 *             trust, same as before.
 * null      → inside a request but unauthenticated.
 */
export function currentPrincipal(): Principal | null | undefined {
  return store.getStore();
}

/**
 * Why the current caller may not write to SAP, or null when they may.
 * Called by the shared write gate AFTER the dry-run branch, so previews stay
 * available to everyone and only real writes are role-checked.
 */
export function sapWriteDenial(): string | null {
  const principal = store.getStore();
  if (principal === undefined) return null;
  if (principal === null) return "Write blocked: not signed in.";
  if (can(principal.role, "sap:write")) return null;
  return (
    `Write blocked: your role (${principal.role}) is read-only. ` +
    `Ask an owner or admin to change your role if you need to write to SAP.`
  );
}

// ---------------------------------------------------------------------------
// Route → permission
// ---------------------------------------------------------------------------

/**
 * The permission a request needs, or null when any signed-in user may call it.
 *
 * Deliberately SMALL: only the admin surface is mapped. Everything else the
 * extension/PWA calls (lookups, prep, parts, /api/debug/query for the map…)
 * stays open to every signed-in role exactly as before — mapping those
 * route-by-route is how routes get forgotten. SAP *writes* are protected where
 * they converge instead (sapWriteDenial, in the write gate).
 */
export function requiredPermission(method: string, pathname: string): Permission | null {
  const read = method === "GET" || method === "HEAD";
  if (pathname === "/api/admin/users" || pathname.startsWith("/api/admin/users/")) {
    return read ? "users:read" : "users:manage";
  }
  if (pathname.startsWith("/api/admin/tenant")) return "tenants:manage";
  if (pathname.startsWith("/api/admin/tables")) return "debug";
  if (pathname.startsWith("/api/admin/audit")) return "audit:read";
  if (pathname.startsWith("/api/admin/")) return read ? "settings:read" : "settings:write";
  return null;
}
