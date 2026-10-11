/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/*
 * Ask C4S (Field) — service worker.
 *
 * Field techs work in plant basements and equipment rooms with no signal, so
 * offline behaviour is a product requirement, not a nicety.
 *
 * Two deliberate strategies:
 *   • App shell  → cache-first. The UI must open instantly with no network.
 *   • API GETs   → network-first with a cache fallback, so a tech who loses
 *                  signal still sees the last My Day list they loaded.
 *
 * WRITES ARE NEVER CACHED OR REPLAYED. A queued SAP write that fires later
 * without the operator watching would be exactly the "incorrect business
 * transaction" hazard the gated-write design exists to prevent. Writes fail
 * loudly offline and the tech retries.
 */
// Bump this whenever the shell changes. `install` — the only thing that
// re-fetches SHELL — fires when THIS FILE's bytes change, so a version bump is
// what forces installed apps to pick up a new app.js immediately.
//
// v2: app.js gained the sign-in screen. The shell below is now
// stale-while-revalidate rather than pure cache-first, so even a forgotten
// bump self-heals on the next launch instead of pinning an old client forever.
// v3: app.js gained SSO auto-identity (whoami → My Day) + dev sign-in.
// v4: login screen gained the "Sign in with Microsoft" (Entra) button.
// v5: ticket detail gained a working "Prep for PM" screen.
// v6: switched to the extension's light slate theme (index.html shell changed).
// v7: styles moved to the shared design system (/shared/askc4s.css) — cached
//     as part of the shell so the app still styles correctly offline.
// v8: ticket detail gained a working "Parts check" screen.
// v9: home rebuilt to mirror the extension (command box + phase chip grid).
const VERSION = "askc4s-field-v10";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL = ["/", "/app.js", "/manifest.webmanifest", "/shared/askc4s.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch cross-origin or non-GET (see the write note above).
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // API reads: network-first, fall back to the last good response offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => {
            if (hit) {
              // Mark it so the UI can show an honest "offline / stale" banner
              // rather than pretending this is live SAP data.
              const h = new Headers(hit.headers);
              h.set("X-AskC4S-Offline", "1");
              return hit.blob().then((b) => new Response(b, { status: 200, headers: h }));
            }
            return new Response(JSON.stringify({ error: "offline" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }),
        ),
    );
    return;
  }

  // App shell: stale-while-revalidate.
  //
  // Serve the cached copy immediately (the app still opens instantly with no
  // signal — the product requirement), but ALWAYS refetch in the background and
  // update the cache, so the next launch runs the new code.
  //
  // This used to be pure cache-first, which had a nasty failure mode: `install`
  // only re-fetches the shell when sw.js itself changes, so shipping an app.js
  // fix without touching sw.js left installed apps pinned to the old client
  // FOREVER. That nearly shipped a client with no sign-in screen against a
  // server that now requires a token — an app a tech could not repair, because
  // the repair was the thing being cached over.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || caches.match("/"));
      // Cached copy now if we have one; otherwise wait for the network.
      return hit || network;
    }),
  );
});
