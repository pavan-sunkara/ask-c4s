#!/usr/bin/env node
/**
 * scripts/dev.mjs — start Ask C4S on this machine for development.
 *
 *   npm start                  compile the shim, run it on 127.0.0.1:3031 with the
 *                              local-dev settings, wait until it answers, open Chrome
 *                              with the extension loaded into its own profile
 *   npm start -- --no-chrome   shim only (the admin page and the field app are
 *                              served by the shim anyway)
 *   npm start -- --replace     stop the Ask C4S shim that already holds the port,
 *                              then start this one
 *   npm run stop               stop the shim on the port
 *
 * Never two shims. If the port already answers as an Ask C4S shim this refuses to
 * start another one: left alone, the new shim would hop to the next free port and
 * the extension (which expects 3031) would keep talking to the old one. Anything
 * on the port that is NOT a shim is reported and never touched.
 *
 * Ctrl+C stops the shim and closes the dev browser. Needs only Node 18+.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(value("--port", process.env.SERVICE_OPS_UI_PORT || 3031));
const base = `http://127.0.0.1:${port}`;
const isWin = platform() === "win32";
const log = (m) => console.log(`[askc4s] ${m}`);

if (has("--help") || has("-h")) {
  console.log(`usage: npm start [-- --no-chrome] [-- --replace] [-- --port <n>]
       npm run stop [-- --port <n>]
The extension expects port 3031; --port is for experiments.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// What is on the port?  "free" | { shim, pid } | { other, pid }
// ---------------------------------------------------------------------------
function portBusy() {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); done(true); });
    s.once("error", () => done(false));
  });
}

async function describePort() {
  if (!(await portBusy())) return "free";
  const pid = pidOnPort();
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j = res.ok ? await res.json().catch(() => null) : null;
    if (j && j.ok === true && typeof j.name === "string") return { shim: j, pid };
  } catch {
    /* not HTTP, or not answering — treat as foreign */
  }
  return { other: true, pid };
}

function pidOnPort() {
  try {
    if (isWin) {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout ?? "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
    } else {
      const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "";
      const pid = Number(out.trim().split(/\s+/)[0]);
      if (pid) return pid;
    }
  } catch {
    /* best effort */
  }
  return null;
}

function kill(pid) {
  if (isWin) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGTERM");
}

async function waitUntil(predicate, ms, every = 300) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

async function stopShim(state) {
  if (state === "free") {
    log(`Nothing is listening on ${base}.`);
    return true;
  }
  if (state.other) {
    log(`Port ${port} is in use by something that is not an Ask C4S shim${state.pid ? ` (pid ${state.pid})` : ""} — leaving it alone.`);
    return false;
  }
  if (!state.pid) {
    log(`An Ask C4S shim answers on ${base} but its process could not be found — stop it by hand.`);
    return false;
  }
  log(`Stopping the Ask C4S shim on ${base} (pid ${state.pid})…`);
  kill(state.pid);
  const gone = await waitUntil(async () => !(await portBusy()), 8000);
  log(gone ? "Stopped." : `Still listening after 8 s — stop pid ${state.pid} by hand.`);
  return gone;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
function findBrowser() {
  if (process.env.ASKC4S_BROWSER) return process.env.ASKC4S_BROWSER;
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LocalAppData ?? join(homedir(), "AppData", "Local");
  const candidates = isWin
    ? [
        join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        join(local, "Google", "Chrome", "Application", "chrome.exe"),
        join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function profileDir() {
  if (process.env.ASKC4S_DEV_PROFILE) return process.env.ASKC4S_DEV_PROFILE;
  if (isWin) return join(process.env.LocalAppData ?? homedir(), "AskC4S-Dev-Profile");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "AskC4S-Dev-Profile");
  return join(homedir(), ".config", "askc4s-dev-profile");
}

// Google Chrome 137+ silently ignores --load-extension. The supported way to load an
// unpacked extension from a script is the DevTools command Extensions.loadUnpacked over
// Chrome's debugging PIPE (fd 3 in, fd 4 out; needs --enable-unsafe-extension-debugging) —
// the mechanism Puppeteer uses. Keeping the pipe open keeps the browser open, so the dev
// browser lives exactly as long as this launcher.
let browser = null;
function openBrowser() {
  const exe = findBrowser();
  if (!exe) {
    log("No Chrome or Edge found. Set ASKC4S_BROWSER=<path to chrome.exe>, or load chrome-extension/ by hand at chrome://extensions (Developer mode → Load unpacked).");
    return;
  }
  const child = spawn(
    exe,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profileDir()}`,
      "--no-first-run",
      "--no-default-browser-check",
      `${base}/settings`,
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  child.on("error", (e) => log(`Couldn't start the browser: ${e.message}`));
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  toChrome.on("error", () => {});
  fromChrome.on("error", () => {});
  let buf = "";
  fromChrome.setEncoding("utf8");
  fromChrome.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id !== 1) continue;
      if (msg.result?.id) {
        log(`Opened ${basename(exe)} with the extension loaded (id ${msg.result.id}; dev profile: ${profileDir()}).`);
      } else {
        log(`Opened ${basename(exe)}, but it could not load the extension (${msg.error?.message ?? "unknown error"}).`);
        log("Load chrome-extension/ by hand once: chrome://extensions → Developer mode → Load unpacked. It then stays in this profile.");
      }
    }
  });
  toChrome.write(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: join(root, "chrome-extension") } }) + "\0");
  browser = { child, toChrome };
}

