// Ask C4S — background service worker
// ---------------------------------------------------------------------------
// Responsibilities:
//   1. Add the right-click "Ask C4S about <selection>" context menu
//   2. Handle the in-page "Ask C4S" floating-button click (sent via
//      chrome.runtime.sendMessage from content.js)
//   3. Pass the active-tab URL into the popup so popup.js can detect a
//      ticket ID from it
//   4. Wire keyboard shortcuts (Ctrl+Shift+Y → popup, Ctrl+Shift+U → side
//      panel)
//   5. Handle "open-side-panel" messages from popup to flip a session
//      into the persistent side-panel mode

const CONTEXT_MENU_ID = "askc4s-ask-selection";
const CONTEXT_MENU_KB_ID = "c4s-kb-search-selection";

// ---- SLA-watcher constants ----
const SLA_ALARM = "c4s-sla-watch";
const SLA_NOTIFIED_KEY = "c4s.sla-watch.notified";
const SLA_LAST_RUN_KEY = "c4s.sla-watch.lastRun";

// Settings keys (chrome.storage.sync)
const SLA_ENABLED_KEY = "c4s.sla-watch.enabled";
const SLA_HOURS_AHEAD_KEY = "c4s.sla-watch.hoursAhead";
const SLA_INTERVAL_KEY = "c4s.sla-watch.intervalMinutes";

// ---------------------------------------------------------------------------
// Per-tab side-panel gating
// ---------------------------------------------------------------------------
// Ask C4S is a Service Cloud companion, so the side panel should only be
// available on SAP C4C tabs — not on every tab in the browser. We enable the
// panel for C4C hosts and disable it everywhere else.
//
// Note on behaviour: Chrome's `enabled` flag controls *availability*, not
// auto-opening. Landing on a disabled tab hides an open panel, but returning
// to a C4C tab may need a single click on the toolbar icon to reopen it —
// Chrome requires a user gesture to open a side panel, so an extension cannot
// auto-reopen it on a tab switch.
const SIDE_PANEL_PATH = "popup.html?mode=sidepanel";

// Matches the SAP C4C hosts declared in manifest host_permissions:
//   *.crm.ondemand.com, *.crm.sap.com, *.c4c.sap.com
// Anchored to the end of the hostname so only these domains (and their
// subdomains) match — never something like "crm.sap.com.evil.example".
const C4C_HOST_RE = /(^|\.)(crm\.ondemand\.com|crm\.sap\.com|c4c\.sap\.com)$/i;

function isC4cUrl(url) {
  if (!url) return false;
  try {
    return C4C_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false; // chrome://, about:blank, malformed, etc.
  }
}

// Enable the panel on C4C tabs, disable it on everything else.
async function applyPanelForTab(tabId, url) {
  if (typeof tabId !== "number" || tabId < 0) return;
  if (!chrome.sidePanel?.setOptions) return; // Chrome < 114
  try {
    if (isC4cUrl(url)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: SIDE_PANEL_PATH,
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch (e) {
    console.warn("[c4s] side-panel setOptions failed:", e);
  }
}

// Re-evaluate every existing tab. Needed on install/update and browser
// restart, where tabs already exist and no navigation event fires for them.
async function syncAllTabsPanelState() {
  if (!chrome.sidePanel?.setOptions) return;
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => applyPanelForTab(t.id, t.url || "")));
  } catch (e) {
    console.warn("[c4s] side-panel syncAllTabs failed:", e);
  }
}

// A tab finished loading or navigated to a new URL → re-evaluate it.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || typeof info.url === "string") {
    applyPanelForTab(tabId, tab?.url || "");
  }
});

