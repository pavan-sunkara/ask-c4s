/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * User directory — personal accounts, passwords, sign-in and lockout.
 *
 * TWO MODES, and the switch is simply "does the users table have a row?":
 *
 *   legacy     (no users)  Exactly what shipped before: the shared admin
 *                          password, SSO under an optional domain allowlist,
 *                          ASKC4S_ADMIN_INSECURE for local dev. Nothing changes
 *                          until an owner is created, so upgrading is safe.
 *   directory  (≥1 user)   Personal accounts. Every token belongs to a user, the
 *                          role is read live from the database on each request
 *                          (so demoting or disabling someone bites immediately),
 *                          and SSO only admits people who already have an
 *                          account — the directory IS the allowlist.
 *
 * Why SQLite and not a flat file like the tenant catalog: accounts change often
 * and concurrently, and we want UNIQUE(email) enforced by the engine. The
 * catalog's "chicken-and-egg" reason for a flat file (it picks which tenant the
 * tenant-scoped tables belong to) doesn't apply — users are global.
 *
 * Passwords: scrypt (Node built-in, no dependency), per-user random salt,
 * parameters stored in the hash string so they can be raised later without a
 * migration. Comparison is constant-time and unknown emails still pay for one
 * scrypt, so response time doesn't reveal which emails have accounts.
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { getCacheDb, writeAudit } from "./cache.js";
import { getTenantId } from "./c4cClient.js";
import { ROLES, actorLabel, canManageRole, isRole, type Principal, type Role } from "./access.js";

const db = getCacheDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE,
    name                 TEXT,
    role                 TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'active',
    password_hash        TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    locked_until         INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    created_by           TEXT,
    last_login_at        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  password_hash: string | null;
  must_change_password: number;
  failed_attempts: number;
  locked_until: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  last_login_at: number | null;
};

export type UserStatus = "active" | "disabled";

/** What the API returns. Never includes the hash or lockout counters. */
export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  /** false = SSO-only account (can't sign in with a password). */
  hasPassword: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastLoginAt: number | null;
};

/** The few fields the auth gate needs on every request. */
export type LiteUser = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  mustChangePassword: boolean;
};

/** An error that is safe to show the caller, with the HTTP status to use. */
export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

// Fail closed on anything unrecognised: an unknown role is the least privileged
// one, an unknown status is "disabled".
function roleOf(raw: string): Role {
  return isRole(raw) ? raw : "agent";
}

function statusOf(raw: string): UserStatus {
  return raw === "active" ? "active" : "disabled";
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: roleOf(row.role),
    status: statusOf(row.status),
    hasPassword: Boolean(row.password_hash),
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    lastLoginAt: row.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM users`);
const byIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const byEmailStmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
const listStmt = db.prepare(`SELECT * FROM users ORDER BY created_at ASC`);
const otherActiveOwnersStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id <> ?`,
);
const insertStmt = db.prepare(
  `INSERT INTO users
     (id, email, name, role, status, password_hash, must_change_password, created_at, updated_at, created_by)
   VALUES
     (@id, @email, @name, @role, 'active', @password_hash, @must_change_password, @now, @now, @created_by)`,
);
const updateCoreStmt = db.prepare(
  `UPDATE users SET name = @name, role = @role, status = @status, updated_at = @now WHERE id = @id`,
);
const setPasswordStmt = db.prepare(
  `UPDATE users
      SET password_hash = @hash, must_change_password = @must,
          failed_attempts = 0, locked_until = 0, updated_at = @now
    WHERE id = @id`,
);
const loginOkStmt = db.prepare(
  `UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = @now WHERE id = @id`,
);
const loginFailStmt = db.prepare(
  `UPDATE users SET failed_attempts = @failed, locked_until = @locked WHERE id = @id`,
);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function cleanName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const name = String(raw).trim().slice(0, 120);
  return name || null;
}

