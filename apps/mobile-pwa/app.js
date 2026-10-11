/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/*
 * Ask C4S (Field) — app logic.
 *
 * My Day chain (mirrors the extension's own My Day panel):
 *   identity → POST /api/resolve_employee → BusinessPartnerID
 *            → POST /api/tools/get_my_tickets { processorPartyId }
 *
 * docs/engineering-notes.md records that admin/service-agent logins have no EmployeeCollection
 * row, so resolve_employee legitimately returns {found:false} and the extension
 * falls back to manual party-ID entry. This does the same rather than treating
 * that as an error.
 */
(function () {
  "use strict";

  var PARTY_KEY = "askc4s.field.partyId";
  var NAME_KEY = "askc4s.field.name";
  var TOKEN_KEY = "askc4s.field.token";
  // authOptional: set at boot when the server proves it isn't enforcing auth
  // (local dev). Never persisted — it is re-proven on every launch, so a
  // hosted server can't inherit a stale "no login needed" from localStorage.
  var VER = "v0.27.86";
  var state = {
    partyId: null, name: null, tickets: null, stale: false,
    token: null, authOptional: false,
    // The ticket the home-page command chips act on. The extension detects this
    // from the live SAP page; a phone has none, so the tech sets it from My Day.
    currentTicket: null,
  };

  // The extension's home command grid, mirrored. `flow` maps to a built PWA
  // screen; null = works in the extension, coming to the app.
  var CHIP_GROUPS = [
    { key: "discovery", label: "① Discovery" },
    { key: "troubleshooting", label: "② Troubleshooting" },
    { key: "resolution", label: "③ Resolution" },
    { key: "closure", label: "④ Closure" },
  ];
  var CHIPS = [
    { grp: "discovery", icon: "💚", label: "Customer Pulse", cat: "triage", flow: null },
    { grp: "discovery", icon: "📨", label: "Interactions", cat: "triage", flow: null },
    { grp: "discovery", icon: "🗺", label: "Map view", cat: "field", flow: null },
    { grp: "discovery", icon: "🎯", label: "Triage", cat: "triage", flow: null },
    { grp: "troubleshooting", icon: "📋", label: "Ticket Summary", cat: "triage", flow: null },
    { grp: "troubleshooting", icon: "📚", label: "KB resolution", cat: "knowledge", flow: null },
    { grp: "troubleshooting", icon: "🕘", label: "Service history", cat: "triage", flow: null },
    { grp: "troubleshooting", icon: "🔍", label: "Check warranty", cat: "triage", flow: null },
    { grp: "resolution", icon: "🛠️", label: "Parts check", cat: "parts", flow: "partsCheck" },
    { grp: "resolution", icon: "📦", label: "Order parts", cat: "parts", flow: null },
    { grp: "resolution", icon: "🔧", label: "Prep for PM", cat: "parts", flow: "prepPm" },
    { grp: "resolution", icon: "🛡", label: "PM kit gaps", cat: "parts", flow: null },
    { grp: "closure", icon: "✅", label: "Close-out", cat: "close", flow: null },
    { grp: "closure", icon: "⏱", label: "Book time", cat: "close", flow: null },
    { grp: "closure", icon: "📍", label: "Nearby PMs", cat: "field", flow: null },
    { grp: "closure", icon: "✉", label: "Email summary", cat: "comms", flow: null },
  ];

  try {
    state.partyId = localStorage.getItem(PARTY_KEY);
    state.name = localStorage.getItem(NAME_KEY);
    // localStorage, not sessionStorage: iOS evicts PWA processes aggressively
    // and sessionStorage would force a tech to re-enter the password every time
    // the app is backgrounded. The token is short-lived server-side (the shim
    // holds it in memory, so a restart invalidates it), a 401 clears it, and
    // signing out wipes it together with the cached SAP data.
    state.token = localStorage.getItem(TOKEN_KEY);
  } catch (e) { /* private mode */ }

  var $ = function (id) { return document.getElementById(id); };
  var view = $("view");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showErr(msg) {
    var el = $("err");
    if (!msg) { el.className = "banner err"; el.textContent = ""; return; }
    el.className = "banner err show";
    el.textContent = msg;
  }
  function showOffline(on) {
    $("offline").className = "banner offline" + (on ? " show" : "");
  }
  function netPill() {
    // The header no longer carries a #net indicator (it shows the version, like
    // the extension), so this is a null-safe no-op unless one is present.
    var el = $("net");
    if (el) el.textContent = navigator.onLine ? "online" : "offline";
  }
  function whoPill() {
    var el = $("who");
    if (el) el.textContent = state.name || (state.partyId ? state.partyId : "not set");
  }

  // --- auth ---------------------------------------------------------------
  /**
   * The shim denies every /api/* route without a Bearer token (deny-by-default
   * gate in uiServer.handleApi). This app therefore cannot do anything useful
   * until the tech signs in.
   */
  function setToken(tok) {
    state.token = tok || null;
    try {
      if (tok) localStorage.setItem(TOKEN_KEY, tok);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /**
   * Drop cached SAP responses on sign-out. The service worker keys its API
   * cache on URL alone — it never sees the Authorization header — so without
   * this, the next person to open the app on a shared iPad could read the
   * previous tech's tickets straight out of the cache.
   *
   * Only the `-data` caches go. The `-shell` cache is HTML/JS/manifest with no
   * user data in it, and dropping it would break the offline launch that techs
   * in basements depend on. Matched by suffix so a SW version bump can't
   * silently start leaving SAP data behind.
   */
  function clearCachedData() {
    try {
      if (!("caches" in window)) return Promise.resolve();
      return caches.keys().then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return /-data$/.test(k); })
              .map(function (k) { return caches.delete(k); }),
        );
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  function signOut() {
    setToken(null);
    state.authOptional = false;
    state.tickets = null;
    state.stale = false;
    return clearCachedData().then(function () { renderLogin(); });
  }

  /** Do we hold credentials, or has the server told us it doesn't want any? */
  function authed() {
    return !!state.token || state.authOptional;
  }

  /**
   * Ask a gated route whether this server actually enforces auth, mirroring
   * what apps/light-admin does.
   *
   * In local dev (ASKC4S_ADMIN_INSECURE=true with no password configured) the
   * shim serves everything without a token AND /api/internal/auth returns 503
   * "ASKC4S_INTERNAL_PASSWORD is not set" — so there is no password that could
   * ever work. Showing a login screen there is a dead end. If the gate lets us
   * through without a token, skip login entirely.
   *
   * /api/client-config is the probe because it is gated but cheap: it reads
   * tenant policy from settings and never touches SAP.
   */
  function probeAuthEnforced() {
    return fetch("/api/client-config", { headers: { "X-Admin-Actor": "field-pwa" } })
      .then(function (r) { return r.status === 401; })
      .catch(function () { return true; }); // unreachable → assume gated, show login
  }

  function renderLogin(msg) {
    ["day", "me"].forEach(function (t) {
      var b = $("nav-" + t);
      if (b) b.className = "";
    });
    view.innerHTML =
      "<h2>Sign in</h2>" +
      '<div class="card">' +
      '<p style="margin:0 0 12px;font-size:13.5px;color:var(--muted)">' +
      "Ask C4S connects to your live SAP tenant, so it needs you to sign in first.</p>" +
      // Filled in async once we know whether Entra SSO is configured.
      '<div id="ssoSlot"></div>' +
      // Revealed only when the server reports personal accounts (providers.directory).
      '<div id="emailRow" style="display:none">' +
      '<label for="em">Email</label>' +
      '<input id="em" type="email" autocomplete="username" placeholder="you@company.com" />' +
      "</div>" +
      '<label for="pw">Password</label>' +
      '<input id="pw" type="password" autocomplete="current-password" placeholder="••••••••" />' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="primary" id="loginBtn">Sign in</button>' +
      "</div></div>";
    if (msg) showErr(msg);

    // Show "Sign in with Microsoft" only when the server reports Entra SSO is
    // configured. Until then the org uses the password fallback. Best-effort:
    // a failed probe just leaves the password form.
    var directory = false; // personal accounts (email + password) vs the shared password
    fetch("/api/auth/providers", { headers: { "X-Admin-Actor": "field-pwa" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var p = (j && j.providers) || {};
        directory = !!p.directory;
        if (directory && $("emailRow")) $("emailRow").style.display = "";
        var slot = $("ssoSlot");
        if (!slot || !p.oidc) return;
        slot.innerHTML =
          '<button class="primary" id="ssoBtn" style="width:100%;margin-bottom:10px">' +
          "Sign in with Microsoft</button>" +
          '<div style="text-align:center;font-size:12px;color:var(--faint);margin-bottom:10px">or</div>';
        $("ssoBtn").onclick = function () {
          // Full-page redirect into the Entra flow; /callback returns a page
          // that stores the token and sends us back to "/".
          window.location.href = (p.oidcStartUrl || "/api/auth/oidc/start");
        };
      })
      .catch(function () { /* password form stands on its own */ });
    var submit = function () {
      var pw = $("pw").value;
      var em = $("em") ? $("em").value.trim() : "";
      if (!pw || (directory && !em)) return;
      showErr("");
      $("loginBtn").disabled = true;
      // Not via post(): this is the one call that legitimately has no token.
      // Personal accounts sign in with email + password; before any exist it is
      // the shared admin password, exactly as before.
      fetch(directory ? "/api/auth/login" : "/api/internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(directory ? { email: em, password: pw } : { password: pw }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.token) {
              throw new Error(j.error || (r.status === 401 ? "Wrong password." : "HTTP " + r.status));
            }
            return j;
          });
        })
        .then(function (j) {
          setToken(j.token);
          showErr("");
          // A temporary password (new account or admin reset) is only good for
          // choosing a real one — the server refuses everything else until then.
          if (j.mustChangePassword) { renderChangePassword(pw); return; }
          // Password tokens carry no email, so whoami will report needsIdentity
          // and route to the Me tab — but going through the same resolver keeps
          // one code path, and means an SSO token (which DOES carry an email)
          // lands straight on My Day.
          resolveIdentityAndRoute();
        })
        .catch(function (e) {
          showErr(e.message);
          $("loginBtn").disabled = false;
        });
    };
    $("loginBtn").onclick = submit;
    $("pw").onkeydown = function (e) { if (e.key === "Enter") submit(); };
  }

  /**
   * Forced password change for accounts holding a temporary password. Only the
   * change-password and sign-out routes work until it's done, so this screen is
   * the whole app until the tech picks their own.
   */
  function renderChangePassword(currentPassword) {
    ["day", "me"].forEach(function (t) {
      var b = $("nav-" + t);
      if (b) b.className = "";
    });
    view.innerHTML =
      "<h2>Choose a new password</h2>" +
      '<div class="card">' +
      '<p style="margin:0 0 12px;font-size:13.5px;color:var(--muted)">' +
      "You signed in with a temporary password. Choose your own to continue.</p>" +
      '<label for="cpCur">Temporary password</label>' +
      '<input id="cpCur" type="password" autocomplete="current-password" />' +
      '<label for="cpNew">New password (at least 12 characters)</label>' +
      '<input id="cpNew" type="password" autocomplete="new-password" />' +
      '<label for="cpNew2">Repeat new password</label>' +
      '<input id="cpNew2" type="password" autocomplete="new-password" />' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="primary" id="cpBtn">Save and continue</button>' +
      "</div></div>";
    if (currentPassword) $("cpCur").value = currentPassword;
    var submit = function () {
      var cur = $("cpCur").value, nw = $("cpNew").value, nw2 = $("cpNew2").value;
      if (!cur || !nw) { showErr("Fill in every field."); return; }
      if (nw !== nw2) { showErr("The new passwords don't match."); return; }
      showErr("");
      $("cpBtn").disabled = true;
      fetch("/api/auth/change-password", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
            return j;
          });
        })
        .then(function () { showErr(""); resolveIdentityAndRoute(); })
        .catch(function (e) {
          showErr(e.message);
          $("cpBtn").disabled = false;
        });
    };
    $("cpBtn").onclick = submit;
    $("cpNew2").onkeydown = function (e) { if (e.key === "Enter") submit(); };
  }

  // --- api ----------------------------------------------------------------
  function authHeaders(extra) {
    var h = { "X-Admin-Actor": "field-pwa" };
    if (extra) for (var k in extra) h[k] = extra[k];
    if (state.token) h["Authorization"] = "Bearer " + state.token;
    return h;
  }

  /**
   * The SSO payoff: turn the identity already proven by the token into a SAP
   * party ID and land the tech on My Day — no "who are you?" step.
   *
   *   token (carries email, from SSO) → GET /api/whoami → { partyId, name }
   *
   * Falls back to manual entry only when the server says needsIdentity — which
   * is the normal outcome for admin/service-agent logins that have no
   * EmployeeCollection row, and for password tokens that carry no email.
   */
  function resolveIdentityAndRoute() {
    view.innerHTML = "<h2>My Day</h2><div class=\"skel\"></div><div class=\"skel\"></div>";
    return fetch("/api/whoami", { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) {
          setToken(null);
          state.authOptional = false;
          renderLogin("Your session expired — please sign in again.");
          return null;
        }
        return r.json();
      })
      .then(function (j) {
        if (!j) return;
        // A stored token can belong to an account that still has a temporary
        // password (or was just reset): the server answers 403 until it's changed.
        if (j.code === "password_change_required") { renderChangePassword(); return; }
        if (!j.needsIdentity && j.partyId) {
          // Resolved from SSO — zero touch.
          state.partyId = j.partyId;
          state.name = j.name || state.name;
          state.tickets = null;
          try {
            localStorage.setItem(PARTY_KEY, state.partyId);
            if (state.name) localStorage.setItem(NAME_KEY, state.name);
          } catch (e) {}
          whoPill();
          go("home");
          return;
        }
        // Not resolvable to a tech. If a party ID was set up manually before,
        // land on Home; otherwise send them to the Me tab to enter one.
        whoPill();
        if (state.partyId) go("home");
        else renderMe();
      })
      .catch(function () {
        // whoami unreachable — degrade to whatever identity we already hold.
        if (state.partyId) go("home"); else renderMe();
      });
  }

  function post(path, body) {
    var headers = authHeaders({ "Content-Type": "application/json" });
    return fetch(path, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      state.stale = r.headers.get("X-AskC4S-Offline") === "1";
      // Token expired or revoked (the shim keeps them in memory, so a restart
      // invalidates every token). Bounce to login rather than showing the raw
      // "Unauthorized…" text on top of a dead screen.
      if (r.status === 401) {
        setToken(null);
        // Also drop authOptional: the boot probe said this server wasn't
        // enforcing auth, and it now is (restarted with a password, or the
        // PWA is pointed at a different shim). Leaving it set would keep
        // every view convinced it was signed in while every call 401s.
        state.authOptional = false;
        renderLogin("Your session expired — please sign in again.");
        // Marked so callers can bail out silently. Their .catch handlers
        // re-render their own view, which would paint straight over the login
        // screen and strand the tech on a dead page with no way back in.
        var err = new Error("Signed out");
        err.signedOut = true;
        throw err;
      }
      return r.json().then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || "HTTP " + r.status);
        return j;
      });
    });
  }

  // --- My Day -------------------------------------------------------------
  function statusPill(t) {
    var s = String(t.ServiceRequestUserLifeCycleStatusCodeText || t.status || "").toLowerCase();
    var cls = s.indexOf("process") > -1 ? "p-prog" : s.indexOf("open") > -1 ? "p-open" : "p-other";
    return '<span class="pill ' + cls + '">' + esc(t.ServiceRequestUserLifeCycleStatusCodeText || t.status || "—") + "</span>";
  }

  function ticketCard(t) {
    var id = t.ID || t.id || "";
    var oid = t.ObjectID || t.objectId || "";
    return (
      '<div class="card" data-oid="' + esc(oid) + '" data-id="' + esc(id) + '" onclick="openTicket(this)">' +
      '<div class="t"><div class="tid">#' + esc(id) + "</div>" + statusPill(t) + "</div>" +
      '<div class="tt">' + esc(t.Name || t.title || "(untitled)") + "</div>" +
      '<div class="tc">' + esc(t.BuyerPartyName || t.customer || "") + "</div>" +
      "</div>"
    );
  }

  // --- Home (the extension's command grid, mirrored) ----------------------
  // Header + current-ticket pill + command box + the 4-phase chip grid. The
  // chips act on state.currentTicket, which the tech sets from My Day (the
  // extension detects it from the SAP page; a phone can't).
  function setNav(tab) {
    ["home", "day", "me"].forEach(function (t) {
      var b = $("nav-" + t);
      if (b) b.className = t === tab ? "on" : "";
    });
  }

  function renderHome() {
    if (!authed()) { renderLogin(); return; }
    setNav("home");
    var ct = state.currentTicket;
    var pill = ct
      ? '<span class="ticket-pill" onclick="go(\'day\')">🎫 Ticket ' + esc(ct.id) +
          (ct.name ? " · " + esc(ct.name.slice(0, 26)) : "") + "</span>"
      : '<span class="ticket-pill empty" onclick="go(\'day\')">🎫 No ticket — tap to pick from My Day</span>';

    // Ticket context card (the equivalent of the extension's detected-ticket
    // panel), shown only when a ticket is selected.
    var ctxCard = ct
      ? '<div class="card">' +
          '<div class="tt">' + esc(ct.name || "(untitled)") + "</div>" +
          '<div class="tc" style="margin-bottom:8px">' + esc(ct.customer || "") + "</div>" +
          '<div class="kv"><span>Status</span><span>' + esc(ct.status || "—") + "</span></div>" +
          '<div class="kv"><span>Priority</span><span>' + esc(ct.priority || "—") + "</span></div>" +
          '<div class="kv"><span>Product</span><span>' + esc(ct.product || "—") + "</span></div>" +
          '<div class="kv"><span>Serial</span><span>' + esc(ct.serial || "—") + "</span></div>" +
          "</div>"
      : "";

    var chipsHtml = CHIP_GROUPS.map(function (g) {
      var cols = CHIPS.filter(function (c) { return c.grp === g.key; }).map(function (c) {
        return '<button class="template-chip' + (c.flow ? "" : " soon") + '"' +
          ' data-category="' + c.cat + '" data-flow="' + (c.flow || "") + '"' +
          ' data-label="' + esc(c.label) + '">' + c.icon + " " + esc(c.label) + "</button>";
      }).join("");
      return '<div class="chip-phase-col"><div class="chip-phase-header">' + g.label + "</div>" + cols + "</div>";
    }).join("");

    view.innerHTML =
      '<div style="margin-bottom:10px">' + pill + "</div>" +
      ctxCard +
      '<textarea class="cmd-box" id="cmdbox" placeholder="Ask anything — or try /pulse, /triage, /knowledge, /nearby, /close-out, /skills, /help"></textarea>' +
      '<div class="template-chips phase-grid">' + chipsHtml + "</div>";

    var btns = view.querySelectorAll(".template-chip");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.onclick = function () { onChip(btn.getAttribute("data-flow"), btn.getAttribute("data-label")); };
      })(btns[i]);
    }
  }

  function onChip(flow, label) {
    if (!flow) {
      showErr("“" + label + "” works in the extension today — coming to the app soon.");
      return;
    }
    var ct = state.currentTicket;
    if (!ct || !ct.objectId) {
      showErr("Pick a ticket from My Day first.");
      go("day");
      return;
    }
    if (flow === "prepPm") renderPmPrep(ct.objectId, ct.id);
    else if (flow === "partsCheck") renderPartsCheck(ct.objectId, ct.id);
  }

  function renderDay() {
    // Backstop: a 401 mid-flight clears the token and shows the login screen,
    // but the caller's .catch then re-renders this view on top of it. Checking
    // here means no code path can paint over the sign-in prompt.
    if (!authed()) { renderLogin(); return; }
    setNav("day");
    if (!state.partyId) {
      view.innerHTML =
        '<h2>My Day</h2>' +
        '<div class="card"><p style="margin:0 0 12px;font-size:13.5px;color:var(--muted)">' +
        "Tell us who you are to load your assigned tickets.</p>" +
        '<button class="primary" onclick="go(\'me\')">Set up</button></div>';
      return;
    }
    if (!state.tickets) {
      view.innerHTML = '<h2>My Day</h2><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      loadDay();
      return;
    }
    if (!state.tickets.length) {
      view.innerHTML = '<h2>My Day</h2><div class="empty">No open tickets assigned to you.</div>';
      return;
    }
    view.innerHTML =
      "<h2>My Day · " + state.tickets.length + "</h2>" + state.tickets.map(ticketCard).join("");
  }

  function loadDay() {
    showErr("");
    post("/api/tools/get_my_tickets", { processorPartyId: state.partyId, top: 25 })
      .then(function (j) {
        var r = j.result || j;
        var rows = r.tickets || r.results || (r.d && r.d.results) || [];
        state.tickets = Array.isArray(rows) ? rows : [];
        showOffline(state.stale);
        renderDay();
      })
      .catch(function (e) {
        if (e.signedOut) return; // renderLogin() already owns the screen
        state.tickets = [];
        showErr(e.message === "offline" ? "Offline and nothing cached yet." : e.message);
        renderDay();
      });
  }

  // --- ticket selection ---------------------------------------------------
  // Tapping a My Day ticket makes it the "current ticket" and returns to Home,
  // where the command chips act on it — mirroring the extension, where the
  // chips act on the ticket detected from the SAP page.
  window.openTicket = function (el) {
    var id = el.getAttribute("data-id");
    var oid = el.getAttribute("data-oid");
    showErr("");
    view.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    post("/api/lookup", { input: id })
      .then(function (j) {
        var t = j.ticket && (j.ticket.d ? j.ticket.d.results : j.ticket);
        if (Array.isArray(t)) t = t[0];
        t = t || {};
        state.currentTicket = {
          objectId: t.ObjectID || oid || "",
          id: id,
          name: t.Name || "",
          customer: t.BuyerPartyName || "",
          status: t.ServiceRequestUserLifeCycleStatusCodeText || "",
          priority: t.ServiceRequestUserLifeCyclePriorityCodeText || t.ServicePriorityCodeText || "",
          product: t.ProductID || "",
          serial: t.SerialID || "",
        };
        go("home");
      })
      .catch(function (e) {
        if (e.signedOut) return; // renderLogin() already owns the screen
        showErr(e.message);
        renderDay();
      });
  };

  // --- Prep for PM (thin renderer over /api/get_pm_prep) -------------------
  // ALL logic — SAP fetches, PM detection, labour/parts rollup, and the
  // kit-gap LLM inference — lives in the shim. This function only calls the
  // endpoint and paints the result. That's the "one core, thin doors" rule:
  // the same endpoint backs the extension's /prep-pm panel.
  function fmtDate(s) {
    if (!s) return "—";
    var m = /\/Date\((\d+)/.exec(String(s));
    var ms = m ? Number(m[1]) : Date.parse(String(s));
    if (!isFinite(ms)) return String(s);
    var d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  function renderPmPrep(objectId, ticketId) {
    showErr("");
    // The extension's progress-strip loader (from the shared design system), so
    // the "working…" state looks identical to the side panel's slow-command UI.
    view.innerHTML =
      '<h2>Prep for PM · ' + esc(ticketId) + "</h2>" +
      '<div class="progress-strip">' +
        '<div class="progress-step progress-step-pending"><span class="progress-spinner"></span>' +
        '<span class="progress-message">Pulling equipment history from SAP…</span></div>' +
        '<div class="progress-step"><span class="progress-spinner"></span>' +
        '<span class="progress-message">Inferring PM kit contents + gaps…</span></div>' +
      "</div>" +
      '<div class="skel"></div><div class="skel"></div>';
    // kitAnalysis=1 asks the shim to run the LLM kit-gap step server-side.
    var qs = "objectId=" + encodeURIComponent(objectId) + "&kitAnalysis=1";
    fetch("/api/get_pm_prep?" + qs, { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { setToken(null); state.authOptional = false; renderLogin("Your session expired — please sign in again."); return null; }
        return r.json();
      })
      .then(function (p) {
        if (!p) return;
        if (!p.ok) { showErr(p.error || "Prep failed."); return; }
        paintPmPrep(p, objectId, ticketId);
      })
      .catch(function (e) { showErr(e.message); });
  }

  function paintPmPrep(p, objectId, ticketId) {
    var ct = p.currentTicket || {};
    var h = "";

    // No serial → the endpoint returns a warning; show it plainly.
    if (p.warning === "no-serial") {
      h += '<div class="card"><div class="tt">No equipment history</div>' +
        '<div class="tc">' + esc(p.message || "This ticket has no serial to prep against.") + "</div></div>";
    }

    // Headline: last PM.
    var lp = p.lastPM;
    h += '<div class="card">' +
      '<div class="tt">' + esc(ct.productName || ct.product || "Equipment") + "</div>" +
      '<div class="tc" style="margin-bottom:8px">Serial ' + esc(ct.serial || "—") + " · " + esc(ct.customer || "") + "</div>";
    if (lp) {
      h += '<div class="kv"><span>Last PM</span><span>' + esc(fmtDate(lp.completedAt)) +
        (lp.daysAgo != null ? " (" + lp.daysAgo + "d ago)" : "") + "</span></div>" +
        '<div class="kv"><span>By</span><span>' + esc(lp.fseName || "—") + "</span></div>" +
        (lp.secondaryTypeText ? '<div class="kv"><span>Type</span><span>' + esc(lp.secondaryTypeText) + "</span></div>" : "");
    } else {
      h += '<div class="tc">No prior completed PM found on this serial.</div>';
    }
    h += "</div>";

    // Kit-gap analysis (server-side LLM).
    var ka = p.kitAnalysis;
    if (ka && (ka.shortNarrative || (ka.gaps && ka.gaps.length) || (ka.inferredKitContents && ka.inferredKitContents.length))) {
      h += '<div class="card" style="border-color:#fcd34d;background:#fffbeb">' +
        '<div class="tt">🛡 Kit gaps</div>';
      if (ka.shortNarrative) h += '<div class="tc" style="margin-bottom:8px">' + esc(ka.shortNarrative) + "</div>";
      (ka.gaps || []).forEach(function (g) {
        h += '<div style="margin:6px 0"><b>' + esc(g.name) + "</b>" +
          (g.concern ? '<div class="tc" style="color:#92400e">' + esc(g.concern) + "</div>" : "") + "</div>";
      });
      if (ka.inferredKitContents && ka.inferredKitContents.length) {
        h += '<div class="tc" style="margin-top:8px;color:var(--faint)">Typical kit: ' +
          ka.inferredKitContents.map(function (k) { return esc(k.name); }).join(", ") + "</div>";
      }
      h += "</div>";
    }

    // Cumulative labour.
    var cl = p.cumulativeLabour || {};
    h += '<div class="card"><div class="tt">Effort history</div>' +
      '<div class="kv"><span>On-equipment</span><span>' + (cl.totalHours || 0) + " h</span></div>" +
      '<div class="kv"><span>Travel</span><span>' + (cl.totalTravelHours || 0) + " h</span></div>" +
      '<div class="kv"><span>Across</span><span>' + (cl.ticketsWithLabour || 0) + " visits</span></div></div>";

    // Corrective since last PM.
    var cm = p.correctiveMaintenanceSinceLastPM || {};
    h += '<div class="card"><div class="tt">Corrective since last PM · ' + (cm.count || 0) + "</div>";
    (cm.tickets || []).slice(0, 6).forEach(function (t) {
      h += '<div style="margin:6px 0"><b>#' + esc(t.ticketId) + "</b> " +
        '<span class="tc">' + esc(t.subject || "") + "</span> " +
        '<span class="tc" style="color:var(--faint)">' + esc(fmtDate(t.completedAt)) + "</span></div>";
    });
    if (!(cm.tickets || []).length) h += '<div class="tc">None — clean since the last PM.</div>';
    h += "</div>";

    // Parts replacement history.
    var ph = (p.partsHistory && p.partsHistory.distinctParts) || [];
    h += '<div class="card"><div class="tt">Parts replaced (this serial)</div>';
    ph.slice(0, 10).forEach(function (pt) {
      h += '<div class="kv"><span>' + esc(pt.name) + "</span><span>" + pt.timesReplaced + "× · " + esc(fmtDate(pt.lastReplacedAt)) + "</span></div>";
    });
    if (!ph.length) h += '<div class="tc">No parts history captured.</div>';
    h += "</div>";

    // Open follow-ups.
    var of = (p.openFollowUps && p.openFollowUps.tickets) || [];
    if (of.length) {
      h += '<div class="card"><div class="tt">Open follow-ups · ' + of.length + "</div>";
      of.slice(0, 6).forEach(function (t) {
        h += '<div style="margin:6px 0"><b>#' + esc(t.ticketId) + "</b> " +
          '<span class="tc">' + esc(t.subject || "") + "</span> " +
          '<span class="pill p-open">' + esc(t.statusText || "open") + "</span></div>";
      });
      h += "</div>";
    }

    h += '<button onclick="go(\'home\')">← Back to Home</button>';
    view.innerHTML = "<h2>Prep for PM · " + esc(ticketId) + "</h2>" + h;
  }

  // --- Parts check (thin renderer over /api/get_parts_check) ---------------
  // The whole inference engine — similar tickets, consumption line-item
  // extraction, LLM inference, stock cross-check — lives in the shim (a port of
  // the extension's runPartsInference). This only calls it and paints.
  function renderPartsCheck(objectId, ticketId) {
    showErr("");
    view.innerHTML =
      '<h2>Parts check · ' + esc(ticketId) + "</h2>" +
      '<div class="progress-strip">' +
        '<div class="progress-step progress-step-pending"><span class="progress-spinner"></span>' +
        '<span class="progress-message">Finding similar tickets + reading resolutions…</span></div>' +
        '<div class="progress-step"><span class="progress-spinner"></span>' +
        '<span class="progress-message">Inferring parts + checking stock…</span></div>' +
      "</div>" +
      '<div class="skel"></div><div class="skel"></div>';
    fetch("/api/get_parts_check?objectId=" + encodeURIComponent(objectId), { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { setToken(null); state.authOptional = false; renderLogin("Your session expired — please sign in again."); return null; }
        return r.json();
      })
      .then(function (p) {
        if (!p) return;
        if (!p.ok) { showErr(p.error || "Parts check failed."); return; }
        paintPartsCheck(p, objectId, ticketId);
      })
      .catch(function (e) { showErr(e.message); });
  }

  function confPill(c) {
    var cls = c === "high" ? "p-open" : c === "medium" ? "p-prog" : "p-other";
    return '<span class="pill ' + cls + '">' + esc(c || "low") + "</span>";
  }
  function stockBadge(st) {
    if (!st || st.onHand == null) return '<span class="pill p-other">stock —</span>';
    if (st.onHand <= 0) return '<span class="pill p-prog">out of stock</span>';
    return '<span class="pill p-open">' + st.onHand + (st.uom ? " " + esc(st.uom) : "") + " on hand</span>";
  }

  function paintPartsCheck(p, objectId, ticketId) {
    var ct = p.currentTicket || {};
    var h = "";

    if (p.warning === "no-product-symptom") {
      h += '<div class="card"><div class="tt">Can\'t infer parts</div>' +
        '<div class="tc">' + esc(p.message || "This ticket has no product or symptom.") + "</div></div>";
    }

    h += '<div class="card">' +
      '<div class="tt">' + esc(ct.product || "Equipment") + "</div>" +
      '<div class="tc" style="margin-bottom:6px">Serial ' + esc(ct.serial || "—") + " · " + esc(ct.customer || "") + "</div>" +
      (p.summary ? '<div class="tc">' + esc(p.summary) + "</div>" : "") +
      "</div>";

    var parts = p.parts || [];
    if (!parts.length) {
      h += '<div class="card"><div class="tt">No parts inferred</div>' +
        '<div class="tc">No recurring parts found across ' + (p.similarTicketCount || 0) + " similar ticket(s).</div></div>";
    } else {
      h += '<div class="card"><div class="tt">Likely parts · ' + parts.length + "</div>";
      parts.forEach(function (pt) {
        h += '<div style="padding:8px 0;border-bottom:1px solid var(--line)">' +
          '<div class="t"><span style="font-weight:600;font-size:13.5px">' + esc(pt.name || pt.materialId || "?") + "</span>" +
          confPill(pt.confidence) + "</div>" +
          '<div class="tc" style="margin:3px 0">' + esc(pt.reason || "") + "</div>" +
          '<div>' + stockBadge(pt.stock) +
          (pt.materialId ? ' <span class="tc" style="font-family:var(--mono);font-size:11px">' + esc(pt.materialId) + "</span>" : "") +
          "</div></div>";
      });
      h += "</div>";
    }

    // Why these? — the diagnostic the extension's panel shows.
    var pcnt = p.phaseCounts || {};
    h += '<div class="card"><div class="tt">Why these suggestions?</div>' +
      '<div class="kv"><span>Similar tickets</span><span>' + (pcnt.similarTickets || 0) +
        " (" + (pcnt.fromSerialHistory || 0) + " serial · " + (pcnt.fromVectorSearch || 0) + " vector)</span></div>" +
      '<div class="kv"><span>With resolutions</span><span>' + (pcnt.ticketsWithResolutions || 0) + "</span></div>" +
      '<div class="kv"><span>Line items scanned</span><span>' + (p.lineItemsScanned || 0) +
        " (" + (p.excludedByProcType || 0) + " wrong type)</span></div>" +
      '<div class="kv"><span>Matched in catalog</span><span>' + (pcnt.matchedInCatalog || 0) + "</span></div>" +
      '<div class="tc" style="margin-top:6px;color:var(--faint)">Consumption types: ' + esc((p.includeProcTypes || []).join(", ")) + "</div>" +
      "</div>";

    h += '<button onclick="go(\'home\')">← Back to Home</button>';
    view.innerHTML = "<h2>Parts check · " + esc(ticketId) + "</h2>" + h;
  }

  // Re-open a ticket from a synthetic element (used by the Prep back button).
  window.openTicketById = function (ticketId, oid) {
    var fake = { getAttribute: function (k) { return k === "data-id" ? ticketId : oid; } };
    window.openTicket(fake);
  };

  // --- Me / identity ------------------------------------------------------
  function renderMe() {
    // DEV ONLY: simulate an SSO sign-in without an IdP. Appears only when the
    // server is in the insecure dev posture (probe said auth isn't enforced);
    // it drives /api/auth/dev-login, which itself 404s in any real posture. It
    // exists so the SSO zero-touch flow (email → whoami → My Day) can be seen
    // before the Entra App Registration is set up. With real Entra this card is
    // absent and the identity comes from the login token automatically.
    var devCard = state.authOptional
      ? '<div class="card" style="border-color:#fcd34d;background:#fffbeb">' +
        '<label for="devEmail">Dev sign-in (simulates SSO)</label>' +
        '<input id="devEmail" type="email" placeholder="alex.doe@example.com" value="' +
          esc(state.name ? "" : "") + '" />' +
        '<div class="row" style="margin-top:10px">' +
        '<button class="primary" id="devLoginBtn">Sign in as this user</button>' +
        "</div>" +
        '<p style="font-size:12px;color:#92400e;margin:10px 0 0">' +
        "Local dev only. Resolves the SAP identity from the email and lands on My Day — " +
        "the same path real Entra SSO will take.</p>" +
        "</div>"
      : "";

    view.innerHTML =
      "<h2>Me</h2>" +
      devCard +
      '<div class="card">' +
      '<label for="nm">Your name (as it appears in SAP)</label>' +
      '<input id="nm" placeholder="e.g. Marouane Najar" value="' + esc(state.name || "") + '" />' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="primary" id="lookupBtn">Look me up</button>' +
      "</div>" +
      '<p style="font-size:12.5px;color:var(--faint);margin:12px 0 0">' +
      "Finds your SAP business-partner ID. Admin logins often have no employee record — " +
      "enter the party ID directly below if lookup finds nothing.</p>" +
      "</div>" +
      '<div class="card">' +
      '<label for="pid">Processor party ID</label>' +
      '<input id="pid" inputmode="numeric" placeholder="800…" value="' + esc(state.partyId || "") + '" />' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="primary" id="saveBtn">Save</button>' +
      '<button id="clearBtn">Clear</button>' +
      "</div></div>" +
      '<div class="card">' +
      '<label>Session</label>' +
      '<p style="font-size:12.5px;color:var(--faint);margin:4px 0 10px">' +
      "Signing out also clears every SAP page cached on this device.</p>" +
      '<button id="signOutBtn">Sign out</button>' +
      "</div>" +
      '<div class="card soon"><div class="tc">Settings, GPS routing, barcode scan and push notifications land with the ' +
      "field flows.</div></div>";

    $("lookupBtn").onclick = function () {
      var nm = $("nm").value.trim();
      if (!nm) return;
      showErr("");
      $("lookupBtn").disabled = true;
      post("/api/resolve_employee", { names: [nm] })
        .then(function (j) {
          // /api/resolve_employee normalises the SAP row to camelCase:
          //   { found, employee: { partyId, employeeId, userId, name, email } }
          // NOT the raw BusinessPartnerID/BusinessPartnerFormattedName fields.
          var e = j && j.employee;
          if (!j.found || !e || !e.partyId) {
            throw new Error("No employee record found for that name — enter the party ID manually.");
          }
          $("pid").value = e.partyId;
          state.name = e.name || nm;
          try { localStorage.setItem(NAME_KEY, state.name); } catch (err) {}
          whoPill();
          showErr("");
        })
        .catch(function (e) { if (!e.signedOut) showErr(e.message); })
        .then(function () { var b = $("lookupBtn"); if (b) b.disabled = false; });
    };
    $("saveBtn").onclick = function () {
      var pid = $("pid").value.trim();
      if (!pid) return;
      state.partyId = pid;
      state.name = $("nm").value.trim() || state.name;
      state.tickets = null;
      try {
        localStorage.setItem(PARTY_KEY, pid);
        if (state.name) localStorage.setItem(NAME_KEY, state.name);
      } catch (e) {}
      whoPill();
      go("home");
    };
    $("clearBtn").onclick = function () {
      state.partyId = null; state.name = null; state.tickets = null;
      try { localStorage.removeItem(PARTY_KEY); localStorage.removeItem(NAME_KEY); } catch (e) {}
      whoPill();
      renderMe();
    };
    $("signOutBtn").onclick = function () {
      $("signOutBtn").disabled = true;
      signOut();
    };
    if ($("devLoginBtn")) {
      $("devLoginBtn").onclick = function () {
        var email = $("devEmail").value.trim();
        if (!email) return;
        showErr("");
        $("devLoginBtn").disabled = true;
        fetch("/api/auth/dev-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok || !j.token) throw new Error(j.error || "Dev sign-in unavailable (HTTP " + r.status + ").");
              return j;
            });
          })
          .then(function (j) {
            setToken(j.token);
            resolveIdentityAndRoute(); // email → whoami → My Day, zero touch
          })
          .catch(function (e) {
            showErr(e.message);
            var b = $("devLoginBtn"); if (b) b.disabled = false;
          });
      };
    }
  }

  // --- nav ----------------------------------------------------------------
  window.go = function (tab) {
    showErr("");
    // Every tab needs SAP, and SAP needs a token. Nothing to show until then.
    if (!authed()) { renderLogin(); return; }
    if (tab === "me") { setNav("me"); renderMe(); }
    else if (tab === "day") { renderDay(); }        // renderDay sets its own nav
    else { renderHome(); }                           // "home" — the command grid
  };

  window.addEventListener("online", function () { netPill(); showOffline(false); });
  window.addEventListener("offline", netPill);

  try { var vEl = $("ver"); if (vEl) vEl.textContent = VER; } catch (e) {}
  netPill();
  whoPill();
  if (state.token) {
    // Signed in already — resolve identity from the token (SSO zero-touch) and
    // land on Home (the command grid). A relaunch lands there with no interaction.
    resolveIdentityAndRoute();
  } else {
    // No token yet. Find out whether this server even wants one before
    // showing a login screen the operator might have no way to satisfy.
    view.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    probeAuthEnforced().then(function (enforced) {
      state.authOptional = !enforced;
      // Dev/insecure server: no token to resolve identity from, so go straight
      // to identity resolution (which will land on My Day if a party ID was
      // saved before, else the Me tab with its dev sign-in).
      if (enforced) renderLogin();
      else resolveIdentityAndRoute();
    });
  }

  // Register the service worker (offline shell). Non-fatal if unsupported.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function (e) {
        console.debug("[field] SW registration skipped:", e && e.message);
      });
    });
  }
})();
