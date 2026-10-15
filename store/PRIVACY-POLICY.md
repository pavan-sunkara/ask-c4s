# Ask C4S — Privacy Policy

_Last updated: 2026-10-14_

> **Draft.** Review with your privacy/legal team and set the correct publishing
> entity and contact before hosting this at a public URL (required by the
> Chrome Web Store).

## Overview
Ask C4S is a browser extension that assists users of SAP Service Cloud (C4S / C4C).
It connects to a backend service configured by your organization's administrator
(the "Service") to help triage tickets, search the knowledge base, check parts,
and draft replies.

## What the extension accesses
- **Page content on SAP Service Cloud pages** (`*.crm.ondemand.com`, `*.crm.sap.com`,
  `*.c4c.sap.com`, `*.cloudfoundry.io`): when you invoke the extension (right-click,
  slash command, or the on-page button), it may read the content of the current page
  to detect the ticket you are viewing and provide relevant context for your request.
- **Text you select or type**: selections you act on and prompts you enter.
- **Your sign-in session**: an authentication token and your account details,
  stored locally in your browser.

## What is sent, and where
When you make a request, the extension sends your query and the relevant page/ticket
context to the backend Service configured by your administrator (the "Server URL" in
the extension's settings). That Service:
- retrieves data from your organization's SAP Service Cloud tenant to answer your
  request, and
- may send the request and context to a third-party AI provider (for example,
  Anthropic or OpenAI) to generate a response, as configured by your administrator.

The extension itself does not transmit your data to any party other than the
configured backend Service.

## What is stored locally
Stored in your browser (`chrome.storage`), on your device only:
- your authentication token and account info (to keep you signed in), and
- your settings (e.g., Server URL, display preferences, SLA-watcher settings).

These are sent only to the configured Service as described above. You can clear
them by signing out or removing the extension.

## Data sharing and sale
Ask C4S does **not** sell your data and does **not** share it with third parties
other than the backend Service you connect to (and, via that Service, the AI
provider your administrator configures).

## Data retention
Retention at the backend Service, SAP, and any AI provider is governed by your
organization's policies and those providers' terms. The extension retains only the
local items listed above.

## Permissions
The extension requests only the permissions needed to perform its function; each is
explained in the Chrome Web Store listing.

## Contact
Questions about this policy: **[REPLACE WITH CONTACT EMAIL]**.