function audit(
  action: string,
  actor: Principal | string | null,
  targetKey: string | null,
  details?: Record<string, unknown>,
): void {
  try {
    writeAudit({
      tenantId: getTenantId(),
      actor: typeof actor === "string" ? actor : actorLabel(actor),
      action,
      targetTable: "users",
      targetKey,
      details: details ?? null,
    });
  } catch (error) {
    console.warn("[users] audit write failed:", error instanceof Error ? error.message : error);
  }
}

// uiServer registers this so disabling or resetting someone also kills their
// live tokens (tokens live in uiServer's in-memory map).
let revokeSessions: (userId: string) => void = () => {};
export function setSessionRevoker(fn: (userId: string) => void): void {
  revokeSessions = fn;
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200; // bounds the work an attacker can make us do

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHashPromise: Promise<string> | null = null;
/** A real hash of a throwaway secret, so unknown emails cost one scrypt too. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(12).toString("base64"));
  return dummyHashPromise;
}

/** A human-readable reason the password is unacceptable, or null if it's fine. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string") return "A password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    return "Password must not be your email address.";
  }
  return null;
}

/** 20 URL-safe characters (~120 bits). Shown to the admin once, never stored. */
function generateTempPassword(): string {
  return randomBytes(15).toString("base64url");
}

// ---------------------------------------------------------------------------
// Directory queries
// ---------------------------------------------------------------------------

/**
 * True once any account exists. Disabled accounts count: if every owner got
 * disabled the deployment must stay locked (recover with the CLI), never fall
 * back to the open legacy mode.
 */
export function directoryActive(): boolean {
  return (countStmt.get() as { n: number }).n > 0;
}

export function listUsers(): PublicUser[] {
  return (listStmt.all() as UserRow[]).map(toPublic);
}

export function getUserById(id: string): PublicUser | null {
  const row = byIdStmt.get(id) as UserRow | undefined;
  return row ? toPublic(row) : null;
}

export function getUserByEmail(email: string): PublicUser | null {
  const row = byEmailStmt.get(normalizeEmail(email)) as UserRow | undefined;
  return row ? toPublic(row) : null;
}

/** Per-request lookup for the auth gate. null = unknown or disabled. */
export function getActiveUserLite(id: string): LiteUser | null {
  const row = byIdStmt.get(id) as UserRow | undefined;
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: roleOf(row.role),
    mustChangePassword: row.must_change_password === 1,
  };
}

// ---------------------------------------------------------------------------
// Admin operations (all authorised against the acting principal)
// ---------------------------------------------------------------------------

export type CreateUserInput = {
  email: unknown;
  name?: unknown;
  role: unknown;
  /** Omit/blank → a temporary password is generated and returned once. */
  password?: unknown;
  /** true → no password; the person signs in through Google/Entra only. */
  ssoOnly?: unknown;
  /**
   * true (default) → the person must change the supplied password at first
   * sign-in. false → a shared / service account that keeps the given password
   * (e.g. a single login several people share). Ignored for ssoOnly accounts
   * and for the first owner (who always keeps their own password).
   */
  forceChange?: unknown;
};

export async function createUser(
  input: CreateUserInput,
  actor: Principal,
): Promise<{ user: PublicUser; tempPassword: string | null; firstUser: boolean }> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new UserError("A valid email address is required.");
  }
  if (!isRole(input.role)) {
    throw new UserError(`Role must be one of: ${ROLES.join(", ")}.`);
  }
  const role: Role = input.role;
  const ssoOnly = input.ssoOnly === true;
  const firstUser = !directoryActive();

  if (firstUser) {
    // Moving a deployment from the shared password to personal accounts: the
    // first account must be an owner who can always get back in with a password.
    if (role !== "owner") throw new UserError("The first account must be an owner.");
    if (ssoOnly) {
      throw new UserError("The first owner needs a password so you can always sign in.");
    }
  } else if (!canManageRole(actor.role, role)) {
    throw new UserError(`Your role (${actor.role}) can't create ${role} accounts.`, 403);
  }
  if (getUserByEmail(email)) throw new UserError("A user with that email already exists.", 409);

  let tempPassword: string | null = null;
  let hash: string | null = null;
  let mustChange = 0;
  if (!ssoOnly) {
    const supplied =
      typeof input.password === "string" && input.password.length > 0 ? input.password : null;
    if (supplied) {
      const problem = passwordProblem(supplied, email);
      if (problem) throw new UserError(problem);
      hash = await hashPassword(supplied);
      // The first owner keeps their own password; everyone else must change
      // theirs at first sign-in — unless it's a shared/service account.
      mustChange = firstUser || input.forceChange === false ? 0 : 1;
    } else {
      tempPassword = generateTempPassword();
      hash = await hashPassword(tempPassword);
      mustChange = 1;
    }
  }

  const id = randomUUID();
  try {
    insertStmt.run({
      id,
      email,
      name: cleanName(input.name),
      role,
      password_hash: hash,
      must_change_password: mustChange,
      now: Date.now(),
      created_by: actorLabel(actor),
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new UserError("A user with that email already exists.", 409);
    }
    throw error;
  }
  audit("user.create", actor, id, { email, role, ssoOnly });
  return { user: toPublic(byIdStmt.get(id) as UserRow), tempPassword, firstUser };
}

