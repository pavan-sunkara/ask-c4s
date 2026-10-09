// Ask C4S — options page
// ---------------------------------------------------------------------------
// Three sections:
//   1. Endpoint    — Server URL (chrome.storage.sync)
//   2. Sign-in     — Google OAuth via chrome.identity.getAuthToken;
//                    forwarded to /api/auth/google for server-side validation
//   3. Manual      — pasted Bearer token (legacy / password-based)

const DEFAULT_ENDPOINT = "http://127.0.0.1:3031";
const OAUTH_PLACEHOLDER = "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID";

// If the extension is reloaded while this page is open, every chrome.* call
// throws "Extension context invalidated." We catch that once at the top and
// show a one-line nudge instead of letting React-style stale references blow
// up downstream.
function extensionContextOk() {
  try {
    // chrome.runtime.id throws after the extension is reloaded.
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function showStaleContextNotice() {
  const banner = document.getElementById("stale-context");
  if (banner) banner.style.display = "block";
}

async function getEndpoint() {
  const { endpoint } = await chrome.storage.sync.get("endpoint");
  return endpoint || DEFAULT_ENDPOINT;
}

function $(id) {
  return document.getElementById(id);
}

/** Brief "Saved ✓" flash by re-using the same indicator the manual Save button uses. */
function flashSaved() {
  const msg = $("saved-msg");
  if (!msg) return;
  msg.style.display = "inline";
  setTimeout(() => (msg.style.display = "none"), 1500);
}

/**
 * Read the manifest's oauth2.client_id. If it's still the placeholder, the
 * extension hasn't been wired up yet — calling chrome.identity.getAuthToken
 * in that state opens an internal OAuth page whose inline script violates
 * our CSP, and Chrome bubbles the violation up to options.html. Detecting
 * the placeholder up-front avoids that whole mess.
 */
function getOauthClientId() {
  try {
    const m = chrome.runtime.getManifest();
    return m?.oauth2?.client_id ?? "";
  } catch {
    return "";
  }
}

function oauthConfigured() {
  const id = getOauthClientId();
  return Boolean(id) && !id.startsWith(OAUTH_PLACEHOLDER);
}

async function load() {
  if (!extensionContextOk()) {
    showStaleContextNotice();
    return;
  }
  const {
    endpoint,
    token,
    "sso-token": ssoToken,
    "sso-user": ssoUser,
    "askc4s.auto-triage": autoTriage,
  } = await chrome.storage.sync.get([
    "endpoint",
    "token",
    "sso-token",
    "sso-user",
    "askc4s.auto-triage",
  ]);
  $("endpoint").value = endpoint || DEFAULT_ENDPOINT;
  $("token").value = token || "";
  renderAuthSection(ssoToken, ssoUser);

  // v0.27.46 — My SAP identity (party ID) for the dashboard's My Day
  // briefing. Saved on blur, synced via the Chrome profile. The popup's
  // inline setup card writes the same key.
  const partyIdEl = $("my-party-id");
  if (partyIdEl) {
    const { "my-party-id": myPartyId } = await chrome.storage.sync.get("my-party-id");
    partyIdEl.value = myPartyId || "";
    partyIdEl.addEventListener("blur", async () => {
      const val = partyIdEl.value.trim();
      const { "my-party-id": current } = await chrome.storage.sync.get("my-party-id");
      if (val === (current || "")) return; // unchanged — keep auto-detect label intact
      if (val) {
        // v0.27.47 — a manual edit overrides any auto-detected identity, so
        // drop the stale "Name · Employee NNN" label the dashboard shows.
        await chrome.storage.sync.set({ "my-party-id": val, "my-party-source": "manual" });
        await chrome.storage.sync.remove("my-party-label");
      } else {
        await chrome.storage.sync.remove(["my-party-id", "my-party-label", "my-party-source"]);
      }
      flashSaved();
    });
  }

  // v0.27.55 — Display name for the dashboard greeting ("Good afternoon, …").
  // Manual entry wins over (and is not clobbered by) the SAP-session
  // auto-harvest — marked source "manual".
  const displayNameEl = $("my-display-name");
  if (displayNameEl) {
    const { "my-display-name": myName } = await chrome.storage.sync.get("my-display-name");
    displayNameEl.value = myName || "";
    displayNameEl.addEventListener("blur", async () => {
      const val = displayNameEl.value.trim();
      const { "my-display-name": current } = await chrome.storage.sync.get("my-display-name");
      if (val === (current || "")) return;
      if (val) {
        await chrome.storage.sync.set({ "my-display-name": val, "my-display-name-source": "manual" });
      } else {
        // Cleared → let the SAP harvest repopulate it automatically.
        await chrome.storage.sync.remove(["my-display-name", "my-display-name-source"]);
      }
      flashSaved();
    });
  }

  // SLA Watcher settings — checkbox + two numeric inputs. Changes write
  // straight to chrome.storage.sync; the background service worker listens
  // on storage.onChanged and re-initialises the alarm accordingly.
  const slaEnabledEl = $("sla-enabled");
  const slaHoursEl = $("sla-hours-ahead");
  const slaIntervalEl = $("sla-interval");
  const slaSettings = await chrome.storage.sync.get([
    "c4s.sla-watch.enabled",
    "c4s.sla-watch.hoursAhead",
    "c4s.sla-watch.intervalMinutes",
  ]);
  if (slaEnabledEl) slaEnabledEl.checked = Boolean(slaSettings["c4s.sla-watch.enabled"]);
  if (slaHoursEl) slaHoursEl.value = String(slaSettings["c4s.sla-watch.hoursAhead"] ?? 24);
  if (slaIntervalEl) slaIntervalEl.value = String(slaSettings["c4s.sla-watch.intervalMinutes"] ?? 15);

  if (slaEnabledEl) {
    slaEnabledEl.addEventListener("change", async () => {
      await chrome.storage.sync.set({ "c4s.sla-watch.enabled": slaEnabledEl.checked });
      flashSaved();
    });
  }
  if (slaHoursEl) {
    slaHoursEl.addEventListener("blur", async () => {
      const n = Math.max(1, Math.min(168, parseInt(slaHoursEl.value, 10) || 24));
      slaHoursEl.value = String(n);
      await chrome.storage.sync.set({ "c4s.sla-watch.hoursAhead": n });
      flashSaved();
    });
  }
  if (slaIntervalEl) {
    slaIntervalEl.addEventListener("blur", async () => {
      const n = Math.max(5, Math.min(60, parseInt(slaIntervalEl.value, 10) || 15));
      slaIntervalEl.value = String(n);
      await chrome.storage.sync.set({ "c4s.sla-watch.intervalMinutes": n });
      flashSaved();
    });
  }

  // Auto-triage radio group.
  const currentTriage =
    autoTriage === "always" || autoTriage === "once" ? autoTriage : "off";
  const radio = document.querySelector(
    `input[name="auto-triage"][value="${currentTriage}"]`,
  );
  if (radio) radio.checked = true;
  document.querySelectorAll('input[name="auto-triage"]').forEach((r) => {
    r.addEventListener("change", async (e) => {
      const val = e.target.value;
      await chrome.storage.sync.set({ "askc4s.auto-triage": val });
      flashSaved();
    });
  });

  // External KB URL template — used by /knowledge to render external
  // search shortcuts. Empty = section hidden. Saved on blur.
  const externalKbEl = $("external-kb-url");
  const { "c4s.external-kb-url": externalKbUrl } = await chrome.storage.sync.get(
    "c4s.external-kb-url",
  );
  if (externalKbEl) {
    externalKbEl.value = externalKbUrl || "";
    externalKbEl.addEventListener("blur", async () => {
      const v = externalKbEl.value.trim();
      // Light validation — must contain {query} if non-empty, must be http(s)
      if (v && (!v.includes("{query}") || !/^https?:\/\//.test(v))) {
        externalKbEl.style.borderColor = "#dc2626";
        externalKbEl.title = "Must start with http(s):// and contain {query}";
        return;
      }
      externalKbEl.style.borderColor = "";
      externalKbEl.title = "";
      await chrome.storage.sync.set({ "c4s.external-kb-url": v });
      flashSaved();
    });
  }

  // KB direct-mode URL — when set, /kb + /kb-ticket call the KB directly
  // from Chrome using the user's existing session cookies. Bypasses the
  // shim entirely (no Azure AD required). Saved on blur.
  const kbDirectEl = $("kb-direct-url");
  const { "c4s.kb-direct-url": kbDirectUrl } = await chrome.storage.sync.get(
    "c4s.kb-direct-url",
  );
  if (kbDirectEl) {
    kbDirectEl.value = kbDirectUrl || "";
    kbDirectEl.addEventListener("blur", async () => {
      const v = kbDirectEl.value.trim().replace(/\/+$/, ""); // strip trailing slashes
      if (v && !/^https?:\/\//.test(v)) {
        kbDirectEl.style.borderColor = "#dc2626";
        kbDirectEl.title = "Must start with https://";
        return;
      }
      kbDirectEl.style.borderColor = "";
      kbDirectEl.title = "";
      // If user typed a host that's not in our manifest host_permissions,
      // request it at runtime via chrome.permissions.request. Chrome will
      // pop a confirmation dialog.
      if (v && chrome.permissions?.request) {
        try {
          const granted = await chrome.permissions.request({ origins: [v + "/*"] });
          if (!granted) {
            kbDirectEl.style.borderColor = "#f59e0b";
            kbDirectEl.title = "Permission denied — extension can't call this host until granted";
            return;
          }
        } catch (e) {
          // Already in manifest static permissions → request returns true silently
          // or throws "non-async" — either way, proceed
        }
      }
      await chrome.storage.sync.set({ "c4s.kb-direct-url": v });
      flashSaved();
    });
  }

  // v0.26.51/.54/.67 — Parts-ORDERING processing type code (NOT
  // consumption). Default ZRP3. Used by /order-parts when committing
  // line items via log_service_item. The two SAP workflows are distinct:
  //   ZRP3 = Parts Ordering (request parts for a planned repair)
  //   SRP1 = Parts Consumption (log parts already installed)
  // Tenant variance: ZRP3 (Thermo Fisher / Z-prefix customer extension),
  // ZRP1, ZSRP, or SAP-standard codes. Saved on blur.
  const ptCodeEl = $("part-processing-type-code");
  const { "c4s.part-processing-type-code": storedCode } = await chrome.storage.sync.get(
    "c4s.part-processing-type-code",
  );
  if (ptCodeEl) {
    ptCodeEl.value = (storedCode || "ZRP3").toUpperCase();
    ptCodeEl.addEventListener("blur", async () => {
      const v = ptCodeEl.value.trim().toUpperCase();
      if (v && !/^[A-Z][A-Z0-9]{2,4}$/.test(v)) {
        ptCodeEl.style.borderColor = "#dc2626";
        ptCodeEl.title = "Must be 3-5 chars, start with a letter (e.g., ZRP1, SRP1)";
        return;
      }
      ptCodeEl.style.borderColor = "";
      ptCodeEl.title = "";
      ptCodeEl.value = v;  // normalize uppercase
      await chrome.storage.sync.set({ "c4s.part-processing-type-code": v });
      flashSaved();
    });
  }

  // v0.26.84 — Parts-inference: include processing types (allowlist for
  // structured line-item search). Default SRP1,ZRP1. Comma-separated.
  const inferIncEl = $("parts-inference-include-types");
  const { "c4s.parts-inference-include-types": storedInfTypes } = await chrome.storage.sync.get(
    "c4s.parts-inference-include-types",
  );
  if (inferIncEl) {
    inferIncEl.value = (storedInfTypes || "SRP1,ZRP1").toUpperCase();
    inferIncEl.addEventListener("blur", async () => {
      const raw = inferIncEl.value.trim();
      // Normalize: split on comma/whitespace, uppercase, dedupe, filter
      // out any token that doesn't look like a SAP processing-type code.
      const tokens = raw.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
      const valid = tokens.filter((t) => /^[A-Z][A-Z0-9_]{2,15}$/.test(t));
      const invalid = tokens.filter((t) => !/^[A-Z][A-Z0-9_]{2,15}$/.test(t));
      if (invalid.length > 0) {
        inferIncEl.style.borderColor = "#dc2626";
        inferIncEl.title = `Invalid tokens (rejected): ${invalid.join(", ")}. Codes must be 3-16 chars, letters/digits/underscores, starting with a letter.`;
        return;
      }
      inferIncEl.style.borderColor = "";
      inferIncEl.title = "";
      const normalized = Array.from(new Set(valid)).join(",");
      inferIncEl.value = normalized;
      await chrome.storage.sync.set({ "c4s.parts-inference-include-types": normalized });
      flashSaved();
    });
  }

  // Direct-call test button — fires a small GET against the configured KB
  // base + /@api/deki/site/search?q=test to verify auth + reachability.
  const kbTestBtn = $("kb-direct-test");
  const kbTestResult = $("kb-direct-test-result");
  if (kbTestBtn && kbDirectEl) {
    kbTestBtn.addEventListener("click", async () => {
      const baseUrl = kbDirectEl.value.trim().replace(/\/+$/, "");
      if (!baseUrl) {
        if (kbTestResult) {
          kbTestResult.textContent = "Set a URL first.";
          kbTestResult.style.color = "#f59e0b";
        }
        return;
      }
      kbTestBtn.disabled = true;
      if (kbTestResult) {
        kbTestResult.textContent = "Testing…";
        kbTestResult.style.color = "";
      }
      try {
        const url = `${baseUrl}/@api/deki/site/search?q=test&limit=1&format=json`;
        const r = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json, application/xml" },
        });
        if (r.status === 401 || r.status === 403) {
          if (kbTestResult) {
            kbTestResult.innerHTML = `❌ Not signed in (${r.status}). <a href="${baseUrl}" target="_blank">Open ${baseUrl}</a>, log in via SSO, then test again.`;
            kbTestResult.style.color = "#b91c1c";
          }
        } else if (!r.ok) {
          if (kbTestResult) {
            kbTestResult.textContent = `❌ HTTP ${r.status} — check the URL + your host_permissions.`;
            kbTestResult.style.color = "#b91c1c";
          }
        } else {
          if (kbTestResult) {
            kbTestResult.textContent = `✅ KB responded (${r.status}). Direct mode is ready.`;
            kbTestResult.style.color = "#059669";
          }
        }
      } catch (e) {
        if (kbTestResult) {
          kbTestResult.textContent = `❌ ${e.message ?? e}`;
          kbTestResult.style.color = "#b91c1c";
        }
      } finally {
        kbTestBtn.disabled = false;
      }
    });
  }

  // Auto Customer Pulse radio group (mirrors auto-triage). Settings key
  // is `c4s.auto-pulse` with values "off" | "once" | "always".
  const { "c4s.auto-pulse": autoPulseRaw } = await chrome.storage.sync.get("c4s.auto-pulse");
  const currentPulse =
    autoPulseRaw === "always" || autoPulseRaw === "once" ? autoPulseRaw : "off";
  const pulseRadio = document.querySelector(
    `input[name="auto-pulse"][value="${currentPulse}"]`,
  );
  if (pulseRadio) pulseRadio.checked = true;
  document.querySelectorAll('input[name="auto-pulse"]').forEach((r) => {
    r.addEventListener("change", async (e) => {
      const val = e.target.value;
      await chrome.storage.sync.set({ "c4s.auto-pulse": val });
      flashSaved();
    });
  });

  // Auto-KB-fetch radio group (mirrors auto-triage). Settings key is
  // `c4s.auto-kb` with values "off" | "once" | "always".
  const { "c4s.auto-kb": autoKbRaw } = await chrome.storage.sync.get("c4s.auto-kb");
  const currentKb =
    autoKbRaw === "always" || autoKbRaw === "once" ? autoKbRaw : "off";
  const kbRadio = document.querySelector(
    `input[name="auto-kb"][value="${currentKb}"]`,
  );
  if (kbRadio) kbRadio.checked = true;
  document.querySelectorAll('input[name="auto-kb"]').forEach((r) => {
    r.addEventListener("change", async (e) => {
      const val = e.target.value;
      await chrome.storage.sync.set({ "c4s.auto-kb": val });
      flashSaved();
    });
  });

  // Auto-KB-RESOLVE radio group (deep variant — searches all angles, fetches
  // article bodies, LLM-extracts resolutions). Skipped silently when direct
  // mode isn't configured. Settings key `c4s.auto-kb-resolve`.
  const { "c4s.auto-kb-resolve": autoKbResolveRaw } = await chrome.storage.sync.get(
    "c4s.auto-kb-resolve",
  );
  const currentKbResolve =
    autoKbResolveRaw === "always" || autoKbResolveRaw === "once" ? autoKbResolveRaw : "off";
  const kbResolveRadio = document.querySelector(
    `input[name="auto-kb-resolve"][value="${currentKbResolve}"]`,
  );
  if (kbResolveRadio) kbResolveRadio.checked = true;
  document.querySelectorAll('input[name="auto-kb-resolve"]').forEach((r) => {
    r.addEventListener("change", async (e) => {
      const val = e.target.value;
      await chrome.storage.sync.set({ "c4s.auto-kb-resolve": val });
      flashSaved();
    });
  });

  // Templates list.
  await renderTemplatesList();

  // v0.27.39 — adaptive chip ordering reset. The panel counts chip runs
  // in chrome.storage.local `c4s.chip-usage` and promotes the most-used
  // chips into the always-visible top row; this wipes the counts so the
  // chips return to the curated default order.
  const resetChipBtn = $("reset-chip-order");
  if (resetChipBtn) {
    resetChipBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove("c4s.chip-usage");
      const status = $("reset-chip-order-status");
      if (status) {
        status.textContent = "✓ Reset — chips return to default order.";
        setTimeout(() => { status.textContent = ""; }, 3000);
      }
    });
  }

  // If the OAuth client_id is still the placeholder, gray the button and
  // show the wire-up instructions inline instead of letting the click
  // crash into Chrome's OAuth error page.
  if (!oauthConfigured()) {
    // SSO isn't configured for this deployment — hide the SSO button and show
    // the notice; the email + password form below is the active sign-in.
    const ssoRow = $("sso-row");
    if (ssoRow) ssoRow.style.display = "none";
    const banner = $("oauth-unconfigured");
    if (banner) banner.style.display = "block";
  }
}

