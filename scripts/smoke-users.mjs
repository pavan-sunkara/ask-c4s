#!/usr/bin/env node
/**
 * smoke-users.mjs — end-to-end check of personal accounts + roles.
 *
 *   npm run build
 *   node scripts/smoke-users.mjs
 *
 * It starts its OWN throwaway shim from dist/ — a random free port, a scratch
 * data folder and NO SAP configuration at all — runs the checks over HTTP, then
 * stops it and deletes the scratch folder. It never touches your real data/,
 * tenant catalog, .env credentials or SAP, so it is safe to run next to a shim
 * you are using. Exit code is non-zero when any check fails.
 *
 * The tenants section starts a FAKE SAP as well — a tiny HTTP server on this
 * machine that checks Basic auth and answers empty OData results — so the admin
 * page's catalog → encrypted password → SAP request path is proven end to end
 * without a real tenant.
 *
 * Needs only Node (18+): no bash, no curl.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "uiServer.js");
if (!existsSync(entry)) {
  console.error("dist/uiServer.js not found — run `npm run build` first.");
  process.exit(2);
}

const OWNER_EMAIL = "owner@smoke.test";
const OWNER_TEMP = "Temp-Owner-Pass-1";
const OWNER_PW = "Smoke-Owner-Pass-2026";
const USER_PW = "Smoke-User-Pass-2026";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "askc4s-smoke-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

// Fake SAP: accepts exactly one Basic-auth pair, logs every request, and
// answers an empty OData result set. Enough to prove the shim sends the
// catalog tenant's credentials — no real SAP is involved anywhere.
const SAP_USER = "sap.integration";
const SAP_PW = "Sap-Secret-1";
const sapAuth = "Basic " + Buffer.from(`${SAP_USER}:${SAP_PW}`).toString("base64");
const sapHits = [];
const fakeSap = createHttpServer((req, res) => {
  sapHits.push({ method: req.method, url: req.url ?? "", auth: req.headers.authorization ?? null, ua: req.headers["user-agent"] ?? null });
  if (req.headers.authorization !== sapAuth) {
    res.writeHead(401, { "content-type": "text/html", "www-authenticate": 'Basic realm="SAP NetWeaver Application Server"' });
    res.end("<html><body>Logon failed</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ d: { results: [] } }));
});
const sapPort = await freePort();
await new Promise((r) => fakeSap.listen(sapPort, "127.0.0.1", r));
const sapBase = `http://127.0.0.1:${sapPort}/sap/c4c/odata/v1/c4codataapi`;

const child = spawn(process.execPath, [entry], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    // Everything the shim writes goes to the scratch folder — including the
    // tenant catalog and its key, which otherwise live under the real data/.
    DATA_DIR: dataDir,
    ADMIN_TENANT_CATALOG_PATH: join(dataDir, "tenant-catalog.json"),
    ADMIN_TENANT_KEY_PATH: join(dataDir, ".tenant-key"),
    ADMIN_TENANT_STORE_PATH: join(dataDir, "tenant-override.json"),
    ADMIN_ENABLED: "true",
    HOST: "127.0.0.1",
    SERVICE_OPS_UI_PORT: String(port),
    ASKC4S_BOOTSTRAP_OWNER_EMAIL: OWNER_EMAIL,
    ASKC4S_BOOTSTRAP_OWNER_PASSWORD: OWNER_TEMP,
    // Don't read the project's .env at all (see connectors/c4c/client.ts), and
    // blank anything the surrounding shell might have exported. Together these
    // mean the throwaway server has no SAP credentials to use, by construction.
    ASKC4S_NO_DOTENV: "1",
    ASKC4S_INTERNAL_PASSWORD: "",
    ASKC4S_ALLOW_SHARED_PASSWORD: "",
    ASKC4S_ADMIN_INSECURE: "",
    ASKC4S_AUTH_ALLOWED_DOMAINS: "",
    C4C_BASE_URL: "",
    C4C_USER: "",
    C4C_PASSWORD: "",
  },
});

let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));
let exited = false;
const exitPromise = new Promise((resolveExit) =>
  child.once("exit", () => {
    exited = true;
    resolveExit();
  }),
);

let passed = 0;
let failed = 0;
function check(name, expected, actual) {
  if (expected === actual) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}   (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* static pages are HTML */
  }
  return { status: res.status, json, text };
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error("the throwaway server exited during start-up");
    try {
      const { json } = await call("GET", "/api/auth/providers");
      // directory:true means the bootstrap owner has been written.
      if (json?.providers?.directory === true) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the throwaway server didn't become ready within 30 seconds");
}

