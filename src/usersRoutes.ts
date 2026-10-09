/**
 * HTTP handlers for personal accounts: sign-in, sign-out, change password, and
 * the admin "Users" API.
 *
 * Deliberately a separate file that RECEIVES the server's helpers (sendJson,
 * readJson, token functions) instead of importing them: uiServer.ts is ~6k lines
 * and owns the in-memory token map, and this keeps the user logic reviewable on
 * its own and the uiServer diff down to a few call sites.
 *
 * Authorisation is NOT done here. The single funnel at the top of handleApi
 * already enforced requiredPermission() (users:read / users:manage) before any
 * of this runs; what's checked below is the finer "which roles can this actor
 * touch" logic, which lives in users.ts next to the data.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { assignableRoles, permissionsOf, type Principal } from "./access.js";
import {
  MIN_PASSWORD_LENGTH,
  UserError,
  changeOwnPassword,
  createUser,
  directoryActive,
  listUsers,
  resetPassword,
  updateUser,
  verifyLogin,
} from "./users.js";

export type RouteIo = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  parts: string[];
  principal: Principal | null;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

export type AuthHooks = {
  issueToken: (userId: string) => string;
  ttlSec: number;
  revokeToken: (token: string) => void;
  /** Revoke every token a user holds, optionally keeping one (their current session). */
  revokeUserTokens: (userId: string, exceptToken?: string) => void;
  bearerOf: (request: IncomingMessage) => string | null;
  clientIp: (request: IncomingMessage) => string;
  /** Fired after the very first account is created: drop all pre-directory tokens. */
  directoryCreated: () => void;
};

function fail(io: RouteIo, error: unknown): void {
  if (error instanceof UserError) {
    io.sendJson(io.response, error.status, { ok: false, error: error.message });
    return;
  }
  console.error("[users] unexpected error:", error);
  io.sendJson(io.response, 500, { ok: false, error: "Something went wrong. Check the server log." });
}

/** /api/auth/login · /api/auth/logout · /api/auth/change-password. Returns true when handled. */
export async function handleAuthRoutes(io: RouteIo, hooks: AuthHooks): Promise<boolean> {
  const { request, response, url, principal, sendJson, readJson } = io;
  const method = request.method ?? "GET";

  if (url.pathname === "/api/auth/login" && method === "POST") {
    if (!directoryActive()) {
      sendJson(response, 409, {
        ok: false,
        error:
          "Personal accounts aren't set up on this deployment yet. Use the shared admin password.",
      });
      return true;
    }
    const body = await readJson(request);
    const result = await verifyLogin(body.email, body.password, hooks.clientIp(request));
    if (!result.ok) {
      sendJson(response, result.status, { ok: false, error: result.error });
      return true;
    }
    sendJson(response, 200, {
      ok: true,
      token: hooks.issueToken(result.user.id),
      ttlSec: hooks.ttlSec,
      user: { email: result.user.email, name: result.user.name },
      role: result.user.role,
      permissions: permissionsOf(result.user.role),
      mustChangePassword: result.user.mustChangePassword,
    });
    return true;
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const token = hooks.bearerOf(request);
    if (token) hooks.revokeToken(token);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/auth/change-password" && method === "POST") {
    if (!principal?.userId) {
      sendJson(response, 400, {
        ok: false,
        error: "Only personal accounts have a password to change.",
      });
      return true;
    }
    const body = await readJson(request);
    try {
      await changeOwnPassword(principal.userId, body.currentPassword, body.newPassword);
    } catch (error) {
      fail(io, error);
      return true;
    }
    // Sign out every OTHER session for this account; keep the one in use.
    hooks.revokeUserTokens(principal.userId, hooks.bearerOf(request) ?? undefined);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

/** /api/admin/users[...]. Returns true when handled (always, for this prefix). */
export async function handleAdminUsers(
  io: RouteIo,
  hooks: Pick<AuthHooks, "directoryCreated">,
): Promise<boolean> {
  const { request, response, parts, principal, sendJson, readJson } = io;
  const method = request.method ?? "GET";

  if (!principal) {
    sendJson(response, 401, { ok: false, error: "Sign in first." });
    return true;
  }

  // parts = ["api", "admin", "users", <id>?, <action>?]
  const id = parts[3];
  const action = parts[4];

  if (!id && method === "GET") {
    const directory = directoryActive();
    sendJson(response, 200, {
      ok: true,
      mode: directory ? "directory" : "legacy",
      users: listUsers(),
      me: {
        role: principal.role,
        userId: principal.userId ?? null,
        email: principal.email ?? null,
      },
      // Before the first account exists the only valid move is creating an owner.
      assignableRoles: directory ? assignableRoles(principal.role) : ["owner"],
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
    return true;
  }

  if (!id && method === "POST") {
    const body = await readJson(request);
    try {
      const { user, tempPassword, firstUser } = await createUser(
        {
          email: body.email,
          name: body.name,
          role: body.role,
          password: body.password,
          ssoOnly: body.ssoOnly,
          forceChange: body.forceChange,
        },
        principal,
      );
      if (firstUser) hooks.directoryCreated();
      // tempPassword is returned exactly once and is never stored in the clear.
      sendJson(response, 201, { ok: true, user, tempPassword, firstUser });
    } catch (error) {
      fail(io, error);
    }
    return true;
  }

  if (id && !action && method === "PATCH") {
    const body = await readJson(request);
    try {
      const user = updateUser(id, { name: body.name, role: body.role, status: body.status }, principal);
      sendJson(response, 200, { ok: true, user });
    } catch (error) {
      fail(io, error);
    }
    return true;
  }

  if (id && action === "reset-password" && method === "POST") {
    try {
      const { user, tempPassword } = await resetPassword(id, principal);
      sendJson(response, 200, { ok: true, user, tempPassword });
    } catch (error) {
      fail(io, error);
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: "Unknown users route." });
  return true;
}