export function updateUser(
  id: string,
  patch: { name?: unknown; role?: unknown; status?: unknown },
  actor: Principal,
): PublicUser {
  const target = byIdStmt.get(id) as UserRow | undefined;
  if (!target) throw new UserError("User not found.", 404);
  const targetRole = roleOf(target.role);
  const targetStatus = statusOf(target.status);
  const self = actor.userId === target.id;

  if (!self && !canManageRole(actor.role, targetRole)) {
    throw new UserError(`Your role (${actor.role}) can't manage ${targetRole} accounts.`, 403);
  }

  let name = target.name;
  let role: Role = targetRole;
  let status: UserStatus = targetStatus;
  if (patch.name !== undefined) name = cleanName(patch.name);
  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw new UserError(`Role must be one of: ${ROLES.join(", ")}.`);
    role = patch.role;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "disabled") {
      throw new UserError('Status must be "active" or "disabled".');
    }
    status = patch.status;
  }

  const roleChanged = role !== targetRole;
  const statusChanged = status !== targetStatus;
  if (self && (roleChanged || statusChanged)) {
    // Stops both accidental lock-out and self-promotion.
    throw new UserError("You can't change your own role or status. Ask another admin.", 403);
  }
  if (roleChanged && !canManageRole(actor.role, role)) {
    throw new UserError(`Your role (${actor.role}) can't assign the ${role} role.`, 403);
  }
  if (targetRole === "owner" && targetStatus === "active" && (role !== "owner" || status !== "active")) {
    const others = (otherActiveOwnersStmt.get(id) as { n: number }).n;
    if (others === 0) {
      throw new UserError("That is the last active owner. Make someone else an owner first.", 409);
    }
  }

  updateCoreStmt.run({ id, name, role, status, now: Date.now() });
  if (statusChanged && status === "disabled") revokeSessions(id);
  if (statusChanged && status === "active") loginFailStmt.run({ id, failed: 0, locked: 0 });

  audit("user.update", actor, id, {
    email: target.email,
    ...(roleChanged ? { role: { from: targetRole, to: role } } : {}),
    ...(statusChanged ? { status: { from: targetStatus, to: status } } : {}),
    ...(name !== target.name ? { name: true } : {}),
  });
  return toPublic(byIdStmt.get(id) as UserRow);
}

export async function resetPassword(
  id: string,
  actor: Principal,
): Promise<{ user: PublicUser; tempPassword: string }> {
  const target = byIdStmt.get(id) as UserRow | undefined;
  if (!target) throw new UserError("User not found.", 404);
  if (actor.userId === target.id) {
    throw new UserError("Use Change password for your own account.", 403);
  }
  if (!canManageRole(actor.role, roleOf(target.role))) {
    throw new UserError(`Your role (${actor.role}) can't manage ${roleOf(target.role)} accounts.`, 403);
  }
  const tempPassword = generateTempPassword();
  setPasswordStmt.run({ id, hash: await hashPassword(tempPassword), must: 1, now: Date.now() });
  revokeSessions(id);
  audit("user.reset_password", actor, id, { email: target.email });
  return { user: toPublic(byIdStmt.get(id) as UserRow), tempPassword };
}

