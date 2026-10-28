/* BrownHub Haul — the offline shell behind the installed app.
 *
 * Installability is not the point of this file; it is a consequence of it. Keep
 * the shell on the device so a traveller who added Haul to their home screen can
 * still open the booking form in a basement car park, and let every network-first
 * path fail back to the last good page rather than the browser's dinosaur.
 *
 * Rules:
 *   navigations  network-first, cache fallback — the studio's brand tokens are
 *                injected at serve time, so the freshest shell must win online.
 *   static shell stale-while-revalidate — fast start, updated in the background.
 *   api/ photos  never touched. A manifest, a PIN and a traveller's face do not
 *                belong in a cache this file can read.
 *
 * Bump VERSION whenever a shell file changes; activate drops every other cache.
 */
const VERSION = "v1";
const CACHE = `brownhub-haul-${VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./site.webmanifest",
  "./styles/app.css",
  "./app/js/api.mjs",
  "./app/js/booking.mjs",
  "./app/js/dispatch.mjs",
  "./app/js/dom.mjs",
  "./app/js/install.mjs",
  "./app/js/main.mjs",
  "./app/js/track.mjs",
  "./core/codes.mjs",
  "./core/pricing.mjs",
  "./core/zones.mjs",
  "./assets/logo.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/apple-touch-icon.png",
];

const at = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL.map(at));
      await self.skipWaiting();
    })()
  );
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

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            await cache.put(at("./"), fresh.clone());
            await cache.put(at("./index.html"), fresh.clone());
          }
          return fresh;
        } catch {
          return (await cache.match(at("./"))) || (await cache.match(at("./index.html"))) || offlinePage();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((fresh) => {
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        })
        .catch(() => null);
      return hit || (await net) || new Response("", { status: 504, statusText: "offline" });
    })()
  );
});