// ---------- Templates manager ------------------------------------------
//
// Mirrors the popup's storage layer (TEMPLATES_KEY, BUILT_IN_TEMPLATES) but
// renders a manage-style list with per-row delete/hide buttons. Duplicates
// some constants from popup.js because Manifest V3 doesn't let us share
// modules between popup and options pages without a build step.

const TEMPLATES_KEY = "askc4s.templates";
const BUILT_IN_TEMPLATES_OPTIONS = [
  { id: "tpl-builtin-pulse", label: "💚 Customer Pulse", prompt: "/pulse", builtIn: true },
  { id: "tpl-builtin-closeout", label: "✅ Close-out", prompt: "/close-out", builtIn: true },
  { id: "tpl-builtin-nearby", label: "📍 Nearby PMs", prompt: "/nearby", builtIn: true },
  { id: "tpl-builtin-parts-check", label: "🔧 Parts check", prompt: "/parts-check", builtIn: true },
  { id: "tpl-builtin-pm-kit-check", label: "🛡 PM kit gaps", prompt: "/pm-kit-check", builtIn: true },
  { id: "tpl-builtin-order-parts", label: "📦 Order parts", prompt: "/order-parts", builtIn: true },
  { id: "tpl-builtin-emails", label: "✉ Email summary", prompt: "/emails", builtIn: true },
  { id: "tpl-builtin-map", label: "🗺 Map view", prompt: "/map", builtIn: true },
  { id: "tpl-builtin-triage", label: "🎯 Triage", prompt: "/triage", builtIn: true },
  {
    id: "tpl-builtin-summarize-visits",
    label: "📋 Summarize visits",
    prompt: "/visits",
    builtIn: true,
  },
  {
    id: "tpl-builtin-warranty",
    label: "🔍 Check warranty",
    prompt: "/warranty",
    builtIn: true,
  },
  {
    id: "tpl-builtin-escalation",
    label: "🚨 Draft escalation",
    prompt:
      "Draft an internal escalation note for this ticket explaining: (1) why this needs management attention, (2) what's blocked, (3) recommended next step. Keep it under 100 words.",
    builtIn: true,
  },
  {
    id: "tpl-builtin-customer-update",
    label: "📞 Customer update",
    prompt:
      "Draft a 2-paragraph customer-facing status update for this ticket — what we know, what we're doing, when they'll hear back. No markdown.",
    builtIn: true,
  },
  { id: "tpl-builtin-similar", label: "🔁 Find similar", prompt: "/similar", builtIn: true },
  { id: "tpl-builtin-knowledge", label: "🗂 Full knowledge view", prompt: "/knowledge", builtIn: true },
  { id: "tpl-builtin-skills-match", label: "👤 Skill match", prompt: "/skills", builtIn: true },
  { id: "tpl-builtin-kb-ticket", label: "📚 KB for this ticket", prompt: "/kb-ticket", builtIn: true },
  { id: "tpl-builtin-kb-resolve", label: "🧠 KB resolution", prompt: "/kb-resolve", builtIn: true },
  { id: "tpl-builtin-kb-search", label: "📚 Search KB", prompt: "/kb ", builtIn: true },
  { id: "tpl-builtin-parts", label: "🔧 Parts lookup", prompt: "/parts ", builtIn: true },
  { id: "tpl-builtin-history", label: "📜 Service history", prompt: "/history", builtIn: true },
  { id: "tpl-builtin-notes", label: "📝 Notes", prompt: "/notes", builtIn: true },
  { id: "tpl-builtin-help", label: "❓ All commands", prompt: "/help", builtIn: true },
  { id: "tpl-builtin-contract-coverage", label: "📋 Coverage analysis", prompt: "[contract page LLM prompt]", builtIn: true },
  { id: "tpl-builtin-contract-renewal", label: "📅 Renewal check", prompt: "[contract page LLM prompt]", builtIn: true },
  { id: "tpl-builtin-contract-renewal-draft", label: "✉️ Draft renewal outreach", prompt: "[contract page LLM prompt]", builtIn: true },
  { id: "tpl-builtin-contract-linked-tickets", label: "🔗 Linked tickets", prompt: "[contract page LLM prompt]", builtIn: true },
];

