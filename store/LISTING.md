# Ask C4S — Chrome Web Store submission

Paste these into the Developer Dashboard. Set **Visibility = Private** (add tester
Google emails as trusted testers) or **Unlisted** (link-only).

---

## Single purpose (required)
Ask C4S helps users of SAP Service Cloud (C4S/C4C) work with service tickets —
triage, knowledge-base search, parts checks, and drafting replies — from within the
browser.

## Short description (≤ 132 chars)
A companion for SAP Service Cloud: triage tickets, search the knowledge base, check
parts, and draft replies — from your browser.

## Detailed description
Ask C4S is a service companion for SAP Service Cloud (C4S / C4C). Open it from the
side panel or a popup, or right-click a selection on a Service Cloud page, to:

- Triage and summarize service tickets
- Search your knowledge base
- Check parts and stock
- Draft replies and notes, with one-click writeback
- See a daily briefing of your assigned work

It connects to a backend service configured by your organization's administrator,
which integrates with your SAP Service Cloud tenant.

---

## Permission justifications (the "why do you need this?" review questions)

| Permission | Why it is needed |
|---|---|
| **Host access — SAP Service Cloud** (`*.crm.ondemand.com`, `*.crm.sap.com`, `*.c4c.sap.com`, `*.cloudfoundry.io`) | A content script runs on your Service Cloud pages to detect the current ticket and provide context **when you invoke the extension**. |
| **Host access — backend service** (the configured Server URL) | The extension calls the backend API to answer your requests. |
| **Host access — knowledge base** (`knowledge1.thermofisher.com`, `*.thermofisher.com`) | To open and search knowledge-base articles referenced in results. |
| **Host access — maps** (`nominatim.openstreetmap.org`, `*.tile.openstreetmap.org`) | To show a map for the optional "nearby" / location features. |
| **Optional host access** (`https://*/*`, requested at runtime) | Requested **only with your consent** when an administrator points the extension at a custom backend Server URL not already listed. Never granted by default. |
| **storage** | Saves your sign-in session and settings locally. |
| **activeTab**, **scripting**, **tabs** | Read the current Service Cloud page's context when you invoke the extension, and open/focus the relevant tab. |
| **contextMenus** | The right-click "Ask C4S" menu entries. |
| **sidePanel** | Show Ask C4S in the browser side panel. |
| **notifications** | Optional SLA-deadline alerts. |
| **alarms** | Schedule the optional SLA watcher. |
| **clipboardWrite** | One-click copy of generated text. |
| **geolocation** | Optional "nearby" feature for field use. |

> Note: `localhost` host entries are for local development and can be removed from
> the distributed build if a reviewer asks.

---

## Data-usage disclosures (Chrome's privacy form)
- **Collects user data?** Yes — processes the content you submit and page context to
  provide its function.
- **Data types:** "Website content" (the page/ticket context you submit) and
  authentication info.
- **Use:** solely to provide the extension's functionality. **Not** sold, **not**
  used for advertising or any unrelated purpose.
- **Privacy policy URL:** _[host PRIVACY-POLICY.md and put the URL here]_

---

## After publishing
1. Note the assigned **extension ID** (permanent).
2. Give IT that ID and ask them to **allowlist** it (or **force-install** it) on
   managed browsers — otherwise managed Chrome/Edge may block the install.
3. Confirm the listing is **Private/Unlisted**, not Public.

## Before you submit — still to do
- **Bake the default endpoint** into the distributed build (set `DEFAULT_ENDPOINT` to
  `https://ec2-54-83-232-127.compute-1.amazonaws.com`) so testers don't configure it.
  Do this once the server is deployed and reachable.
- **Host the privacy policy** at a public URL (GitHub Pages, or serve it from the
  deployed server) and put that URL in the form above.
- **Screenshots** (1280×800): a couple of the panel in action.
