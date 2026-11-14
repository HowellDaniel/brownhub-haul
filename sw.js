/* BrownHub Haul — the offline shell behind the installed app.
 *
 * Installability is not the point of this file; it is a consequence of it. Keep
 * the shell on the device so a traveller who added Haul to their home screen can
 * still open the booking form in a basement car park, and let every network-first
 * path fail back to the last good page rather than the browser's dinosaur.
 *
 * Rules:
 *   navigations  stale-while-revalidate — once a traveller has opened Haul the
 *                saved shell paints at once on every later launch, even while
 *                the engine is cold; a background revalidation stores the
 *                freshest shell (the studio's brand tokens are injected at
 *                serve time) for the next open. Nothing is fetched until the
 *                app is actually opened, so it never renders before it is.
 *   static shell network-first, cache fallback — new HTML must never run against
 *                an older cached module while online.
 *   api/ photos  never touched. A manifest, a PIN and a traveller's face do not
 *                belong in a cache this file can read.
 *
 * Bump VERSION whenever a shell file changes; activate drops every other cache.
 */
const VERSION = "v9";
const CACHE = `brownhub-haul-${VERSION}`;

const at = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  // No eager cache.addAll() here: pre-fetching the whole shell would render the
  // app before the traveller ever opens it. The fetch handler below caches each
  // resource the first time it is actually requested, so the offline copy builds
  // up as the app is used, not before.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith("brownhub-haul-") && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const offlinePage = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BrownHub Haul — offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fffbf7;color:#26100f;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:2rem}
main{max-width:34rem}h1{font-size:1.5rem;margin:0 0 .6rem}p{margin:0 0 1rem;color:#6e5248}
a{color:#c82027;font-weight:600}</style></head>
<body><main><h1>Haul is offline.</h1>
<p>This device has no connection and no saved copy of the app. Reconnect and open Haul again — your booking and tracking codes are not held in this page.</p>
<p>Need a person now? Message the depot on WhatsApp.</p></main></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);
  if (rel.startsWith("api/") || rel.startsWith("photos/")) return; // network only
  if (/\.(mp4|webm|ogg)$/i.test(rel)) return; // video streams use range requests

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = (await cache.match(at("./"))) || (await cache.match(at("./index.html")));
        const revalidate = fetch(req)
          .then(async (fresh) => {
            if (fresh && fresh.ok) {
              await cache.put(at("./"), fresh.clone());
              await cache.put(at("./index.html"), fresh.clone());
            }
            return fresh;
          })
          .catch(() => null);
        // Open straight: hand back the shell already on the device at once and
        // refresh it in the background for the next launch. On the very first
        // open there is nothing saved yet, so wait for the live response.
        if (cached) {
          event.waitUntil(revalidate);
          return cached;
        }
        return (await revalidate) || offlinePage();
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        return hit || new Response("", { status: 504, statusText: "offline" });
      }
    })()
  );
});