/** Self-service. The caller proves they know the current password. */
export async function changeOwnPassword(
  userId: string,
  current: unknown,
  next: unknown,
): Promise<void> {
  const row = byIdStmt.get(userId) as UserRow | undefined;
  if (!row || row.status !== "active") throw new UserError("Account not found.", 404);
  const knowsCurrent =
    typeof current === "string" &&
    current.length <= MAX_PASSWORD_LENGTH &&
    Boolean(row.password_hash) &&
    (await verifyPassword(current, row.password_hash as string));
  if (!knowsCurrent) {
    recordFailure(row);
    throw new UserError("Current password is incorrect.", 403);
  }
  const problem = passwordProblem(next, row.email);
  if (problem) throw new UserError(problem);
  if (next === current) throw new UserError("Choose a password different from the current one.");
  setPasswordStmt.run({ id: userId, hash: await hashPassword(next as string), must: 0, now: Date.now() });
  audit("user.change_password", row.email, userId);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; user: PublicUser }
  | { ok: false; status: 401 | 403 | 429; error: string };

const BAD_LOGIN = "Incorrect email or password.";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Per-address throttle on top of the per-account lockout, so one source can't
// walk through many accounts. In-memory: a restart resets it, which is fine for
// a brake (the lockout is what's persisted).
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_FAILURES = 30;
const ipFailures = new Map<string, { count: number; resetAt: number }>();

function ipBlocked(ip: string): boolean {
  const entry = ipFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    ipFailures.delete(ip);
    return false;
  }
  return entry.count >= IP_MAX_FAILURES;
}

function noteIpFailure(ip: string): void {
  const now = Date.now();
  const entry = ipFailures.get(ip);
  if (!entry || entry.resetAt < now) {
    ipFailures.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (ipFailures.size > 500) {
    for (const [key, value] of ipFailures) if (value.resetAt < now) ipFailures.delete(key);
  }
}

function recordFailure(row: UserRow): void {
  const failed = row.failed_attempts + 1;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    loginFailStmt.run({ id: row.id, failed: 0, locked: Date.now() + LOCK_MS });
    audit("auth.lockout", row.email, row.id, { minutes: LOCK_MS / 60000 });
  } else {
    loginFailStmt.run({ id: row.id, failed, locked: 0 });
  }
}

export async function verifyLogin(
  emailRaw: unknown,
  password: unknown,
  ip: string,
): Promise<LoginResult> {
  if (ipBlocked(ip)) {
    return {
      ok: false,
      status: 429,
      error: "Too many sign-in attempts from this address. Try again in a few minutes.",
    };
  }
  const email = normalizeEmail(emailRaw);
  if (!email || typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, status: 401, error: BAD_LOGIN };
  }

  const row = byEmailStmt.get(email) as UserRow | undefined;
  if (!row || !row.password_hash) {
    await verifyPassword(password, await dummyHash()); // same cost as a real attempt
    noteIpFailure(ip);
    return { ok: false, status: 401, error: BAD_LOGIN };
  }

  const now = Date.now();
  if (row.locked_until > now) {
    const minutes = Math.ceil((row.locked_until - now) / 60000);
    return {
      ok: false,
      status: 429,
      error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }

  if (!(await verifyPassword(password, row.password_hash))) {
    noteIpFailure(ip);
    recordFailure(row);
    return { ok: false, status: 401, error: BAD_LOGIN };
  }
  // Only a correct password learns the account state, so a stranger can't use
  // the "disabled" message to probe for accounts.
  if (row.status !== "active") {
    return { ok: false, status: 403, error: "This account is disabled. Contact your administrator." };
  }

  loginOkStmt.run({ id: row.id, now });
  audit("auth.login", row.email, row.id);
  return { ok: true, user: toPublic(byIdStmt.get(row.id) as UserRow) };
}