async function renderTemplatesList() {
  const wrap = $("templates-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  const {
    [TEMPLATES_KEY]: stored,
    [TEMPLATES_KEY + ".hidden"]: hidden,
  } = await chrome.storage.sync.get([TEMPLATES_KEY, TEMPLATES_KEY + ".hidden"]);
  const userTemplates = Array.isArray(stored) ? stored : [];
  const hiddenIds = new Set(Array.isArray(hidden) ? hidden : []);

  // Built-ins
  const all = [
    ...BUILT_IN_TEMPLATES_OPTIONS.map((t) => ({ ...t, hidden: hiddenIds.has(t.id) })),
    ...userTemplates.map((t) => ({ ...t, hidden: false })),
  ];

  if (all.length === 0) {
    wrap.innerHTML = '<p class="help">No templates yet — save one from the popup.</p>';
    return;
  }

  for (const tpl of all) {
    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 4px;" +
      (tpl.hidden ? "opacity: 0.45;" : "");

    const label = document.createElement("div");
    label.style.cssText = "flex: 1; min-width: 0;";
    label.innerHTML =
      `<div style="font-size: 12.5px; font-weight: 500;">${escapeText(tpl.label)}${tpl.builtIn ? ' <span style="font-size: 10px; color: #64748b; font-weight: 400">built-in</span>' : ""}</div>` +
      `<div style="font-size: 11px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeText(tpl.prompt)}</div>`;
    row.appendChild(label);

    const action = document.createElement("button");
    action.type = "button";
    action.style.cssText =
      "font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid #cbd5e1; background: white; cursor: pointer;";
    if (tpl.builtIn) {
      action.textContent = tpl.hidden ? "Show" : "Hide";
      action.addEventListener("click", async () => {
        const set = new Set(hiddenIds);
        if (tpl.hidden) {
          set.delete(tpl.id);
        } else {
          set.add(tpl.id);
        }
        await chrome.storage.sync.set({ [TEMPLATES_KEY + ".hidden"]: [...set] });
        renderTemplatesList();
      });
    } else {
      action.textContent = "Delete";
      action.style.color = "#b91c1c";
      action.style.borderColor = "#fecaca";
      action.addEventListener("click", async () => {
        if (!window.confirm(`Delete template "${tpl.label}"?`)) return;
        const list = userTemplates.filter((t) => t.id !== tpl.id);
        await chrome.storage.sync.set({ [TEMPLATES_KEY]: list });
        renderTemplatesList();
      });
    }
    row.appendChild(action);

    wrap.appendChild(row);
  }
}