function closeBrowser() {
  if (!browser) return;
  try { browser.toChrome.write(JSON.stringify({ id: 2, method: "Browser.close" }) + "\0"); } catch { /* already gone */ }
  browser = null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const state = await describePort();

if (has("--stop")) {
  process.exit((await stopShim(state)) ? 0 : 1);
}

if (state !== "free") {
  if (state.shim && has("--replace")) {
    if (!(await stopShim(state))) process.exit(1);
  } else if (state.shim) {
    log(`An Ask C4S shim is already running at ${base}${state.pid ? ` (pid ${state.pid})` : ""} — not starting a second one.`);
    log("Use it as it is, stop it with `npm run stop`, or replace it with `npm start -- --replace`.");
    process.exit(1);
  } else {
    log(`Port ${port} is in use by something that is not an Ask C4S shim${state.pid ? ` (pid ${state.pid})` : ""}. Stop it, or pass --port <n>.`);
    process.exit(1);
  }
}

log("Compiling the shim (tsc)…");
const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root, stdio: "inherit" });
if (tsc.status !== 0) {
  log("Compile failed — fix the errors above.");
  process.exit(tsc.status ?? 1);
}

// Local-dev posture: no sign-in required (ignored the moment a password or an
// account exists), admin API on, fixed port. --use-system-ca makes Node trust the
// OS certificate store (corporate TLS interception) when the running Node has it.
const env = {
  ...process.env,
  ASKC4S_ADMIN_INSECURE: "true",
  ADMIN_ENABLED: "true",
  SERVICE_OPS_UI_PORT: String(port),
  HOST: "127.0.0.1",
};
if (process.allowedNodeEnvironmentFlags.has("--use-system-ca") && !(env.NODE_OPTIONS ?? "").includes("--use-system-ca")) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --use-system-ca`.trim();
}

const shim = spawn(process.execPath, [join(root, "dist", "uiServer.js")], { cwd: root, env, stdio: "inherit" });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  closeBrowser();
  if (shim.exitCode === null) {
    if (isWin) spawnSync("taskkill", ["/PID", String(shim.pid), "/T", "/F"], { stdio: "ignore" });
    else shim.kill("SIGTERM");
  }
};
process.on("SIGINT", () => { stop(); process.exit(130); });
process.on("SIGTERM", () => { stop(); process.exit(143); });
process.on("exit", stop);
shim.on("exit", (code) => {
  if (!stopping) {
    log(`The shim exited (code ${code ?? "?"}).`);
    process.exit(code ?? 1);
  }
});

const up = await waitUntil(async () => (await describePort())?.shim !== undefined, 60_000);
if (!up) {
  log(`The shim did not answer on ${base} within 60 s — see its output above.`);
  stop();
  process.exit(1);
}

log(`Shim is up: ${base}`);
log(`  admin page   ${base}/settings`);
log(`  field app    ${base}/`);
if (has("--no-chrome")) {
  log("  extension    not opened (--no-chrome); load chrome-extension/ in chrome://extensions if needed");
} else {
  openBrowser();
  log("  extension    pin Ask C4S in the toolbar; Ctrl+Shift+U opens the side panel");
}
log(has("--no-chrome") ? "Ctrl+C stops the shim." : "Ctrl+C stops the shim and closes the dev browser.");