/**
 * SSO (Google/Entra) in directory mode: the identity provider vouches for the
 * email, the directory decides whether that person may use this deployment.
 * No auto-provisioning — an admin adds people first.
 */
export function resolveSsoUser(
  emailRaw: string,
): { ok: true; user: PublicUser } | { ok: false; status: 403; error: string } {
  const email = normalizeEmail(emailRaw);
  const row = byEmailStmt.get(email) as UserRow | undefined;
  if (!row) {
    return {
      ok: false,
      status: 403,
      error: `There is no Ask C4S account for ${email}. Ask your administrator to add you.`,
    };
  }
  if (row.status !== "active") {
    return { ok: false, status: 403, error: "This account is disabled. Contact your administrator." };
  }
  loginOkStmt.run({ id: row.id, now: Date.now() });
  audit("auth.login_sso", row.email, row.id);
  return { ok: true, user: toPublic(row) };
}

// ---------------------------------------------------------------------------
// Bootstrap + recovery (no HTTP, no acting principal)
// ---------------------------------------------------------------------------

/**
 * First-run provisioning for hosted deployments: if the directory is empty and
 * ASKC4S_BOOTSTRAP_OWNER_EMAIL + ASKC4S_BOOTSTRAP_OWNER_PASSWORD are set, create
 * that owner (who must change the password at first sign-in). A no-op once any
 * account exists, so leaving the variables in place later does nothing — remove
 * them anyway.
 */
export async function bootstrapOwnerFromEnv(): Promise<void> {
  if (directoryActive()) return;
  const email = normalizeEmail(process.env.ASKC4S_BOOTSTRAP_OWNER_EMAIL);
  const password = process.env.ASKC4S_BOOTSTRAP_OWNER_PASSWORD ?? "";
  if (!email && !password) return;
  if (!EMAIL_RE.test(email) || !password) {
    console.warn(
      "[users] bootstrap skipped: set BOTH ASKC4S_BOOTSTRAP_OWNER_EMAIL and ASKC4S_BOOTSTRAP_OWNER_PASSWORD.",
    );
    return;
  }
  const problem = passwordProblem(password, email);
  if (problem) {
    console.warn(`[users] bootstrap skipped: ${problem}`);
    return;
  }
  const id = randomUUID();
  insertStmt.run({
    id,
    email,
    name: null,
    role: "owner",
    password_hash: await hashPassword(password),
    must_change_password: 1,
    now: Date.now(),
    created_by: "bootstrap",
  });
  audit("user.create", "bootstrap", id, { email, role: "owner", via: "env" });
  console.log(
    `[users] bootstrapped owner ${email} from env — they must change the password at first sign-in. ` +
      `Remove ASKC4S_BOOTSTRAP_OWNER_PASSWORD from the environment now.`,
  );
}

/**
 * Recovery from the host (see usersCli.ts): create the owner, or promote and
 * re-enable an existing account, and set a temporary password. This is the way
 * back in if the last owner forgot their password.
 */
export async function systemSetOwner(emailRaw: string, password: string): Promise<PublicUser> {
  const email = normalizeEmail(emailRaw);
  if (!EMAIL_RE.test(email)) throw new UserError("A valid email address is required.");
  const problem = passwordProblem(password, email);
  if (problem) throw new UserError(problem);
  const hash = await hashPassword(password);
  const now = Date.now();
  const existing = byEmailStmt.get(email) as UserRow | undefined;
  if (existing) {
    updateCoreStmt.run({ id: existing.id, name: existing.name, role: "owner", status: "active", now });
    setPasswordStmt.run({ id: existing.id, hash, must: 1, now });
    revokeSessions(existing.id);
    audit("user.system_set_owner", "cli", existing.id, { email });
    return toPublic(byIdStmt.get(existing.id) as UserRow);
  }
  const id = randomUUID();
  insertStmt.run({
    id,
    email,
    name: null,
    role: "owner",
    password_hash: hash,
    must_change_password: 1,
    now,
    created_by: "cli",
  });
  audit("user.create", "cli", id, { email, role: "owner" });
  return toPublic(byIdStmt.get(id) as UserRow);
}