async function createUser(token, email, role, extra = {}) {
  const r = await call("POST", "/api/admin/users", { token, body: { email, role, ...extra } });
  return { status: r.status, id: r.json?.user?.id, temp: r.json?.tempPassword, json: r.json };
}

/** Sign in with the temporary password, choose a real one, return the token. */
async function signIn(email, tempPassword) {
  const login = await call("POST", "/api/auth/login", { body: { email, password: tempPassword } });
  const token = login.json?.token;
  await call("POST", "/api/auth/change-password", {
    token,
    body: { currentPassword: tempPassword, newPassword: USER_PW },
  });
  return token;
}

async function run() {
  console.log(`throwaway shim on ${base}  (data: ${dataDir})\n`);

  console.log("== pages are served ==");
  const settingsPage = await call("GET", "/settings");
  check("/settings serves the admin page", 200, settingsPage.status);
  check("…and it has the Users tab", true, settingsPage.text.includes('id="tab-users"'));
  check("…and the Tenants tab", true, settingsPage.text.includes('id="tab-tenants"'));
  check("/ serves the field app", 200, (await call("GET", "/")).status);

  console.log("\n== owner: sign-in and forced password change ==");
  let r = await call("POST", "/api/auth/login", { body: { email: OWNER_EMAIL, password: "not-the-password-1" } });
  check("wrong password → 401", 401, r.status);
  r = await call("POST", "/api/auth/login", { body: { email: OWNER_EMAIL, password: OWNER_TEMP } });
  check("temporary password signs in", 200, r.status);
  check("…and is flagged must-change", true, r.json?.mustChangePassword);
  const ownerTemp = r.json?.token;
  r = await call("GET", "/api/admin/users", { token: ownerTemp });
  check("temporary token is blocked from admin", 403, r.status);
  check("…with code password_change_required", "password_change_required", r.json?.code);
  r = await call("GET", "/api/recent", { token: ownerTemp });
  check("…and from the normal API too", 403, r.status);
  r = await call("POST", "/api/auth/change-password", {
    token: ownerTemp,
    body: { currentPassword: OWNER_TEMP, newPassword: "short" },
  });
  check("a too-short new password is rejected", 400, r.status);
  r = await call("POST", "/api/auth/change-password", {
    token: ownerTemp,
    body: { currentPassword: OWNER_TEMP, newPassword: OWNER_PW },
  });
  check("owner chooses a real password", 200, r.status);
  const owner = ownerTemp;
  r = await call("GET", "/api/admin/users", { token: owner });
  check("owner can now list users", 200, r.status);
  check("…and sees themselves as an owner", "owner", r.json?.users?.[0]?.role);
  const ownerId = r.json?.users?.[0]?.id;
  r = await call("POST", "/api/internal/auth", { body: { password: "anything" } });
  check("the shared password is refused once accounts exist", 403, r.status);

  console.log("\n== one user per role ==");
  const admin = await createUser(owner, "admin1@smoke.test", "admin");
  const manager = await createUser(owner, "manager1@smoke.test", "manager");
  const agent = await createUser(owner, "agent1@smoke.test", "agent");
  check("owner creates an admin", 201, admin.status);
  check("…and the temporary password is returned once", true, typeof admin.temp === "string" && admin.temp.length >= 12);
  const adminTok = await signIn("admin1@smoke.test", admin.temp);
  const mgrTok = await signIn("manager1@smoke.test", manager.temp);
  const agentTok = await signIn("agent1@smoke.test", agent.temp);
  let me = await call("GET", "/api/auth/me", { token: adminTok });
  check("admin role", "admin", me.json?.role);
  me = await call("GET", "/api/auth/me", { token: mgrTok });
  check("manager role", "manager", me.json?.role);
  check("manager has no write permission", false, me.json?.permissions?.includes("sap:write"));
  me = await call("GET", "/api/auth/me", { token: agentTok });
  check("agent role", "agent", me.json?.role);
  check("agent has the write permission", true, me.json?.permissions?.includes("sap:write"));
  r = await call("POST", "/api/admin/users", { token: owner, body: { email: "admin1@smoke.test", role: "agent" } });
  check("a duplicate email is rejected", 409, r.status);

  console.log("\n== route permissions ==");
  check("agent cannot list users", 403, (await call("GET", "/api/admin/users", { token: agentTok })).status);
  check("agent cannot read settings", 403, (await call("GET", "/api/admin/settings", { token: agentTok })).status);
  check("manager cannot list users", 403, (await call("GET", "/api/admin/users", { token: mgrTok })).status);
  check("manager can read settings", 200, (await call("GET", "/api/admin/settings", { token: mgrTok })).status);
  r = await call("PUT", "/api/admin/settings/feature.auto_writeback_enabled", { token: mgrTok, body: { value: true } });
  check("manager cannot change settings", 403, r.status);
  check("admin can list users", 200, (await call("GET", "/api/admin/users", { token: adminTok })).status);
  check("agent can use the normal API", 200, (await call("GET", "/api/recent", { token: agentTok })).status);
  check("no token → 401", 401, (await call("GET", "/api/recent")).status);
  // Routes of the former console were deleted, not hidden: even the owner gets 404.
  for (const gone of ["/api/admin/tables", "/api/admin/audit", "/api/admin/stats", "/api/admin/tenant"]) {
    check(`${gone} does not exist`, 404, (await call("GET", gone, { token: owner })).status);
  }

  console.log("\n== SAP write gate (no SAP is configured, so nothing can be written) ==");
  const write = (token, dryRun) =>
    call("POST", "/api/tools/update_ticket_priority", {
      token,
      body: { objectId: "SMOKE-NOT-A-REAL-TICKET", servicePriorityCode: "3", dryRun },
    });
  r = await write(mgrTok, false);
  check("manager's real write is blocked", true, r.json?.result?.blocked === true);
  check("…because the role is read-only", true, /read-only/i.test(r.json?.result?.reason ?? ""));
  r = await write(mgrTok, true);
  check("manager can still preview (dry run)", true, r.json?.result?.dryRun === true && !r.json?.result?.blocked);
  r = await write(agentTok, false);
  check("agent's write passes the role check", false, /read-only/i.test(r.json?.result?.reason ?? ""));
  check("…and is stopped only by the write-back feature flag", true, /auto_writeback/i.test(r.json?.result?.reason ?? ""));

  console.log("\n== who may manage whom ==");
  check("admin cannot create an owner", 403, (await call("POST", "/api/admin/users", { token: adminTok, body: { email: "o2@smoke.test", role: "owner" } })).status);
  check("admin can change an agent's role", 200, (await call("PATCH", `/api/admin/users/${agent.id}`, { token: adminTok, body: { role: "manager" } })).status);
  check("…and change it back", 200, (await call("PATCH", `/api/admin/users/${agent.id}`, { token: adminTok, body: { role: "agent" } })).status);
  check("admin cannot promote themselves", 403, (await call("PATCH", `/api/admin/users/${admin.id}`, { token: adminTok, body: { role: "owner" } })).status);
  check("admin cannot touch an owner", 403, (await call("PATCH", `/api/admin/users/${ownerId}`, { token: adminTok, body: { status: "disabled" } })).status);
  check("owner cannot disable themselves", 403, (await call("PATCH", `/api/admin/users/${ownerId}`, { token: owner, body: { status: "disabled" } })).status);
  check("an unknown role is rejected", 400, (await call("PATCH", `/api/admin/users/${agent.id}`, { token: owner, body: { role: "superuser" } })).status);

  console.log("\n== revocation ==");
  check("owner disables the agent", 200, (await call("PATCH", `/api/admin/users/${agent.id}`, { token: owner, body: { status: "disabled" } })).status);
  check("the agent's existing token dies immediately", 401, (await call("GET", "/api/recent", { token: agentTok })).status);
  check("a disabled agent cannot sign in", 403, (await call("POST", "/api/auth/login", { body: { email: "agent1@smoke.test", password: USER_PW } })).status);
  check("owner re-enables the agent", 200, (await call("PATCH", `/api/admin/users/${agent.id}`, { token: owner, body: { status: "active" } })).status);
  check("…and the agent can sign in again", 200, (await call("POST", "/api/auth/login", { body: { email: "agent1@smoke.test", password: USER_PW } })).status);
  r = await call("POST", `/api/admin/users/${manager.id}/reset-password`, { token: owner, body: {} });
  check("owner resets the manager's password", 200, r.status);
  check("…and gets a temporary password back", true, typeof r.json?.tempPassword === "string" && r.json.tempPassword.length >= 12);
  check("the manager's old token dies on reset", 401, (await call("GET", "/api/recent", { token: mgrTok })).status);
  const quitter = await createUser(owner, "quitter@smoke.test", "agent");
  const quitterTok = await signIn("quitter@smoke.test", quitter.temp);
  check("sign out works", 200, (await call("POST", "/api/auth/logout", { token: quitterTok })).status);
  check("…and the token is dead afterwards", 401, (await call("GET", "/api/recent", { token: quitterTok })).status);

  console.log("\n== lockout ==");
  const locky = await createUser(owner, "locky@smoke.test", "agent");
  for (let i = 1; i <= 5; i += 1) {
    await call("POST", "/api/auth/login", { body: { email: "locky@smoke.test", password: `wrong-password-${i}` } });
  }
  r = await call("POST", "/api/auth/login", { body: { email: "locky@smoke.test", password: locky.temp } });
  check("5 failures lock the account — even the right password gets 429", 429, r.status);

  console.log("\n== tenants (a fake SAP on this machine answers the shim) ==");
  const agentTok2 = (await call("POST", "/api/auth/login", { body: { email: "agent1@smoke.test", password: USER_PW } })).json?.token;
  const mgr2 = await createUser(owner, "manager2@smoke.test", "manager");
  const mgrTok2 = await signIn("manager2@smoke.test", mgr2.temp);
  check("manager cannot see tenants", 403, (await call("GET", "/api/admin/tenants", { token: mgrTok2 })).status);
  check("agent cannot see tenants", 403, (await call("GET", "/api/admin/tenants", { token: agentTok2 })).status);
  r = await call("GET", "/api/admin/tenants", { token: owner });
  check("owner sees an empty catalog", true, r.status === 200 && r.json?.source === "missing" && r.json?.tenants?.length === 0);
  const val = { label: "Fake Val", environment: "val", baseUrl: sapBase, user: SAP_USER, password: SAP_PW };
  r = await call("POST", "/api/admin/tenants", { token: owner, body: val });
  check("owner adds a tenant", "fake-val", r.json?.tenant?.id);
  const addText = r.text;
  r = await call("GET", "/api/admin/tenants", { token: owner });
  check("…which becomes active automatically", true, r.json?.activeId === "fake-val" && r.json?.source === "catalog");
  check("…and no password ever comes back", false, /passwordEnc|Sap-Secret-1/.test(addText + r.text));
  r = await call("POST", "/api/admin/tenants/fake-val/test", { token: owner, body: {} });
  check("the stored password reaches SAP", true, r.status === 200 && r.json?.ok === true && r.json?.status === 200);
  r = await call("POST", "/api/admin/tenant/test", { token: owner, body: { ...val, password: "not-the-sap-password" } });
  check("a wrong password is reported as HTTP 401", true, r.status === 200 && r.json?.ok === false && r.json?.status === 401);
  r = await call("POST", "/api/admin/tenants", { token: adminTok, body: { ...val, label: "Fake Prod", environment: "production" } });
  check("admin can add a tenant too", 200, r.status);
  check("…without changing the active one", "fake-val", (await call("GET", "/api/admin/tenants", { token: owner })).json?.activeId);
  r = await call("PATCH", "/api/admin/tenants/fake-prod", { token: adminTok, body: { label: "Fake Prod EU", environment: "production", baseUrl: sapBase, user: SAP_USER } });
  check("editing with a blank password keeps the old one", true, r.status === 200 && (await call("POST", "/api/admin/tenants/fake-prod/test", { token: adminTok, body: {} })).json?.ok === true);
  check("manager cannot add a tenant", 403, (await call("POST", "/api/admin/tenants", { token: mgrTok2, body: val })).status);
  r = await call("POST", "/api/admin/tenants/fake-prod/activate", { token: owner, body: {} });
  check("owner activates the production tenant", "production", r.json?.environment);
  const hitsBefore = sapHits.length;
  check("the extension's first call (client-config) works", 200, (await call("GET", "/api/client-config", { token: agentTok2 })).status);
  r = await call("POST", "/api/lookup", { token: agentTok2, body: { input: "42" } });
  const lookupHits = sapHits.slice(hitsBefore);
  check("an agent's lookup is let through", true, r.status !== 401 && r.status !== 403);
  check("…and reaches the catalog tenant with its credentials", true, lookupHits.some((h) => h.auth === sapAuth && /ServiceRequestCollection/.test(h.url)));
  check("…sending the same User-Agent as the probe", true, lookupHits.length > 0 && lookupHits.every((h) => /AskC4S/.test(h.ua ?? "")));
  r = await call("PUT", "/api/admin/settings/feature.auto_writeback_enabled", { token: owner, body: { value: true } });
  check("owner enables write-back", 200, r.status);
  r = await write(agentTok2, false);
  check("a production tenant refuses a write without acknowledgement", true, r.json?.result?.blocked === true && /acknowledgeProduction/.test(r.json?.result?.reason ?? ""));
  check("testing an unknown tenant is a 404", 404, (await call("POST", "/api/admin/tenants/nope/test", { token: owner, body: {} })).status);
  r = await call("DELETE", "/api/admin/tenants/fake-prod", { token: owner });
  check("removing the active tenant falls back to the next one", "fake-val", r.status === 200 && (await call("GET", "/api/admin/tenants", { token: owner })).json?.activeId);
  await call("DELETE", "/api/admin/tenants/fake-val", { token: owner });
  r = await call("GET", "/api/admin/tenants", { token: owner });
  check("removing the last tenant leaves no SAP connection", true, r.json?.source === "missing" && r.json?.tenants?.length === 0);
  r = await call("POST", "/api/lookup", { token: agentTok2, body: { input: "42" } });
  check("…and a lookup now fails with a clear message", true, r.status === 500 && /C4C config/i.test(r.json?.error ?? ""));
}

try {
  await waitForServer();
  await run();
} catch (error) {
  failed += 1;
  console.error(`\nFATAL: ${error instanceof Error ? error.message : error}`);
} finally {
  child.kill();
  fakeSap.close();
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a leftover temp folder is harmless */
  }
  if (failed > 0 && serverLog) {
    console.error("\n--- throwaway server output (last 40 lines) ---");
    console.error(serverLog.trim().split("\n").slice(-40).join("\n"));
  }
  console.log(`\npassed: ${passed}   failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}