function escapeText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderAuthSection(ssoToken, ssoUser) {
  const signedIn = Boolean(ssoToken && ssoUser);
  $("signed-out").style.display = signedIn ? "none" : "block";
  $("signed-in").style.display = signedIn ? "block" : "none";
  if (signedIn) {
    $("user-name").textContent = ssoUser.name || ssoUser.email;
    // Personal accounts carry a role (owner/admin/manager/agent); show it.
    $("user-email").textContent = ssoUser.email + (ssoUser.role ? " · " + ssoUser.role : "");
    if (ssoUser.picture) {
      $("user-pic").src = ssoUser.picture;
      $("user-pic").style.display = "block";
    } else {
      $("user-pic").style.display = "none";
    }
  }
}

async function signInWithGoogle() {
  const err = $("signin-error");
  err.textContent = "";

  if (!extensionContextOk()) {
    showStaleContextNotice();
    return;
  }

  // Hard-block when the manifest still has the placeholder client_id.
  // chrome.identity.getAuthToken would otherwise crash into a Chrome
  // OAuth error page whose inline script trips our extension CSP — the
  // user sees a confusing "inline script violates ..." error that
  // appears to come from options.html itself.
  if (!oauthConfigured()) {
    err.textContent =
      "Google OAuth client_id is not configured. See README §Setting up Google SSO " +
      "— paste your client ID into chrome-extension/manifest.json and reload the extension.";
    return;
  }

  try {
    // Step 1 — get a Google OAuth access token via chrome.identity.
    // This pops a Google consent screen the first time, then returns
    // a cached token on subsequent calls.
    const tokenResult = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message ?? "identity error"));
        } else if (!token) {
          reject(new Error("No token returned — did you set up the OAuth client?"));
        } else {
          resolve(token);
        }
      });
    });

    // Step 2 — exchange Google access token for a session token.
    const endpoint = (await getEndpoint()).replace(/\/$/, "");
    const r = await fetch(`${endpoint}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: tokenResult }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      err.textContent = data.error || `HTTP ${r.status}`;
      return;
    }
    // Step 3 — persist for popup + main calls.
    await chrome.storage.sync.set({
      "sso-token": data.token,
      "sso-user": data.user,
      "sso-expires-at": Date.now() + data.ttlSec * 1000,
    });
    renderAuthSection(data.token, data.user);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
}

// A login that succeeded with a TEMPORARY password. Held in memory only — it is
// not stored (so the popup never runs on a half-usable token) until the person
// has chosen a real password.
let pendingLogin = null;

async function persistSignIn(token, user, ttlSec) {
  await chrome.storage.sync.set({
    "sso-token": token,
    "sso-user": user,
    "sso-expires-at": Date.now() + (ttlSec || 86400) * 1000,
  });
  renderAuthSection(token, user);
}

async function signInWithPassword() {
  const err = $("pw-error");
  err.textContent = "";
  if (!extensionContextOk()) {
    showStaleContextNotice();
    return;
  }
  const email = $("pw-email").value.trim();
  const password = $("pw-password").value;
  if (!email || !password) {
    err.textContent = "Enter your email and password.";
    return;
  }
  try {
    const endpoint = (await getEndpoint()).replace(/\/$/, "");
    const r = await fetch(`${endpoint}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      err.textContent = data.error || `HTTP ${r.status}`;
      return;
    }
    const user = { ...data.user, role: data.role };
    if (data.mustChangePassword) {
      pendingLogin = { token: data.token, user, ttlSec: data.ttlSec, currentPassword: password };
      $("pw-signin").style.display = "none";
      $("pw-change").style.display = "block";
      return;
    }
    $("pw-password").value = "";
    await persistSignIn(data.token, user, data.ttlSec);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function savePasswordChange() {
  const err = $("pw-change-error");
  err.textContent = "";
  if (!pendingLogin) return;
  const next = $("pw-new").value;
  if (!next || next !== $("pw-new2").value) {
    err.textContent = "The new passwords don't match.";
    return;
  }
  try {
    const endpoint = (await getEndpoint()).replace(/\/$/, "");
    const r = await fetch(`${endpoint}/api/auth/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pendingLogin.token}`,
      },
      body: JSON.stringify({ currentPassword: pendingLogin.currentPassword, newPassword: next }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      err.textContent = data.error || `HTTP ${r.status}`;
      return;
    }
    const { token, user, ttlSec } = pendingLogin;
    pendingLogin = null;
    $("pw-new").value = "";
    $("pw-new2").value = "";
    $("pw-password").value = "";
    $("pw-change").style.display = "none";
    $("pw-signin").style.display = "block";
    await persistSignIn(token, user, ttlSec);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function signOut() {
  // End the server-side session too (best effort — an expired or Google token
  // just gets a harmless 401).
  try {
    const { "sso-token": current } = await chrome.storage.sync.get("sso-token");
    if (current) {
      const endpoint = (await getEndpoint()).replace(/\/$/, "");
      fetch(`${endpoint}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${current}` },
      }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  pendingLogin = null;
  // Revoke the Google token client-side too so re-signin gets a fresh
  // consent if needed.
  try {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) chrome.identity.removeCachedAuthToken({ token }, () => {});
    });
  } catch {
    /* ignore */
  }
  await chrome.storage.sync.remove(["sso-token", "sso-user", "sso-expires-at"]);
  renderAuthSection(null, null);
}