// Switching tabs → make sure the newly-active tab has the correct state
// (covers tabs that were open before the extension started).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    applyPanelForTab(tabId, tab?.url || "");
  } catch {
    /* tab may have closed between activation and lookup */
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: on a reload/update the items may already exist, and a bare
  // create() then logs "Cannot create item with duplicate id". Clearing first
  // makes re-registration idempotent and keeps the Errors page clean.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Ask C4S about "%s"',
      contexts: ["selection"],
    });
    // KB search — operator selects an error code, symptom, part number,
    // whatever, right-clicks, and the panel opens with `/kb <selection>`
    // pre-filled. One click on Ask runs the search.
    chrome.contextMenus.create({
      id: CONTEXT_MENU_KB_ID,
      title: 'Search C4S knowledge base for "%s"',
      contexts: ["selection"],
    });
  });
  // Re-initialise the SLA watcher on every install/update so manifest
  // permission bumps take effect cleanly.
  initSlaWatcher().catch((e) => console.warn("[c4s] initSlaWatcher on install:", e));
  // v0.26.31 — make the toolbar-icon click open the side panel by
  // default. Requires `default_popup` to NOT be set in manifest (we
  // removed it in v0.26.31). When this is true, clicking the action
  // icon AND the _execute_action keyboard shortcut both route to the
  // side panel instead of a popup. Users wanting a detached popup
  // window can use the "Pop out" button inside the side panel.
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn("[c4s] setPanelBehavior failed:", e));
  }
  // Gate the panel to C4C tabs for any tabs already open at install/update.
  syncAllTabsPanelState();
});

// Re-apply on startup in case onInstalled didn't fire (browser
// restart after install). Idempotent — Chrome stores the panel
// behavior persistently, but no harm in re-setting.
chrome.runtime.onStartup.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => { /* ignore */ });
  }
  // Re-gate the panel to C4C tabs for tabs restored on browser launch.
  syncAllTabsPanelState();
});

// Also re-init on startup — service workers are short-lived, but onStartup
// fires once when the browser launches with the extension already installed.
chrome.runtime.onStartup.addListener(() => {
  initSlaWatcher().catch((e) => console.warn("[c4s] initSlaWatcher on startup:", e));
});

// Re-init whenever the user changes the SLA-watcher settings in Options.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (SLA_ENABLED_KEY in changes || SLA_INTERVAL_KEY in changes) {
    initSlaWatcher().catch((e) => console.warn("[c4s] initSlaWatcher on storage:", e));
  }
});

// Right-click handlers — different stash payload per menu item so the
// popup can format the prompt appropriately.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const selection = info.selectionText?.trim() ?? "";
  if (!selection) return;

  if (info.menuItemId === CONTEXT_MENU_ID) {
    // Generic "Ask C4S about <selection>" — popup pre-fills with
    // 'Tell me about: "<selection>"'.
    await chrome.storage.session.set({
      "pending-query": {
        kind: "ask",
        text: selection,
        url: tab?.url ?? "",
        at: Date.now(),
      },
    });
    openPopupWindow();
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_KB_ID) {
    // KB search — popup pre-fills with `/kb <selection>` so the user
    // just clicks Ask. Special kind tells popup.js to use the slash form.
    await chrome.storage.session.set({
      "pending-query": {
        kind: "kb-search",
        text: selection,
        url: tab?.url ?? "",
        at: Date.now(),
      },
    });
    openPopupWindow();
    return;
  }
});

// In-page button click → open popup window. The content script can't open
// the action popup directly, so it messages the service worker.
//
// Note: we deliberately do NOT handle an "open-side-panel" message here.
// chrome.sidePanel.open() requires a user-gesture context, and Chrome
// drops the gesture token when a message crosses processes (popup ➜
// service worker via runtime.sendMessage). The popup calls sidePanel.open()
// directly instead — see openInSidePanel() in popup.js.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "open-popup") {
        // Stash the page snapshot (scraped DOM) so the popup can use it as
        // additional LLM context. Expires after 10 min via the timestamp.
        if (msg.pageSnapshot) {
          await chrome.storage.session.set({
            "page-snapshot": msg.pageSnapshot,
          });
        }
        openPopupWindow();
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "apply-annotation") {
        // In-page annotation overlay clicked Apply. We can't call the
        // shim directly from the page context (no auth), so we route
        // through the background worker which has chrome.storage access
        // for the auth token.
        const result = await applyAnnotationFromBackground(msg.actionTool, msg.actionArgs);
        sendResponse(result);
        return;
      }
      sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // keep the channel open for the async response
});

