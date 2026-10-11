/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

// Ask C4S — in-page content script for SAP C4C ticket screens.
// ---------------------------------------------------------------------------
// Two responsibilities:
//   1. Inject a floating "✨ Ask C4S" badge bottom-right
//   2. Scrape the visible page DOM for ticket-shaped data and ship it to
//      the popup as additional context. The LLM gets a richer ticket
//      summary even when SAP's URL doesn't expose the ID cleanly.
//
// The DOM scraping is intentionally defensive — SAP C4C / Service Cloud
// markup varies by tenant + UI version. We:
//   - Grab the document.title (cheapest, almost always present)
//   - Pick out visible text from a curated set of selectors that map to
//     common SAP UI5 components (headers, fields, labels)
//   - Stop at ~6KB to keep storage + LLM input small
//   - Skip script / style / hidden elements

(function () {
  if (window.__askc4sBadgeInstalled) return;
  window.__askc4sBadgeInstalled = true;

  // ---- DOM scraping ------------------------------------------------------

  /**
   * Cheap "visible text" walker — produces a deduped, length-capped string
   * from the parts of the DOM most likely to carry ticket info. Returns
   * a structured snapshot so the popup can render fields when they exist
   * and fall back to raw text otherwise.
   */
  function snapshotPage() {
    const out = {
      url: window.location.href,
      title: document.title || "",
      heading: "",
      // titles[] captures EVERY likely page/object header so the popup
      // can scan all of them for a ticket-ID pattern. SAP C4C's HTML5
      // client often puts "Home" or a breadcrumb in the first <h1> and
      // hides the actual ticket title inside a sapMObjectHeader-title or
      // a tab-active label — relying on the first H1 alone misses those.
      titles: /** @type {string[]} */ ([]),
      fields: /** @type {Record<string, string>} */ ({}),
      bodyText: "",
      capturedAt: Date.now(),
    };

    // Best-effort heading: first H1/H2 or page header (kept for backwards
    // compat with older popup builds).
    const heading =
      document.querySelector("h1, h2, [role='heading']") ||
      document.querySelector(".sapMTitle, .sapMText--Header");
    if (heading) out.heading = norm(heading.textContent ?? "");

    // Multi-source title collector. Order doesn't matter — the popup
    // tries each in turn looking for the first one with a ticket-ID
    // pattern. Cap at ~40 candidates so we don't ship the whole DOM.
    //
    // Also collected from every same-origin iframe — SAP C4C's HTML5
    // shell often renders the ticket detail in a nested iframe whose
    // contents are invisible from the top document. Cross-origin iframes
    // are silently skipped (security boundary, nothing we can do).
    const TITLE_SELECTORS = [
      "h1",
      "h2",
      "h3",
      "h4",
      "[role='heading']",
      ".sapMTitle",
      ".sapMText--Header",
      ".sapMObjectHeaderTitle",
      ".sapMObjectHeader-title",
      ".sapMObjectHeaderTitleText",
      ".sapMObjectHeaderTitleTextWrapper",
      ".sapMObjectListItemTitle",
      ".sap-ui-title-text",
      ".sapUshellShellHeader-tabContainer-tab-active",
      ".sapMITBFilterText",
      "[data-sap-ui*='title']",
      "[data-help-id*='title']",
      "[aria-label*='Ticket']",
      "[aria-label*='Service']",
    ];
    const seen = new Set();
    function collectFromDoc(doc) {
      for (const sel of TITLE_SELECTORS) {
        let nodes;
        try {
          nodes = doc.querySelectorAll(sel);
        } catch {
          continue; // some doc views throw on attribute selectors
        }
        for (const n of nodes) {
          if (out.titles.length >= 40) return;
          const t = norm(n.textContent || "");
          if (!t || t.length > 200 || seen.has(t)) continue;
          seen.add(t);
          out.titles.push(t);
        }
      }
    }
    collectFromDoc(document);
    // Recurse into same-origin iframes. We descend only one level deep
    // to keep this O(frames) and avoid infinite loops on circular cases.
    try {
      for (const iframe of document.querySelectorAll("iframe, frame")) {
        try {
          const idoc = iframe.contentDocument;
          if (!idoc) continue; // cross-origin — DOMException would have thrown
          collectFromDoc(idoc);
          // Two-level descent for SAP's nested-shell layouts.
          for (const inner of idoc.querySelectorAll("iframe, frame")) {
            try {
              const innerDoc = inner.contentDocument;
              if (innerDoc) collectFromDoc(innerDoc);
            } catch {
              /* nested cross-origin */
            }
          }
        } catch {
          /* cross-origin iframe — skip silently */
        }
      }
    } catch {
      /* defensive */
    }

    // SAP C4C labelled fields — pair label text with its sibling value.
    // The most stable pattern across SAP UI5 versions:
    //   <label class="sapMLabel"> + nearby <span class="sapMText"> | <input>
    const labels = document.querySelectorAll(
      ".sapMLabel, .sapMITBText, [data-sap-ui-area='label']",
    );
    for (const el of labels) {
      const labelText = norm(el.textContent || "");
      if (!labelText || labelText.length > 60) continue;
      // Look for an associated value: 'for' attribute → element by id, or
      // next sibling, or aria-labelledby reverse-lookup.
      let valEl = null;
      const forId = el.getAttribute("for");
      if (forId) valEl = document.getElementById(forId);
      if (!valEl) {
        let n = el.nextElementSibling;
        while (n && n.textContent != null && norm(n.textContent).length === 0) {
          n = n.nextElementSibling;
        }
        valEl = n;
      }
      if (!valEl) continue;
      const value = norm(valEl.textContent || valEl.value || "");
      if (value && value !== labelText && !out.fields[labelText]) {
        out.fields[labelText] = value.slice(0, 200);
      }
      if (Object.keys(out.fields).length >= 30) break;
    }

    // Fallback body text — visible text content from the main region.
    // We avoid grabbing the whole DOM because it's enormous on SAP UI5
    // and we'd burn LLM tokens on chrome.
    const main =
      document.querySelector("main, [role='main'], #shell-content") ||
      document.body;
    if (main) {
      const visibleText = extractVisibleText(main, 6000);
      out.bodyText = visibleText.slice(0, 6000);
    }

    // Append same-origin iframe body text too — bounded so the total
    // payload stays around 8 KB. SAP C4C's HTML5 shell renders ticket
    // details in nested iframes; without this, ticket-ID extraction
    // misses them entirely.
    try {
      for (const iframe of document.querySelectorAll("iframe, frame")) {
        if ((out.bodyText?.length ?? 0) >= 8000) break;
        try {
          const idoc = iframe.contentDocument;
          if (!idoc?.body) continue;
          const extra = extractVisibleText(idoc.body, 3000);
          if (extra) out.bodyText = (out.bodyText ? out.bodyText + "\n---\n" : "") + extra;
        } catch {
          /* cross-origin — skip */
        }
      }
    } catch {
      /* defensive */
    }

    return out;
  }

  function norm(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }

  function extractVisibleText(root, cap) {
    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS",
    ]);
    const acc = [];
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        // Skip hidden elements (cheap heuristic — full computed-style
        // would be more accurate but ~10x slower on big SAP pages).
        if (parent.hidden) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const t = norm(n.nodeValue);
      if (!t) continue;
      acc.push(t);
      total += t.length + 1;
      if (total >= cap) break;
    }
    // Dedupe consecutive identical lines (SAP UI5 often repeats labels)
    const deduped = [];
    let last = "";
    for (const line of acc) {
      if (line === last) continue;
      deduped.push(line);
      last = line;
    }
    return deduped.join("\n");
  }

  // ---- Inject the badge --------------------------------------------------

  const root = document.createElement("div");
  root.id = "askc4s-overlay";
  root.style.cssText = [
    "position: fixed",
    "bottom: 22px",
    "right: 22px",
    "z-index: 2147483646",
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "font-size: 13px",
    "user-select: none",
  ].join(";");

  const button = document.createElement("button");
  button.type = "button";
  button.id = "askc4s-ask";
  button.title = "Open Ask C4S for this page (includes scraped context)";
  button.innerHTML =
    '<span style="font-size:16px; line-height:1;">✨</span><span>Ask C4S</span>';
  button.style.cssText = [
    "display: inline-flex",
    "align-items: center",
    "gap: 8px",
    "padding: 10px 14px",
    "border: none",
    "border-radius: 999px",
    "color: white",
    "background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 35%, #8b5cf6 70%, #ec4899 100%)",
    "box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25)",
    "cursor: pointer",
    "font-weight: 600",
    "font-size: 13px",
    "transition: transform 120ms ease, box-shadow 120ms ease",
  ].join(";");

  button.addEventListener("mouseenter", () => {
    button.style.transform = "translateY(-1px)";
    button.style.boxShadow = "0 10px 28px rgba(15, 23, 42, 0.32)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.transform = "translateY(0)";
    button.style.boxShadow = "0 6px 20px rgba(15, 23, 42, 0.25)";
  });

  button.addEventListener("click", () => {
    // Scrape NOW (page state is freshest right when the user clicks) and
    // send to background, which stashes it for the popup.
    const snapshot = snapshotPage();
    chrome.runtime.sendMessage({
      type: "open-popup",
      url: window.location.href,
      pageSnapshot: snapshot,
    });
  });

  const close = document.createElement("button");
  close.type = "button";
  close.title = "Hide for this tab (refresh to bring back)";
  close.innerHTML = "×";
  close.style.cssText = [
    "position: absolute",
    "top: -8px",
    "right: -8px",
    "width: 20px",
    "height: 20px",
    "border-radius: 50%",
    "border: 1px solid rgba(15,23,42,0.15)",
    "background: white",
    "color: #475569",
    "font-size: 14px",
    "line-height: 1",
    "cursor: pointer",
    "box-shadow: 0 2px 6px rgba(15,23,42,0.18)",
  ].join(";");
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    root.remove();
  });

  root.appendChild(button);
  root.appendChild(close);

  if (document.body) {
    document.body.appendChild(root);
  } else {
    const observer = new MutationObserver(() => {
      if (document.body) {
        document.body.appendChild(root);
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // Also respond to a "scrape-now" message from the popup (used when the
  // popup is opened via the toolbar icon — no in-page button clicked).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "scrape-page") {
      sendResponse(snapshotPage());
      return true; // keep channel open for async response
    }
  });
})();