function wireEvents() {
  const signIn = $("sign-in");
  const signOutBtn = $("sign-out");
  const save = $("save");
  if (signIn) signIn.addEventListener("click", signInWithGoogle);
  if (signOutBtn) signOutBtn.addEventListener("click", signOut);
  const pwSignIn = $("pw-sign-in");
  if (pwSignIn) pwSignIn.addEventListener("click", signInWithPassword);
  const pwField = $("pw-password");
  if (pwField) pwField.addEventListener("keydown", (e) => { if (e.key === "Enter") signInWithPassword(); });
  const pwChange = $("pw-change-btn");
  if (pwChange) pwChange.addEventListener("click", savePasswordChange);
  if (save) {
    save.addEventListener("click", async () => {
      if (!extensionContextOk()) {
        showStaleContextNotice();
        return;
      }
      try {
        const endpoint = $("endpoint").value.trim() || DEFAULT_ENDPOINT;
        const token = $("token").value.trim();
        await chrome.storage.sync.set({ endpoint, token });
        const msg = $("saved-msg");
        msg.style.display = "inline";
        setTimeout(() => (msg.style.display = "none"), 1500);
      } catch (e) {
        // Most likely "Extension context invalidated."
        showStaleContextNotice();
      }
    });
  }
  const reloadLink = $("reload-extension");
  if (reloadLink) {
    reloadLink.addEventListener("click", (e) => {
      e.preventDefault();
      // We can't reload the extension from a stale page — just reload
      // this options page so the user gets a fresh chrome.* context.
      window.location.reload();
    });
  }
}

wireEvents();
load();