/**
 * Apply an annotation by calling the shim's tool endpoint. Pulls auth
 * (SSO token, fall-back to manual token) from chrome.storage.sync —
 * the page-context script doesn't have access to those, so all
 * writebacks have to be funneled through this background handler.
 */
async function applyAnnotationFromBackground(actionTool, actionArgs) {
  if (!actionTool || typeof actionTool !== "string") {
    return { ok: false, error: "missing actionTool" };
  }
  // Whitelist tools to prevent malicious page injection from triggering
  // arbitrary tool calls. Only the safe-write tools the LLM is allowed
  // to suggest.
  const ALLOWED = new Set([
    "update_ticket_priority",
    "update_ticket_lifecycle",
    "escalate_ticket",
    "add_service_request_text",
    // /order-parts cart commits route through here too — each cart entry
    // becomes a single log_service_item POST with processingTypeCode=SRP1.
    "log_service_item",
  ]);
  if (!ALLOWED.has(actionTool)) {
    return { ok: false, error: `tool "${actionTool}" not in allowlist` };
  }
  try {
    const { endpoint, token, "sso-token": ssoToken, "sso-expires-at": ssoExp } =
      await chrome.storage.sync.get(["endpoint", "token", "sso-token", "sso-expires-at"]);
    const baseUrl = (endpoint || "http://127.0.0.1:3031").replace(/\/$/, "");
    const authToken = (ssoToken && Date.now() < (ssoExp ?? 0)) ? ssoToken : (token || "");
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    headers["X-Admin-Actor"] = "chrome-extension";
    const body = {
      ...(actionArgs || {}),
      dryRun: false,
      acknowledgeProduction: true,
    };
    const r = await fetch(`${baseUrl}/api/tools/${actionTool}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    // The shim denies every /api/* route without a Bearer token. Say so in
    // words the operator can act on — this is the write path, so the raw
    // "HTTP 401" would otherwise read as "SAP rejected my commit".
    if (r.status === 401) {
      return {
        ok: false,
        error:
          "Not signed in — the shim rejected this write (401). " +
          "Open the Ask C4S Options page and sign in, then try again. " +
          "Nothing was written to SAP.",
      };
    }
    if (!r.ok) return { ok: false, error: data?.error || `HTTP ${r.status}` };
    // v0.26.80 — detect runGatedWrite blocked/dryRun responses. They
    // come back with HTTP 200 + result.blocked=true (or result.dryRun=true)
    // and the previous `ok === false` check didn't match these shapes.
    // The cart was clearing as if the commit succeeded, but no SAP write
    // had happened. Surface these states as errors with the actionable
    // reason so the operator sees what to flip in /admin → Settings.
    if (data?.result && data.result.blocked === true) {
      return {
        ok: false,
        error: data.result.reason || "Write blocked by feature flag",
        blocked: true,
        wouldDo: data.result.wouldDo,
      };
    }
    if (data?.result && data.result.dryRun === true) {
      return {
        ok: false,
        error: data.result.note || "Dry-run only — no SAP write happened",
        dryRun: true,
        wouldDo: data.result.wouldDo,
      };
    }
    if (data?.result && data.result.ok === false) {
      return { ok: false, error: data.result.error || data.result.message || "tool failed" };
    }
    return { ok: true, result: data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Keyboard shortcut: Ctrl+Shift+U opens the side panel. (The Ctrl+Shift+Y
// shortcut maps to _execute_action automatically — Chrome handles it.)
//
// We use the callback form (not async/await) so we never await between
// the gesture and chrome.sidePanel.open(). Awaiting a promise inside a
// command handler can drop the user-gesture token on some Chrome
// versions, which would surface as "sidePanel.open() may only be
// called in response to a user gesture."
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-side-panel") return;
  chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
    if (chrome.runtime.lastError || !win?.id) return;
    chrome.sidePanel.open({ windowId: win.id }).catch(() => {
      /* sidePanel.open requires Chrome 116+ — silently skip on older */
    });
  });
});

function openPopupWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?from=in-page"),
    type: "popup",
    width: 480,
    height: 640,
  });
}

// =========================================================================
// SLA Watcher — toolbar badge + desktop notifications
// =========================================================================
//
// Polls the shim's `get_sla_at_risk` tool on a chrome.alarms schedule
// (default every 15 min). For each ticket that crossed the threshold
// since the last run:
//   1. Toolbar badge updates with the count
//   2. A desktop notification fires (one per ticket, de-duped via
//      chrome.storage.local — we don't re-notify on every tick)
//   3. Click on the notification opens the side panel with the ticket
//      pre-loaded for auto-triage
//
// Default OFF — user opts in via Options → SLA Watcher section. Polling
// minimum is 5 minutes (Chrome enforces this in MV3) and we cap at 60.

/**
 * Initialise (or re-initialise) the chrome.alarms-driven poller. Reads
 * settings from chrome.storage.sync. When the toggle is off, clears the
 * alarm and wipes the badge.
 */
async function initSlaWatcher() {
  await chrome.alarms.clear(SLA_ALARM);
  const settings = await chrome.storage.sync.get([SLA_ENABLED_KEY, SLA_INTERVAL_KEY]);
  const enabled = Boolean(settings[SLA_ENABLED_KEY]);
  if (!enabled) {
    try {
      await chrome.action.setBadgeText({ text: "" });
    } catch {
      /* defensive — older Chrome may not have setBadgeText */
    }
    console.debug("[c4s] sla-watch: disabled");
    return;
  }
  // Chrome MV3 enforces a 1-minute minimum for periodic alarms; we use 5
  // as the realistic floor.
  const periodInMinutes = Math.max(5, Math.min(60, Number(settings[SLA_INTERVAL_KEY]) || 15));
  // Fire the first check ~10 seconds after init so the user sees something
  // immediately, then settle into the periodic cadence.
  await chrome.alarms.create(SLA_ALARM, {
    when: Date.now() + 10_000,
    periodInMinutes,
  });
  console.debug("[c4s] sla-watch: scheduled every", periodInMinutes, "min");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SLA_ALARM) return;
  checkSlaAtRisk().catch((e) => console.warn("[c4s] sla check failed:", e));
});

/**
 * One poll cycle: fetch tickets at risk, update badge, fire notifications
 * for newly-crossed threshold tickets, clear stale notifications.
 */
async function checkSlaAtRisk() {
  const settings = await chrome.storage.sync.get([
    "endpoint",
    "token",
    "sso-token",
    "sso-expires-at",
    SLA_HOURS_AHEAD_KEY,
  ]);
  const baseUrl = (settings.endpoint || "http://127.0.0.1:3031").replace(/\/$/, "");
  const ssoToken = settings["sso-token"];
  const ssoExp = settings["sso-expires-at"] ?? 0;
  const authToken = ssoToken && Date.now() < ssoExp ? ssoToken : settings.token || "";
  const hoursAhead = Math.max(1, Math.min(168, Number(settings[SLA_HOURS_AHEAD_KEY]) || 24));

  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  headers["X-Admin-Actor"] = "chrome-extension";

  let tickets = [];
  try {
    const r = await fetch(`${baseUrl}/api/tools/get_sla_at_risk`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hoursAhead, top: 25 }),
    });
    if (!r.ok) {
      if (r.status === 401) {
        // Background alarm with no user watching. Staying quiet is correct —
        // a notification here would fire at an arbitrary moment with no
        // context. The popup's interceptor prompts to sign in the next time
        // the user actually opens Ask C4S.
        console.warn("[c4s] sla check: 401 — not signed in; skipping until sign-in.");
        return;
      }
      console.warn("[c4s] sla check: HTTP", r.status);
      return;
    }
    const data = await r.json();
    // Response shapes vary by version of the shim — try the common ones.
    const raw =
      data?.result?.tickets ??
      data?.result?.results ??
      data?.result?.d?.results ??
      data?.result ??
      [];
    tickets = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.warn("[c4s] sla check: fetch failed", e);
    return;
  }

  await chrome.storage.local.set({ [SLA_LAST_RUN_KEY]: Date.now() });

  // Update badge — empty string clears it.
  try {
    if (tickets.length > 0) {
      const text = tickets.length > 99 ? "99+" : String(tickets.length);
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }); // red-600
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.warn("[c4s] badge update failed:", e);
  }

  // Compute the diff against last cycle.
  const stored = await chrome.storage.local.get(SLA_NOTIFIED_KEY);
  const notified = stored[SLA_NOTIFIED_KEY] || {}; // { ticketId: { notifId, at, objectId, title } }
  const stillAtRisk = new Set();

  for (const t of tickets) {
    const ticketId = String(t.ID || t.ServiceRequestID || t.id || t.ticketId || t.ObjectID || "").trim();
    if (!ticketId) continue;
    stillAtRisk.add(ticketId);
    if (notified[ticketId]) continue; // already notified — don't re-fire

    const title = String(t.Name || t.SubjectName || t.subject || t.title || "Service request");
    const customer = String(t.BuyerPartyName || t.AccountPartyName || t.customer || "?");
    const priority = String(t.ServicePriorityCodeText || t.priority || "");

    const notifId = `c4s-sla-${ticketId}-${Date.now()}`;
    try {
      await chrome.notifications.create(notifId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: `⚠ Ticket ${ticketId} — SLA at risk`,
        message:
          `${title.slice(0, 80)}\n` +
          `${customer}${priority ? " · " + priority : ""}\n` +
          `Click to triage in C4S.`,
        priority: 2,
        requireInteraction: false,
      });
      notified[ticketId] = {
        notifId,
        at: Date.now(),
        objectId: t.ObjectID || t.objectId || "",
        title: title.slice(0, 80),
      };
    } catch (e) {
      console.warn("[c4s] notification create failed for", ticketId, e);
    }
  }

  // Clear notifications for tickets that resolved or de-risked since
  // the last cycle — keeps the notification tray tidy.
  for (const ticketId of Object.keys(notified)) {
    if (!stillAtRisk.has(ticketId)) {
      const info = notified[ticketId];
      try {
        await chrome.notifications.clear(info.notifId);
      } catch {
        /* notification may have already been dismissed */
      }
      delete notified[ticketId];
    }
  }

  await chrome.storage.local.set({ [SLA_NOTIFIED_KEY]: notified });
}

/**
 * Click on a desktop notification → look up which ticket it represents,
 * stash the ticket-ID for the panel to pick up on next open, and open
 * the side panel. The popup/sidepanel reads `c4s.sla-watch.clicked`
 * from chrome.storage.session at init time and pre-fills the prompt.
 */
chrome.notifications.onClicked.addListener(async (notifId) => {
  try {
    const stored = await chrome.storage.local.get(SLA_NOTIFIED_KEY);
    const notified = stored[SLA_NOTIFIED_KEY] || {};
    let ticketId = null;
    let objectId = null;
    let title = null;
    for (const [tId, info] of Object.entries(notified)) {
      if (info.notifId === notifId) {
        ticketId = tId;
        objectId = info.objectId || null;
        title = info.title || null;
        break;
      }
    }
    if (ticketId) {
      await chrome.storage.session.set({
        "c4s.sla-watch.clicked": { ticketId, objectId, title, at: Date.now() },
      });
    }
    // Open the side panel. We need a windowId in scope; getLastFocused
    // gets the most recent normal browser window (skipping our own popups).
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
      if (win?.id) {
        chrome.sidePanel.open({ windowId: win.id }).catch((e) => {
          // sidePanel.open() can fail if not invoked inside a gesture
          // depending on Chrome version. Fall back to popup window so
          // the user still lands somewhere.
          console.warn("[c4s] sidePanel.open failed, opening popup window:", e);
          openPopupWindow();
        });
      } else {
        openPopupWindow();
      }
    });
    // Dismiss the clicked notification — they've acted on it.
    try {
      await chrome.notifications.clear(notifId);
    } catch {
      /* notification may have already been dismissed */
    }
  } catch (e) {
    console.warn("[c4s] notification click handler failed:", e);
  }
});
